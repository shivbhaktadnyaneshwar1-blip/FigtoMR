import {
  InMemorySessionService,
  getFunctionCalls,
  getFunctionResponses,
  isFinalResponse,
  LlmAgent,
  Runner,
} from '@google/adk';
import { requireGeminiConfig, type StudioEnv } from '../config/env.js';
import { logger } from '../utils/logger.js';
import {
  AsyncQueue,
  labelAgentTool,
  summarizeArgs,
  summarizeToolResult,
  type ProgressEvent,
} from './progress.js';
import { createAgentRuntime } from './runtime.js';
import { createRepairTools, type RepairMode } from './tools/repair-tools.js';
import { filterToProposalScope } from '../utils/file-writer.js';
import type { TargetFrontendProfile } from '../target/frontend-profile.js';

export const REPAIR_AGENT_NAME = 'figto_mr_repair';
export const REPAIR_APP_NAME = 'FigtoMRRepair';

const LINT_REPAIR_PROMPT = `
You are FigtoMR's LINT repair agent.

The host already wrote a Figma-generated component. Lint and/or typecheck failed.
This pass is LINT ONLY. Do not fix unrelated tests.

## Rules
- Only edit the current component under src/components/<kebab>/** (and its colocated *.test.ts).
- Do NOT add declare global / JSX IntrinsicElements hacks.
- Use semantic HTML only — no s-* or aui-* custom elements.
- After each fix call run_target_lint. Stop when it passes.
- Never open an MR.
`.trim();

const TEST_REPAIR_PROMPT = `
You are FigtoMR's TEST repair agent for the target repo.

Lint already passed in a separate loop. Scoped unit tests failed.
This pass is TESTS ONLY. Do not restyle components to chase lint.

## Rules
- Fix failing assertions in the current component's colocated test file under src/components/<kebab>/.
- Do NOT edit files outside that component folder.
- Do NOT add \`declare global\` / JSX IntrinsicElements hacks.
- For renderer tests, pass resolved props (schema.parse / buildRendererProps), never an empty object when props are required.
- After each fix call run_target_tests. Stop when it passes.
- Never open an MR.
`.trim();

const BUILD_REPAIR_PROMPT = `
You are FigtoMR's BUILD repair agent for the target repo.

The target repo build failed while compiling the generated React component.
This pass is BUILD ONLY. Do not edit tests. Do not restyle the component to chase the formatter.

## Rules
- Only edit the current component under src/components/<kebab>/**.
- Fix missing imports, bad JSX, and syntax errors in that folder.
- After each fix call run_target_build. Stop when it passes.
- Never open an MR.
`.trim();

function repairPrompt(mode: Exclude<RepairMode, 'visual'>): string {
  if (mode === 'lint') return LINT_REPAIR_PROMPT;
  if (mode === 'build') return BUILD_REPAIR_PROMPT;
  return TEST_REPAIR_PROMPT;
}

function repairLabel(mode: Exclude<RepairMode, 'visual'>): string {
  if (mode === 'lint') return 'Lint';
  if (mode === 'build') return 'Build';
  return 'Test';
}

export type RepairStreamEvent =
  | { type: 'status'; message: string }
  | {
      type: 'tool';
      name?: string;
      label?: string;
      detail?: string;
      phase?: 'start' | 'done' | 'error' | 'info';
      source?: 'agent' | 'figma-mcp' | 'studio';
    }
  | { type: 'agent'; text: string; final?: boolean }
  | { type: 'error'; message: string };

export interface RepairPassInput {
  readonly env: StudioEnv;
  readonly repoPath: string;
  readonly targetProfile: TargetFrontendProfile;
  readonly componentName?: string;
  readonly scopedFiles: readonly string[];
  readonly failureLog: string;
  readonly attempt: number;
  readonly maxAttempts: number;
  /** Lint, catalog build, and tests are separate host loops — this pass only fixes one of them. */
  readonly mode: Exclude<RepairMode, 'visual'>;
  readonly onEvent?: (event: RepairStreamEvent) => void;
}

export interface RepairPassResult {
  readonly ok: boolean;
  readonly written: string[];
  readonly agentText: string;
}

function progressToEvent(event: ProgressEvent): RepairStreamEvent {
  return {
    type: 'tool',
    name: event.name,
    label: event.label,
    detail: event.detail,
    phase: event.phase,
    source: event.source,
  };
}

function emit(input: RepairPassInput, event: RepairStreamEvent): void {
  input.onEvent?.(event);
}

/**
 * One LLM repair pass: read failures, edit allowlisted files, re-check via tools.
 */
