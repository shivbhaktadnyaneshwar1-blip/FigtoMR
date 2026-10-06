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
import { toKebabCase } from '../utils/names.js';
import {
  AsyncQueue,
  labelAgentTool,
  summarizeArgs,
  summarizeToolResult,
  type ProgressEvent,
} from './progress.js';
import { createAgentRuntime } from './runtime.js';
import { createRepairTools } from './tools/repair-tools.js';
import type { TargetFrontendProfile } from '../target/frontend-profile.js';
import { filterToProposalScope } from '../utils/file-writer.js';

export const REFINE_AGENT_NAME = 'figto_mr_refine';
export const REFINE_APP_NAME = 'FigtoMRRefine';

const REFINE_PROMPT = `
You are FigtoMR's visual refine agent.

You close the gap between the Figma design and the current preview render.
Each pass MUST make the preview **closer** to Figma — never farther. Prefer tiny surgical diffs over rewrites.

You MUST follow this loop order on every visual-compare turn — do not skip steps:

## Mandatory sequence (visual compare)
1. **CURRENT** — Read the component TSX, CSS, and props as needed.
2. **MISSING** — Compare FIGMA vs PLAYGROUND images. List concrete residual gaps only — include **data mismatches** (wrong title, wrong numbers, placeholder copy) as well as chrome/layout.
3. **DEVELOP** — Edit allowlisted files with **minimal** changes. Use semantic HTML + CSS classes only (no custom elements).
4. **MATCH** — End with exactly one of:
   VISUAL_MATCH: true
   VISUAL_MATCH: false
   true only when playground is a close visual match (minor pixel diffs OK).

When VISUAL_MATCH is false, you MUST also emit a MISSING block (before the VISUAL_MATCH line) as a short bullet list of what still diverges, e.g.:
MISSING:
- title shows wrong copy vs Figma
- KPI "Notices handled" value is not 34
- feature rows lack check-circle icons
- CTA is not full-width primary

## Convergence rules (critical)
- Preserve layout/copy/structure that already matches Figma.
- **Match Figma data**, not placeholders: titles, CTA labels, badge text, prices, fee lines, feature bullets, KPI captions/values/deltas, chart category labels must match what is visible in FIGMA (and any FIGMA_DATA hints from the host).
- Update fixture props and colocated test data together. Do not leave "Metric 1", sample prices, or empty chartLabels when Figma shows real values.
- Fix at most 2–3 gaps per pass; leave the rest for the next iteration.
- If unsure whether a change helps, write nothing and set VISUAL_MATCH: false with the MISSING list.
- Never swap a pricing/action card for KPI/chart chrome (or the reverse) unless FIGMA clearly shows that pattern.
- Never invent SVG icons or non-semantic custom elements to "improve" the design.
- Chart *series numbers* may stay approximate when Figma does not show exact bar heights — but axis/category labels and all readable copy/numbers must match.

## Rules
- Only edit this component's allowlisted files under the detected component root (normally \`src/components/<kebab>/**\`).
- Use semantic HTML only. Do not invent design-system tags or inline SVG icons.
- Keep layout CSS in the component .css file when needed.
- Never use Figma layer names (Dialog, Contents, Background close) as UI copy.
- Do NOT chase lint/type/test failures — Approve/MR owns those gates.
- Skip quality gates in visual mode.
- Never open an MR — the host owns git / push.

## Chat refine (no screenshots)
Read current files → apply the user request with semantic HTML and CSS → stop. Prefer surgical edits.
`.trim();

export type RefineImageAttachment = {
  readonly label: string;
  readonly mimeType: string;
  readonly dataUrl: string;
};

export type RefineStreamEvent =
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

export interface RefinePassInput {
  readonly env: StudioEnv;
  readonly repoPath: string;
  readonly targetProfile: TargetFrontendProfile;
  readonly componentName: string;
  readonly userMessage: string;
  readonly figmaUrl?: string;
  readonly scopedFiles: readonly string[];
  readonly images?: readonly RefineImageAttachment[];
  readonly onEvent?: (event: RefineStreamEvent) => void;
}

