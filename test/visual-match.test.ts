import { describe, expect, it } from 'vitest';
import {
  formatVisualMismatchSummary,
  parseVisualGaps,
  parseVisualMatch,
} from '../src/agent/refine-agent.js';
import { parseVisualProgress } from '../src/server/visual-converge.js';

describe('parseVisualMatch', () => {
  it('reads VISUAL_MATCH true/false from agent text', () => {
    expect(parseVisualMatch('Looks good.\nVISUAL_MATCH: true')).toBe(true);
    expect(parseVisualMatch('Still off\nVISUAL_MATCH: false\n')).toBe(false);
    expect(parseVisualMatch('no marker here')).toBeUndefined();
  });
});

describe('parseVisualGaps', () => {
  it('reads MISSING bullets before VISUAL_MATCH', () => {
    const gaps = parseVisualGaps(`
CURRENT looks sparse.
MISSING:
- feature rows lack check-circle icons
- activation fee not struck through
- CTA is not full-width primary
SKYLAB MCP next
VISUAL_MATCH: false
`);
    expect(gaps).toEqual([
      'feature rows lack check-circle icons',
      'activation fee not struck through',
      'CTA is not full-width primary',
    ]);
  });

  it('reads inline GAPS list', () => {
    expect(parseVisualGaps('GAPS: missing badge; wrong spacing\nVISUAL_MATCH: false')).toEqual([
      'missing badge',
      'wrong spacing',
    ]);
  });
});

describe('formatVisualMismatchSummary', () => {
  it('builds retry headline + gap detail for AI Processing', () => {
    const copy = formatVisualMismatchSummary({
      iteration: 1,
      maxIterations: 3,
      gaps: ['no check icons', 'CTA not full width'],
      willRetry: true,
    });
    expect(copy.headline).toContain('Not matching with Figma — retrying');
    expect(copy.detail).toContain('no check icons');
    expect(copy.thoughts[0]).toContain('Not matching with Figma');
  });
});

describe('parseVisualProgress', () => {
  it('parses CLOSER / SAME / FARTHER from judge text', () => {
    expect(parseVisualProgress('CLOSER\nCTA is fuller width')).toBe('closer');
    expect(parseVisualProgress('SAME — still missing icons')).toBe('same');
    expect(parseVisualProgress('FARTHER\nInvented KPI chrome')).toBe('farther');
    expect(parseVisualProgress('no verdict')).toBe('unknown');
  });
});