export async function runQualityGateRepairPass(
  input: RepairPassInput,
): Promise<RepairPassResult> {
  const env = requireGeminiConfig(input.env);
  const runtime = createAgentRuntime({
    componentName: input.componentName,
    targetRepoPath: input.repoPath,
    dryRun: false,
    env: input.env,
  });
  runtime.state.dryRun = false;
  runtime.state.targetRepoPath = input.repoPath;
  runtime.state.targetProfile = input.targetProfile;
  runtime.state.componentName = input.componentName;
  runtime.state.writtenFiles = filterToProposalScope(
    [...input.scopedFiles],
    input.componentName,
    input.targetProfile,
  );

  const progressQueue = new AsyncQueue<RepairStreamEvent>();
  runtime.setProgressHandler((event) => {
    progressQueue.push(progressToEvent(event));
  });

  const agent = new LlmAgent({
    name: REPAIR_AGENT_NAME,
    model: env.ADK_MODEL,
    description:
      input.mode === 'lint'
        ? 'Fixes the target repo Biome/tsc failures before opening an MR.'
        : input.mode === 'build'
          ? 'Fixes compile errors in the generated component before opening an MR.'
          : 'Fixes the target repo unit test failures before opening an MR.',
    instruction: repairPrompt(input.mode),
    tools: createRepairTools(runtime, input.mode),
  });

  const sessionService = new InMemorySessionService();
  const userId = 'studio-repair';
  const session = await sessionService.createSession({
    appName: REPAIR_APP_NAME,
    userId,
  });
  const runner = new Runner({
    appName: REPAIR_APP_NAME,
    agent,
    sessionService,
  });

  const message = [
    `${repairLabel(input.mode)} repair attempt ${input.attempt}/${input.maxAttempts}.`,
    `the target repo repo: ${input.repoPath}`,
    input.componentName ? `Component: ${input.componentName}` : undefined,
    `Files in scope:\n${input.scopedFiles.map((f) => `- ${f}`).join('\n') || '(none listed)'}`,
    '',
    input.mode === 'lint'
      ? 'Lint/type failures to fix (do not run or edit tests for assertion failures):'
      : input.mode === 'build'
        ? 'Build failures to fix in the component folder. Do not edit tests:'
        : 'Unit test failures to fix in the component folder:',
    '```',
    input.failureLog.slice(0, 10_000),
    '```',
    '',
    input.mode === 'lint'
      ? 'Use read_target_file / write_target_file / run_target_lint until lint passes.'
      : input.mode === 'build'
        ? 'Use read_target_file / write_target_file / run_target_build until the build passes.'
        : 'Use read_target_file / write_target_file / run_target_tests until tests pass.',
  ]
    .filter(Boolean)
    .join('\n');

  emit(input, {
    type: 'status',
    message: `${input.mode === 'lint' ? 'Lint' : 'Test'} repair attempt ${input.attempt}/${input.maxAttempts}…`,
  });

  let agentText = '';
  try {
    const adkStream = runner.runAsync({
      userId,
      sessionId: session.id,
      newMessage: { role: 'user', parts: [{ text: message }] },
    });

    const adkIter = adkStream[Symbol.asyncIterator]();
    let adkPending = adkIter.next();
    let progPending = progressQueue.next();
    let progOpen = true;

    while (true) {
      if (!progOpen) {
        const result = await adkPending;
        if (result.done) break;
        handleAdkEvent(result.value, input, (text) => {
          agentText = text;
        });
        adkPending = adkIter.next();
        continue;
      }

      const winner = await Promise.race([
        adkPending.then((result) => ({ kind: 'adk' as const, result })),
        progPending.then((result) => ({ kind: 'prog' as const, result })),
      ]);

      if (winner.kind === 'prog') {
        if (winner.result.done) {
          progOpen = false;
          continue;
        }
        if (winner.result.value) {
          emit(input, winner.result.value);
        }
        progPending = progressQueue.next();
        continue;
      }

      if (winner.result.done) {
        progressQueue.close();
        while (progOpen) {
          const left = await progPending;
          if (left.done) {
            progOpen = false;
            break;
          }
          if (left.value) emit(input, left.value);
          progPending = progressQueue.next();
        }
        break;
      }

      handleAdkEvent(winner.result.value, input, (text) => {
        agentText = text;
      });
      adkPending = adkIter.next();
    }

    logger.info(
      `${input.mode} repair pass ${input.attempt} finished (agent turn complete — host will re-check ${input.mode} only). ` +
        `In-scope files: ${runtime.state.writtenFiles.length}.`,
    );
    return {
      ok: true,
      written: [...runtime.state.writtenFiles],
      agentText: agentText.trim(),
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    emit(input, { type: 'error', message: msg });
    return {
      ok: false,
      written: [...runtime.state.writtenFiles],
      agentText: agentText.trim() || msg,
    };
  } finally {
    progressQueue.close();
    runtime.setProgressHandler(undefined);
    try {
      await runtime.mcp.close();
    } catch {
      // unused
    }
  }
}

function handleAdkEvent(
  event: Parameters<typeof getFunctionCalls>[0],
  input: RepairPassInput,
  setText: (text: string) => void,
): void {
  const chunk =
    event.content?.parts?.map((part) => ('text' in part ? (part.text ?? '') : '')).join('') ?? '';
  if (chunk) {
    if (isFinalResponse(event)) {
      setText(chunk);
    }
    emit(input, { type: 'agent', text: chunk, final: isFinalResponse(event) });
  }

  for (const call of getFunctionCalls(event)) {
    const args =
      call.args && typeof call.args === 'object'
        ? (call.args as Record<string, unknown>)
        : undefined;
    emit(input, {
      type: 'tool',
      name: call.name,
      label: labelAgentTool(call.name ?? 'tool'),
      detail: summarizeArgs(args),
      phase: 'start',
      source: 'agent',
    });
  }

  for (const response of getFunctionResponses(event)) {
    emit(input, {
      type: 'tool',
      name: response.name,
      label: labelAgentTool(response.name ?? 'tool'),
      detail: summarizeToolResult(response.response),
      phase: 'done',
      source: 'agent',
    });
  }
}
