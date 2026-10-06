import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { MCPConnectionParams } from '@google/adk';
import type { ProgressHandler } from '../agent/progress.js';
import {
  labelMcpTool,
  summarizeArgs,
} from '../agent/progress.js';
import {
  loadResolvedMcpConfig,
  type ResolvedMcpConfig,
  type ResolvedMcpServer,
} from '../config/mcp-servers.js';
import { logger } from '../utils/logger.js';
import { extractFigmaImages } from '../utils/figma-media.js';
import { getFigmaOAuthProvider, isRemoteFigmaMcp } from './figma-oauth.js';

export interface ListedMcpTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
}

export interface McpCallResult {
  readonly server: 'figma';
  readonly tool: string;
  readonly content: unknown;
  /** Image / media parts preserved separately (MCP often mixes text + image). */
  readonly images?: readonly {
    readonly mimeType: string;
    readonly dataUrl: string;
    readonly byteLength: number;
    readonly source: 'base64' | 'url';
  }[];
  readonly isError?: boolean;
}

interface ConnectedServer {
  readonly config: ResolvedMcpServer;
  readonly client: Client;
  readonly tools: ListedMcpTool[];
}

function rewriteMcpConnectError(
  name: 'figma',
  server: ResolvedMcpServer,
  error: unknown,
): Error {
  const raw = error instanceof Error ? error.message : String(error);
  const is401 = /401|Unauthorized/i.test(raw);
  if (name === 'figma' && is401) {
    return new Error(
      [
        `Figma MCP unauthorized at ${server.url ?? '(no url)'}.`,
        'Click “Connect Figma” in the UI to open the OAuth window (same flow as Cursor),',
        'or set FIGMA_MCP_URL=http://127.0.0.1:3845/mcp after enabling desktop Dev Mode MCP.',
      ].join(' '),
    );
  }
  if (name === 'figma' && /403|Forbidden/i.test(raw)) {
    return new Error(
      [
        `Figma blocked MCP OAuth client registration for this app.`,
        'Remote MCP is limited to catalog clients (Cursor, VS Code, Claude).',
        'Use desktop MCP (http://127.0.0.1:3845/mcp) or join Figma’s MCP client waitlist.',
        `Details: ${raw}`,
      ].join(' '),
    );
  }
  return new Error(`Failed to connect to ${name} MCP (${server.transport} ${server.url ?? ''}): ${raw}`);
}

function toAdkConnectionParams(server: ResolvedMcpServer): MCPConnectionParams {
  if (server.transport === 'stdio') {
    if (!server.command) {
      throw new Error(`MCP server "${server.name}" is configured for stdio but has no command.`);
    }
    return {
      type: 'StdioConnectionParams',
      serverParams: {
        command: server.command,
        args: server.args ?? [],
        env: server.env,
        cwd: server.cwd,
      },
      timeout: server.timeoutMs,
    };
  }

  if (!server.url) {
    throw new Error(
      `MCP server "${server.name}" is configured for ${server.transport} but has no url.`,
    );
  }

  return {
    type: 'StreamableHTTPConnectionParams',
    url: server.url,
    timeout: server.timeoutMs,
    transportOptions: server.headers
      ? {
          requestInit: {
            headers: server.headers,
          },
        }
      : undefined,
  };
}

async function connectClient(server: ResolvedMcpServer): Promise<Client> {
  const client = new Client({ name: 'figto-mr', version: '0.1.0' });

  if (server.transport === 'stdio') {
    if (!server.command) {
      throw new Error(`MCP server "${server.name}" is configured for stdio but has no command.`);
    }
    await client.connect(
      new StdioClientTransport({
        command: server.command,
        args: server.args ?? [],
        env: server.env,
        cwd: server.cwd,
      }),
    );
    return client;
  }

  if (!server.url) {
    throw new Error(
      `MCP server "${server.name}" is configured for ${server.transport} but has no url.`,
    );
  }

  const url = new URL(server.url);
  if (server.transport === 'sse') {
    await client.connect(
      new SSEClientTransport(url, {
        requestInit: server.headers ? { headers: server.headers } : undefined,
      }),
    );
    return client;
  }

  const useFigmaOAuth = server.name === 'figma' && isRemoteFigmaMcp(server.url);
  const authProvider = useFigmaOAuth ? getFigmaOAuthProvider() : undefined;
  await client.connect(
    new StreamableHTTPClientTransport(url, {
      authProvider,
      requestInit: server.headers ? { headers: server.headers } : undefined,
    }),
  );
  return client;
}

function extractTextContent(result: {
  content?: unknown;
  structuredContent?: unknown;
  isError?: boolean;
}): unknown {
  if (result.structuredContent !== undefined) {
    return result.structuredContent;
  }
  const content = result.content;
  if (!Array.isArray(content)) {
    return content ?? null;
  }
  const texts = content
    .filter((item): item is { type: string; text: string } => {
      return Boolean(
        item &&
        typeof item === 'object' &&
        'type' in item &&
        item.type === 'text' &&
        'text' in item,
      );
    })
    .map((item) => item.text);
  if (texts.length === 1) {
    try {
      return JSON.parse(texts[0] ?? '');
    } catch {
      return texts[0];
    }
  }
  if (texts.length > 0) {
    return texts;
  }
  // Keep non-text blocks (images) so callers can still inspect them.
  return content;
}

export class McpClientManager {
  private readonly connections = new Map<'figma', ConnectedServer>();
  private progressHandler: ProgressHandler | undefined;

  constructor(private readonly config: ResolvedMcpConfig = loadResolvedMcpConfig()) {}

