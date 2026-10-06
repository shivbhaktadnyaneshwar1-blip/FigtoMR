import {
  InMemorySessionService,
  getFunctionCalls,
  getFunctionResponses,
  isFinalResponse,
  Runner,
} from '@google/adk';
import { resolveTargetRepoPath, studioPreviewUrl } from '../config/env.js';
import {
  composeHostScaffold,
  hasCustomComponentScaffold,
  isPlaceholderRenderer,
} from '../generation/figma-scaffold.js';
import { reactTypeScriptGenerator } from '../generation/react-generator.js';
import {
  assertSupportedFrontendProfile,
  buildPreviewDeepLink,
  profileFromEnv,
} from '../target/frontend-profile.js';
import { saveProposal, proposalPublicView } from '../server/proposal-store.js';
import { buildProposedChanges } from '../server/apply-proposal.js';
import { streamStageProposal } from '../server/stage-proposal.js';
import { streamVisualCompareLoop } from '../server/compare-loop.js';
import { APP_NAME, createFigtoMRAgent } from './agent.js';
import {
  AsyncQueue,
  labelAgentTool,
  summarizeArgs,
  summarizeToolResult,
  type ProgressEvent,
} from './progress.js';
import { createAgentRuntime, type AgentRuntime } from './runtime.js';
import { summarizeState } from './state.js';
import { toPascalCase } from '../utils/names.js';

export interface PrefetchedFigma {
  readonly designText?: string;
  readonly screenshot?: {
    readonly mimeType: string;
    readonly dataUrl: string;
    readonly byteLength: number;
    readonly fileKey?: string;
    readonly nodeId?: string;
    readonly capturedAt?: string;
  };
}

export interface RunAgentInput {
  readonly message: string;
  readonly figmaUrl?: string;
  readonly componentName?: string;
  readonly targetRepoPath?: string;
  readonly dryRun?: boolean;
  /** When true (default for UI), never write/MR — emit a proposal for user approval. */
  readonly previewOnly?: boolean;
  readonly createMr?: boolean;
  readonly userId?: string;
  readonly sessionId?: string;
  /**
   * Human-in-the-loop: Figma already inspected + user-confirmed.
   * Seeds runtime state and skips re-inspect / re-emitting the confirm screenshot.
   */
  readonly prefetchedFigma?: PrefetchedFigma;
  /**
   * Skip the ADK tool-calling agent — compose HTML/CSS scaffold from design text immediately.
   * Used after Figma confirm for fast first paint.
   */
  readonly hostFirst?: boolean;
  /**
   * After staging, run the LLM visual-compare loop vs Figma screenshot.
   * Default true for host-first continue; false for CLI/tests that only need a scaffold.
   */
  readonly autoCompare?: boolean;
  /** Max visual-compare iterations when autoCompare is on (default 3). */
  readonly compareMaxIterations?: number;
}

export interface RunAgentResult {
  readonly text: string;
  readonly stateSummary: string;
  readonly mrUrl?: string;
  readonly proposalId?: string;
}

export type StudioStreamEvent =
  | { type: 'status'; message: string }
  | { type: 'agent'; text: string; final?: boolean }
  | {
      type: 'tool';
      name?: string;
      detail?: string;
      phase?: 'start' | 'done' | 'error' | 'info';
      source?: 'agent' | 'figma-mcp' | 'studio';
      label?: string;
    }
  | { type: 'error'; message: string }
  | {
      type: 'figma_screenshot';
      mimeType?: string;
      dataUrl: string;
      byteLength?: number;
      fileKey?: string;
      nodeId?: string;
      capturedAt?: string;
    }
  | {
      type: 'proposal';
      proposalId: string;
      componentName?: string;
      mode?: string;
      createMr: boolean;
      targetRepoPath: string;
      playgroundUrl?: string;
      playgroundVariantPath?: string;
      playgroundVariantContents?: string;
      figmaScreenshot?: {
        mimeType: string;
        dataUrl: string;
        byteLength: number;
        fileKey?: string;
        nodeId?: string;
        capturedAt?: string;
      };
      files: Array<{
        path: string;
        action: 'create' | 'update';
        summary?: string;
        contents: string;
        bytes: number;
      }>;
      agentText: string;
    }
  | {
      type: 'done';
      text: string;
      stateSummary: string;
      mrUrl?: string;
      branchName?: string;
      dryRun: boolean;
      proposalId?: string;
      awaitingApproval?: boolean;
      sessionId?: string;
      pendingId?: string;
      awaitingFigmaConfirm?: boolean;
    }
  | {
      type: 'awaiting_figma_confirm';
      pendingId: string;
      figmaUrl: string;
      componentName?: string;
      hasScreenshot: boolean;
      message: string;
    }
  | {
      type: 'staged';
      proposalId: string;
      written: string[];
      sessionId: string;
      playgroundUrl: string;
      playgroundReachable: boolean;
      playgroundStarted: boolean;
    }
  | {
      type: 'playground_screenshot';
      mimeType?: string;
      dataUrl: string;
      byteLength?: number;
      url?: string;
      capturedAt?: string;
      iteration?: number;
    }
  | {
      type: 'compare_iteration';
      iteration: number;
      maxIterations: number;
      visualMatch?: boolean;
      written: string[];
      gaps?: readonly string[];
      mismatchSummary?: string;
      files?: Array<{
        path: string;
        action: 'create' | 'update';
        summary?: string;
        contents: string;
        bytes: number;
      }>;
    }
  | {
      type: 'compare_result';
      ok: boolean;
      matched: boolean;
      iterations: number;
      written: string[];
      playgroundUrl: string;
      agentText?: string;
      gaps?: readonly string[];
      mismatchSummary?: string;
      files?: Array<{
        path: string;
        action: 'create' | 'update';
        summary?: string;
        contents: string;
        bytes: number;
      }>;
    };

