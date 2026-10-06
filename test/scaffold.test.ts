import { describe, expect, it } from 'vitest';
import { buildScaffoldFiles } from '../src/generation/scaffold.js';

describe('React component scaffolds', () => {
  it('emits the generic React component file set', () => {
    const scaffold = buildScaffoldFiles({
      pascalName: 'DemoMetric',
      description: 'A compact metric tile.',
      rendererJsx: '<strong data-ref="demo-metric-value">{title}</strong>',
      props: [],
    });
    expect(scaffold.kebabName).toBe('demo-metric');
    expect(Object.keys(scaffold.files)).toEqual(
      expect.arrayContaining([
        'src/components/demo-metric/props.ts',
        'src/components/demo-metric/DemoMetric.tsx',
        'src/components/demo-metric/index.ts',
        'src/components/demo-metric/demo-metric.css',
        'src/components/demo-metric/DemoMetric.test.ts',
      ]),
    );
    expect(scaffold.files['src/components/demo-metric/props.ts']).toContain('.strict()');
    expect(scaffold.files['src/components/demo-metric/DemoMetric.tsx']).toContain('displayName');
  });
});
