import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { loadEnv, splitArgs, type StudioEnv } from './env.js';

const TransportSchema = z.enum(['stdio', 'sse', 'http']);

const ServerConfigSchema = z.object({
  enabled: z.boolean().default(true),
  transport: TransportSchema.default('stdio'),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  url: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  timeoutMs: z.number().int().positive().optional(),
  toolAliases: z.record(z.string(), z.array(z.string())).optional(),
});

export const McpConfigFileSchema = z.object({
  servers: z.object({
    figma: ServerConfigSchema,
  }),
});

export type McpTransportKind = z.infer<typeof TransportSchema>;
export type McpServerConfig = z.infer<typeof ServerConfigSchema>;
export type McpConfigFile = z.infer<typeof McpConfigFileSchema>;

/**
 * ADK DevTools may execute from a temp copy of sources, so `import.meta.url`
 * is not a reliable package-root anchor. Prefer cwd / walk-up / env.
 */
function findPackageRoot(): string {
  const candidates = [
    process.cwd(),
    resolve(process.cwd(), '..'),
    resolve(dirname(fileURLToPath(import.meta.url)), '../..'),
  ];

  for (const start of candidates) {
    let dir = start;
    for (let i = 0; i < 8; i += 1) {
      const configPath = resolve(dir, 'mcp-config.json');
      const pkgPath = resolve(dir, 'package.json');
      if (existsSync(configPath) && existsSync(pkgPath)) {
        return dir;
      }
      const parent = dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
  }

  return process.cwd();
}

function interpolate(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_match, name: string) => env[name] ?? '');
}

function interpolateRecord(
  record: Record<string, string> | undefined,
  env: NodeJS.ProcessEnv,
): Record<string, string> | undefined {
  if (!record) {
    return undefined;
  }
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, interpolate(value, env)]),
  );
}

export function defaultMcpConfigPath(): string {
  return resolve(findPackageRoot(), 'mcp-config.json');
}

export function loadMcpConfigFile(
  path = process.env.MCP_CONFIG_PATH || defaultMcpConfigPath(),
): McpConfigFile {
  const resolved = resolve(path);
  if (!existsSync(resolved)) {
    throw new Error(`MCP config not found at "${resolved}".`);
  }
  const raw = JSON.parse(readFileSync(resolved, 'utf8')) as unknown;
  return McpConfigFileSchema.parse(raw);
}

function applyEnvOverrides(config: McpConfigFile, env: StudioEnv): McpConfigFile {
  const figmaArgs = splitArgs(env.FIGMA_MCP_ARGS);

  return {
    servers: {
      figma: {
        ...config.servers.figma,
        enabled: config.servers.figma.enabled,
        transport: env.FIGMA_MCP_URL ? env.FIGMA_MCP_TRANSPORT : config.servers.figma.transport,
        command: env.FIGMA_MCP_COMMAND ?? config.servers.figma.command,
        args: figmaArgs ?? config.servers.figma.args,
        url: env.FIGMA_MCP_URL ?? config.servers.figma.url,
      },
    },
  };
}

export interface ResolvedMcpServer {
  readonly name: 'figma';
  readonly enabled: boolean;
  readonly transport: McpTransportKind;
  readonly command?: string;
  readonly args?: string[];
  readonly cwd?: string;
  readonly url?: string;
  readonly headers?: Record<string, string>;
  readonly env?: Record<string, string>;
  readonly timeoutMs?: number;
  readonly toolAliases: Record<string, string[]>;
}

export interface ResolvedMcpConfig {
  readonly figma: ResolvedMcpServer;
}

function resolveServer(
  name: 'figma',
  server: McpServerConfig,
  processEnv: NodeJS.ProcessEnv,
): ResolvedMcpServer {
  return {
    name,
    enabled: server.enabled,
    transport: server.transport,
    command: server.command,
    args: server.args,
    cwd: server.cwd,
    url: server.url ? interpolate(server.url, processEnv) : undefined,
    headers: interpolateRecord(server.headers, processEnv),
    env: interpolateRecord(server.env, processEnv),
    timeoutMs: server.timeoutMs,
    toolAliases: server.toolAliases ?? {},
  };
}

export function loadResolvedMcpConfig(env: StudioEnv = loadEnv()): ResolvedMcpConfig {
  const file = applyEnvOverrides(
    loadMcpConfigFile(env.MCP_CONFIG_PATH || defaultMcpConfigPath()),
    env,
  );
  return {
    figma: resolveServer('figma', file.servers.figma, process.env),
  };
}
