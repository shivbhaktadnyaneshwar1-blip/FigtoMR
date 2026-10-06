import { randomBytes } from 'node:crypto';
import { studioPreviewUrl, type StudioEnv } from '../config/env.js';
import { buildComponentPreviewUrl } from './proposal-store.js';
import type { TargetFrontendProfile } from '../target/frontend-profile.js';

export interface StudioSession {
  readonly id: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly componentName: string;
  readonly targetRepoPath: string;
  readonly targetProfile: TargetFrontendProfile;
  readonly branchName?: string;
  readonly mrUrl?: string;
  readonly mrIid?: number;
  /** Existing MR attached from a sessionless chat; agent edits require explicit push confirmation. */
  readonly requirePushConfirmation?: boolean;
  pendingPush?: {
    readonly files: readonly string[];
    readonly commitMessage: string;
    readonly agentText: string;
    readonly createdAt: string;
  };
  readonly figmaUrl?: string;
  /** Clipped Figma design-context text for data/copy hints during visual refine. */
  readonly figmaDesignText?: string;
  readonly playgroundUrl: string;
  figmaScreenshot?: {
    mimeType: string;
    dataUrl: string;
    byteLength: number;
    capturedAt?: string;
  };
  playgroundScreenshot?: {
    mimeType: string;
    dataUrl: string;
    byteLength: number;
    capturedAt?: string;
    url?: string;
  };
  readonly chat: Array<{ role: 'user' | 'assistant'; text: string; at: string }>;
  readonly env: StudioEnv;
}

const sessions = new Map<string, StudioSession>();
const TTL_MS = 8 * 60 * 60 * 1000;

function pruneExpired(): void {
  const cutoff = Date.now() - TTL_MS;
  for (const [id, session] of sessions) {
    if (Date.parse(session.updatedAt) < cutoff) {
      sessions.delete(id);
    }
  }
}

export function saveStudioSession(
  input: Omit<StudioSession, 'id' | 'createdAt' | 'updatedAt' | 'chat' | 'playgroundUrl'> & {
    playgroundUrl?: string;
    figmaScreenshot?: StudioSession['figmaScreenshot'];
    playgroundScreenshot?: StudioSession['playgroundScreenshot'];
  },
): StudioSession {
  pruneExpired();
  const now = new Date().toISOString();
  const playgroundUrl =
    input.playgroundUrl ??
    buildComponentPreviewUrl(studioPreviewUrl(input.env), input.componentName, input.targetProfile);
  const session: StudioSession = {
    ...input,
    id: randomBytes(12).toString('hex'),
    createdAt: now,
    updatedAt: now,
    playgroundUrl,
    chat: [],
  };
  sessions.set(session.id, session);
  return session;
}

export function getStudioSession(id: string): StudioSession | undefined {
  pruneExpired();
  return sessions.get(id);
}

export function updateStudioSession(
  id: string,
  patch: Partial<Omit<StudioSession, 'id' | 'createdAt' | 'env'>>,
): StudioSession | undefined {
  const current = getStudioSession(id);
  if (!current) return undefined;
  const next: StudioSession = {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  sessions.set(id, next);
  return next;
}

export function appendSessionChat(
  id: string,
  entry: { role: 'user' | 'assistant'; text: string },
): StudioSession | undefined {
  const current = getStudioSession(id);
  if (!current) return undefined;
  return updateStudioSession(id, {
    chat: [...current.chat, { ...entry, at: new Date().toISOString() }],
  });
}

export function sessionPublicView(session: StudioSession) {
  return {
    id: session.id,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    componentName: session.componentName,
    targetRepoPath: session.targetRepoPath,
    branchName: session.branchName,
    mrUrl: session.mrUrl,
    mrIid: session.mrIid,
    figmaUrl: session.figmaUrl,
    playgroundUrl: session.playgroundUrl,
    chat: session.chat,
  };
}
