import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  attachProposalSession,
  deleteProposal,
  readComponentFilesFromDisk,
  saveProposal,
  syncProposalFilesFromDisk,
  syncProposalFilesForSession,
} from '../src/server/proposal-store.js';
import type { StudioEnv } from '../src/config/env.js';
import type { TargetFrontendProfile } from '../src/target/frontend-profile.js';

const stubEnv = { STUDIO_PREVIEW_URL: 'http://localhost:5174' } as StudioEnv;
const profile: TargetFrontendProfile = {
  framework: 'react',
  componentRoot: 'src/components',
  componentTestLocation: 'colocated',
  formatter: 'none',
  scripts: {},
  previewPath: '/#/components/{{componentName}}',
  detectionNotes: [],
};

const created: string[] = [];

afterEach(() => {
  for (const id of created.splice(0)) {
    deleteProposal(id);
  }
});

describe('readComponentFilesFromDisk / syncProposalFilesFromDisk', () => {
  it('replaces scaffold snapshot with on-disk refine output', () => {
    const repo = mkdtempSync(join(tmpdir(), 'figto-mr-proposal-sync-'));
    const dir = join(repo, 'src/components/widget-x');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'WidgetX.tsx'), 'export const AFTER = true;\n', 'utf8');
    writeFileSync(join(dir, 'props.ts'), 'export const props = 1;\n', 'utf8');

    const fromDisk = readComponentFilesFromDisk(repo, 'WidgetX', profile);
    expect(fromDisk.map((f) => f.path)).toContain(
      'src/components/widget-x/WidgetX.tsx',
    );
    expect(
      fromDisk.find((f) => f.path.endsWith('/WidgetX.tsx'))?.contents,
    ).toContain('AFTER');

    const proposal = saveProposal({
      createMr: false,
      targetRepoPath: repo,
      targetProfile: profile,
      componentName: 'WidgetX',
      agentText: 'scaffold',
      env: stubEnv,
      files: [
        {
          path: 'src/components/widget-x/WidgetX.tsx',
          action: 'create',
          contents: 'export const BEFORE = true;\n',
        },
      ],
    });
    created.push(proposal.id);

    const synced = syncProposalFilesFromDisk(proposal.id);
    expect(synced).toBeDefined();
    const render = synced!.files.find((f) => f.path.endsWith('/WidgetX.tsx'));
    expect(render?.contents).toContain('AFTER');
    expect(render?.contents).not.toContain('BEFORE');
  });

  it('syncs via staged session id', () => {
    const repo = mkdtempSync(join(tmpdir(), 'figto-mr-proposal-sess-'));
    const dir = join(repo, 'src/components/sess-widget');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SessWidget.tsx'), 'export const SESS = 1;\n', 'utf8');

    const proposal = saveProposal({
      createMr: false,
      targetRepoPath: repo,
      targetProfile: profile,
      componentName: 'SessWidget',
      agentText: '',
      env: stubEnv,
      files: [
        {
          path: 'src/components/sess-widget/SessWidget.tsx',
          action: 'create',
          contents: 'export const OLD = 0;\n',
        },
      ],
    });
    created.push(proposal.id);
    attachProposalSession(proposal.id, 'session-abc');

    const synced = syncProposalFilesForSession('session-abc');
    expect(synced?.files.find((f) => f.path.endsWith('/SessWidget.tsx'))?.contents).toContain(
      'SESS',
    );
  });
});
