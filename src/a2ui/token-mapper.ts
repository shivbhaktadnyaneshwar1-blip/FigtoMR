const TEXT_VARIANTS = ['h1', 'h2', 'h3', 'h4', 'h5', 'p', 'strong', 'small'] as const;
const FLEX_GAPS = ['none', 'xs', 'sm', 'md', 'lg', 'xl'] as const;
const FLEX_JUSTIFY = ['start', 'end', 'center', 'space-between', 'stretch'] as const;
const FLEX_ALIGN = ['start', 'end', 'center', 'stretch'] as const;

export type TextVariant = (typeof TEXT_VARIANTS)[number];
export type FlexGap = (typeof FLEX_GAPS)[number];
export type FlexJustify = (typeof FLEX_JUSTIFY)[number];
export type FlexAlign = (typeof FLEX_ALIGN)[number];

export type LayoutPrimitive = 'Box' | 'FlexRow' | 'FlexColumn' | 'Row' | 'Col' | 'Fragment';

export interface FigmaLayoutHints {
  readonly layoutMode?: string | null;
  readonly itemSpacing?: number | null;
  readonly padding?: number | null;
  readonly primaryAxisAlignItems?: string | null;
  readonly counterAxisAlignItems?: string | null;
  readonly layoutWrap?: string | null;
  readonly fontSize?: number | null;
  readonly fontWeight?: number | null;
  readonly fills?: ReadonlyArray<{
    readonly type?: string;
    readonly color?: string;
    readonly hex?: string;
  }>;
  readonly name?: string | null;
  readonly type?: string | null;
}

const GAP_BREAKPOINTS: ReadonlyArray<readonly [number, FlexGap]> = [
  [0, 'none'],
  [6, 'xs'],
  [12, 'sm'],
  [18, 'md'],
  [24, 'lg'],
  [30, 'xl'],
];

export function mapSpacingToGap(px: number | null | undefined): FlexGap | undefined {
  if (px === null || px === undefined || Number.isNaN(px)) {
    return undefined;
  }
  if (px <= 0) {
    return 'none';
  }
  let closest: FlexGap = 'md';
  let best = Number.POSITIVE_INFINITY;
  for (const [tokenPx, token] of GAP_BREAKPOINTS) {
    const delta = Math.abs(px - tokenPx);
    if (delta < best) {
      closest = token;
      best = delta;
    }
  }
  return closest;
}

export function mapFontToTextVariant(
  fontSize?: number | null,
  fontWeight?: number | null,
): TextVariant {
  const size = fontSize ?? 14;
  const weight = fontWeight ?? 400;
  if (size >= 32) return 'h1';
  if (size >= 26) return 'h2';
  if (size >= 22) return 'h3';
  if (size >= 18) return 'h4';
  if (size >= 16 && weight >= 600) return 'h5';
  if (weight >= 600) return 'strong';
  if (size <= 12) return 'small';
  return 'p';
}

export function mapAlign(
  value?: string | null,
  axis: 'primary' | 'counter' = 'primary',
): FlexJustify | FlexAlign {
  const normalized = (value ?? '').toLowerCase();
  if (
    normalized.includes('space') ||
    normalized === 'spacebetween' ||
    normalized === 'space-between'
  ) {
    return 'space-between';
  }
  if (normalized.includes('center')) return 'center';
  if (
    normalized.includes('max') ||
    normalized.includes('end') ||
    normalized.includes('right') ||
    normalized.includes('bottom')
  ) {
    return 'end';
  }
  if (normalized.includes('stretch')) return 'stretch';
  return axis === 'primary' ? 'start' : 'stretch';
}

export function mapLayoutPrimitive(hints: FigmaLayoutHints): LayoutPrimitive {
  const mode = (hints.layoutMode ?? '').toUpperCase();
  const type = (hints.type ?? '').toUpperCase();
  const name = (hints.name ?? '').toLowerCase();

  if (name.includes('card') || name.includes('surface') || name.includes('panel')) {
    return 'Box';
  }
  if (mode === 'HORIZONTAL' || name.includes('row') || name.includes('inline')) {
    return 'FlexRow';
  }
  if (mode === 'VERTICAL' || name.includes('column') || name.includes('stack')) {
    return 'FlexColumn';
  }
  if (type === 'TEXT') {
    return 'Fragment';
  }
  if (type === 'FRAME' || type === 'GROUP' || type === 'COMPONENT' || type === 'INSTANCE') {
    return 'FlexColumn';
  }
  return 'Fragment';
}

const COLOR_TO_TOKEN: ReadonlyArray<readonly [RegExp, string]> = [
  [/success|green/i, 'var(--color-status-success-fg)'],
  [/warn|orange|amber/i, 'var(--color-status-warning-fg)'],
  [/error|danger|red/i, 'var(--color-status-danger-fg)'],
  [/info|blue/i, 'var(--color-status-info-fg)'],
  [/muted|subdued|secondary/i, 'var(--color-text-secondary)'],
];

export function mapColorToCssToken(input?: string | null): string | undefined {
  if (!input) {
    return undefined;
  }
  for (const [pattern, token] of COLOR_TO_TOKEN) {
    if (pattern.test(input)) {
      return token;
    }
  }
  if (input.startsWith('var(--')) {
    return input;
  }
  return 'var(--color-text-primary)';
}

export function mapControlPrimitive(name: string, type?: string | null): string {
  const haystack = `${name} ${type ?? ''}`.toLowerCase();
  if (haystack.includes('button') || haystack.includes('cta')) return 'Button';
  if (
    haystack.includes('badge') ||
    haystack.includes('chip') ||
    haystack.includes('tag') ||
    haystack.includes('pill')
  ) {
    return 'Tag';
  }
  if (haystack.includes('alert') || haystack.includes('banner') || haystack.includes('toast'))
    return 'Alert';
  if (haystack.includes('icon')) return 'Icon';
  if (
    haystack.includes('input') ||
    haystack.includes('select') ||
    haystack.includes('checkbox') ||
    haystack.includes('form')
  ) {
    return 'Form';
  }
  if (haystack.includes('table') || haystack.includes('grid')) return 'Table';
  if (haystack.includes('dialog') || haystack.includes('modal')) return 'Dialog';
  if (type?.toUpperCase() === 'TEXT') return 'Text';
  return mapLayoutPrimitive({ name, type });
}

export interface MappedNode {
  readonly primitive: string;
  readonly textVariant?: TextVariant;
  readonly gap?: FlexGap;
  readonly justify?: FlexJustify;
  readonly align?: FlexAlign;
  readonly wrap?: boolean;
  readonly colorToken?: string;
}

export function mapFigmaHints(hints: FigmaLayoutHints): MappedNode {
  const primitive = mapControlPrimitive(hints.name ?? '', hints.type);
  return {
    primitive,
    textVariant:
      primitive === 'Text' ? mapFontToTextVariant(hints.fontSize, hints.fontWeight) : undefined,
    gap: mapSpacingToGap(hints.itemSpacing ?? hints.padding),
    justify: mapAlign(hints.primaryAxisAlignItems, 'primary') as FlexJustify,
    align: mapAlign(hints.counterAxisAlignItems, 'counter') as FlexAlign,
    wrap: (hints.layoutWrap ?? '').toUpperCase() === 'WRAP',
    colorToken: mapColorToCssToken(
      hints.fills?.[0]?.hex ?? hints.fills?.[0]?.color ?? hints.name,
    ),
  };
}
