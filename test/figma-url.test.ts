import { describe, expect, it } from 'vitest';
import {
  parseFigmaUrl,
  requireNodeId,
  toColonNodeId,
  toDashedNodeId,
} from '../src/utils/figma-url.js';

describe('parseFigmaUrl', () => {
  it('extracts fileKey and converts dashed node ids to colon form', () => {
    const parsed = parseFigmaUrl(
      'https://www.figma.com/design/AbCdEfGhIjKlMnOpQrStUv/Summary-Card?node-id=123-456',
    );
    expect(parsed.fileKey).toBe('AbCdEfGhIjKlMnOpQrStUv');
    expect(parsed.nodeId).toBe('123:456');
    expect(parsed.nodeIdDashed).toBe('123-456');
    expect(parsed.title).toBe('Summary-Card');
    expect(parsed.kind).toBe('design');
  });

  it('accepts colon node ids and %3A encodings', () => {
    const parsed = parseFigmaUrl(
      'https://figma.com/file/AbCdEfGhIjKlMnOpQrStUv/Title?node-id=12%3A34',
    );
    expect(parsed.kind).toBe('file');
    expect(parsed.nodeId).toBe('12:34');
  });

  it('uses branchKey as fileKey for branch URLs', () => {
    const parsed = parseFigmaUrl(
      'https://www.figma.com/design/AbCdEfGhIjKlMnOpQrStUv/branch/ZyXwVuTsRqPoNmLkJiHgFe/Name?node-id=1-2',
    );
    expect(parsed.fileKey).toBe('ZyXwVuTsRqPoNmLkJiHgFe');
    expect(parsed.branchKey).toBe('ZyXwVuTsRqPoNmLkJiHgFe');
    expect(parsed.nodeId).toBe('1:2');
  });

  it('defaults Make files to node 0:1', () => {
    const parsed = parseFigmaUrl('https://www.figma.com/make/AbCdEfGhIjKlMnOpQrStUv/Prototype');
    expect(parsed.kind).toBe('make');
    expect(parsed.nodeId).toBe('0:1');
  });

  it('rejects non-Figma hosts', () => {
    expect(() => parseFigmaUrl('https://example.com/design/abc')).toThrow(/figma.com/);
  });
});

describe('node id helpers', () => {
  it('normalizes dashed and colon ids', () => {
    expect(toColonNodeId('10-20')).toBe('10:20');
    expect(toDashedNodeId('10:20')).toBe('10-20');
  });

  it('requireNodeId throws when missing', () => {
    const parsed = parseFigmaUrl('https://www.figma.com/design/AbCdEfGhIjKlMnOpQrStUv/Title');
    expect(parsed.nodeId).toBeUndefined();
    expect(() => requireNodeId(parsed)).toThrow(/node-id/);
  });
});
