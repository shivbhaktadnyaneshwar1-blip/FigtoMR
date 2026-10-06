import { describe, expect, it } from 'vitest';
import { filterTscLogToPaths, stripAnsi, summarizeScopedErrors } from '../src/utils/target-repo-quality.js';

describe('target-repo-quality', () => {
  it('strips ANSI color codes', () => {
    expect(stripAnsi('\u001b[96msrc/foo.ts\u001b[0m')).toBe('src/foo.ts');
  });

  it('filters tsc diagnostics to scoped files only', () => {
    const log = `
src/custom-components/agent-dashboard/render.tsx(12,5): error TS2339: Property 's-flex-row' does not exist.
src/custom-components/old-junk/render.tsx(1,1): error TS2339: Property 's-flex-column' does not exist.
src/custom-components/agent-dashboard/render.tsx(13,1): error TS2322: Type mismatch.
`.trim();

    const filtered = filterTscLogToPaths(log, [
      'src/custom-components/agent-dashboard/render.tsx',
    ]);
    expect(filtered.ok).toBe(false);
    expect(filtered.errorCount).toBe(2);
    expect(filtered.log).toContain('agent-dashboard/render.tsx');
    expect(filtered.log).not.toContain('old-junk');
  });

  it('reports ok when scoped files have no errors', () => {
    const log = `
src/custom-components/old-junk/render.tsx(1,1): error TS2339: Property 's-flex-column' does not exist.
`.trim();
    const filtered = filterTscLogToPaths(log, ['src/custom-components/new-card/render.tsx']);
    expect(filtered.ok).toBe(true);
    expect(filtered.errorCount).toBe(0);
  });

  it('summarizes file+error lines for the UI', () => {
    const summary = summarizeScopedErrors(
      'src/custom-components/x/render.tsx(12,5): error TS2339: Property missing.\n  Type VNode is not assignable.',
    );
    expect(summary).toContain('render.tsx(12,5)');
    expect(summary).toContain('error TS2339');
  });
});
