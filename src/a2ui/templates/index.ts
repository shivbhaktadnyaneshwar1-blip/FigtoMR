import { symbolPrefix, toKebabCase } from '../../utils/names.js';

export interface ComponentScaffoldInput {
  readonly pascalName: string;
  readonly description: string;
  readonly props: ReadonlyArray<{
    readonly name: string;
    readonly zod: string;
    readonly describe: string;
    readonly required?: boolean;
    readonly defaultValue?: string;
  }>;
  readonly rendererJsx: string;
  readonly titleDefault?: string;
}

export interface GeneratedScaffoldFiles {
  readonly kebabName: string;
  readonly pascalName: string;
  readonly files: Record<string, string>;
}

function indentBlock(source: string, spaces = 6): string {
  const pad = ' '.repeat(spaces);
  return source
    .split('\n')
    .map((line) => (line.length === 0 ? line : `${pad}${line}`))
    .join('\n')
    .trimStart();
}

/** Strip Stencil JSX pragma — custom-component renderers must use React JSX. */
export function sanitizeRenderTsx(source: string): string {
  return source
    .replace(/^\/\*\*\s*@jsxImportSource\s+@stencil\/core\s*\*\/\s*\n?/m, '')
    .replace(/^\/\*\s*@jsxImportSource\s+@stencil\/core\s*\*\/\s*\n?/m, '')
    .replace(/^\/\/\s*@jsxImportSource\s+@stencil\/core\s*\n?/m, '');
}

/** Generic scaffolds use Zod in props.ts directly; no source migration is needed. */
export function ensureSchemaImports(source: string): string {
  return source;
}

function normalizePropZod(zodExpr: string): string {
  if (/DynamicStringSchema|DynamicNumberSchema|DynamicBooleanSchema/.test(zodExpr)) {
    if (zodExpr.includes('Boolean')) return 'z.boolean()';
    if (zodExpr.includes('Number')) return 'z.number()';
    return 'z.string()';
  }
  return zodExpr;
}

export function renderPropsTs(input: ComponentScaffoldInput): string {
  const symbol = symbolPrefix(input.pascalName);
  const props = input.props.length
    ? input.props
    : [
        {
          name: 'title',
          zod: 'z.string()',
          describe: 'Visible heading text from the Figma frame.',
          required: false,
          defaultValue: JSON.stringify(input.titleDefault ?? input.pascalName),
        },
      ];
  const fields = props
    .map((prop) => {
      const optional = prop.required ? '' : '.optional()';
      const fallback = prop.defaultValue ? `.default(${prop.defaultValue})` : '';
      const zod = normalizePropZod(prop.zod);
      return `  ${prop.name}: ${zod}.describe(${JSON.stringify(prop.describe)})${optional}${fallback},`;
    })
    .join('\n');

  return `import { z } from 'zod';

export const ${symbol}Schema = z
  .object({
${fields}
  })
  .strict();

export type ${symbol}Props = z.infer<typeof ${symbol}Schema>;
`;
}

export function renderComponentTsx(input: ComponentScaffoldInput): string {
  const symbol = symbolPrefix(input.pascalName);
  const kebab = toKebabCase(input.pascalName);
  const body =
    input.rendererJsx.trim() ||
    `<h2 className="title">{title}</h2>`;

  return `import type { FC } from 'react';
import { ${symbol}Schema, type ${symbol}Props } from './props';
import './${kebab}.css';

export const ${symbol}: FC<${symbol}Props> = (props) => {
  const parsed = ${symbol}Schema.parse(props);
  const { title = ${JSON.stringify(input.titleDefault ?? input.pascalName)}, ...rest } = parsed;
  void rest;
  return (
    <section className="${kebab}" data-testid="${kebab}">
      ${indentBlock(body.replace(/\bprops\./g, '').replace(/\{props\.title\}/g, '{title}'), 6)}
    </section>
  );
};

${symbol}.displayName = '${symbol}';
`;
}

