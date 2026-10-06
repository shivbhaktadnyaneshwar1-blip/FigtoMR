import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { sanitizeRenderTsx } from '../generation/scaffold.js';
import { toKebabCase } from './names.js';
import { logger } from './logger.js';
import type { TargetFrontendProfile } from '../target/frontend-profile.js';

export interface WritePlanFile {
  readonly relativePath: string;
  readonly contents: string;
}

export interface WritePlan {
  readonly repoPath: string;
  readonly dryRun: boolean;
  readonly files: WritePlanFile[];
}

export interface WriteResult {
  readonly written: string[];
  readonly skipped: string[];
  readonly dryRun: boolean;
}

function ensureParent(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}

function prepareContents(relativePath: string, contents: string): string {
  const normalized = relativePath.replace(/\\/g, '/');
  let next = contents;
  if (
    (normalized.startsWith('src/components/') || normalized.startsWith('src/custom-components/')) &&
    normalized.endsWith('.tsx')
  ) {
    next = sanitizeRenderTsx(next);
  }
  return next.endsWith('\n') ? next : `${next}\n`;
}

export function applyWritePlan(plan: WritePlan): WriteResult {
  const written: string[] = [];
  const skipped: string[] = [];

  for (const file of plan.files) {
    const absolute = join(plan.repoPath, file.relativePath);
    if (plan.dryRun) {
      logger.info(`[dry-run] would write ${file.relativePath}`);
      skipped.push(file.relativePath);
      continue;
    }
    ensureParent(absolute);
    writeFileSync(absolute, prepareContents(file.relativePath, file.contents), 'utf8');
    written.push(file.relativePath);
    logger.info(`Wrote ${file.relativePath}`);
  }

  return { written, skipped, dryRun: plan.dryRun };
}

/** Paths FigtoMR may commit: one generated React component folder. */
export function isAllowedStudioMrPath(
  relativePath: string,
  profile?: Pick<TargetFrontendProfile, 'componentRoot'>,
): boolean {
  const normalized = relativePath.replace(/\\/g, '/');
  const root = profile?.componentRoot ?? 'src/components';
  return normalized.startsWith(`${root.replace(/\/$/, '')}/`);
}

/**
 * Narrow allowlisted paths to the current proposal component.
 * Prevents leftover component folders from prior runs from entering the MR.
 */
export function isProposalScopedPath(
  relativePath: string,
  componentName: string | undefined,
  profile?: Pick<TargetFrontendProfile, 'componentRoot'>,
): boolean {
  const normalized = relativePath.replace(/\\/g, '/');
  if (!isAllowedStudioMrPath(normalized, profile)) {
    return false;
  }
  if (!componentName?.trim()) {
    return true;
  }
  const kebab = toKebabCase(componentName);
  const root = profile?.componentRoot ?? 'src/components';
  return normalized.startsWith(`${root.replace(/\/$/, '')}/${kebab}/`);
}

export function filterToProposalScope(
  paths: readonly string[],
  componentName: string | undefined,
  profile?: Pick<TargetFrontendProfile, 'componentRoot'>,
): string[] {
  return [...new Set(paths.filter((p) => isProposalScopedPath(p, componentName, profile)))];
}
