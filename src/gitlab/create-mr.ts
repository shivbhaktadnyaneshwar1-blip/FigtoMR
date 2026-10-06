import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  gitMrTargetBranch,
  gitRemoteProject,
  targetGitBaseBranch,
  targetGitRemote,
  type StudioEnv,
} from '../config/env.js';
import { isAllowedStudioMrPath } from '../utils/file-writer.js';
import { logger } from '../utils/logger.js';
import type { TargetFrontendProfile } from '../target/frontend-profile.js';

const execFileAsync = promisify(execFile);

export interface PrepareBranchInput {
  readonly repoPath: string;
  readonly env: StudioEnv;
  readonly branchName: string;
}

export interface OpenMergeRequestInput {
  readonly repoPath: string;
  readonly env: StudioEnv;
  readonly branchName: string;
  readonly commitMessage: string;
  readonly title: string;
  readonly description: string;
  /** Required: only these relative paths are staged (never `git add -A`). */
  readonly files: readonly string[];
  readonly targetProfile?: Pick<TargetFrontendProfile, 'componentRoot'>;
}

export interface CreateMergeRequestResult {
  readonly branchName: string;
  readonly mrUrl: string;
  readonly mrIid: number;
  readonly webUrl: string;
}

async function git(repoPath: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', repoPath, ...args], {
    maxBuffer: 20 * 1024 * 1024,
  });
  return stdout.trim();
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

export function buildFeatureBranchName(componentName?: string): string {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  const slug = componentName ? slugify(componentName) : 'figma-component';
  return `studio/${slug}-${stamp}`;
}

/**
 * Fetch the remote base branch and create the Studio feature branch.
 *
 * After stage/refine the target repo tree can be dirty with generated component changes.
 * We stash that WIP, branch from the remote base, then restore so checkout never aborts
 * and Approve can commit/push the existing Studio work on the new branch.
 */
export async function prepareFeatureBranch(input: PrepareBranchInput): Promise<string> {
  const { repoPath, env, branchName } = input;
  const remote = targetGitRemote(env);
  const baseBranch = gitMrTargetBranch(env) || targetGitBaseBranch(env);
  await git(repoPath, ['fetch', remote, baseBranch]);

  const porcelain = await git(repoPath, ['status', '--porcelain']);
  const dirty = porcelain.length > 0;
  let stashed = false;

  if (dirty) {
    await git(repoPath, [
      'stash',
      'push',
      '-u',
      '-m',
      `figto-mr-prepare:${branchName}`,
    ]);
    stashed = true;
    logger.info(`Stashed local the target repo changes before switching to ${branchName}`);
  }

  try {
    await git(repoPath, ['checkout', '-B', branchName, `${remote}/${baseBranch}`]);
  } catch (error) {
    if (stashed) {
      await git(repoPath, ['stash', 'pop']).catch(() => undefined);
    }
    throw error;
  }

  if (stashed) {
    await restoreStashedStudioChanges(repoPath, branchName);
  }

  logger.info(
    `Prepared branch ${branchName} from ${remote}/${baseBranch}` +
      (dirty ? ' (preserved local Studio changes)' : ''),
  );
  return branchName;
}

/** Prefer stashed Studio working-tree files when stash pop conflicts. */
async function restoreStashedStudioChanges(repoPath: string, branchName: string): Promise<void> {
  try {
    await git(repoPath, ['stash', 'pop']);
    return;
  } catch (error) {
    logger.warn(
      `Stash pop onto ${branchName} reported conflicts — keeping Studio working-tree versions. ${
        error instanceof Error ? error.message : String(error)
      }`.slice(0, 400),
    );
  }

  try {
    const conflicted = (await git(repoPath, ['diff', '--name-only', '--diff-filter=U']))
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    for (const file of conflicted) {
      // During `stash pop`, "theirs" is the stashed Studio WIP.
      try {
        await git(repoPath, ['checkout', '--theirs', '--', file]);
      } catch {
        await git(repoPath, ['checkout', '--ours', '--', file]);
      }
      await git(repoPath, ['add', '--', file]);
    }
    // Drop the stash entry if pop left it applied-with-conflicts.
    await git(repoPath, ['stash', 'drop']).catch(() => undefined);
  } catch (resolveError) {
    logger.warn(
      `Could not fully resolve stash conflicts on ${branchName}; continuing — Approve will rewrite the component files. ${
        resolveError instanceof Error ? resolveError.message : String(resolveError)
      }`.slice(0, 300),
    );
  }
}

