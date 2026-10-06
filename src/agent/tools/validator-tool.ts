import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { FunctionTool } from '@google/adk';
import { z } from 'zod';
import { assertPascalComponentName, toKebabCase } from '../../utils/names.js';
import type { AgentRuntime } from '../runtime.js';

const execFileAsync = promisify(execFile);

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function validateScaffoldSource(
  files: Record<string, string>,
  pascalName: string,
  componentRoot = 'src/components',
): string[] {
  const kebab = toKebabCase(pascalName);
  const root = componentRoot.replace(/\/$/, '');
  const issues: string[] = [];
  const required = [
    `${root}/${kebab}/props.ts`,
    `${root}/${kebab}/index.ts`,
    `${root}/${kebab}/${pascalName}.tsx`,
    `${root}/${kebab}/${kebab}.css`,
  ];
  for (const path of required) {
    if (!files[path]) {
      issues.push(`Missing required scaffold file: ${path}`);
    }
  }

  const props = files[`${root}/${kebab}/props.ts`] ?? '';
  const render =
    files[`src/components/${kebab}/${pascalName}.tsx`] ??
    Object.entries(files).find(
      ([path]) => path.includes(`/${root}/${kebab}/`) && path.endsWith('.tsx'),
    )?.[1] ??
    '';
  const index = files[`${root}/${kebab}/index.ts`] ?? '';

  if (props && !props.includes('.strict()')) {
    issues.push('props.ts schema must call .strict().');
  }
  if (props && !props.includes('.describe(')) {
    issues.push('props.ts must include .describe(...) on each field.');
  }
  if (render && !render.includes('displayName')) {
    issues.push('Component TSX must set displayName.');
  }
  if (render && /style=\{\{/.test(render)) {
    issues.push('Component must not use inline style objects.');
  }
  if (render && /<(s-|aui-)[a-z0-9-]+/.test(render)) {
    issues.push('Component must use semantic HTML only — no s-* or aui-* custom elements.');
  }
  if (index && !index.includes(`export { ${pascalName}`)) {
    issues.push('index.ts must re-export the component.');
  }
  return issues;
}

export function createValidatorTools(runtime: AgentRuntime): FunctionTool[] {
  const validate = new FunctionTool({
    name: 'validate_component_scaffold',
    description:
      'Validate the generated React component scaffold (props.ts, component TSX, CSS, index.ts) before approval.',
    parameters: z.object({
      pascalName: z.string().optional(),
      files: z
        .record(z.string(), z.string())
        .optional()
        .describe('Relative path → file contents. Defaults to the last scaffold.'),
    }),
    execute: ({ pascalName, files }) => {
      const issues: string[] = [];
      const resolvedName = pascalName ?? runtime.state.componentName;
      const resolvedFiles = files ?? runtime.state.generatedFiles;

      if (!resolvedFiles || !resolvedName) {
        issues.push('No component scaffold to validate. Call generate_component_scaffold first.');
      } else {
        try {
          const name = assertPascalComponentName(resolvedName);
          issues.push(
            ...validateScaffoldSource(
              resolvedFiles,
              name,
              runtime.state.targetProfile?.componentRoot,
            ),
          );
          runtime.state.componentName = name;
          runtime.state.generatedFiles = resolvedFiles;
        } catch (error) {
          issues.push(error instanceof Error ? error.message : String(error));
        }
      }

      runtime.state.validationIssues = issues;
      return json({
        ok: issues.length === 0,
        issues,
        files: resolvedFiles ? Object.keys(resolvedFiles) : [],
      });
    },
  });

  const typecheck = new FunctionTool({
    name: 'run_target_typecheck',
    description:
      'Run an npm script in TARGET_REPO_PATH (default lint:types). Use after writing files.',
    parameters: z.object({
      script: z.string().optional().default('lint:types'),
    }),
    execute: async ({ script }) => {
      const repo = runtime.state.targetRepoPath;
      if (!repo) {
        return json({ ok: false, error: 'Target repo path is not set. Set TARGET_REPO_PATH.' });
      }
      if (runtime.state.dryRun) {
        return json({ ok: true, skipped: true, reason: 'dry-run' });
      }
      try {
        const { stdout, stderr } = await execFileAsync('npm', ['run', script], {
          cwd: repo,
          timeout: 120_000,
        });
        return json({ ok: true, stdout, stderr });
      } catch (error) {
        const err = error as { stdout?: string; stderr?: string; message?: string };
        return json({
          ok: false,
          error: err.message,
          stdout: err.stdout,
          stderr: err.stderr,
        });
      }
    },
  });

  return [validate, typecheck];
}