function buildUserMessage(input: RunAgentInput): string {
  const lines = [input.message];
  if (input.figmaUrl) {
    lines.push(`Figma URL: ${input.figmaUrl}`);
  }
  if (input.componentName) {
    lines.push(`Target component name: ${input.componentName}`);
  }
  if (input.targetRepoPath) {
    lines.push(`Target repo path: ${input.targetRepoPath}`);
  }
  lines.push('Dry run: yes — do NOT write files to disk. The host will show a proposal for user approval.');
  if (input.prefetchedFigma) {
    lines.push(
      'Figma was already inspected and confirmed by the user. Design context + screenshot are already in host state.',
    );
    lines.push(
      'Do NOT call inspect_figma_node or parse_figma_url again — skip straight to scaffolding.',
    );
  } else {
    lines.push(
      'Call inspect_figma_node with includeScreenshot=true before scaffolding.',
    );
  }
  lines.push(
    'MANDATORY: Call generate_component_scaffold before you finish. The Studio approval UI has no files without it.',
  );
  lines.push(
    'You MAY call write_generated_files with dryRun=true to confirm the plan, but never dryRun=false.',
  );
  if (input.createMr) {
    lines.push(
      'After approval the host commits src/components/<kebab>/ and opens a merge request. Do not register a catalog.',
    );
  }
  return lines.join('\n');
}

function extractEventText(event: {
  content?: { parts?: Array<{ text?: string | null }> } | null;
}): string {
  return event.content?.parts?.map((part) => part.text ?? '').join('') ?? '';
}

function progressToStreamEvent(event: ProgressEvent): StudioStreamEvent {
  if (event.imageDataUrl) {
    return {
      type: 'figma_screenshot',
      dataUrl: event.imageDataUrl,
      mimeType: event.detail?.includes('image/')
        ? event.detail.split('·').pop()?.trim()
        : undefined,
      byteLength: undefined,
    };
  }
  return {
    type: 'tool',
    name: event.name,
    label: event.label,
    detail: event.detail,
    phase: event.phase,
    source: event.source,
  };
}

function* eventsFromAdkEvent(event: Parameters<typeof getFunctionCalls>[0]): Generator<StudioStreamEvent> {
  const chunk = extractEventText(event);
  if (chunk) {
    yield { type: 'agent', text: chunk, final: isFinalResponse(event) };
  }

  for (const call of getFunctionCalls(event)) {
    const args =
      call.args && typeof call.args === 'object'
        ? (call.args as Record<string, unknown>)
        : undefined;
    yield {
      type: 'tool',
      name: call.name,
      label: labelAgentTool(call.name ?? 'tool'),
      detail: summarizeArgs(args),
      phase: 'start',
      source: 'agent',
    };
  }

  for (const response of getFunctionResponses(event)) {
    yield {
      type: 'tool',
      name: response.name,
      label: labelAgentTool(response.name ?? 'tool'),
      detail: summarizeToolResult(response.response),
      phase: 'done',
      source: 'agent',
    };
  }
}

/**
 * Merge ADK events with live MCP progress so the UI updates while long
 * Figma tool calls are still in flight.
 */