export interface RefinePassResult {
  readonly ok: boolean;
  readonly written: string[];
  readonly agentText: string;
  readonly visualMatch?: boolean;
  readonly gaps: readonly string[];
}

function emit(input: RefinePassInput, event: RefineStreamEvent): void {
  input.onEvent?.(event);
}

function progressToEvent(event: ProgressEvent): RefineStreamEvent {
  return {
    type: 'tool',
    name: event.name,
    label: event.label,
    detail: event.detail,
    phase: event.phase,
    source: event.source,
  };
}

function dataUrlToInlinePart(attachment: RefineImageAttachment): {
  text?: string;
  inlineData?: { mimeType: string; data: string };
} {
  const raw = attachment.dataUrl.includes(',')
    ? attachment.dataUrl.slice(attachment.dataUrl.indexOf(',') + 1)
    : attachment.dataUrl;
  return {
    inlineData: {
      mimeType: attachment.mimeType || 'image/png',
      data: raw,
    },
  };
}

export function parseVisualMatch(agentText: string): boolean | undefined {
  const match = /VISUAL_MATCH:\s*(true|false)/i.exec(agentText);
  if (!match) return undefined;
  return match[1]!.toLowerCase() === 'true';
}

/**
 * Extract concrete Figma vs playground gaps from the refine agent's MISSING block.
 */
export function parseVisualGaps(agentText: string): string[] {
  const text = agentText.trim();
  if (!text) return [];

  const block =
    /(?:^|\n)\s*(?:MISSING|GAPS)\s*[:\-]\s*\n([\s\S]*?)(?=\n\s*(?:DEVELOP|MATCH|VISUAL_MATCH)\b|$)/i.exec(
      text,
    )?.[1] ??
    /(?:^|\n)\s*(?:MISSING|GAPS)\s*[:\-]\s*(.+?)(?=\n\s*VISUAL_MATCH\b|$)/is.exec(text)?.[1];

  const blockLines = (block ?? '').split(/\n/);
  const bulletLines = blockLines.filter((line) => /^\s*[-*•]/.test(line));
  const rawLines = (bulletLines.length > 0 ? bulletLines : blockLines)
    .flatMap((line) => line.split(/[;|]/))
    .map((line) => line.replace(/^[-*•\d.)\s]+/, '').trim())
    .filter((line) => line.length >= 4 && line.length <= 160)
    .filter((line) => !/^VISUAL_MATCH\b/i.test(line));

  if (rawLines.length > 0) {
    return [...new Set(rawLines)].slice(0, 8);
  }

  // Fallback: single-line "GAPS: a; b; c"
  const inline = /(?:MISSING|GAPS)\s*[:\-]\s*(.+)/i.exec(text)?.[1];
  if (inline) {
    return [
      ...new Set(
        inline
          .split(/[;\n|]/)
          .map((part) => part.replace(/^[-*•\s]+/, '').trim())
          .filter((part) => part.length >= 4 && part.length <= 120),
      ),
    ].slice(0, 8);
  }

  return [];
}

/** Short copy for AI Processing when compare says not matching. */
export function formatVisualMismatchSummary(input: {
  readonly iteration: number;
  readonly maxIterations: number;
  readonly gaps: readonly string[];
  readonly willRetry: boolean;
}): { headline: string; detail: string; thoughts: string[] } {
  const gapText =
    input.gaps.length > 0
      ? input.gaps.slice(0, 5).join('; ')
      : 'Visible layout/chrome still differs from Figma';
  const headline = input.willRetry
    ? `Not matching with Figma — retrying (${input.iteration}/${input.maxIterations})`
    : `Not matching with Figma after ${input.iteration} pass(es)`;
  return {
    headline,
    detail: gapText,
    thoughts: [
      headline,
      ...input.gaps.slice(0, 4).map((gap) => `Gap: ${gap}`),
      input.willRetry ? 'Asking design system MCP + patching again…' : 'Stopping visual loop — refine in chat or Approve.',
    ],
  };
}

