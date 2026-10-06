import { studioPreviewUrl, type StudioEnv } from '../config/env.js';
import { applyWritePlan } from '../utils/file-writer.js';
import { formatTargetRepoPaths } from '../utils/target-repo-format.js';
import { logger } from '../utils/logger.js';
import {
  buildComponentPreviewUrl,
  getProposal,
  attachProposalSession,
  type ComponentProposal,
} from './proposal-store.js';
import {
  capturePlaygroundScreenshot,
  ensurePlaygroundRunning,
  type PlaygroundScreenshot,
} from './playground-lifecycle.js';
import { saveStudioSession, updateStudioSession } from './session-store.js';

export type StageStreamEvent =
  | { type: 'status'; message: string }
  | {
      type: 'tool';
      name?: string;
      label?: string;
      detail?: string;
      phase?: 'start' | 'done' | 'error' | 'info';
      source?: 'studio';
    }
  | { type: 'error'; message: string }
  | {
      type: 'playground_screenshot';
      mimeType: string;
      dataUrl: string;
      byteLength: number;
      url: string;
      capturedAt: string;
    }
  | ({ type: 'staged' } & StageProposalResult);

export type StageProposalResult = {
  readonly proposalId: string;
  readonly written: string[];
  readonly sessionId: string;
  readonly playgroundUrl: string;
  readonly playgroundReachable: boolean;
  readonly playgroundStarted: boolean;
  readonly playgroundScreenshot?: PlaygroundScreenshot;
};

function componentFiles(proposal: ComponentProposal) {
  return proposal.files.filter(
    (file) =>
      file.path
        .replace(/\\/g, '/')
        .startsWith(`${proposal.targetProfile.componentRoot.replace(/\/$/, '')}/`) &&
      !file.contents.startsWith('// Preview only'),
  );
}

/**
 * Write the component into the local target repo, open a refine session
 * (no MR required), and capture a preview screenshot for Figma compare.
 */
export async function* streamStageProposal(input: {
  readonly proposalId: string;
  readonly env: StudioEnv;
  readonly captureScreenshot?: boolean;
}): AsyncGenerator<StageStreamEvent> {
  const proposal = getProposal(input.proposalId);
  if (!proposal) {
    yield { type: 'error', message: `Unknown or expired proposal "${input.proposalId}".` };
    return;
  }

  const files = componentFiles(proposal);
  if (files.length === 0) {
    yield { type: 'error', message: 'Proposal has no component source files to stage locally.' };
    return;
  }

  const repoPath = proposal.targetRepoPath;
  const name = proposal.componentName;

  yield { type: 'status', message: `Writing ${files.length} file(s) to local the target repo…` };
  const writeResult = applyWritePlan({
    repoPath,
    dryRun: false,
    files: files.map((file) => ({
      relativePath: file.path,
      contents: file.contents,
    })),
  });
  const written = [...writeResult.written];

  yield { type: 'status', message: 'Formatting staged component files…' };
  if (proposal.targetProfile.formatter === 'biome') {
    await formatTargetRepoPaths(repoPath, written);
  }

  const playgroundUrl = name
    ? buildComponentPreviewUrl(studioPreviewUrl(input.env), name, proposal.targetProfile)
    : studioPreviewUrl(input.env);

  yield { type: 'status', message: 'Ensuring the target repo playground is running…' };
  const playground = await ensurePlaygroundRunning({
    repoPath,
    env: input.env,
    profile: proposal.targetProfile,
  });
  yield {
    type: 'status',
    message: playground.message,
  };

  const session = saveStudioSession({
    componentName: name ?? 'Component',
    targetRepoPath: repoPath,
    targetProfile: proposal.targetProfile,
    figmaUrl: proposal.figmaUrl,
    playgroundUrl,
    env: input.env,
    figmaDesignText: proposal.figmaDesignText,
    figmaScreenshot: proposal.figmaScreenshot
      ? {
          mimeType: proposal.figmaScreenshot.mimeType,
          dataUrl: proposal.figmaScreenshot.dataUrl,
          byteLength: proposal.figmaScreenshot.byteLength,
          capturedAt: proposal.figmaScreenshot.capturedAt,
        }
      : undefined,
  });
  attachProposalSession(proposal.id, session.id);

  let playgroundScreenshot: PlaygroundScreenshot | undefined;
  if (input.captureScreenshot !== false && playground.reachable) {
    yield { type: 'status', message: 'Capturing playground screenshot…' };
    try {
      playgroundScreenshot = await capturePlaygroundScreenshot({ url: playgroundUrl });
      yield {
        type: 'playground_screenshot',
        mimeType: playgroundScreenshot.mimeType,
        dataUrl: playgroundScreenshot.dataUrl,
        byteLength: playgroundScreenshot.byteLength,
        url: playgroundScreenshot.url,
        capturedAt: playgroundScreenshot.capturedAt,
      };
      updateStudioSession(session.id, {
        // keep chat empty; screenshot is returned on staged event
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`Playground screenshot failed: ${message}`);
      yield {
        type: 'status',
        message: `Playground screenshot skipped: ${message}`,
      };
    }
  }

  yield {
    type: 'status',
    message: `Local stage ready — chat refine session ${session.id}. Open ${playgroundUrl}`,
  };

  yield {
    type: 'staged',
    proposalId: proposal.id,
    written,
    sessionId: session.id,
    playgroundUrl,
    playgroundReachable: playground.reachable,
    playgroundStarted: playground.started,
    playgroundScreenshot,
  };
}

export async function stageProposal(input: {
  readonly proposalId: string;
  readonly env: StudioEnv;
  readonly captureScreenshot?: boolean;
}): Promise<StageProposalResult> {
  let result: StageProposalResult | undefined;
  for await (const event of streamStageProposal(input)) {
    if (event.type === 'staged') {
      const { type: _t, ...rest } = event;
      result = rest;
    }
  }
  if (!result) {
    throw new Error('Stage finished without a result.');
  }
  return result;
}
