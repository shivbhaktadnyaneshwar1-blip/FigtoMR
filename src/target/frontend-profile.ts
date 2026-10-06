import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { StudioEnv } from '../config/env.js';

export type FrontendFramework = 'react' | 'unknown';

export interface TargetFrontendProfile {
  readonly framework: FrontendFramework;
  readonly componentRoot: string;
  readonly componentTestLocation: 'colocated';
  readonly formatter: 'biome' | 'none';
  readonly scripts: {
    readonly build?: string;
    readonly lint?: string;
    readonly test?: string;
    readonly typecheck?: string;
    readonly preview?: string;
  };
  readonly previewPath: string;
  readonly detectionNotes: readonly string[];
}

type PackageManifest = {
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
  readonly scripts?: Record<string, string>;
};

function readPackageManifest(repoPath: string): PackageManifest | undefined {
  const path = join(repoPath, 'package.json');
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as PackageManifest;
  } catch {
    return undefined;
  }
}

function dependencyNames(manifest: PackageManifest | undefined): Set<string> {
  return new Set([
    ...Object.keys(manifest?.dependencies ?? {}),
    ...Object.keys(manifest?.devDependencies ?? {}),
  ]);
}

function firstExistingScript(
  scripts: Record<string, string> | undefined,
  names: readonly string[],
): string | undefined {
  return names.find((name) => scripts?.[name] !== undefined);
}

/**
 * Infer a conservative frontend contract from a target checkout.
 * An unknown framework is intentionally not scaffolded: callers must ask for an
 * explicit profile rather than emitting code for the wrong stack.
 */
export function inspectTargetFrontendProfile(repoPath: string): TargetFrontendProfile {
  const manifest = readPackageManifest(repoPath);
  const dependencies = dependencyNames(manifest);
  const scripts = manifest?.scripts;
  const hasReact = dependencies.has('react') || dependencies.has('react-dom');
  const componentRoot = existsSync(join(repoPath, 'src', 'components'))
    ? 'src/components'
    : existsSync(join(repoPath, 'components'))
      ? 'components'
      : 'src/components';
  const formatter = existsSync(join(repoPath, 'biome.json')) || dependencies.has('@biomejs/biome')
    ? 'biome'
    : 'none';
  const framework: FrontendFramework = hasReact ? 'react' : 'unknown';
  const notes = [
    manifest ? 'package.json found' : 'No package.json found',
    hasReact ? 'React dependency found' : 'React dependency not found',
    `component root: ${componentRoot}`,
  ];

  return {
    framework,
    componentRoot,
    componentTestLocation: 'colocated',
    formatter,
    scripts: {
      build: firstExistingScript(scripts, ['build']),
      lint: firstExistingScript(scripts, ['lint:all', 'lint']),
      test: firstExistingScript(scripts, ['test']),
      typecheck: firstExistingScript(scripts, ['typecheck', 'lint:types']),
      preview: firstExistingScript(scripts, ['playground', 'dev', 'start']),
    },
    previewPath: '/#/components/{{componentName}}',
    detectionNotes: notes,
  };
}

/** Optional environment override for repositories with nonstandard layouts or scripts. */
export function profileFromEnv(
  repoPath: string,
  env: Pick<StudioEnv, 'TARGET_FRONTEND_PROFILE'>,
): TargetFrontendProfile {
  const detected = inspectTargetFrontendProfile(repoPath);
  const raw = env.TARGET_FRONTEND_PROFILE?.trim();
  if (!raw) return detected;
  try {
    const override = JSON.parse(raw) as Partial<TargetFrontendProfile>;
    return {
      ...detected,
      ...override,
      scripts: { ...detected.scripts, ...override.scripts },
      detectionNotes: [...detected.detectionNotes, 'TARGET_FRONTEND_PROFILE override applied'],
    };
  } catch {
    throw new Error('TARGET_FRONTEND_PROFILE must be valid JSON.');
  }
}

export function assertSupportedFrontendProfile(profile: TargetFrontendProfile): void {
  if (profile.framework !== 'react') {
    throw new Error(
      `Unsupported target frontend (${profile.detectionNotes.join('; ')}). ` +
        'FigtoMR currently generates React/TypeScript. Add React to the target repo or provide a future framework generator.',
    );
  }
}

export function buildPreviewDeepLink(
  baseUrl: string,
  profile: TargetFrontendProfile,
  componentName: string,
): string {
  return `${baseUrl.replace(/\/$/, '')}${profile.previewPath.replace(
    '{{componentName}}',
    encodeURIComponent(componentName),
  )}`;
}
