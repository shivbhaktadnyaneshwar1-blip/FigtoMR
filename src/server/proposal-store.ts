import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { StudioEnv } from '../config/env.js';
import {
  buildPreviewDeepLink,
  type TargetFrontendProfile,
} from '../target/frontend-profile.js';
import { toKebabCase } from '../utils/names.js';

export interface ProposedFileChange {
  readonly path: string;
  readonly action: 'create' | 'update';
  readonly contents: string;
  readonly summary?: string;
}

export interface ComponentProposal {
  readonly id: string;
  readonly createdAt: string;
  readonly figmaUrl?: string;
  readonly componentName?: string;
  readonly mode?: string;
  readonly createMr: boolean;
  readonly targetRepoPath: string;
  readonly targetProfile: TargetFrontendProfile;
  readonly agentText: string;
  readonly files: ProposedFileChange[];
  readonly playgroundUrl?: string;
  /** Clipped Figma design context for fixture / data matching. */
  readonly figmaDesignText?: string;
  /** Figma node screenshot captured during generate (data URL). */
  readonly figmaScreenshot?: {
    readonly mimeType: string;
    readonly dataUrl: string;
    readonly byteLength: number;
    readonly fileKey?: string;
    readonly nodeId?: string;
    readonly capturedAt?: string;
  };
  readonly env: StudioEnv;
  /** Set when proposal has been staged to the local the target repo checkout. */
  stagedSessionId?: string;
}

const proposals = new Map<string, ComponentProposal>();
const TTL_MS = 60 * 60 * 1000;

function pruneExpired(): void {
  const cutoff = Date.now() - TTL_MS;
  for (const [id, proposal] of proposals) {
    if (Date.parse(proposal.createdAt) < cutoff) {
      proposals.delete(id);
    }
  }
}

export function saveProposal(
  input: Omit<ComponentProposal, 'id' | 'createdAt'>,
): ComponentProposal {
  pruneExpired();
  const proposal: ComponentProposal = {
    ...input,
    id: randomBytes(12).toString('hex'),
    createdAt: new Date().toISOString(),
  };
  proposals.set(proposal.id, proposal);
  return proposal;
}

export function getProposal(id: string): ComponentProposal | undefined {
  pruneExpired();
  return proposals.get(id);
}

export function deleteProposal(id: string): void {
  proposals.delete(id);
}

/** Attach a local-stage chat session id onto a live proposal. */
export function attachProposalSession(id: string, sessionId: string): void {
  const proposal = proposals.get(id);
  if (!proposal) return;
  proposal.stagedSessionId = sessionId;
}

export function findProposalBySessionId(sessionId: string): ComponentProposal | undefined {
  pruneExpired();
  for (const proposal of proposals.values()) {
    if (proposal.stagedSessionId === sessionId) return proposal;
  }
  return undefined;
}

function isComponentSourcePath(path: string, profile: TargetFrontendProfile): boolean {
  return path.replace(/\\/g, '/').startsWith(`${profile.componentRoot.replace(/\/$/, '')}/`);
}

/** Repo-relative paths for one custom component (source + playground + unit test). */
export function listComponentScopedRelativePaths(
  repoPath: string,
  componentName: string,
  profile: TargetFrontendProfile,
): string[] {
  const kebab = toKebabCase(componentName);
  const files: string[] = [];
  const pushDir = (relDir: string) => {
    const abs = join(repoPath, relDir);
    if (!existsSync(abs)) return;
    for (const name of readdirSync(abs)) {
      files.push(`${relDir}/${name}`.replace(/\\/g, '/'));
    }
  };
  pushDir(`${profile.componentRoot.replace(/\/$/, '')}/${kebab}`);
  return files;
}

/** Read current on-disk component files (after stage / refine / compare). */
export function readComponentFilesFromDisk(
  repoPath: string,
  componentName: string,
  profile: TargetFrontendProfile,
): ProposedFileChange[] {
  return listComponentScopedRelativePaths(repoPath, componentName, profile).map((path) => ({
    path,
    action: existsSync(join(repoPath, path)) ? 'update' : 'create',
    contents: readFileSync(join(repoPath, path), 'utf8'),
    summary: `Update ${path}`,
  }));
}

/**
 * Replace proposal component file snapshots with what is on disk.
 * Keeps only files belonging to the generated target component.
 */
export function syncProposalFilesFromDisk(proposalId: string): ComponentProposal | undefined {
  const proposal = getProposal(proposalId);
  if (!proposal?.componentName) return undefined;

  const fromDisk = readComponentFilesFromDisk(
    proposal.targetRepoPath,
    proposal.componentName,
    proposal.targetProfile,
  );
  if (fromDisk.length === 0) return undefined;

  const stubs = proposal.files.filter((file) => !isComponentSourcePath(file.path, proposal.targetProfile));
  const merged = fromDisk.map((file) => {
    const previous = proposal.files.find((entry) => entry.path === file.path);
    return {
      ...file,
      action: previous?.action ?? 'create',
      summary: previous?.summary ?? file.summary,
    };
  });

  const updated: ComponentProposal = {
    ...proposal,
    files: [...merged, ...stubs],
  };
  proposals.set(proposalId, updated);
  return updated;
}

/** Sync the proposal attached to a staged session (compare / chat refine). */
export function syncProposalFilesForSession(sessionId: string): ComponentProposal | undefined {
  const proposal = findProposalBySessionId(sessionId);
  if (!proposal) return undefined;
  return syncProposalFilesFromDisk(proposal.id) ?? proposal;
}

export function proposalPublicView(proposal: ComponentProposal) {
  return {
    id: proposal.id,
    createdAt: proposal.createdAt,
    figmaUrl: proposal.figmaUrl,
    componentName: proposal.componentName,
    mode: proposal.mode,
    createMr: proposal.createMr,
    targetRepoPath: proposal.targetRepoPath,
    agentText: proposal.agentText,
    playgroundUrl: proposal.playgroundUrl,
    figmaScreenshot: proposal.figmaScreenshot
      ? {
          mimeType: proposal.figmaScreenshot.mimeType,
          dataUrl: proposal.figmaScreenshot.dataUrl,
          byteLength: proposal.figmaScreenshot.byteLength,
          fileKey: proposal.figmaScreenshot.fileKey,
          nodeId: proposal.figmaScreenshot.nodeId,
          capturedAt: proposal.figmaScreenshot.capturedAt,
        }
      : undefined,
    files: proposal.files.map((file) => ({
      path: file.path,
      action: file.action,
      summary: file.summary,
      contents: file.contents,
      bytes: Buffer.byteLength(file.contents, 'utf8'),
    })),
  };
}

/** Deep-link into the target repo preview for a generated component. */
export function buildComponentPreviewUrl(
  baseUrl: string,
  componentName: string,
  profile: TargetFrontendProfile,
): string {
  return buildPreviewDeepLink(baseUrl, profile, componentName);
}
