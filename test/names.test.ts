import { describe, expect, it } from 'vitest';
import { symbolPrefix, toKebabCase, toPascalCase } from '../src/utils/names.js';

describe('names', () => {
  it('converts titles to PascalCase and kebab-case', () => {
    expect(toPascalCase('summary card')).toBe('SummaryCard');
    expect(toKebabCase('SummaryCard')).toBe('summary-card');
    expect(symbolPrefix('SummaryCard')).toBe('SummaryCard');
  });

  it('rejects empty or illegal names', () => {
    expect(() => toPascalCase('***')).toThrow();
    expect(() => toKebabCase('***')).toThrow();
  });
});
