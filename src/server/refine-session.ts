import { studioPreviewUrl, type StudioEnv } from '../config/env.js';
import { commitAndPushChanges } from '../gitlab/create-mr.js';
import { runRefinePass, type RefineStreamEvent } from '../agent/refine-agent.js';
import { logger } from '../utils/logger.js';
import { appendSessionChat, getStudioSession, updateStudioSession } from './session-store.js';
import {
  buildComponentPreviewUrl,
  listComponentScopedRelativePaths,
  proposalPublicView,
  syncProposalFilesForSession,
} from './proposal-store.js';

export type RefineSessionEvent =
  | RefineStreamEvent
  | {
      type: 'result';
      ok: boolean;
      sessionId: string;
      written: string[];
      pushed: boolean;
      awaitingPushConfirmation?: boolean;
      commitSha?: string;
      mrUrl?: string;
      playgroundUrl: string;
      agentText: string;
      files?: ReturnType<typeof proposalPublicView>['files'];
      error?: string;
    };

/** Apply a chat refine on an open MR session, then commit + push when files change. */
export async function* streamRefineSessionChat(input: {
  sessionId: string;
  message: string;
  env: StudioEnv;
  deferPush?: boolean;
}): AsyncGenerator<RefineSessionEvent> {
  const session = getStudioSession(input.sessionId);
  if (!session) {
    yield { type: 'error', message: `Unknown or expired session "${input.sessionId}".` };
    return;
  }
  if (!session.branchName) {
    yield {
      type: 'status',
      message: `Refining ${session.componentName} on local disk (no MR branch yet)…`,
    };
  } else {
    yield {
      type: 'status',
      message: `Refining ${session.componentName} on ${session.branchName}…`,
    };
  }

  const message = input.message.trim();
  if (!message) {
    yield { type: 'error', message: 'Chat message is required.' };
    return;
  }

  appendSessionChat(session.id, { role: 'user', text: message });
  const scopedFiles = listComponentScopedRelativePaths(
    session.targetRepoPath,
    session.componentName,
    session.targetProfile,
  );

  const pending: RefineStreamEvent[] = [];
  let resolveWait: (() => void) | undefined;
  const wake = () => {
    resolveWait?.();
    resolveWait = undefined;
  };

  const passPromise = runRefinePass({
    env: input.env,
    repoPath: session.targetRepoPath,
    targetProfile: session.targetProfile,
    componentName: session.componentName,
    userMessage: message,
    figmaUrl: session.figmaUrl,
    scopedFiles,
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

  // Visual-first: do not block chat refine on lint. Approve / MR owns build→lint→test.
  if (!pass.ok) {
    const errText = pass.agentText || 'Refine pass failed.';
    appendSessionChat(session.id, { role: 'assistant', text: errText });
    yield {
      type: 'result',
      ok: false,
      sessionId: session.id,
      written: pass.written,
      pushed: false,
      mrUrl: session.mrUrl,
      playgroundUrl: session.playgroundUrl,
      agentText: pass.agentText,
      error: errText,
    };
    return;
  }

  let pushed = false;
  let commitSha: string | undefined;
  let awaitingPushConfirmation = false;
  if (pass.written.length > 0 && session.branchName) {
    const commitMessage = `fix: refine ${session.componentName} via Studio chat`;
    if (input.deferPush) {
      awaitingPushConfirmation = true;
      updateStudioSession(session.id, {
        pendingPush: {
          files: pass.written,
          commitMessage,
          agentText: pass.agentText,
          createdAt: new Date().toISOString(),
        },
      });
      yield {
        type: 'status',
        message: `Changes are ready for ${session.branchName}; waiting for push confirmation…`,
      };
    } else {
      yield { type: 'status', message: `Pushing updates to ${session.branchName}…` };
      try {
        const push = await commitAndPushChanges({
          repoPath: session.targetRepoPath,
          env: input.env,
          branchName: session.branchName,
          commitMessage,
          files: pass.written,
          targetProfile: session.targetProfile,
        });
        pushed = push.pushed;
        commitSha = push.commitSha;
      } catch (error) {
        const errText = error instanceof Error ? error.message : String(error);
        appendSessionChat(session.id, { role: 'assistant', text: errText });
        yield {
          type: 'result',
          ok: false,
          sessionId: session.id,
          written: pass.written,
          pushed: false,
          mrUrl: session.mrUrl,
          playgroundUrl: session.playgroundUrl,
          agentText: pass.agentText,
          error: errText,
        };
        return;
      }
    }
  } else if (pass.written.length > 0) {
    yield {
      type: 'status',
      message: `Updated ${pass.written.length} local file(s) — refresh playground to verify.`,
    };
  }

  const playgroundUrl = buildComponentPreviewUrl(
    studioPreviewUrl(input.env),
    session.componentName,
    session.targetProfile,
  );
  const assistantText = awaitingPushConfirmation
    ? `${pass.agentText ? `${pass.agentText}\n\n` : ''}I changed ${pass.written.length} file(s). Push these changes to ${session.branchName}? Reply yes or no.`
    : pass.agentText ||
      (pushed
        ? `Updated and pushed to ${session.branchName}. Refresh playground: ${playgroundUrl}`
        : pass.written.length > 0
          ? `Updated local the target repo files. Refresh playground: ${playgroundUrl}`
          : 'No file changes were needed (or agent made no writes).');

  appendSessionChat(session.id, { role: 'assistant', text: assistantText });
  updateStudioSession(session.id, { playgroundUrl });

  const synced = syncProposalFilesForSession(session.id);
  const files = synced ? proposalPublicView(synced).files : undefined;

  logger.info(
    `Refine session ${session.id}: written=${pass.written.length} pushed=${pushed} sha=${commitSha ?? '-'}`,
  );

  yield {
    type: 'result',
    ok: true,
    sessionId: session.id,
    written: pass.written,
    pushed,
    commitSha,
    awaitingPushConfirmation,
    mrUrl: session.mrUrl,
    playgroundUrl,
    agentText: assistantText,
    files,
  };
}
