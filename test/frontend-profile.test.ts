import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertSupportedFrontendProfile,
  buildPreviewDeepLink,
  inspectTargetFrontendProfile,
  profileFromEnv,
  type TargetFrontendProfile,
} from '../src/target/frontend-profile.js';
import { reactTypeScriptGenerator } from '../src/generation/react-generator.js';

describe('target frontend profile', () => {
  it('detects a React target and component conventions', () => {
    const repo = mkdtempSync(join(tmpdir(), 'figto-mr-react-'));
    mkdirSync(join(repo, 'src/components'), { recursive: true });
    writeFileSync(
      join(repo, 'package.json'),
      JSON.stringify({
        dependencies: { react: '^19.0.0' },
        scripts: { build: 'vite build', test: 'vitest run', playground: 'vite' },
      }),
    );

    const profile = inspectTargetFrontendProfile(repo);
    expect(profile.framework).toBe('react');
    expect(profile.componentRoot).toBe('src/components');
    expect(profile.scripts.preview).toBe('playground');
    expect(buildPreviewDeepLink('http://localhost:5173/', profile, 'Summary Card')).toBe(
      'http://localhost:5173/#/components/Summary%20Card',
    );
  });

  it('merges an explicit environment profile and rejects unknown frameworks by default', () => {
    const repo = mkdtempSync(join(tmpdir(), 'figto-mr-unknown-'));
    const profile = profileFromEnv(repo, {
      TARGET_FRONTEND_PROFILE: JSON.stringify({
        framework: 'react',
        componentRoot: 'ui/components',
        scripts: { test: 'check' },
      }),
    });
    expect(profile.componentRoot).toBe('ui/components');
    expect(profile.scripts.test).toBe('check');
    expect(() => assertSupportedFrontendProfile(inspectTargetFrontendProfile(repo))).toThrow(
      'Unsupported target frontend',
    );
  });

  it('uses the detected component root through the React generator interface', () => {
    const profile: TargetFrontendProfile = {
      framework: 'react',
      componentRoot: 'ui/components',
      componentTestLocation: 'colocated',
      formatter: 'none',
      scripts: {},
      previewPath: '/components/{{componentName}}',
      detectionNotes: [],
    };
    const result = reactTypeScriptGenerator.generate(
      {
        pascalName: 'FigmaCard',
        description: 'Card from Figma.',
        rendererJsx: '<h2>{title}</h2>',
        props: [],
      },
      profile,
    );
    expect(Object.keys(result.files)).toContain('ui/components/figma-card/FigmaCard.tsx');
  });
});
