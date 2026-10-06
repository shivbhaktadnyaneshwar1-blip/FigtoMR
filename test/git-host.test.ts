import { describe, expect, it } from 'vitest';
import { buildReviewRequest, parseGitHost } from '../src/gitlab/create-mr.js';

const env = {
  GITLAB_API_URL: 'https://gitlab.example/api/v4',
  GITHUB_API_URL: 'https://api.github.com',
};

describe('parseGitHost', () => {
  it('defaults to gitlab and accepts github', () => {
    expect(parseGitHost(undefined)).toBe('gitlab');
    expect(parseGitHost('gitlab')).toBe('gitlab');
    expect(parseGitHost('github')).toBe('github');
    expect(() => parseGitHost('bitbucket')).toThrow(/gitHost/);
  });
});

describe('buildReviewRequest', () => {
  it('builds a GitHub pull request call', () => {
    const request = buildReviewRequest({
      gitHost: 'github',
      env,
      token: 'gh-token',
      projectPath: 'acme/widgets',
      branchName: 'studio/card-1',
      baseBranch: 'main',
      title: 'feat: card',
      description: 'from Figma',
    });
    expect(request.url).toBe('https://api.github.com/repos/acme/widgets/pulls');
    expect(request.init.headers).toMatchObject({
      Authorization: 'Bearer gh-token',
      Accept: 'application/vnd.github+json',
    });
    expect(JSON.parse(String(request.init.body))).toEqual({
      title: 'feat: card',
      body: 'from Figma',
      head: 'studio/card-1',
      base: 'main',
    });
  });

  it('builds a GitLab merge request call', () => {
    const request = buildReviewRequest({
      gitHost: 'gitlab',
      env,
      token: 'gl-token',
      projectPath: 'group/widgets',
      branchName: 'studio/card-1',
      baseBranch: 'main',
      title: 'feat: card',
      description: 'from Figma',
    });
    expect(request.url).toBe(
      'https://gitlab.example/api/v4/projects/group%2Fwidgets/merge_requests',
    );
    expect(request.init.headers).toMatchObject({ 'PRIVATE-TOKEN': 'gl-token' });
    expect(JSON.parse(String(request.init.body))).toMatchObject({
      source_branch: 'studio/card-1',
      target_branch: 'main',
      title: 'feat: card',
    });
  });

  it('requires owner/repo for GitHub', () => {
    expect(() =>
      buildReviewRequest({
        gitHost: 'github',
        env,
        token: 'gh-token',
        projectPath: 'group/team/widgets',
        branchName: 'studio/card-1',
        baseBranch: 'main',
        title: 'feat: card',
        description: 'from Figma',
      }),
    ).toThrow(/owner\/repo/);
  });
});