async function* mergeAdkAndProgress(
  adkEvents: AsyncIterable<Parameters<typeof getFunctionCalls>[0]>,
  progress: AsyncQueue<StudioStreamEvent>,
): AsyncGenerator<StudioStreamEvent> {
  const adkIter = adkEvents[Symbol.asyncIterator]();
  let adkPending = adkIter.next();
  let progPending = progress.next();
  let progOpen = true;

  while (true) {
    if (!progOpen) {
      const result = await adkPending;
      if (result.done) {
        break;
      }
      yield* eventsFromAdkEvent(result.value);
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
        yield winner.result.value;
      }
      progPending = progress.next();
      continue;
    }

    if (winner.result.done) {
      progress.close();
      while (progOpen) {
        const left = await progPending;
        if (left.done) {
          progOpen = false;
          break;
        }
        if (left.value) {
          yield left.value;
        }
        progPending = progress.next();
      }
      break;
    }

    yield* eventsFromAdkEvent(winner.result.value);
    adkPending = adkIter.next();
  }
}

export async function* streamFigtoMRAgent(
  input: RunAgentInput,
): AsyncGenerator<StudioStreamEvent> {
  const createMrIntent = Boolean(input.createMr);
  // Preview-first: never write or open MR in the generate pass.
  const previewOnly = input.previewOnly !== false;
  const dryRun = true;

  const runtime: AgentRuntime = createAgentRuntime({
    figmaUrl: input.figmaUrl,
    componentName: input.componentName,
    targetRepoPath: input.targetRepoPath,
    dryRun,
  });

  const progressQueue = new AsyncQueue<StudioStreamEvent>();
  runtime.setProgressHandler((event) => {
    progressQueue.push(progressToStreamEvent(event));
  });

  const prefetched = input.prefetchedFigma;
  if (prefetched?.designText) {
    runtime.state.figmaDesignText = prefetched.designText;
  }
  if (prefetched?.screenshot) {
    runtime.state.figmaScreenshot = {
      mimeType: prefetched.screenshot.mimeType,
      dataUrl: prefetched.screenshot.dataUrl,
      byteLength: prefetched.screenshot.byteLength,
      source: 'base64',
      tool: 'get_screenshot',
      fileKey: prefetched.screenshot.fileKey,
      nodeId: prefetched.screenshot.nodeId,
      capturedAt: prefetched.screenshot.capturedAt,
    };
  }

  let text = '';
  try {
    yield { type: 'status', message: 'Preparing the target repo…' };
    const repoPath = resolveTargetRepoPath(runtime.env);
    const profile = profileFromEnv(repoPath, runtime.env);
    assertSupportedFrontendProfile(profile);
    runtime.state.targetRepoPath = repoPath;
    runtime.state.targetProfile = profile;
    yield {
      type: 'status',
      message: `Detected ${profile.framework} target (${profile.componentRoot}).`,
    };

    if (input.hostFirst) {
      const fallbackName = toPascalCase(
        runtime.state.componentName ?? input.componentName ?? 'FigmaComponent',
      );
      const designText = runtime.state.figmaDesignText ?? '';
      yield {
        type: 'status',
        message: 'Building host scaffold from Figma (semantic HTML + CSS)…',
      };
      const composed = composeHostScaffold(fallbackName, designText);
      yield {
        type: 'tool',
        name: 'compose_host_scaffold',
        label: composed.description,
        phase: 'done',
        source: 'studio',
        detail: composed.pascalName,
      };
      const scaffold = reactTypeScriptGenerator.generate(composed, profile);
      runtime.state.componentName = fallbackName;
      runtime.state.mode = 'scaffold';
      runtime.state.generatedFiles = scaffold.files;
      text = `Host scaffold for ${fallbackName} — visual compare will refine vs Figma.`;
    } else {
      yield {
        type: 'status',
        message: prefetched
          ? 'Figma confirmed — starting React component scaffold…'
          : 'Starting Figma → React agent (preview — no writes until you Approve)…',
      };
      const agent = createFigtoMRAgent(runtime);
      const sessionService = new InMemorySessionService();
      const userId = input.userId ?? 'studio-ui';
      const session = await sessionService.createSession({
        appName: APP_NAME,
        userId,
        sessionId: input.sessionId,
      });
      const runner = new Runner({
        appName: APP_NAME,
        agent,
        sessionService,
      });

      const adkStream = runner.runAsync({
        userId,
        sessionId: session.id,
        newMessage: {
          role: 'user',
          parts: [{ text: buildUserMessage({ ...input, dryRun }) }],
        },
      });

      for await (const event of mergeAdkAndProgress(adkStream, progressQueue)) {
        if (event.type === 'agent' && event.text) {
          text = event.final ? event.text : text || event.text;
        }
        yield event;
      }

      // Studio requires a scaffold proposal. If the model skipped the tool, force one more turn.
      if (previewOnly && Object.keys(runtime.state.generatedFiles ?? {}).length === 0) {
        yield {
          type: 'status',
          message: 'No scaffold yet — requiring generate_component_scaffold…',
        };
        const nudgeName =
          runtime.state.componentName ??
          input.componentName ??
          'FigmaComponent';
        const nudgeProgress = new AsyncQueue<StudioStreamEvent>();
        runtime.setProgressHandler((event) => {
          nudgeProgress.push(progressToStreamEvent(event));
        });
        const nudgeStream = runner.runAsync({
          userId,
          sessionId: session.id,
          newMessage: {
            role: 'user',
            parts: [
              {
                text: [
                  'STOP. You finished without calling generate_component_scaffold.',
                  'The Studio approval UI cannot show files without it.',
                  `Call generate_component_scaffold NOW with pascalName="${nudgeName}" (or a better PascalCase name from the Figma node),`,
                  'a short description, and rendererJsx that reproduces the Figma screenshot with semantic HTML + CSS classes only.',
                  'Use headings, lists, span.badge, span.icon, and <button type="button" className="primary">.',
                  'Never emit the placeholder sentence. No s-* or aui-* custom elements.',
                  'Then call validate_component_scaffold. Do not write to disk.',
                ].join(' '),
              },
            ],
          },
        });
        try {
          for await (const event of mergeAdkAndProgress(nudgeStream, nudgeProgress)) {
            if (event.type === 'agent' && event.text) {
              text = event.final ? event.text : text || event.text;
            }
            yield event;
          }
        } finally {
          nudgeProgress.close();
          runtime.setProgressHandler((event) => {
            progressQueue.push(progressToStreamEvent(event));
          });
        }
      }
    }

    let generatedFiles = runtime.state.generatedFiles ?? {};
    let proposed = buildProposedChanges({
      repoPath,
      generatedFiles,
      componentName: runtime.state.componentName ?? input.componentName,
      componentRoot: profile.componentRoot,
    });

    const renderSource = Object.entries(generatedFiles).find(
      ([path]) => path.endsWith('/render.tsx') || /\/src\/components\/[^/]+\/.+\.tsx$/.test(path),
    )?.[1];
    // A proposal with no real component sources still needs a host scaffold.
    const needsHostScaffold =
      previewOnly &&
      !input.hostFirst &&
      (!hasCustomComponentScaffold(generatedFiles) ||
        (renderSource !== undefined && isPlaceholderRenderer(renderSource)));

    if (needsHostScaffold) {
      const fallbackName = toPascalCase(
        runtime.state.componentName ?? input.componentName ?? 'FigmaComponent',
      );
      const composed = composeHostScaffold(fallbackName, runtime.state.figmaDesignText ?? '');
      yield {
        type: 'status',
        message: `Host scaffold from Figma (${composed.description}).`,
      };
      const scaffold = reactTypeScriptGenerator.generate(composed, profile);
      runtime.state.componentName = fallbackName;
      runtime.state.mode = 'scaffold';
      runtime.state.generatedFiles = scaffold.files;
      generatedFiles = scaffold.files;
      proposed = buildProposedChanges({
        repoPath,
        generatedFiles,
        componentName: fallbackName,
        componentRoot: profile.componentRoot,
      });
    }

    if (previewOnly && !hasCustomComponentScaffold(generatedFiles)) {
      yield {
        type: 'error',
        message:
          'No React component scaffold was produced. Re-run generate.',
      };
      yield {
        type: 'done',
        text: text.trim() || 'Scaffold missing',
        stateSummary: summarizeState(runtime.state),
        dryRun: true,
        awaitingApproval: false,
      };
      return;
    }

    if (previewOnly && proposed.length > 0) {
      const componentName = runtime.state.componentName ?? input.componentName;
      const playgroundUrl = componentName
        ? buildPreviewDeepLink(studioPreviewUrl(runtime.env), profile, componentName)
        : undefined;
      const shot = runtime.state.figmaScreenshot;
      // Don't re-emit the confirm screenshot after HITL — user already approved the frame.
      if (shot && !prefetched) {
        yield {
          type: 'figma_screenshot',
          dataUrl: shot.dataUrl,
          mimeType: shot.mimeType,
          byteLength: shot.byteLength,
          fileKey: shot.fileKey,
          nodeId: shot.nodeId,
        };
      }
      const proposal = saveProposal({
        figmaUrl: input.figmaUrl,
        componentName,
        mode: runtime.state.mode,
        createMr: createMrIntent,
        targetRepoPath: repoPath,
        targetProfile: profile,
        agentText: text.trim(),
        files: proposed,
        playgroundUrl,
        figmaDesignText: runtime.state.figmaDesignText,
        figmaScreenshot: shot
          ? {
              mimeType: shot.mimeType,
              dataUrl: shot.dataUrl,
              byteLength: shot.byteLength,
              fileKey: shot.fileKey,
              nodeId: shot.nodeId,
              capturedAt: shot.capturedAt,
            }
          : undefined,
        env: runtime.env,
      });
      const view = proposalPublicView(proposal);
      yield {
        type: 'status',
        message: `Proposal ready — staging locally into the target repo for playground + chat refine…`,
      };
      if (playgroundUrl) {
        yield {
          type: 'status',
          message: `Playground target: ${playgroundUrl}`,
        };
      }
      yield {
        type: 'proposal',
        proposalId: view.id,
        componentName: view.componentName,
        mode: view.mode,
        createMr: view.createMr,
        targetRepoPath: view.targetRepoPath,
        playgroundUrl: view.playgroundUrl,
        figmaScreenshot: view.figmaScreenshot,
        files: view.files,
        agentText: view.agentText,
      };

      // Write to local the target repo, start playground if needed, open refine chat,
      // and capture a playground screenshot for Figma compare — before Approve/MR.
      let sessionId: string | undefined;
      try {
        for await (const stageEvent of streamStageProposal({
          proposalId: view.id,
          env: runtime.env,
          captureScreenshot: true,
        })) {
          if (stageEvent.type === 'status') {
            yield { type: 'status', message: stageEvent.message };
          } else if (stageEvent.type === 'tool') {
            yield {
              type: 'tool',
              name: stageEvent.name,
              label: stageEvent.label,
              detail: stageEvent.detail,
              phase: stageEvent.phase,
              source: stageEvent.source ?? 'studio',
            };
          } else if (stageEvent.type === 'error') {
            yield { type: 'error', message: stageEvent.message };
          } else if (stageEvent.type === 'playground_screenshot') {
            yield {
              type: 'playground_screenshot',
              mimeType: stageEvent.mimeType,
              dataUrl: stageEvent.dataUrl,
              byteLength: stageEvent.byteLength,
              url: stageEvent.url,
              capturedAt: stageEvent.capturedAt,
            };
          } else if (stageEvent.type === 'staged') {
            sessionId = stageEvent.sessionId;
            yield {
              type: 'staged',
              proposalId: stageEvent.proposalId,
              written: stageEvent.written,
              sessionId: stageEvent.sessionId,
              playgroundUrl: stageEvent.playgroundUrl,
              playgroundReachable: stageEvent.playgroundReachable,
              playgroundStarted: stageEvent.playgroundStarted,
            };
          }
        }
      } catch (stageError) {
        yield {
          type: 'error',
          message: `Local stage failed: ${
            stageError instanceof Error ? stageError.message : String(stageError)
          }`,
        };
      }

      // After host scaffold (or agent), loop Figma screenshot ↔ playground until visual match.
      const shouldCompare = input.autoCompare !== false && Boolean(sessionId && shot?.dataUrl);
      const compareMax = Math.max(1, Math.min(4, input.compareMaxIterations ?? 3));
      if (shouldCompare && sessionId && shot?.dataUrl) {
        yield {
          type: 'status',
          message: `Visual match loop vs Figma (max ${compareMax} iters, HTML/CSS tags only)…`,
        };
        try {
          for await (const cmp of streamVisualCompareLoop({
            sessionId,
            env: runtime.env,
            figmaScreenshot: {
              mimeType: shot.mimeType,
              dataUrl: shot.dataUrl,
              byteLength: shot.byteLength,
              capturedAt: shot.capturedAt,
            },
            maxIterations: compareMax,
            designText: runtime.state.figmaDesignText,
          })) {
            if (cmp.type === 'status') {
              yield { type: 'status', message: cmp.message };
            } else if (cmp.type === 'tool') {
              yield {
                type: 'tool',
                name: cmp.name,
                label: cmp.label,
                detail: cmp.detail,
                phase: cmp.phase,
                source: cmp.source ?? 'studio',
              };
            } else if (cmp.type === 'agent') {
              yield { type: 'agent', text: cmp.text, final: cmp.final };
            } else if (cmp.type === 'error') {
              yield { type: 'error', message: cmp.message };
            } else if (cmp.type === 'playground_screenshot') {
              yield {
                type: 'playground_screenshot',
                mimeType: cmp.mimeType,
                dataUrl: cmp.dataUrl,
                byteLength: cmp.byteLength,
                url: cmp.url,
                capturedAt: cmp.capturedAt,
                iteration: cmp.iteration,
              };
            } else if (cmp.type === 'compare_iteration') {
              yield {
                type: 'compare_iteration',
                iteration: cmp.iteration,
                maxIterations: cmp.maxIterations,
                visualMatch: cmp.visualMatch,
                written: cmp.written,
                gaps: cmp.gaps ? [...cmp.gaps] : undefined,
                mismatchSummary: cmp.mismatchSummary,
                files: cmp.files ? [...cmp.files] : undefined,
              };
            } else if (cmp.type === 'compare_result') {
              yield {
                type: 'compare_result',
                ok: cmp.ok,
                matched: cmp.matched,
                iterations: cmp.iterations,
                written: cmp.written,
                playgroundUrl: cmp.playgroundUrl,
                agentText: cmp.agentText,
                gaps: cmp.gaps ? [...cmp.gaps] : undefined,
                mismatchSummary: cmp.mismatchSummary,
                files: cmp.files ? [...cmp.files] : undefined,
              };
            }
          }
        } catch (compareError) {
          yield {
            type: 'error',
            message: `Visual compare loop failed: ${
              compareError instanceof Error ? compareError.message : String(compareError)
            }`,
          };
        }
      } else if (sessionId && shot?.dataUrl) {
        yield {
          type: 'status',
          message:
            'Staged — visual compare skipped. Use chat refine or POST /api/sessions/:id/compare-loop.',
        };
      }

      yield {
        type: 'done',
        text:
          text.trim() ||
          (shouldCompare
            ? 'Preview staged + visual match loop finished. Review Figma vs playground, chat refine, then Approve for MR.'
            : 'Preview staged. Review playground, chat refine, or run compare-loop — then Approve for MR.'),
        stateSummary: summarizeState(runtime.state),
        dryRun: true,
        proposalId: view.id,
        awaitingApproval: true,
        sessionId,
      };
      return;
    }

    if (previewOnly && proposed.length === 0) {
      yield {
        type: 'error',
        message:
          'Agent finished without proposing COMPONENT_AUTHORING files. It must call generate_component_scaffold so the UI can show expected the target repo changes for approval.',
      };
    }

    yield {
      type: 'done',
      text: text.trim() || 'The agent completed without a final text response.',
      stateSummary: summarizeState(runtime.state),
      dryRun: true,
      awaitingApproval: false,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    yield { type: 'error', message };
    yield {
      type: 'done',
      text: text.trim(),
      stateSummary: summarizeState(runtime.state),
      dryRun: true,
    };
  } finally {
    progressQueue.close();
    runtime.setProgressHandler(undefined);
    try {
      await runtime.mcp.close();
    } catch {
      // Connections may never have been opened.
    }
  }
}

export async function runFigtoMRAgent(input: RunAgentInput): Promise<RunAgentResult> {
  let text = '';
  let stateSummary = '{}';
  let mrUrl: string | undefined;
  let proposalId: string | undefined;
  let lastError: string | undefined;
  for await (const event of streamFigtoMRAgent(input)) {
    if (event.type === 'agent' && event.text) {
      text = event.text;
    }
    if (event.type === 'error') {
      lastError = event.message;
    }
    if (event.type === 'proposal') {
      proposalId = event.proposalId;
    }
    if (event.type === 'done') {
      text = event.text || text;
      stateSummary = event.stateSummary;
      mrUrl = event.mrUrl;
      proposalId = event.proposalId ?? proposalId;
    }
  }
  if (lastError && !text && !mrUrl && !proposalId) {
    throw new Error(lastError);
  }
  return {
    text:
      text.trim() ||
      (lastError ? `Failed: ${lastError}` : 'The agent completed without a final text response.'),
    stateSummary,
    mrUrl,
    proposalId,
  };
}
