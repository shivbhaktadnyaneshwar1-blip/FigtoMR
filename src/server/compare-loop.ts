import { studioPreviewUrl, type StudioEnv } from '../config/env.js';
import { runRefinePass, formatVisualMismatchSummary, type RefineStreamEvent } from '../agent/refine-agent.js';
import { logger } from '../utils/logger.js';
import {
  capturePlaygroundScreenshot,
  ensurePlaygroundRunning,
  type PlaygroundScreenshot,
} from './playground-lifecycle.js';
import { getStudioSession, updateStudioSession, appendSessionChat } from './session-store.js';
import {
  buildComponentPreviewUrl,
  listComponentScopedRelativePaths,
  proposalPublicView,
  syncProposalFilesForSession,
} from './proposal-store.js';
import {
  checkpointFiles,
  judgeVisualProgress,
  restoreCheckpoint,
} from './visual-converge.js';
import { summarizeFigmaDataHints } from '../generation/figma-scaffold.js';

const DEFAULT_MAX_ITERS = 4;

type ProposalFilePayload = ReturnType<typeof proposalPublicView>['files'];

function refreshedProposalFiles(sessionId: string): ProposalFilePayload | undefined {
  const synced = syncProposalFilesForSession(sessionId);
  return synced ? proposalPublicView(synced).files : undefined;
}

export type ScreenshotPayload = {
  readonly mimeType: string;
  readonly dataUrl: string;
  readonly byteLength: number;
  readonly capturedAt?: string;
  readonly url?: string;
};

export type CompareLoopEvent =
  | RefineStreamEvent
  | {
      type: 'compare_iteration';
      iteration: number;
      maxIterations: number;
      visualMatch?: boolean;
      written: string[];
      gaps?: readonly string[];
      mismatchSummary?: string;
      /** Latest on-disk proposal files after this pass (for UI refresh). */
      files?: ProposalFilePayload;
    }
  | {
      type: 'playground_screenshot';
      mimeType: string;
      dataUrl: string;
      byteLength: number;
      url: string;
      capturedAt: string;
      iteration: number;
    }
  | {
      type: 'compare_result';
      ok: boolean;
      matched: boolean;
      iterations: number;
      written: string[];
      playgroundUrl: string;
      playgroundScreenshot?: PlaygroundScreenshot;
      agentText: string;
      gaps?: readonly string[];
      mismatchSummary?: string;
      files?: ProposalFilePayload;
      error?: string;
    };

/**
 * Loop: capture playground → multimodal compare vs Figma → refine → repeat
 * until VISUAL_MATCH: true or max iterations.
 */
