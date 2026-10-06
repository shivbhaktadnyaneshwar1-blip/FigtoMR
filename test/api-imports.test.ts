import { describe, expect, it } from 'vitest';
import { ensureSchemaImports, renderPropsTs } from '../src/generation/scaffold.js';

describe('generic scaffold templates', () => {
  it('ensureSchemaImports is a no-op', () => {
    const source = 'export const x = 1;\n';
    expect(ensureSchemaImports(source)).toBe(source);
  });

  it('renderPropsTs emits Zod props with strict()', () => {
    const props = renderPropsTs({
      pascalName: 'ActionCard',
      description: 'Card',
      props: [
        { name: 'title', zod: 'z.string()', describe: 'Title' },
        { name: 'count', zod: 'z.number()', describe: 'Count' },
      ],
      rendererJsx: '<h2>{title}</h2>',
    });
    expect(props).toContain('.strict()');
    expect(props).toContain('ActionCardSchema');
    expect(props).toContain('z.number()');
  });
});