/** One refine turn — optional multimodal screenshots for visual compare. */
export async function runRefinePass(input: RefinePassInput): Promise<RefinePassResult> {
  const env = requireGeminiConfig(input.env);
  const kebab = toKebabCase(input.componentName);
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
  runtime.state.writtenFiles = filterToProposalScope([...input.scopedFiles], input.componentName);

  const progressQueue = new AsyncQueue<RefineStreamEvent>();
  runtime.setProgressHandler((event) => {
    progressQueue.push(progressToEvent(event));
  });

  const agent = new LlmAgent({
    name: REFINE_AGENT_NAME,
    model: env.ADK_MODEL,
    description: 'Visual refine: read component → gaps vs Figma → patch HTML/CSS → VISUAL_MATCH.',
    instruction: REFINE_PROMPT,
    tools: [...createRepairTools(runtime, 'visual')],
  });

  const sessionService = new InMemorySessionService();
  const userId = 'studio-refine';
  const session = await sessionService.createSession({
    appName: REFINE_APP_NAME,
    userId,
  });
  const runner = new Runner({
    appName: REFINE_APP_NAME,
    agent,
    sessionService,
  });

  const hasImages = (input.images?.length ?? 0) > 0;
  const message = [
    hasImages
      ? `Visual compare refine for ${input.componentName} (folder ${kebab}):`
      : `User refine request for ${input.componentName} (folder ${kebab}):`,
    input.userMessage.trim(),
    '',
    `Target repo: ${input.repoPath}`,
    input.figmaUrl ? `Original Figma: ${input.figmaUrl}` : undefined,
    `Files in scope:\n${input.scopedFiles.map((f) => `- ${f}`).join('\n') || '(discover via read)'}`,
    '',
    hasImages
      ? [
          'Attached images (in order):',
          ...(input.images ?? []).map((img, i) => `${i + 1}. ${img.label}`),
          'Follow: CURRENT → MISSING → DEVELOP (semantic HTML/CSS) → VISUAL_MATCH: true|false.',
          'Do not invent SVG-heavy widgets. Do not run lint/tests.',
        ].join('\n')
      : 'Read current files → patch JSX/CSS to match Figma. Do not run lint.',
    'Only use tools from your tool list — never invent python_interpreter or similar.',
  ]
    .filter(Boolean)
    .join('\n');

  const parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [
    { text: message },
  ];
  for (const image of input.images ?? []) {
    parts.push({ text: `\n[${image.label}]` });
    parts.push(dataUrlToInlinePart(image));
  }

  emit(input, {
    type: 'status',
    message: hasImages ? 'Comparing Figma vs playground and refining…' : 'Applying chat refine…',
  });

  let agentText = '';
  try {
    const adkStream = runner.runAsync({
      userId,
      sessionId: session.id,
      newMessage: { role: 'user', parts },
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
        if (winner.result.value) emit(input, winner.result.value);
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

    const visualMatch = parseVisualMatch(agentText);
    const gaps = parseVisualGaps(agentText);
    logger.info(
      `Refine pass finished for ${input.componentName}; written=${runtime.state.writtenFiles.length}` +
        (visualMatch === undefined ? '' : `; visualMatch=${visualMatch}`) +
        (gaps.length ? `; gaps=${gaps.length}` : ''),
    );
    return {
      ok: true,
      written: [...runtime.state.writtenFiles],
      agentText: agentText.trim(),
      visualMatch,
      gaps,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    emit(input, { type: 'error', message: msg });
    return {
      ok: false,
      written: [...runtime.state.writtenFiles],
      agentText: agentText.trim() || msg,
      gaps: parseVisualGaps(agentText),
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
  input: RefinePassInput,
  setText: (text: string) => void,
): void {
  const chunk =
    event.content?.parts?.map((part) => ('text' in part ? (part.text ?? '') : '')).join('') ?? '';
  if (chunk) {
    if (isFinalResponse(event)) setText(chunk);
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
