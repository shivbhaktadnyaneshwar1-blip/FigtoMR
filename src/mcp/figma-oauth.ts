import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  auth,
  UnauthorizedError,
  type OAuthClientProvider,
} from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { loadEnv } from '../config/env.js';
import { logger } from '../utils/logger.js';

const execFileAsync = promisify(execFile);

const DEFAULT_FIGMA_MCP_URL = 'http://127.0.0.1:3845/mcp';

export interface FigmaOAuthStoredState {
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  codeVerifier?: string;
  oauthState?: string;
  discoveryState?: {
    authorizationServerUrl: string;
    resourceMetadataUrl?: string;
    resourceMetadata?: unknown;
    authorizationServerMetadata?: unknown;
  };
}

export interface FigmaAuthStatus {
  authenticated: boolean;
  mcpUrl: string;
  callbackUrl: string;
  hasTokens: boolean;
  hasClient: boolean;
  mode: 'desktop' | 'remote';
  desktopReachable?: boolean;
  pendingAuthorizationUrl?: string;
}

function tokenStorePath(): string {
  return join(homedir(), '.figto-mr', 'figma-oauth.json');
}

function readStore(): FigmaOAuthStoredState {
  const path = tokenStorePath();
  if (!existsSync(path)) {
    return {};
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as FigmaOAuthStoredState;
  } catch {
    return {};
  }
}

function writeStore(state: FigmaOAuthStoredState): void {
  const path = tokenStorePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2), { mode: 0o600 });
}

export function figmaMcpUrl(): string {
  return (loadEnv().FIGMA_MCP_URL || DEFAULT_FIGMA_MCP_URL).trim() || DEFAULT_FIGMA_MCP_URL;
}

export function figmaOAuthCallbackUrl(): string {
  const env = loadEnv();
  const host = env.HOST === '0.0.0.0' ? '127.0.0.1' : env.HOST;
  return `http://${host}:${env.PORT}/api/figma/oauth/callback`;
}

export function isRemoteFigmaMcp(url = figmaMcpUrl()): boolean {
  try {
    const host = new URL(url).hostname;
    return host === 'mcp.figma.com' || host.endsWith('.figma.com');
  } catch {
    return false;
  }
}

async function openBrowser(url: string): Promise<void> {
  const platform = process.platform;
  try {
    if (platform === 'darwin') {
      await execFileAsync('open', [url]);
    } else if (platform === 'win32') {
      await execFileAsync('cmd', ['/c', 'start', '', url]);
    } else {
      await execFileAsync('xdg-open', [url]);
    }
  } catch (error) {
    logger.warn(`Could not open browser automatically: ${String(error)}`);
  }
}

/**
 * File-backed OAuthClientProvider matching Cursor’s MCP OAuth pattern:
 * dynamic client registration + PKCE + browser redirect.
 */
export class FigmaOAuthProvider implements OAuthClientProvider {
  private pendingAuthorizationUrl: string | undefined;

  constructor(
    private readonly redirectUri: string,
    private readonly onRedirect?: (url: URL) => void | Promise<void>,
  ) {}

  get redirectUrl(): string {
    return this.redirectUri;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'FigtoMR',
      redirect_uris: [this.redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'client_secret_post',
      scope: 'mcp:connect',
    };
  }

  state(): string {
    const store = readStore();
    if (store.oauthState) {
      return store.oauthState;
    }
    const value = randomBytes(24).toString('hex');
    writeStore({ ...store, oauthState: value });
    return value;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return readStore().clientInformation;
  }

  saveClientInformation(clientInformation: OAuthClientInformationMixed): void {
    writeStore({ ...readStore(), clientInformation });
  }

  tokens(): OAuthTokens | undefined {
    return readStore().tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    writeStore({ ...readStore(), tokens, oauthState: undefined, codeVerifier: undefined });
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    this.pendingAuthorizationUrl = authorizationUrl.toString();
    if (this.onRedirect) {
      await this.onRedirect(authorizationUrl);
    } else {
      logger.info(`Figma OAuth — open: ${authorizationUrl}`);
      await openBrowser(authorizationUrl.toString());
    }
  }

  saveCodeVerifier(codeVerifier: string): void {
    writeStore({ ...readStore(), codeVerifier });
  }

  codeVerifier(): string {
    const verifier = readStore().codeVerifier;
    if (!verifier) {
      throw new Error('Missing PKCE code_verifier — restart Figma OAuth from Connect Figma.');
    }
    return verifier;
  }

  discoveryState() {
    return readStore().discoveryState as
      | {
          authorizationServerUrl: string;
          resourceMetadataUrl?: string;
          resourceMetadata?: never;
          authorizationServerMetadata?: never;
        }
      | undefined;
  }

