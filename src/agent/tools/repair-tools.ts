import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FunctionTool } from '@google/adk';
import { z } from 'zod';
import { applyWritePlan, isAllowedStudioMrPath, isProposalScopedPath } from '../../utils/file-writer.js';
import { formatTargetRepoPaths } from '../../utils/target-repo-format.js';
import { runTargetRepoScript } from '../../utils/target-repo-quality.js';
import type { AgentRuntime } from '../runtime.js';

export type RepairMode = 'lint' | 'test' | 'build' | 'visual';

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/** Tools for one repair loop. Lint and tests are separate host loops. */
export function createRepairTools(runtime: AgentRuntime, mode: RepairMode): FunctionTool[] {
  const readFile = new FunctionTool({
    name: 'read_target_file',
    description:
      'Read an allowlisted generated component file from the target repository.',
    parameters: z.object({
      path: z.string().describe('Repo-relative path, e.g. src/components/summary-card/SummaryCard.tsx'),
    }),
    execute: ({ path }) => {
      const repo = runtime.state.targetRepoPath;
      if (!repo) {
        return json({ ok: false, error: 'Target repo path is not set. Set TARGET_REPO_PATH.' });
      }
      const normalized = path.replace(/\\/g, '/');
      if (!isAllowedStudioMrPath(normalized, runtime.state.targetProfile)) {
        return json({
          ok: false,
          error: `Path not allowlisted for Studio edits: ${normalized}`,
        });
      }
      if (!isProposalScopedPath(normalized, runtime.state.componentName, runtime.state.targetProfile)) {
        return json({
          ok: false,
          error: `Path is outside the current proposal component (${runtime.state.componentName ?? 'unknown'}): ${normalized}. Fix only this component's files.`,
        });
      }
      const absolute = join(repo, normalized);
      if (!existsSync(absolute)) {
        return json({ ok: false, error: `File not found: ${normalized}` });
      }
      const contents = readFileSync(absolute, 'utf8');
      runtime.emitProgress({
        phase: 'info',
        source: 'studio',
        name: 'read_target_file',
        label: `Reading ${normalized}`,
        detail: `${contents.length} bytes`,
      });
      return json({ ok: true, path: normalized, contents });
    },
  });

  const writeFile = new FunctionTool({
    name: 'write_target_file',
    description:
      'Overwrite an allowlisted the target repo file. In visual mode: close Figma gaps. In lint/test/build mode: fix the quality failure.',
    parameters: z.object({
      path: z.string(),
      contents: z.string().describe('Full new file contents.'),
    }),
    execute: async ({ path, contents }) => {
      const repo = runtime.state.targetRepoPath;
      if (!repo) {
        return json({ ok: false, error: 'Target repo path is not set. Set TARGET_REPO_PATH.' });
      }
      const normalized = path.replace(/\\/g, '/');
      if (!isAllowedStudioMrPath(normalized, runtime.state.targetProfile)) {
        return json({
          ok: false,
          error: `Refusing to write non-allowlisted path: ${normalized}`,
        });
      }
      if (!isProposalScopedPath(normalized, runtime.state.componentName, runtime.state.targetProfile)) {
        return json({
          ok: false,
          error: `Refusing to edit leftover component outside proposal (${runtime.state.componentName ?? 'unknown'}): ${normalized}`,
        });
      }
      if (/declare\s+global/.test(contents) || /namespace\s+JSX/.test(contents)) {
        return json({
          ok: false,
          error: 'Do not add declare global / JSX IntrinsicElements. Use semantic HTML in the component.',
        });
      }
      runtime.emitProgress({
        phase: 'start',
        source: 'studio',
        name: 'write_target_file',
        label: `Writing fix → ${normalized}`,
      });
      const result = applyWritePlan({
        repoPath: repo,
        dryRun: false,
        files: [{ relativePath: normalized, contents }],
      });
      if (runtime.state.targetProfile?.formatter === 'biome') {
        await formatTargetRepoPaths(repo, result.written);
      }
      runtime.state.writtenFiles = [
        ...new Set([...runtime.state.writtenFiles, ...result.written]),
      ];
      runtime.emitProgress({
        phase: 'done',
        source: 'studio',
        name: 'write_target_file',
        label: `Updated ${normalized} (Biome-formatted)`,
      });
      return json({ ok: true, written: result.written, biomeFormatted: true });
    },
  });

  const runLint = new FunctionTool({
    name: 'run_target_lint',
    description:
      'Run full the target repo `npm run lint:all` (tsc + Biome on the whole repo). Fix every reported error, then re-run until it passes.',
    parameters: z.object({}),
    execute: async () => {
      const repo = runtime.state.targetRepoPath;
      if (!repo) {
        return json({ ok: false, error: 'Target repo path is not set. Set TARGET_REPO_PATH.' });
      }
      runtime.emitProgress({
        phase: 'start',
        source: 'studio',
        name: 'run_target_lint',
        label: 'Running npm run lint:all (full repo)',
      });
      const lint = await runTargetRepoScript(repo, runtime.state.targetProfile?.scripts.lint);
      runtime.emitProgress({
        phase: lint.ok ? 'done' : 'error',
        source: 'studio',
        name: 'run_target_lint',
        label: lint.ok ? 'lint passed' : 'lint failed',
        detail: lint.log.slice(0, 240),
      });
      return json({
        ok: lint.ok,
        log: lint.log,
        hint: lint.ok
          ? undefined
          : 'Fix lint errors in the generated component files. Use semantic HTML only.',
      });
    },
  });

  const runTests = new FunctionTool({
    name: 'run_target_tests',
    description:
      'Run full the target repo `npm test`. Fix failing assertions anywhere in the suite, then re-run until green.',
    parameters: z.object({}),
    execute: async () => {
      const repo = runtime.state.targetRepoPath;
      if (!repo) {
        return json({ ok: false, error: 'Target repo path is not set. Set TARGET_REPO_PATH.' });
      }
      runtime.emitProgress({
        phase: 'start',
        source: 'studio',
        name: 'run_target_tests',
        label: 'Running npm test (full repo)',
      });
      const test = await runTargetRepoScript(repo, runtime.state.targetProfile?.scripts.test, 600_000);
      runtime.emitProgress({
        phase: test.ok ? 'done' : 'error',
        source: 'studio',
        name: 'run_target_tests',
        label: test.ok ? 'npm test passed' : 'npm test failed',
        detail: test.log.slice(0, 240),
      });
      return json({ ok: test.ok, log: test.log });
    },
  });

  const runBuild = new FunctionTool({
    name: 'run_target_build',
    description:
      'Run npm run build in the target repo. Fix compile errors in the component, then re-run. Does not run unit tests.',
    parameters: z.object({}),
    execute: async () => {
      const repo = runtime.state.targetRepoPath;
      if (!repo) {
        return json({ ok: false, error: 'Target repo path is not set. Set TARGET_REPO_PATH.' });
      }
      runtime.emitProgress({
        phase: 'start',
        source: 'studio',
        name: 'run_target_build',
        label: 'Running npm run build',
      });
      const build = await runTargetRepoScript(repo, runtime.state.targetProfile?.scripts.build, 180_000);
      runtime.emitProgress({
        phase: build.ok ? 'done' : 'error',
        source: 'studio',
        name: 'run_target_build',
        label: build.ok ? 'build passed' : 'build failed',
        detail: build.log.slice(0, 240),
      });
      return json({
        ok: build.ok,
        log: build.log,
      });
    },
  });

  if (mode === 'lint') {
    return [readFile, writeFile, runLint];
  }
  if (mode === 'build') {
    return [readFile, writeFile, runBuild];
  }
  if (mode === 'visual') {
    // Visual refine / compare: read + write only. Lint/test/build run on Approve.
    return [readFile, writeFile];
  }
  return [readFile, writeFile, runTests];
}