export async function* streamVisualCompareLoop(input: {
  readonly sessionId: string;
  readonly env: StudioEnv;
  readonly figmaScreenshot: ScreenshotPayload;
  readonly maxIterations?: number;
  /** Optional design-context text for FIGMA_DATA hints (copy/numbers). */
  readonly designText?: string;
}): AsyncGenerator<CompareLoopEvent> {
  const session = getStudioSession(input.sessionId);
  if (!session) {
    yield { type: 'error', message: `Unknown or expired session "${input.sessionId}".` };
    return;
  }

  const maxIterations = Math.max(1, Math.min(8, input.maxIterations ?? DEFAULT_MAX_ITERS));
  const playgroundUrl =
    session.playgroundUrl ||
    buildComponentPreviewUrl(
      studioPreviewUrl(input.env),
      session.componentName,
      session.targetProfile,
    );

  updateStudioSession(session.id, {
    figmaScreenshot: {
      mimeType: input.figmaScreenshot.mimeType,
      dataUrl: input.figmaScreenshot.dataUrl,
      byteLength: input.figmaScreenshot.byteLength,
      capturedAt: input.figmaScreenshot.capturedAt,
    },
    ...(input.designText?.trim()
      ? { figmaDesignText: input.designText.trim().slice(0, 24_000) }
      : {}),
  });

  yield { type: 'status', message: 'Ensuring playground is up for visual compare loop…' };
  const playground = await ensurePlaygroundRunning({
    repoPath: session.targetRepoPath,
    env: input.env,
    profile: session.targetProfile,
  });
  if (!playground.reachable) {
    yield {
      type: 'error',
      message: `Playground not reachable at ${playground.url}. ${playground.message}`,
    };
    return;
  }

  const allWritten: string[] = [];
  let lastShot: PlaygroundScreenshot | undefined;
  let matched = false;
  let lastAgentText = '';
  let lastGaps: string[] = [];
  let residualGaps: string[] = [];
  let iterationsRun = 0;

  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    iterationsRun = iteration;
    yield {
      type: 'status',
      message: `Visual match ${iteration}/${maxIterations} — capture playground, then CURRENT → MISSING → design system MCP → DEVELOP…`,
    };

    try {
      lastShot = await capturePlaygroundScreenshot({ url: playgroundUrl, settleMs: 6_000 });
      updateStudioSession(session.id, {
        playgroundScreenshot: {
          mimeType: lastShot.mimeType,
          dataUrl: lastShot.dataUrl,
          byteLength: lastShot.byteLength,
          capturedAt: lastShot.capturedAt,
          url: lastShot.url,
        },
      });
      yield {
        type: 'playground_screenshot',
        mimeType: lastShot.mimeType,
        dataUrl: lastShot.dataUrl,
        byteLength: lastShot.byteLength,
        url: lastShot.url,
        capturedAt: lastShot.capturedAt,
        iteration,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      yield { type: 'error', message: `Playground screenshot failed: ${message}` };
      break;
    }

    const scopedFiles = listComponentScopedRelativePaths(
      session.targetRepoPath,
      session.componentName,
      session.targetProfile,
    );
    const beforeShot = lastShot;
    const checkpoint = checkpointFiles(session.targetRepoPath, scopedFiles);
    const pending: RefineStreamEvent[] = [];
    let resolveWait: (() => void) | undefined;
    const wake = () => {
      resolveWait?.();
      resolveWait = undefined;
    };

    const priorGapBlock =
      residualGaps.length > 0
        ? [
            'PRIOR_GAPS (fix only these — do not rewrite unrelated parts that already look closer to Figma):',
            ...residualGaps.map((gap) => `- ${gap}`),
            'Fix at most 2–3 gaps this pass. Preserve everything else.',
          ].join('\n')
        : 'No PRIOR_GAPS yet — list MISSING carefully from FIGMA vs PLAYGROUND (include wrong/missing data), then fix at most 2–3 gaps.';

    const dataHints = (session.figmaDesignText || input.designText)
      ? `FIGMA_DATA (must appear in playground fixtures / prop defaults):\n${summarizeFigmaDataHints(session.figmaDesignText || input.designText || '')}`
      : 'FIGMA_DATA: read every readable label and number from the FIGMA screenshot — titles, CTAs, prices, KPI values, feature lines. Match those in api defaults + playground TEST_DATA.';

    const passPromise = runRefinePass({
      env: input.env,
      repoPath: session.targetRepoPath,
      targetProfile: session.targetProfile,
      componentName: session.componentName,
      figmaUrl: session.figmaUrl,
      scopedFiles,
      images: [
        {
          label: 'FIGMA (design target)',
          mimeType: input.figmaScreenshot.mimeType,
          dataUrl: input.figmaScreenshot.dataUrl,
        },
        {
          label: 'PLAYGROUND (current the target repo render)',
          mimeType: lastShot.mimeType,
          dataUrl: lastShot.dataUrl,
        },
      ],
      userMessage: [
        `Iteration ${iteration}/${maxIterations}.`,
        'Goal: make PLAYGROUND closer to FIGMA than it is now — layout AND data. Never make it farther.',
        dataHints,
        priorGapBlock,
        'Follow this exact sequence (do not skip):',
        '1) CURRENT — read the component TSX, props, CSS, and colocated test data. Prefer surgical patches.',
        '2) MISSING — compare FIGMA vs PLAYGROUND; emit MISSING bullets for chrome gaps AND data mismatches (wrong title/numbers/placeholders).',
        '3) DEVELOP — write minimal semantic HTML/CSS edits for ≤3 gaps. Sync fixture props and tests. Do not leave Metric 1 / sample copy when Figma shows real data.',
        '4) End with VISUAL_MATCH: true or VISUAL_MATCH: false (+ MISSING bullets when false).',
      ].join('\n'),
      onEvent: (event) => {
        pending.push(event);
        wake();
      },
    });

    let passDone = false;
    passPromise.then(
      () => {
        passDone = true;
        wake();
      },
      () => {
        passDone = true;
        wake();
      },
    );

    while (!passDone || pending.length > 0) {
      if (pending.length === 0) {
        await new Promise<void>((resolve) => {
          resolveWait = resolve;
        });
        continue;
      }
      yield pending.shift()!;
    }

    const pass = await passPromise;
    lastAgentText = pass.agentText;
    lastGaps = [...pass.gaps];
    if (pass.gaps.length > 0) {
      residualGaps = [...pass.gaps];
    }
    allWritten.push(...pass.written);

    // Host keep-best gate: if this pass wrote files, re-capture and roll back when FARTHER from Figma.
    if (pass.written.length > 0 && beforeShot) {
      try {
        const afterShot = await capturePlaygroundScreenshot({
          url: playgroundUrl,
          settleMs: 5_000,
        });
        const verdict = await judgeVisualProgress({
          env: input.env,
          figma: {
            mimeType: input.figmaScreenshot.mimeType,
            dataUrl: input.figmaScreenshot.dataUrl,
          },
          before: beforeShot,
          after: afterShot,
        });
        yield {
          type: 'tool',
          name: 'visual_progress',
          label:
            verdict.progress === 'closer'
              ? 'Closer to Figma — keeping this pass'
              : verdict.progress === 'farther'
                ? 'Farther from Figma — rolling back'
                : verdict.progress === 'same'
                  ? 'Same distance from Figma'
                  : 'Could not judge visual progress',
          detail: verdict.reason.slice(0, 180),
          phase: verdict.progress === 'farther' ? 'error' : 'done',
          source: 'studio',
        };

        if (verdict.progress === 'farther') {
          const restored = restoreCheckpoint(session.targetRepoPath, checkpoint);
          for (const path of pass.written) {
            const idx = allWritten.lastIndexOf(path);
            if (idx >= 0) allWritten.splice(idx, 1);
          }
          lastShot = beforeShot;
          yield {
            type: 'status',
            message: `Rolled back iter ${iteration} (${restored.length} file(s)) — pass made playground farther from Figma. Stopping to keep the best so far.`,
          };
          yield {
            type: 'compare_iteration',
            iteration,
            maxIterations,
            visualMatch: false,
            written: [],
            gaps: residualGaps,
            mismatchSummary: `Not matching with Figma — rolled back worse pass: ${verdict.reason.slice(0, 120)}`,
            files: refreshedProposalFiles(session.id),
          };
          break;
        }

        lastShot = afterShot;
        updateStudioSession(session.id, {
          playgroundScreenshot: {
            mimeType: afterShot.mimeType,
            dataUrl: afterShot.dataUrl,
            byteLength: afterShot.byteLength,
            capturedAt: afterShot.capturedAt,
            url: afterShot.url,
          },
        });
        yield {
          type: 'playground_screenshot',
          mimeType: afterShot.mimeType,
          dataUrl: afterShot.dataUrl,
          byteLength: afterShot.byteLength,
          url: afterShot.url,
          capturedAt: afterShot.capturedAt,
          iteration,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(`Visual keep-best gate skipped: ${message}`);
      }
    }

    matched = pass.visualMatch === true;
    const willRetry =
      !matched &&
      pass.ok &&
      iteration < maxIterations &&
      !(pass.written.length === 0 && pass.visualMatch === false);
    const mismatch =
      matched || pass.visualMatch === undefined
        ? undefined
        : formatVisualMismatchSummary({
            iteration,
            maxIterations,
            gaps: residualGaps.length > 0 ? residualGaps : pass.gaps,
            willRetry,
          });

    if (mismatch) {
      yield {
        type: 'tool',
        name: 'visual_mismatch',
        label: mismatch.headline,
        detail: mismatch.detail,
        phase: willRetry ? 'info' : 'error',
        source: 'studio',
      };
      for (const [index, gap] of (residualGaps.length > 0 ? residualGaps : pass.gaps)
        .slice(0, 6)
        .entries()) {
        yield {
          type: 'tool',
          name: `visual_gap_${index + 1}`,
          label: 'Gap vs Figma',
          detail: gap,
          phase: 'info',
          source: 'studio',
        };
      }
    }

    yield {
      type: 'compare_iteration',
      iteration,
      maxIterations,
      visualMatch: pass.visualMatch,
      written: pass.written,
      gaps: residualGaps.length > 0 ? residualGaps : pass.gaps,
      mismatchSummary: mismatch ? `${mismatch.headline}: ${mismatch.detail}` : undefined,
      files: refreshedProposalFiles(session.id),
    };

    appendSessionChat(session.id, {
      role: 'assistant',
      text:
        `Compare iter ${iteration}/${maxIterations}` +
        (pass.visualMatch === undefined
          ? ''
          : ` · VISUAL_MATCH=${pass.visualMatch}`) +
        (pass.gaps.length ? ` · gaps: ${pass.gaps.slice(0, 4).join('; ')}` : '') +
        (pass.written.length ? ` · wrote ${pass.written.length} file(s)` : '') +
        (pass.agentText ? `\n${pass.agentText.slice(0, 1500)}` : ''),
    });

    if (matched) {
      yield {
        type: 'status',
        message: `Visual match reached on iteration ${iteration}.`,
      };
      break;
    }

    if (!pass.ok) {
      yield {
        type: 'status',
        message: `Compare iter ${iteration} failed — stopping loop.`,
      };
      break;
    }

    if (pass.written.length === 0 && pass.visualMatch === false) {
      yield {
        type: 'status',
        message: `No file changes on iter ${iteration} and still not matching — stopping.`,
      };
      break;
    }

    if (willRetry) {
      yield {
        type: 'status',
        message: `Still not matching Figma — retrying visual pass ${iteration + 1}/${maxIterations} (surgical fixes only)…`,
      };
    }
  }

  // Fresh capture after last edits when we wrote something and claimed match / finished.
  if (allWritten.length > 0 && playground.reachable) {
    try {
      lastShot = await capturePlaygroundScreenshot({ url: playgroundUrl, settleMs: 5_000 });
      yield {
        type: 'playground_screenshot',
        mimeType: lastShot.mimeType,
        dataUrl: lastShot.dataUrl,
        byteLength: lastShot.byteLength,
        url: lastShot.url,
        capturedAt: lastShot.capturedAt,
        iteration: iterationsRun,
      };
    } catch {
      // keep previous shot
    }
  }

  logger.info(
    `Visual compare loop session=${session.id} iters=${iterationsRun} matched=${matched} written=${allWritten.length}`,
  );

  yield {
    type: 'compare_result',
    ok: true,
    matched,
    iterations: iterationsRun,
    written: [...new Set(allWritten)],
    playgroundUrl,
    playgroundScreenshot: lastShot,
    agentText: lastAgentText,
    gaps: lastGaps,
    mismatchSummary: matched
      ? undefined
      : formatVisualMismatchSummary({
          iteration: iterationsRun,
          maxIterations,
          gaps: lastGaps,
          willRetry: false,
        }).headline +
        (lastGaps.length ? `: ${lastGaps.slice(0, 5).join('; ')}` : ''),
    files: refreshedProposalFiles(session.id),
  };
}