  saveDiscoveryState(state: FigmaOAuthStoredState['discoveryState']): void {
    writeStore({ ...readStore(), discoveryState: state });
  }

  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    const store = readStore();
    if (scope === 'all') {
      writeStore({});
      return;
    }
    if (scope === 'client') {
      writeStore({ ...store, clientInformation: undefined });
    }
    if (scope === 'tokens') {
      writeStore({ ...store, tokens: undefined });
    }
    if (scope === 'verifier') {
      writeStore({ ...store, codeVerifier: undefined, oauthState: undefined });
    }
    if (scope === 'discovery') {
      writeStore({ ...store, discoveryState: undefined });
    }
  }

  takePendingAuthorizationUrl(): string | undefined {
    const url = this.pendingAuthorizationUrl;
    this.pendingAuthorizationUrl = undefined;
    return url;
  }
}

let sharedProvider: FigmaOAuthProvider | undefined;

export function getFigmaOAuthProvider(): FigmaOAuthProvider {
  if (!sharedProvider) {
    sharedProvider = new FigmaOAuthProvider(figmaOAuthCallbackUrl());
  }
  return sharedProvider;
}

export async function figmaAuthStatus(): Promise<FigmaAuthStatus> {
  const store = readStore();
  const mcpUrl = figmaMcpUrl();
  const remote = isRemoteFigmaMcp(mcpUrl);
  let desktopReachable: boolean | undefined;
  if (!remote) {
    try {
      const response = await fetch(mcpUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'figto-mr-probe', version: '0.1.0' },
          },
        }),
        signal: AbortSignal.timeout(2000),
      });
      desktopReachable = response.ok || response.status === 406 || response.status === 400;
    } catch {
      desktopReachable = false;
    }
  }

  return {
    authenticated: remote ? Boolean(store.tokens?.access_token) : Boolean(desktopReachable),
    mcpUrl,
    callbackUrl: figmaOAuthCallbackUrl(),
    hasTokens: Boolean(store.tokens?.access_token),
    hasClient: Boolean(store.clientInformation),
    mode: remote ? 'remote' : 'desktop',
    desktopReachable,
  };
}

export function clearFigmaAuth(): void {
  writeStore({});
  sharedProvider = undefined;
  logger.info('Cleared stored Figma MCP OAuth credentials.');
}

/**
 * Start OAuth the way Cursor does: hit MCP → 401 → DCR + browser authorize.
 */
export async function startFigmaOAuth(options: {
  openBrowser?: boolean;
} = {}): Promise<{
  status: 'authenticated' | 'authorization_required' | 'registration_blocked';
  authorizationUrl?: string;
  message: string;
}> {
  const mcpUrl = figmaMcpUrl();
  if (!isRemoteFigmaMcp(mcpUrl)) {
    return {
      status: 'authenticated',
      message: `Figma MCP is local (${mcpUrl}); OAuth is not required.`,
    };
  }

  const provider = getFigmaOAuthProvider();
  if (provider.tokens()?.access_token) {
    return {
      status: 'authenticated',
      message: 'Already authenticated with Figma MCP.',
    };
  }

  const client = new Client({ name: 'figto-mr', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
    authProvider: provider,
  });

  try {
    await client.connect(transport);
    await client.close().catch(() => undefined);
    return {
      status: 'authenticated',
      message: 'Connected to Figma MCP (existing credentials).',
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const pending = provider.takePendingAuthorizationUrl();

    if (pending) {
      if (options.openBrowser !== false) {
        await openBrowser(pending);
      }
      return {
        status: 'authorization_required',
        authorizationUrl: pending,
        message:
          'Open the Figma authorization window, click Allow access, then return here.',
      };
    }

    // Figma currently blocks DCR for non-catalog clients (403 Forbidden).
    if (/403|Forbidden|InvalidClientMetadata|client registration|register/i.test(message)) {
      return {
        status: 'registration_blocked',
        message: [
          'Figma blocked OAuth client registration (HTTP 403).',
          'Remote MCP only allows catalog clients (Cursor, VS Code, Claude Code, etc.).',
          'Join the waitlist at https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/',
          'Or use Figma desktop Dev Mode MCP: FIGMA_MCP_URL=http://127.0.0.1:3845/mcp',
          `Details: ${message}`,
        ].join(' '),
      };
    }

    if (error instanceof UnauthorizedError || /401|Unauthorized/i.test(message)) {
      return {
        status: 'authorization_required',
        message: `Figma MCP requires OAuth but no authorization URL was produced. ${message}`,
      };
    }

    throw error;
  }
}

/**
 * Complete OAuth after browser redirect (exchange code → tokens).
 */
export async function finishFigmaOAuth(params: {
  code: string;
  state?: string | null;
}): Promise<void> {
  const store = readStore();
  if (params.state && store.oauthState && params.state !== store.oauthState) {
    throw new Error('OAuth state mismatch — restart Connect Figma.');
  }

  const provider = getFigmaOAuthProvider();
  const result = await auth(provider, {
    serverUrl: figmaMcpUrl(),
    authorizationCode: params.code,
  });

  if (result !== 'AUTHORIZED') {
    throw new Error(`Figma OAuth token exchange failed: ${result}`);
  }

  logger.info('Figma MCP OAuth completed — tokens stored.');
}
