import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

loadDotenv();

const EnvSchema = z.object({
  /** Google Gemini / ADK (direct API — no enterprise LLM gateway). */
  GEMINI_API_KEY: z.string().optional(),
  GOOGLE_API_KEY: z.string().optional(),
  ADK_MODEL: z.string().default('gemini-2.5-pro'),
  /** Local git checkout where generated components are written. */
  TARGET_REPO_PATH: z.string().optional(),
  TARGET_GIT_REMOTE: z.string().default('origin'),
  TARGET_GIT_BASE_BRANCH: z.string().default('main'),
  /** GitLab/GitHub project path for MR API (e.g. org/repo). Optional. */
  GIT_REMOTE_PROJECT: z.string().optional(),
  STUDIO_PREVIEW_URL: z.string().default('http://localhost:5173'),
  /** Optional JSON profile which overrides repository convention detection. */
  TARGET_FRONTEND_PROFILE: z.string().optional(),
  GITLAB_API_URL: z.string().default('https://gitlab.com/api/v4'),
  GITHUB_API_URL: z.string().default('https://api.github.com'),
  GITLAB_TOKEN: z.string().optional(),
  GITHUB_TOKEN: z.string().optional(),
  GIT_MR_TARGET_BRANCH: z.string().optional(),
  /** @deprecated Use GIT_MR_TARGET_BRANCH */
  GITLAB_MR_TARGET_BRANCH: z.string().optional(),
  PORT: z
    .string()
    .optional()
    .transform((value) => Number(value ?? '8787')),
  HOST: z.string().default('127.0.0.1'),
  FIGMA_API_KEY: z.string().optional(),
  FIGMA_MCP_COMMAND: z.string().optional(),
  FIGMA_MCP_ARGS: z.string().optional(),
  FIGMA_MCP_URL: z.string().optional(),
  FIGMA_MCP_TRANSPORT: z.enum(['stdio', 'sse', 'http']).default('http'),
  STUDIO_DRY_RUN: z
    .string()
    .optional()
    .transform((value) => value !== 'false' && value !== '0'),
  STUDIO_LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
  MCP_CONFIG_PATH: z.string().optional(),
});

export type StudioEnv = z.infer<typeof EnvSchema>;

let cached: StudioEnv | undefined;

export function loadEnv(overrides: Partial<NodeJS.ProcessEnv> = {}): StudioEnv {
  if (cached && Object.keys(overrides).length === 0) {
    return cached;
  }

  const parsed = EnvSchema.parse({ ...process.env, ...overrides });
  if (!cached || Object.keys(overrides).length === 0) {
    cached = parsed;
  }
  return parsed;
}

export function resetEnvCache(): void {
  cached = undefined;
}

export function targetRepoPathFromEnv(env: StudioEnv = loadEnv()): string {
  const raw = env.TARGET_REPO_PATH?.trim();
  if (!raw) {
    throw new Error(
      'TARGET_REPO_PATH is not set. Point it at the local git repo where components should be written.',
    );
  }
  return resolve(raw);
}

export function resolveTargetRepoPath(env: StudioEnv = loadEnv()): string {
  const path = targetRepoPathFromEnv(env);
  if (!existsSync(path)) {
    throw new Error(`Target repo not found at "${path}". Set TARGET_REPO_PATH to a valid checkout.`);
  }
  return path;
}

export function studioPreviewUrl(env: StudioEnv = loadEnv()): string {
  return env.STUDIO_PREVIEW_URL.replace(/\/$/, '');
}

export function gitRemoteProject(env: StudioEnv = loadEnv()): string | undefined {
  return env.GIT_REMOTE_PROJECT?.trim() || undefined;
}

/** Validate Gemini credentials for ADK native models. */
export function requireGeminiConfig(env: StudioEnv = loadEnv()): StudioEnv {
  const key = env.GEMINI_API_KEY?.trim() || env.GOOGLE_API_KEY?.trim();
  if (!key) {
    throw new Error(
      'Missing Gemini API key. Set GEMINI_API_KEY or GOOGLE_API_KEY in the environment.',
    );
  }
  return env;
}

export function targetGitRemote(env: StudioEnv = loadEnv()): string {
  return env.TARGET_GIT_REMOTE;
}

export function targetGitBaseBranch(env: StudioEnv = loadEnv()): string {
  return env.TARGET_GIT_BASE_BRANCH;
}

export function gitMrTargetBranch(env: StudioEnv = loadEnv()): string | undefined {
  return env.GIT_MR_TARGET_BRANCH?.trim() || env.GITLAB_MR_TARGET_BRANCH?.trim() || undefined;
}

export function splitArgs(value: string | undefined): string[] | undefined {
  if (!value?.trim()) {
    return undefined;
  }
  return value
    .split(/[,\s]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}
