import { describe, expect, it } from 'vitest';
import {
  mapColorToCssToken,
  mapControlPrimitive,
  mapFigmaHints,
  mapFontToTextVariant,
  mapLayoutPrimitive,
  mapSpacingToGap,
} from '../src/generation/figma-scaffold.js';

describe('token-mapper', () => {
  it('maps AutoLayout frames to flex primitives', () => {
    expect(mapLayoutPrimitive({ layoutMode: 'HORIZONTAL' })).toBe('FlexRow');
    expect(mapLayoutPrimitive({ layoutMode: 'VERTICAL' })).toBe('FlexColumn');
    expect(mapLayoutPrimitive({ name: 'Payment card' })).toBe('Box');
  });

  it('maps typography and spacing onto generic layout tokens', () => {
    expect(mapFontToTextVariant(34, 600)).toBe('h1');
    expect(mapFontToTextVariant(14, 400)).toBe('p');
    expect(mapFontToTextVariant(11, 400)).toBe('small');
    expect(mapSpacingToGap(12)).toBe('sm');
    expect(mapSpacingToGap(0)).toBe('none');
  });

  it('maps controls and colors to HTML/CSS vocabulary', () => {
    expect(mapControlPrimitive('Primary CTA', 'INSTANCE')).toBe('Button');
    expect(mapControlPrimitive('Status badge')).toBe('Tag');
    expect(mapColorToCssToken('success green')).toBe('var(--color-status-success-fg)');
    expect(
      mapFigmaHints({ name: 'Title', type: 'TEXT', fontSize: 22, fontWeight: 600 }).textVariant,
    ).toBe('h3');
  });
});
