import { spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { logger } from './logger.js';

const execFileAsync = promisify(execFile);

const FORMATTABLE = /\.(ts|tsx|js|jsx)$/;

function ensureTrailingNewline(source: string): string {
  return source.endsWith('\n') ? source : `${source}\n`;
}

/**
 * Format a single source string with the target repo's Biome config
 * (`biome.json`: single quotes, 120 width, spaces, organizeImports via check --write on disk).
 */
export async function formatSourceWithA2uiBiome(
  repoPath: string,
  relativePath: string,
  contents: string,
): Promise<string> {
  const normalized = relativePath.replace(/\\/g, '/');
  if (!FORMATTABLE.test(normalized)) {
    return ensureTrailingNewline(contents);
  }

  return new Promise((resolve) => {
    const child = spawn(
      'npx',
      ['@biomejs/biome', 'format', '--stdin-file-path', normalized],
      {
        cwd: repoPath,
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      logger.warn(`Biome format unavailable for ${normalized}: ${error.message}`);
      resolve(ensureTrailingNewline(contents));
    });
    child.on('close', (code) => {
      if (code === 0 && stdout.trim().length > 0) {
        resolve(ensureTrailingNewline(stdout));
        return;
      }
      logger.warn(
        `Biome format skipped for ${normalized} (exit ${code ?? '?'}): ${stderr.slice(0, 240) || 'no output'}`,
      );
      resolve(ensureTrailingNewline(contents));
    });

    child.stdin.write(contents);
    child.stdin.end();
  });
}

/** Format every JS/TS file in a path→contents map using the target repo Biome. */
export async function formatFilesWithA2uiBiome(
  repoPath: string,
  files: Record<string, string>,
): Promise<Record<string, string>> {
  const entries = Object.entries(files);
  const formatted: Record<string, string> = {};
  for (const [path, contents] of entries) {
    formatted[path] = await formatSourceWithA2uiBiome(repoPath, path, contents);
  }
  return formatted;
}

/**
 * Run the target repo `biome check --write` on paths already on disk
 * (format + safe fixes + organize imports).
 */
export async function biomeWriteA2uiPaths(
  repoPath: string,
  relativePaths: readonly string[],
): Promise<{ ok: boolean; formatted: string[]; log: string }> {
  const targets = [...new Set(relativePaths.map((p) => p.replace(/\\/g, '/')))].filter((p) =>
    FORMATTABLE.test(p),
  );
  if (targets.length === 0) {
    return { ok: true, formatted: [], log: 'No formattable paths.' };
  }

  try {
    const { stdout, stderr } = await execFileAsync(
      'npx',
      ['@biomejs/biome', 'check', '--write', '--files-ignore-unknown=true', '--', ...targets],
      {
        cwd: repoPath,
        maxBuffer: 10 * 1024 * 1024,
        timeout: 120_000,
      },
    );
    const log = `${stdout}\n${stderr}`.trim().slice(0, 4000);
    logger.info(`Biome-formatted ${targets.length} the target repo file(s)`);
    return { ok: true, formatted: targets, log };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    const log = [err.message, err.stdout, err.stderr].filter(Boolean).join('\n').slice(0, 4000);
    // Biome exits non-zero when remaining lint issues exist; formatting may still have applied.
    logger.warn(`Biome check --write finished with issues (formatting may still apply):\n${log}`);
    return { ok: false, formatted: targets, log };
  }
}
