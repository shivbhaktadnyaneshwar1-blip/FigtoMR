import { FunctionTool } from '@google/adk';
import { z } from 'zod';
import { fixtureFromScaffoldProps, type ComponentScaffoldInput } from '../../generation/scaffold.js';
import { reactTypeScriptGenerator } from '../../generation/react-generator.js';
import {
  formatFilesWithTargetRepoStyle,
  formatTargetRepoPaths,
} from '../../utils/target-repo-format.js';
import { applyWritePlan } from '../../utils/file-writer.js';
import { assertPascalComponentName } from '../../utils/names.js';
import type { AgentRuntime } from '../runtime.js';

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function createWriterTools(runtime: AgentRuntime): FunctionTool[] {
  const generateScaffold = new FunctionTool({
    name: 'generate_component_scaffold',
    description:
      'REQUIRED: generate a React component under src/components/<kebab>/ (props.ts, Component.tsx, css, index.ts, test) so the approval UI can show a proposal and the host can open a merge request. Always call this before finishing.',
    parameters: z.object({
      pascalName: z.string(),
      description: z.string(),
      rendererJsx: z
        .string()
        .describe(
          'JSX body inside the component. Semantic HTML only: section, headings, p, ul/li, span.badge, span.icon, button. No inline styles. No custom elements.',
        ),
      titleDefault: z.string().optional(),
      props: z
        .array(
          z.object({
            name: z.string(),
            zod: z
              .string()
              .describe(
                'Zod expression as source text, e.g. z.string().min(1) or z.number().',
              ),
            describe: z.string(),
            required: z.boolean().optional(),
            defaultValue: z
              .string()
              .optional()
              .describe('Source text for .default(...), e.g. "\'Summary\'".'),
          }),
        )
        .optional()
        .default([]),
    }),
    execute: async ({ pascalName, description, rendererJsx, titleDefault, props }) => {
      const name = assertPascalComponentName(pascalName);
      const input: ComponentScaffoldInput = {
        pascalName: name,
        description,
        rendererJsx,
        titleDefault,
        props,
      };
      const profile = runtime.state.targetProfile;
      if (!profile || profile.framework !== 'react') {
        return json({
          ok: false,
          error: 'Target framework is not supported. Detect a React target repository before generating.',
        });
      }
      const scaffold = reactTypeScriptGenerator.generate(input, profile);
      // Persist unformatted files first so a Biome failure cannot drop the proposal.
      runtime.state.componentName = name;
      runtime.state.mode = 'scaffold';
      runtime.state.generatedFiles = scaffold.files;

      const fixture = fixtureFromScaffoldProps(input);

      const repo = runtime.state.targetRepoPath;
      let files = scaffold.files;
      let biomeFormatted = false;
      if (repo) {
        try {
          files = await formatFilesWithTargetRepoStyle(repo, scaffold.files);
          runtime.state.generatedFiles = files;
          biomeFormatted = true;
        } catch (error) {
          // Keep scaffold.files already stored on state.
          runtime.emitProgress({
            phase: 'info',
            source: 'studio',
            name: 'generate_component_scaffold',
            label: 'Biome format skipped — using unformatted scaffold',
            detail: error instanceof Error ? error.message : String(error),
          });
        }
      }

      runtime.emitProgress({
        phase: 'done',
        source: 'studio',
        name: 'generate_component_scaffold',
        label: biomeFormatted
          ? 'Scaffold generated + Biome-formatted (the target repo style)'
          : 'Scaffold generated',
        detail: `${Object.keys(files).length} file(s)`,
      });
      return json({
        ok: true,
        kebabName: scaffold.kebabName,
        files: Object.keys(files),
        biomeFormatted,
        fixture,
      });
    },
  });

  const writeFiles = new FunctionTool({
    name: 'write_generated_files',
    description:
      'Write generated component files under src/components/<kebab>/ in the target repo. Honors dry-run. Does not edit catalogs or build config.',
    parameters: z.object({
      files: z
        .record(z.string(), z.string())
        .optional()
        .describe(
          'Relative path → contents. Defaults to the last generate_component_scaffold output.',
        ),
      pascalName: z.string().optional(),
      dryRun: z.boolean().optional(),
    }),
    execute: async ({ files, pascalName, dryRun }) => {
      const repo = runtime.state.targetRepoPath;
      if (!repo) {
        return json({ ok: false, error: 'Target repo path is not set. Set TARGET_REPO_PATH.' });
      }
      const name = assertPascalComponentName(pascalName ?? runtime.state.componentName ?? '');
      const payload = files ?? runtime.state.generatedFiles;
      if (!payload || Object.keys(payload).length === 0) {
        return json({
          ok: false,
          error: 'No generated files to write. Call generate_component_scaffold first.',
        });
      }
      const isDryRun = dryRun ?? runtime.state.dryRun;
      const formatted = await formatFilesWithTargetRepoStyle(repo, payload);
      runtime.state.generatedFiles = formatted;
      const result = applyWritePlan({
        repoPath: repo,
        dryRun: isDryRun,
        files: Object.entries(formatted).map(([relativePath, contents]) => ({
          relativePath,
          contents,
        })),
      });
      const written = [...result.written];
      if (!isDryRun && written.length > 0) {
        await formatTargetRepoPaths(repo, written);
      }
      runtime.state.writtenFiles = [...new Set([...runtime.state.writtenFiles, ...written])];
      runtime.state.dryRun = isDryRun;
      return json({
        ok: true,
        written,
        skipped: result.skipped,
        dryRun: isDryRun,
        repo,
        pascalName: name,
        biomeFormatted: true,
      });
    },
  });

  return [generateScaffold, writeFiles];
}