  setProgressHandler(handler: ProgressHandler | undefined): void {
    this.progressHandler = handler;
  }

  get resolvedConfig(): ResolvedMcpConfig {
    return this.config;
  }

  toAdkConnectionParams(name: 'figma'): MCPConnectionParams | undefined {
    const server = this.config.figma;
    if (!server?.enabled) {
      return undefined;
    }
    return toAdkConnectionParams(server);
  }

  async connect(name: 'figma'): Promise<ListedMcpTool[]> {
    const existing = this.connections.get(name);
    if (existing) {
      return existing.tools;
    }

    const server = this.config.figma;
    if (!server?.enabled) {
      throw new Error(`MCP server "${name}" is not enabled in mcp-config.json / env.`);
    }

    logger.info(`Connecting to ${name} MCP server via ${server.transport} ${server.url ?? ''}...`);
    this.progressHandler?.({
      phase: 'start',
      source: 'figma-mcp',
      name: `${name}:connect`,
      label: `Connecting to ${name === 'figma' ? 'Figma' : 'HTML/CSS'} MCP`,
      detail: server.url ?? server.command,
    });
    let client: Client;
    try {
      client = await connectClient(server);
    } catch (error) {
      this.progressHandler?.({
        phase: 'error',
        source: 'figma-mcp',
        name: `${name}:connect`,
        label: `Failed to connect to ${name === 'figma' ? 'Figma' : 'HTML/CSS'} MCP`,
        detail: error instanceof Error ? error.message : String(error),
      });
      throw rewriteMcpConnectError(name, server, error);
    }
    const listed = await client.listTools();
    const tools = listed.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
    this.connections.set(name, { config: server, client, tools });
    logger.info(`Connected to ${name} MCP. Discovered ${tools.length} tool(s).`);
    this.progressHandler?.({
      phase: 'done',
      source: 'figma-mcp',
      name: `${name}:connect`,
      label: `Connected to ${name === 'figma' ? 'Figma' : 'HTML/CSS'} MCP`,
      detail: `${tools.length} tool(s): ${tools
        .map((tool) => tool.name)
        .slice(0, 8)
        .join(', ')}${tools.length > 8 ? '…' : ''}`,
    });
    return tools;
  }

  async listTools(name: 'figma'): Promise<ListedMcpTool[]> {
    const connected = this.connections.get(name);
    if (connected) {
      return connected.tools;
    }
    return this.connect(name);
  }

  resolveToolName(
    name: 'figma',
    logicalName: string,
    fallbacks: string[] = [],
  ): string | undefined {
    const server = this.config.figma;
    const aliases = server?.toolAliases[logicalName] ?? [];
    const candidates = [...aliases, ...fallbacks, logicalName];
    const connected = this.connections.get(name);
    const available = new Set((connected?.tools ?? []).map((tool) => tool.name));
    return candidates.find((candidate) => available.has(candidate));
  }

  async callTool(
    name: 'figma',
    toolName: string,
    args: Record<string, unknown> = {},
  ): Promise<McpCallResult> {
    const connected =
      this.connections.get(name) ?? (await this.connect(name), this.connections.get(name));
    if (!connected) {
      throw new Error(`MCP server "${name}" is not connected.`);
    }

    const source = 'figma-mcp';
    const label = labelMcpTool(name, toolName);
    const detail = summarizeArgs(args);
    this.progressHandler?.({
      phase: 'start',
      source,
      name: toolName,
      label,
      detail,
    });

    logger.debug(`Calling ${name}.${toolName}`, args);
    try {
      const result = await connected.client.callTool({ name: toolName, arguments: args });
      const raw = result as { content?: unknown; structuredContent?: unknown; isError?: boolean };
      const content = extractTextContent(raw);
      const images = extractFigmaImages(
        raw.content ?? raw.structuredContent ?? content,
        toolName,
      ).map(({ mimeType, dataUrl, byteLength, source }) => ({
        mimeType,
        dataUrl,
        byteLength,
        source,
      }));
      const callResult: McpCallResult = {
        server: name,
        tool: toolName,
        content,
        images: images.length > 0 ? images : undefined,
        isError: Boolean(raw.isError),
      };
      this.progressHandler?.({
        phase: callResult.isError ? 'error' : 'done',
        source,
        name: toolName,
        label,
        detail: callResult.isError
          ? `MCP returned an error for ${toolName}`
          : images.length > 0
            ? `done · ${images.length} image(s)`
            : detail
              ? `done · ${detail}`
              : 'done',
      });
      return callResult;
    } catch (error) {
      this.progressHandler?.({
        phase: 'error',
        source,
        name: toolName,
        label,
        detail: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async callFirstAvailable(
    name: 'figma',
    logicalName: string,
    args: Record<string, unknown>,
    extraFallbacks: string[] = [],
  ): Promise<McpCallResult> {
    await this.connect(name);
    const resolved = this.resolveToolName(name, logicalName, extraFallbacks);
    if (!resolved) {
      const tools = (await this.listTools(name)).map((tool) => tool.name).join(', ');
      throw new Error(
        `No ${name} MCP tool found for "${logicalName}". Available tools: ${tools || '(none)'}.`,
      );
    }
    return this.callTool(name, resolved, args);
  }

  async close(name?: 'figma'): Promise<void> {
    const targets = name ? [name] : (['figma'] as const);
    await Promise.all(
      targets.map(async (target) => {
        const connected = this.connections.get(target);
        if (!connected) {
          return;
        }
        try {
          await connected.client.close();
        } catch (error) {
          logger.warn(`Failed to close ${target} MCP client cleanly: ${String(error)}`);
        }
        this.connections.delete(target);
      }),
    );
  }
}
