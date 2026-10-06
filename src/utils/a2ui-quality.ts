import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from './logger.js';

const execFileAsync = promisify(execFile);

const ANSI_RE = /\u001b\[[0-9;]*m/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

/**
 * Keep only TypeScript diagnostics that mention one of the scoped paths.
 * Multi-line error blocks stay attached to their file header line.
 */
export function filterTscLogToPaths(rawLog: string, scopedPaths: readonly string[]): {
  readonly ok: boolean;
  readonly log: string;
  readonly errorCount: number;
} {
  const log = stripAnsi(rawLog);
  const paths = scopedPaths.map((p) => p.replace(/\\/g, '/'));
  if (paths.length === 0) {
    const errorCount = (log.match(/error TS\d+/g) ?? []).length;
    return { ok: errorCount === 0, log: log.slice(0, 16_000), errorCount };
  }

  const lines = log.split('\n');
  const kept: string[] = [];
  let keepBlock = false;
  let errorCount = 0;

  for (const line of lines) {
    const isFileHeader = /^[\w./\\-]+\.(ts|tsx|js|jsx)\(\d+,\d+\)/.test(line.trim());
    if (isFileHeader) {
      keepBlock = paths.some((p) => line.includes(p));
    }
    if (keepBlock) {
      kept.push(line);
      if (/error TS\d+/.test(line)) {
        errorCount += 1;
      }
      // End block on blank line after an error continuation
      if (line.trim() === '' && kept.length > 0) {
        keepBlock = false;
      }
    }
  }

  const filtered =
    kept.length > 0
      ? kept.join('\n').trim()
      : paths.length > 0
        ? `No TypeScript errors in scoped files:\n${paths.map((p) => `- ${p}`).join('\n')}`
        : log;

  return {
    ok: errorCount === 0,
    log: filtered.slice(0, 16_000),
    errorCount,
  };
}

export function summarizeScopedErrors(log: string, limit = 5): string {
  const clean = stripAnsi(log);
  const errors = clean
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /error TS\d+/.test(l) || /\.(ts|tsx)\(\d+,\d+\)/.test(l));
  if (errors.length === 0) {
    return clean.slice(0, 300);
  }
  return errors.slice(0, limit).join(' | ').slice(0, 600);
}

/**
 * Child npm/npx/biome processes inherit NODE_OPTIONS=--inspect* when the API is
 * under the debugger, which injects "Debugger listening…" noise and can attach
 * extra inspectors. Strip inspect flags for quality-gate subprocesses.
 */
/** Env for npm/npx quality subprocesses (no inherited debugger inspect flags). */
export function childEnvForQualityGate(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    FORCE_COLOR: '0',
    NO_COLOR: '1',
  };
  delete env.VSCODE_INSPECTOR_OPTIONS;
  delete env.VSCODE_DEBUGGER_WORKER;
  if (env.NODE_OPTIONS) {
    const cleaned = env.NODE_OPTIONS.split(/\s+/)
      .filter((part) => part && !/^--inspect(-brk)?(=|$)/.test(part))
      .filter((part) => !/^--debug(=|$)/.test(part))
      .join(' ')
      .trim();
    if (cleaned) env.NODE_OPTIONS = cleaned;
    else delete env.NODE_OPTIONS;
  }
  return env;
}

function stripDebuggerNoise(text: string): string {
  return text
    .split('\n')
    .filter(
      (line) =>
        !/^Debugger listening on /i.test(line) &&
        !/^Debugger attached\.?$/i.test(line) &&
        !/^Waiting for the debugger to disconnect/i.test(line) &&
        !/^For help, see: https:\/\/nodejs\.org\/en\/docs\/inspector/i.test(line),
    )
    .join('\n');
}

async function runCaptured(
  repoPath: string,
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<{ ok: boolean; log: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd: repoPath,
      maxBuffer: 20 * 1024 * 1024,
      timeout: timeoutMs,
      env: childEnvForQualityGate(),
    });
    return {
      ok: true,
      log: stripDebuggerNoise(stripAnsi(`${stdout}\n${stderr}`)).trim(),
    };
  } catch (error) {
    // Non-zero exit is normal for Biome/tsc failures — surface stdout/stderr to the repair agent.
    const err = error as { stdout?: string; stderr?: string; message?: string };
    const log = stripDebuggerNoise(
      stripAnsi([err.stdout, err.stderr, err.message].filter(Boolean).join('\n')),
    ).trim();
    return { ok: false, log };
  }
}

export interface ScopedQualityResult {
  readonly lintOk: boolean;
  readonly typesOk: boolean;
  readonly biomeOk: boolean;
  readonly log: string;
  readonly summary: string;
}

/**
 * Full-repo the target repo lint gate: `npm run lint:all` (tsc + biome on the whole tree).
 * Same bar as local CI — not scoped to the current component.
 */
export async function runFullA2uiLint(repoPath: string): Promise<ScopedQualityResult> {
  const result = await runCaptured(repoPath, 'npm', ['run', 'lint:all'], 300_000);
  const lintOk = result.ok;
  const log = ['## npm run lint:all (full repo)', result.log || '(clean)']
    .join('\n')
    .slice(0, 20_000);
  const summary = lintOk ? 'lint:all ok' : summarizeScopedErrors(result.log || log);

  if (!lintOk) {
    logger.warn('Full-repo npm run lint:all failed');
  }

  // lint:all = lint:types && lint — we don't split exit codes; treat both as failed when red.
  return { lintOk, typesOk: lintOk, biomeOk: lintOk, log, summary };
}

/** Full-repo the target repo unit tests: `npm test`. */
export async function runFullA2uiTests(repoPath: string): Promise<{ ok: boolean; log: string }> {
  const result = await runCaptured(repoPath, 'npm', ['test'], 600_000);
  return {
    ok: result.ok,
    log: ['## npm test (full repo)', result.log || '(clean)'].join('\n').slice(0, 20_000),
  };
}

/**
 * @deprecated Prefer {@link runFullA2uiLint}. Always runs full-repo lint:all
 * (scopedPaths ignored for compatibility with older call sites).
 */
export async function runScopedA2uiLint(
  repoPath: string,
  _scopedPaths?: readonly string[],
): Promise<ScopedQualityResult> {
  void _scopedPaths;
  return runFullA2uiLint(repoPath);
}
