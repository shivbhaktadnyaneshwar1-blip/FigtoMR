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

export type GitHost = 'github' | 'gitlab';

export function parseGitHost(value: unknown): GitHost {
  if (value === undefined || value === null || value === '' || value === 'gitlab') return 'gitlab';
  if (value === 'github') return 'github';
  throw new Error('gitHost must be "github" or "gitlab".');
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
  /** Studio toggle. Defaults to GitLab. */
  readonly gitHost?: GitHost;
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
  const stamp = new Date()
    .toISOString()
    .replace(/[-:TZ.]/g, '')
    .slice(0, 14);
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
    await git(repoPath, ['stash', 'push', '-u', '-m', `figto-mr-prepare:${branchName}`]);
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

export function buildReviewRequest(input: {
  readonly gitHost: GitHost;
  readonly env: Pick<StudioEnv, 'GITLAB_API_URL' | 'GITHUB_API_URL'>;
  readonly token: string;
  readonly projectPath: string;
  readonly branchName: string;
  readonly baseBranch: string;
  readonly title: string;
  readonly description: string;
}): { url: string; init: RequestInit } {
  if (input.gitHost === 'github') {
    const parts = input.projectPath.split('/').filter(Boolean);
    if (parts.length !== 2) {
      throw new Error('GIT_REMOTE_PROJECT must be owner/repo for a GitHub pull request.');
    }
    const [owner, repo] = parts;
    return {
      url: `${input.env.GITHUB_API_URL.replace(/\/$/, '')}/repos/${owner}/${repo}/pulls`,
      init: {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${input.token}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body: JSON.stringify({
          title: input.title,
          body: input.description,
          head: input.branchName,
          base: input.baseBranch,
        }),
      },
    };
  }

  const project = encodeURIComponent(input.projectPath);
  return {
    url: `${input.env.GITLAB_API_URL.replace(/\/$/, '')}/projects/${project}/merge_requests`,
    init: {
      method: 'POST',
      headers: {
        'PRIVATE-TOKEN': input.token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        source_branch: input.branchName,
        target_branch: input.baseBranch,
        title: input.title,
        description: input.description,
        remove_source_branch: true,
      }),
    },
  };
}

/**
 * Commit agent writes on the current feature branch, push, and open a GitHub pull
 * request or GitLab merge request for the selected host.
 *
 * Only stages the provided component-authoring paths — never the whole working tree.
 */
export async function commitAndOpenMergeRequest(
  input: OpenMergeRequestInput,
): Promise<CreateMergeRequestResult> {
  const { repoPath, env, branchName, commitMessage, title, description } = input;
  const remote = targetGitRemote(env);
  const baseBranch = gitMrTargetBranch(env) || targetGitBaseBranch(env);
  const gitHost = input.gitHost ?? 'gitlab';
  const token = (gitHost === 'github' ? env.GITHUB_TOKEN : env.GITLAB_TOKEN)?.trim();
  const reviewName = gitHost === 'github' ? 'pull request' : 'merge request';

  if (!token) {
    throw new Error(
      gitHost === 'github'
        ? 'GITHUB_TOKEN is required to create a pull request.'
        : 'GITLAB_TOKEN is required to create a merge request.',
    );
  }

  const files = [...new Set(input.files.map((f) => f.replace(/\\/g, '/')))].filter(Boolean);
  if (files.length === 0) {
    throw new Error('No generated component files were written before opening an MR.');
  }

  const rejected = files.filter((file) => !isAllowedStudioMrPath(file, input.targetProfile));
  if (rejected.length > 0) {
    throw new Error(
      `Refusing to MR non-component paths (COMPONENT_AUTHORING only): ${rejected.join(', ')}`,
    );
  }

  const hasComponentFolder = files.some((file) =>
    file.startsWith(
      `${(input.targetProfile?.componentRoot ?? 'src/components').replace(/\/$/, '')}/`,
    ),
  );
  if (!hasComponentFolder) {
    throw new Error(
      'MR must include sources under the detected component root. ' + `Got: ${files.join(', ')}`,
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
    throw new Error(`Set GIT_REMOTE_PROJECT (e.g. org/repo) to open a ${reviewName}.`);
  }
  const request = buildReviewRequest({
    gitHost,
    env,
    token,
    projectPath,
    branchName,
    baseBranch,
    title,
    description,
  });
  const response = await fetch(request.url, request.init);

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `${gitHost === 'github' ? 'GitHub pull request' : 'GitLab merge request'} create failed (${response.status}): ${body}`,
    );
  }

  const payload = (await response.json()) as {
    iid?: number;
    number?: number;
    web_url?: string;
    html_url?: string;
  };
  const mrIid = payload.iid ?? payload.number;
  const webUrl = payload.web_url ?? payload.html_url;
  if (!mrIid || !webUrl) {
    throw new Error(`${reviewName} response is missing a URL.`);
  }

  logger.info(`Opened ${reviewName} !${mrIid}: ${webUrl} (${files.length} file(s))`);
  return {
    branchName,
    mrUrl: webUrl,
    mrIid,
    webUrl,
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
  logger.info(
    `Pushed refine commit ${commitSha.slice(0, 8)} to ${branchName} (${files.length} file(s))`,
  );
  return { pushed: true, commitSha };
}