/**
 * Commit agent writes on the current feature branch, push, and open a GitLab MR
 * against the target repo (`your target repo`).
 *
 * Only stages the provided component-authoring paths — never the whole working tree.
 */
export async function commitAndOpenMergeRequest(
  input: OpenMergeRequestInput,
): Promise<CreateMergeRequestResult> {
  const { repoPath, env, branchName, commitMessage, title, description } = input;
  const remote = targetGitRemote(env);
  const baseBranch = gitMrTargetBranch(env) || targetGitBaseBranch(env);
  const token = env.GITLAB_TOKEN;

  if (!token) {
    throw new Error('GITLAB_TOKEN is required to create a merge request.');
  }

  const files = [...new Set(input.files.map((f) => f.replace(/\\/g, '/')))].filter(Boolean);
  if (files.length === 0) {
    throw new Error(
      'No generated component files were written before opening an MR.',
    );
  }

  const rejected = files.filter((file) => !isAllowedStudioMrPath(file, input.targetProfile));
  if (rejected.length > 0) {
    throw new Error(
      `Refusing to MR non-component paths (COMPONENT_AUTHORING only): ${rejected.join(', ')}`,
    );
  }

  const hasComponentFolder = files.some(
    (file) =>
      file.startsWith(
        `${(input.targetProfile?.componentRoot ?? 'src/components').replace(/\/$/, '')}/`,
      ),
  );
  if (!hasComponentFolder) {
    throw new Error(
      'MR must include sources under the detected component root. ' +
        `Got: ${files.join(', ')}`,
    );
  }

  await git(repoPath, ['add', '--', ...files]);

  const status = await git(repoPath, ['status', '--porcelain', '--', ...files]);
  if (!status) {
    throw new Error(
      `No staged changes for component files: ${files.join(', ')}. Did write_generated_files run with dryRun=false?`,
    );
  }

  await git(repoPath, ['commit', '-m', commitMessage]);
  await git(repoPath, ['push', '-u', remote, branchName]);

  const projectPath = gitRemoteProject(env);
  if (!projectPath) {
    throw new Error('Set GIT_REMOTE_PROJECT (e.g. org/repo) to open a merge request.');
  }
  const project = encodeURIComponent(projectPath);
  const response = await fetch(`${env.GITLAB_API_URL}/projects/${project}/merge_requests`, {
    method: 'POST',
    headers: {
      'PRIVATE-TOKEN': token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      source_branch: branchName,
      target_branch: baseBranch,
      title,
      description,
      remove_source_branch: true,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitLab MR create failed (${response.status}): ${body}`);
  }

  const payload = (await response.json()) as {
    iid: number;
    web_url: string;
  };

  logger.info(`Opened MR !${payload.iid}: ${payload.web_url} (${files.length} file(s))`);
  return {
    branchName,
    mrUrl: payload.web_url,
    mrIid: payload.iid,
    webUrl: payload.web_url,
  };
}

/**
 * Commit allowlisted files on the current branch and push (no new MR).
 * Used after Studio chat refinements on an already-open MR branch.
 */
export async function commitAndPushChanges(input: {
  readonly repoPath: string;
  readonly env: StudioEnv;
  readonly branchName: string;
  readonly commitMessage: string;
  readonly files: readonly string[];
  readonly targetProfile?: Pick<TargetFrontendProfile, 'componentRoot'>;
}): Promise<{ pushed: boolean; commitSha?: string }> {
  const { repoPath, env, branchName, commitMessage } = input;
  const remote = targetGitRemote(env);
  const files = [...new Set(input.files.map((f) => f.replace(/\\/g, '/')))].filter(Boolean);
  if (files.length === 0) {
    return { pushed: false };
  }

  const rejected = files.filter((file) => !isAllowedStudioMrPath(file, input.targetProfile));
  if (rejected.length > 0) {
    throw new Error(
      `Refusing to push non-component paths (COMPONENT_AUTHORING only): ${rejected.join(', ')}`,
    );
  }

  await git(repoPath, ['checkout', branchName]);
  await git(repoPath, ['add', '--', ...files]);
  const status = await git(repoPath, ['status', '--porcelain', '--', ...files]);
  if (!status) {
    logger.info('No staged refine changes to push.');
    return { pushed: false };
  }

  await git(repoPath, ['commit', '-m', commitMessage]);
  const commitSha = await git(repoPath, ['rev-parse', 'HEAD']);
  await git(repoPath, ['push', remote, branchName]);
  logger.info(`Pushed refine commit ${commitSha.slice(0, 8)} to ${branchName} (${files.length} file(s))`);
  return { pushed: true, commitSha };
}