export function renderCss(kebabName: string): string {
  return `.${kebabName} {
  color: var(--color-text-primary, #0e1d2f);
  display: flex;
  flex-direction: column;
  gap: var(--gap-md, 1rem);
  width: 100%;
  font-family: system-ui, sans-serif;
}

.${kebabName} .header-row,
.${kebabName} .flex-row {
  display: flex;
  flex-direction: row;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--gap-md, 1rem);
}

.${kebabName} .header-row {
  justify-content: space-between;
  inline-size: 100%;
}

.${kebabName} .kpi-row {
  display: flex;
  flex-direction: row;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: var(--gap-lg, 1.5rem);
  inline-size: 100%;
}

.${kebabName} .kpi-item,
.${kebabName} aui-kpi-large,
.${kebabName} aui-kpi-small {
  display: block;
  flex: 1 1 12rem;
  min-inline-size: 10rem;
  max-inline-size: 100%;
}

.${kebabName} .chart-shell,
.${kebabName} aui-barchart,
.${kebabName} aui-line-chart,
.${kebabName} aui-donut {
  display: block;
  inline-size: 100%;
  min-block-size: 12rem;
}

.${kebabName} .flex-column {
  display: flex;
  flex-direction: column;
  gap: var(--gap-xs, 0.35rem);
}

.${kebabName} .badge {
  display: inline-block;
  padding: 0.15rem 0.5rem;
  border-radius: 999px;
  font-size: 0.75rem;
  background: var(--color-surface-muted, #eef2f5);
}

.${kebabName} .price-row {
  align-items: baseline;
  gap: 0.35rem;
}

.${kebabName} .price-value {
  margin: 0;
  font-size: 1.75rem;
  font-weight: 600;
  line-height: 1.2;
  color: var(--color-text-primary);
}

.${kebabName} .price-unit {
  color: var(--color-text-secondary, var(--color-text-primary));
  font-size: var(--font-size-sm, 0.875rem);
}

.${kebabName} .activation-line {
  margin: 0;
  color: var(--color-text-secondary, var(--color-text-primary));
}

.${kebabName} .activation-line s {
  text-decoration: line-through;
}

.${kebabName} .feature-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--gap-sm, 0.75rem);
  inline-size: 100%;
}

.${kebabName} .feature-list li {
  display: flex;
  flex-direction: row;
  align-items: flex-start;
  gap: var(--gap-xs, 0.5rem);
}

.${kebabName} .feature-list .icon {
  flex: 0 0 auto;
  margin-top: 0.1rem;
  color: var(--color-success, #2e7d32);
}

.${kebabName} .disclaimer {
  margin: 0;
  color: var(--color-text-secondary, var(--color-text-primary));
  font-size: var(--font-size-xs, 0.75rem);
}

.${kebabName} button.primary.full-width {
  inline-size: 100%;
}
`;
}

export function renderIndexTs(pascalName: string): string {
  const symbol = symbolPrefix(pascalName);
  return `export { ${symbol} } from './${pascalName}';
export { ${symbol}Schema, type ${symbol}Props } from './props';
`;
}

/** Parse prop `.default(...)` source text (JSON literal) into a runtime value. */
export function parsePropDefaultValue(defaultValue?: string): unknown {
  if (defaultValue === undefined || defaultValue.trim() === '') {
    return undefined;
  }
  try {
    const parsed = JSON.parse(defaultValue);
    return typeof parsed === 'string' ? sanitizeFixtureString(parsed) : parsed;
  } catch {
    return undefined;
  }
}

/** Strip trailing escape junk that sometimes lands in Figma-derived fixtures. */
export function sanitizeFixtureString(value: string): string {
  return value
    .replace(/\\n/gi, ' ')
    .replace(/\\+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Build Figma-derived fixture data from scaffold prop defaults.
 * Used by playground variants, unit tests, and Freeform A2UI messages.
 */
export function fixtureFromScaffoldProps(
  input: Pick<ComponentScaffoldInput, 'props' | 'titleDefault' | 'pascalName'>,
): Record<string, unknown> {
  const fixture: Record<string, unknown> = {};
  for (const prop of input.props) {
    if (/z\.function|=>|\bFunction\b/.test(prop.zod)) {
      continue;
    }
    const value = parsePropDefaultValue(prop.defaultValue);
    if (value !== undefined) {
      fixture[prop.name] = value;
    }
  }
  if (fixture.title === undefined) {
    fixture.title = input.titleDefault ?? input.pascalName;
  }
  return fixture;
}

export function renderTestTsx(input: ComponentScaffoldInput): string {
  const symbol = symbolPrefix(input.pascalName);
  const kebab = toKebabCase(input.pascalName);
  const fixture = fixtureFromScaffoldProps(input);
  const titleAssert =
    typeof fixture.title === 'string'
      ? `\n    expect(String(parsed.title ?? '')).toContain(${JSON.stringify(fixture.title)});`
      : '';

  return `import { describe, expect, it } from 'vitest';
import { ${symbol}Schema } from './props';

/** Figma-derived fixture props. */
export const TEST_DATA = ${JSON.stringify(fixture, null, 2)} as const;

describe('${symbol}', () => {
  it('parses fixture props', () => {
    const parsed = ${symbol}Schema.parse(TEST_DATA);
    expect(parsed).toBeTruthy();${titleAssert}
  });

  it('rejects unknown keys (strict mode)', () => {
    expect(() => ${symbol}Schema.parse({ ...TEST_DATA, extra: true })).toThrow();
  });
});
`;
}

export function buildScaffoldFiles(input: ComponentScaffoldInput): GeneratedScaffoldFiles {
  const kebabName = toKebabCase(input.pascalName);
  const symbol = symbolPrefix(input.pascalName);
  return {
    kebabName,
    pascalName: input.pascalName,
    files: {
      [`src/components/${kebabName}/props.ts`]: renderPropsTs(input),
      [`src/components/${kebabName}/${symbol}.tsx`]: sanitizeRenderTsx(renderComponentTsx(input)),
      [`src/components/${kebabName}/${kebabName}.css`]: renderCss(kebabName),
      [`src/components/${kebabName}/index.ts`]: renderIndexTs(input.pascalName),
      [`src/components/${kebabName}/${symbol}.test.ts`]: renderTestTsx(input),
    },
  };
}
