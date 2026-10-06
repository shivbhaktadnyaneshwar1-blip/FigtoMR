import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareFeatureBranch } from '../src/gitlab/create-mr.js';
import type { StudioEnv } from '../src/config/env.js';

const cleanupRoots: string[] = [];

afterEach(() => {
  for (const root of cleanupRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TEMPLATE_DIR: '' },
  }).trim();
}

describe('prepareFeatureBranch', () => {
  it('switches to a new branch from remote base while keeping dirty Studio files', async () => {
    const root = mkdtempSync(join(process.cwd(), 'tmp-prepare-branch-'));
    cleanupRoots.push(root);
    const bare = join(root, 'remote.git');
    const repo = join(root, 'work');
    mkdirSync(bare, { recursive: true });
    git(bare, ['init', '--bare', '--template=']);

    mkdirSync(repo, { recursive: true });
    git(repo, ['init', '--template=']);
    git(repo, ['config', 'user.email', 'studio@test.local']);
    git(repo, ['config', 'user.name', 'Studio Test']);
    writeFileSync(join(repo, 'README.md'), 'base\n', 'utf8');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-m', 'init']);
    git(repo, ['branch', '-M', 'develop']);
    git(repo, ['remote', 'add', 'origin', bare]);
    git(repo, ['push', '-u', 'origin', 'develop']);

    // Dirty tree as after a staged component generation.
    writeFileSync(
      join(repo, 'README.md'),
      'base\npreview changed\n',
      'utf8',
    );
    mkdirSync(join(repo, 'src/components/return-summary-chart'), { recursive: true });
    writeFileSync(
      join(repo, 'src/components/return-summary-chart/ReturnSummaryChart.tsx'),
      'export const X = 1;\n',
      'utf8',
    );

    const env = {
      TARGET_GIT_REMOTE: 'origin',
      TARGET_GIT_BASE_BRANCH: 'develop',
      GIT_MR_TARGET_BRANCH: 'develop',
    } as StudioEnv;

    const branch = 'studio/returnsummarychart-test';
    await prepareFeatureBranch({ repoPath: repo, env, branchName: branch });

    expect(git(repo, ['branch', '--show-current'])).toBe(branch);
    expect(readFileSync(join(repo, 'README.md'), 'utf8')).toContain('preview changed');
    expect(
      readFileSync(join(repo, 'src/components/return-summary-chart/ReturnSummaryChart.tsx'), 'utf8'),
    ).toContain('export const X');
  });
});
