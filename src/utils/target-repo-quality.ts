export {
  childEnvForQualityGate,
  filterTscLogToPaths,
  runFullA2uiLint as runTargetRepoLint,
  runFullA2uiTests as runTargetRepoTests,
  stripAnsi,
  summarizeScopedErrors,
} from './a2ui-quality.js';

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { childEnvForQualityGate } from './a2ui-quality.js';

const execFileAsync = promisify(execFile);

export async function runTargetRepoScript(
  repoPath: string,
  script: string | undefined,
  timeoutMs = 300_000,
): Promise<{ ok: boolean; log: string }> {
  if (!script) {
    return { ok: true, log: 'No target-repo script configured; skipped.' };
  }
  try {
    const { stdout, stderr } = await execFileAsync('npm', ['run', script], {
      cwd: repoPath,
      timeout: timeoutMs,
      maxBuffer: 20 * 1024 * 1024,
      env: childEnvForQualityGate(),
    });
    return { ok: true, log: `${stdout}\n${stderr}`.trim() };
  } catch (error) {
    const err = error as { message?: string; stdout?: string; stderr?: string };
    return {
      ok: false,
      log: [err.message, err.stdout, err.stderr].filter(Boolean).join('\n').slice(0, 20_000),
    };
  }
}
