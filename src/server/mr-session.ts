import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  gitMrTargetBranch,
  gitRemoteProject,
  targetGitBaseBranch,
  targetGitRemote,
  targetRepoPathFromEnv,
  type StudioEnv,
} from '../config/env.js';
import { inspectTargetFrontendProfile } from '../target/frontend-profile.js';
import { toPascalCase } from '../utils/names.js';
import { saveStudioSession, type StudioSession } from './session-store.js';

const execFileAsync = promisify(execFile);

type GitLabMergeRequest = {
  iid: number;
  source_branch: string;
  web_url: string;
};

type GitLabMergeRequestChanges = GitLabMergeRequest & {
  changes?: Array<{
    old_path?: string;
    new_path?: string;
  }>;
};

function parseConfiguredMrUrl(mrUrl: string, env: StudioEnv): number {
  let url: URL;
  try {
    url = new URL(mrUrl);
  } catch {
    throw new Error('Paste a valid GitLab merge request URL.');
  }

  if (url.protocol !== 'https:' && url.hostname !== 'localhost') {
    throw new Error('GitLab MR URL must use HTTPS.');
  }

  const marker = '/-/merge_requests/';
  const markerIndex = url.pathname.indexOf(marker);
  if (markerIndex < 1) {
    throw new Error('URL is not a GitLab merge request URL.');
  }

  const projectPath = decodeURIComponent(url.pathname.slice(1, markerIndex)).replace(/\/+$/, '');
  const configured = gitRemoteProject(env);
  if (configured && projectPath !== configured) {
    throw new Error(
      `MR belongs to "${projectPath}", but Studio is configured for "${configured}".`,
    );
  }

  const iid = Number(url.pathname.slice(markerIndex + marker.length).split('/')[0]);
  if (!Number.isSafeInteger(iid) || iid <= 0) {
    throw new Error('GitLab MR URL does not contain a valid IID.');
  }
  return iid;
}

function componentNameFromChanges(changes: GitLabMergeRequestChanges['changes']): string {
  const roots = new Set<string>();
  for (const change of changes ?? []) {
    for (const path of [change.new_path, change.old_path]) {
      const match = path?.match(/^src\/(?:custom-components|components)\/([^/]+)\//);
      if (match?.[1]) roots.add(match[1]);
    }
  }

  if (roots.size === 0) {
    throw new Error(
      'Could not infer a component from the MR changes. Expected files under src/custom-components/<name>/ or src/components/<name>/.',
    );
  }
  if (roots.size > 1) {
    throw new Error(`MR changes multiple components: ${[...roots].join(', ')}.`);
  }
  return toPascalCase([...roots][0]!);
}

async function git(repoPath: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', repoPath, ...args], {
    maxBuffer: 20 * 1024 * 1024,
  });
  return stdout.trim();
}

export async function checkoutBranchForInspection(input: {
  repoPath: string;
  env: StudioEnv;
  branchName?: string;
}): Promise<string> {
  const { repoPath, env } = input;
  const branchName =
    input.branchName?.trim() || gitMrTargetBranch(env) || targetGitBaseBranch(env);

  const dirty = await git(repoPath, ['status', '--porcelain']);
  if (dirty) {
    throw new Error(
      `Cannot check branch "${branchName}" while ${repoPath} has uncommitted changes. Commit or stash them first.`,
    );
  }

  const remote = targetGitRemote(env);
  await git(repoPath, ['fetch', remote, branchName]);
  await git(repoPath, ['checkout', '-B', branchName, `${remote}/${branchName}`]);
  return branchName;
}

export async function attachMergeRequestSession(input: {
  mrUrl: string;
  env: StudioEnv;
}): Promise<StudioSession> {
  const { env } = input;
  const token = env.GITLAB_TOKEN?.trim();
  if (!token) {
    throw new Error('GITLAB_TOKEN is required to attach an existing merge request.');
  }

  const iid = parseConfiguredMrUrl(input.mrUrl, env);
  const projectPath = gitRemoteProject(env);
  if (!projectPath) {
    throw new Error('Set GIT_REMOTE_PROJECT to attach a merge request.');
  }
  const project = encodeURIComponent(projectPath);
  const response = await fetch(
    `${env.GITLAB_API_URL}/projects/${project}/merge_requests/${iid}/changes`,
    { headers: { 'PRIVATE-TOKEN': token } },
  );
  const rawText = await response.text();
  if (!response.ok) {
    throw new Error(`GitLab MR lookup failed (${response.status}): ${rawText.slice(0, 500)}`);
  }

  const mr = JSON.parse(rawText) as GitLabMergeRequestChanges;
  if (!mr.source_branch || !mr.web_url) {
    throw new Error('GitLab MR response is missing source branch information.');
  }

  const componentName = componentNameFromChanges(mr.changes);
  const repoPath = targetRepoPathFromEnv(env);
  await checkoutBranchForInspection({
    repoPath,
    env,
    branchName: mr.source_branch,
  });

  return saveStudioSession({
    componentName,
    targetRepoPath: repoPath,
    targetProfile: inspectTargetFrontendProfile(repoPath),
    branchName: mr.source_branch,
    mrUrl: mr.web_url,
    mrIid: mr.iid,
    requirePushConfirmation: true,
    env,
  });
}
