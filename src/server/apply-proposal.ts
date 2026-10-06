import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildFeatureBranchName,
  commitAndOpenMergeRequest,
  prepareFeatureBranch,
} from '../gitlab/create-mr.js';
import { studioPreviewUrl, type StudioEnv } from '../config/env.js';
import { applyWritePlan, isAllowedStudioMrPath } from '../utils/file-writer.js';
import { formatTargetRepoPaths } from '../utils/target-repo-format.js';
import { logger } from '../utils/logger.js';
import {
  buildComponentPreviewUrl,
  deleteProposal,
  getProposal,
  syncProposalFilesFromDisk,
  type ComponentProposal,
  type ProposedFileChange,
} from './proposal-store.js';

export interface ApplyProposalResult {
  readonly proposalId: string;
  readonly written: string[];
  readonly branchName?: string;
  readonly mrUrl?: string;
  readonly mrIid?: number;
  readonly playgroundUrl?: string;
  /** Post-MR chat session for refine + re-push. */
  readonly sessionId?: string;
}

export type ApplyStreamEvent =
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
  | { type: 'error'; message: string }
  | ({ type: 'result' } & ApplyProposalResult);

function existingAction(repoPath: string, relativePath: string): 'create' | 'update' {
  return existsSync(join(repoPath, relativePath)) ? 'update' : 'create';
}

function isComponentFile(
  path: string,
  contents: string,
  componentRoot = 'src/components',
): boolean {
  return (
    path.replace(/\\/g, '/').startsWith(`${componentRoot.replace(/\/$/, '')}/`) &&
    !contents.startsWith('// Preview only')
  );
}

/** Build the list of target-repo paths the agent expects to change. */
export function buildProposedChanges(input: {
  repoPath: string;
  generatedFiles: Record<string, string>;
  componentName?: string;
  componentRoot?: string;
}): ProposedFileChange[] {
  const files: ProposedFileChange[] = [];
  for (const [path, contents] of Object.entries(input.generatedFiles)) {
    const componentRoot = input.componentRoot ?? 'src/components';
    if (!isAllowedStudioMrPath(path, { componentRoot }) || !isComponentFile(path, contents, componentRoot)) {
      continue;
    }
    const action = existingAction(input.repoPath, path);
    files.push({
      path,
      action,
      contents,
      summary: `${action === 'create' ? 'Create' : 'Update'} ${path}`,
    });
  }
  return files;
}

export async function* streamApplyApprovedProposal(input: {
  proposalId: string;
  createMr?: boolean;
  env: StudioEnv;
}): AsyncGenerator<ApplyStreamEvent> {
  syncProposalFilesFromDisk(input.proposalId);
  const proposal = getProposal(input.proposalId);
  if (!proposal) {
    throw new Error(`Unknown or expired proposal "${input.proposalId}". Generate again.`);
  }

  const createMr = input.createMr ?? proposal.createMr;
  const repoPath = proposal.targetRepoPath;
  const componentFiles = proposal.files.filter((file) =>
    isComponentFile(file.path, file.contents, proposal.targetProfile.componentRoot),
  );

  if (componentFiles.length === 0) {
    throw new Error('Proposal has no component source files to apply.');
  }

  let branchName: string | undefined;
  if (createMr) {
    branchName = buildFeatureBranchName(proposal.componentName);
    yield { type: 'status', message: `Preparing branch ${branchName}…` };
    logger.info(`Preparing branch ${branchName} for approved proposal…`);
    await prepareFeatureBranch({
      repoPath,
      env: input.env,
      branchName,
    });
  }

  yield { type: 'status', message: 'Writing component files to the target repo…' };
  const writeResult = applyWritePlan({
    repoPath,
    dryRun: false,
    files: componentFiles.map((file) => ({
      relativePath: file.path,
      contents: file.contents,
    })),
  });

  const written = [...writeResult.written];
  const name = proposal.componentName;

  yield {
    type: 'status',
    message: 'Formatting written files when the target repo has a formatter…',
  };
  const biome =
    proposal.targetProfile.formatter === 'biome'
      ? await formatTargetRepoPaths(repoPath, written)
      : { ok: true, formatted: [], log: 'No formatter detected.' };
  yield {
    type: 'tool',
    name: 'format',
    label: biome.ok
      ? `Formatted ${biome.formatted.length} file(s)`
      : `Format notes on ${biome.formatted.length} file(s)`,
    detail: biome.log.slice(0, 400),
    phase: biome.ok ? 'done' : 'info',
    source: 'studio',
  };

  let mrUrl: string | undefined;
  let mrIid: number | undefined;

  if (createMr) {
    if (!branchName) {
      throw new Error('Missing branch name for MR.');
    }
    yield { type: 'status', message: 'Opening merge request…' };
    const mr = await commitAndOpenMergeRequest({
      repoPath,
      env: input.env,
      branchName,
      files: written,
      targetProfile: proposal.targetProfile,
      commitMessage: `feat: add ${name ?? 'component'} from Figma`,
      title: `feat: ${name ?? 'component'} from Figma`,
      description: [
        '## Summary',
        `- Generated from a Figma frame via FigtoMR (proposal \`${proposal.id}\`).`,
        proposal.figmaUrl ? `- Figma: ${proposal.figmaUrl}` : undefined,
        '',
        '## Files',
        ...written.map((file) => `- \`${file}\``),
        '',
        '## Notes',
        `- ${proposal.targetProfile.framework} component under \`${proposal.targetProfile.componentRoot}/<name>/\`.`,
        '- Generated from the target repository conventions. Review against the Figma frame before merge.',
      ]
        .filter(Boolean)
        .join('\n'),
    });
    mrUrl = mr.mrUrl;
    mrIid = mr.mrIid;
    branchName = mr.branchName;
    yield { type: 'status', message: `MR opened: ${mrUrl}` };
  }

  const playgroundUrl = name
    ? buildComponentPreviewUrl(studioPreviewUrl(input.env), name, proposal.targetProfile)
    : undefined;

  let sessionId: string | undefined;
  if (name) {
    const { saveStudioSession, updateStudioSession, getStudioSession } = await import(
      './session-store.js'
    );
    const existing = proposal.stagedSessionId
      ? getStudioSession(proposal.stagedSessionId)
      : undefined;
    if (existing) {
      updateStudioSession(existing.id, {
        branchName,
        mrUrl,
        mrIid,
        playgroundUrl,
      });
      sessionId = existing.id;
    } else {
      const session = saveStudioSession({
        componentName: name,
        targetRepoPath: repoPath,
        targetProfile: proposal.targetProfile,
        branchName,
        mrUrl,
        mrIid,
        figmaUrl: proposal.figmaUrl,
        playgroundUrl,
        env: input.env,
      });
      sessionId = session.id;
    }
  }

  deleteProposal(proposal.id);
  yield {
    type: 'result',
    proposalId: proposal.id,
    written,
    branchName,
    mrUrl,
    mrIid,
    playgroundUrl,
    sessionId,
  };
}

export async function applyApprovedProposal(input: {
  proposalId: string;
  createMr?: boolean;
  env: StudioEnv;
}): Promise<ApplyProposalResult> {
  let result: ApplyProposalResult | undefined;
  for await (const event of streamApplyApprovedProposal(input)) {
    if (event.type === 'result') {
      const { type: _type, ...rest } = event;
      result = rest;
    }
  }
  if (!result) {
    throw new Error('Apply finished without a result.');
  }
  return result;
}

export type { ComponentProposal };
