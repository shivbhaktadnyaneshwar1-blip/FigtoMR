import { describe, expect, it } from 'vitest';
import {
  activityProgress,
  activityToReasoningSteps,
  activityToThoughts,
  aiProcessingPhase,
  reasoningHeaders,
  shouldCollapseReasoning,
} from '../src/studio/activity-reasoning.js';

const sampleActivity = [
  {
    id: 1,
    phase: 'done' as const,
    source: 'figma-mcp' as const,
    name: 'inspect',
    label: 'Inspect Figma',
  },
  {
    id: 2,
    phase: 'start' as const,
    source: 'studio' as const,
    name: 'list-components',
    label: 'List components',
    detail: 'design system MCP',
  },
  {
    id: 3,
    phase: 'info' as const,
    source: 'studio' as const,
    name: 'status',
    label: 'Scaffolding',
  },
];

describe('activity-reasoning', () => {
  it('maps tool activity into ordered s-ai-reasoning steps', () => {
    const steps = activityToReasoningSteps(sampleActivity);

    expect(steps.inspect?.status).toBe('done');
    expect(steps['list-components']?.status).toBe('done'); // only newest in-progress kept
    expect(steps.status?.status).toBe('in-progress');
    expect(steps.status?.order).toBe(2);
  });

  it('forces all steps done when collapsing for accordion', () => {
    const steps = activityToReasoningSteps(sampleActivity, { collapse: true });
    expect(
      Object.values(steps).every(
        (s: { status: string }) => s.status === 'done' || s.status === 'error',
      ),
    ).toBe(true);
  });

  it('strips JSON dumps from reasoning step text', () => {
    const steps = activityToReasoningSteps([
      {
        id: 1,
        phase: 'done',
        source: 'figma-mcp',
        name: 'inspect',
        label: 'Inspecting Figma node',
        detail: '{"result":"{\\n \\"ok\\": true"}',
      },
    ]);
    expect(steps.inspect?.text).toBe('Inspecting Figma node');
    expect(steps.inspect?.text).not.toContain('{');
  });

  it('keeps Figma-asked vs HTML/CSS-provided tags in reasoning', () => {
    const steps = activityToReasoningSteps([
      {
        id: 1,
        phase: 'done',
        source: 'studio',
        name: 'skylab_ask_from_figma',
        label: 'Figma → HTML/CSS ask',
        detail: 'pricing card checklist badge s-box',
      },
      {
        id: 2,
        phase: 'done',
        source: 'studio',
        name: 'skylab_mcp_provided',
        label: 'design system MCP provided',
        detail: 's-box, s-icon, s-badge, s-tag',
      },
    ]);
    expect(steps.skylab_ask_from_figma?.text).toContain('Figma → HTML/CSS ask');
    expect(steps.skylab_ask_from_figma?.text).toContain('pricing card');
    expect(steps.skylab_mcp_provided?.text).toContain('design system MCP provided');
    expect(steps.skylab_mcp_provided?.text).toContain('s-box');
    expect(steps.skylab_mcp_provided?.text).toContain('s-badge');
  });

  it('keeps mismatch headline + gap details in reasoning', () => {
    const steps = activityToReasoningSteps([
      {
        id: 1,
        phase: 'info',
        source: 'studio',
        name: 'visual_mismatch',
        label: 'Not matching with Figma — retrying (1/3)',
        detail: 'no check icons; CTA not full width',
      },
      {
        id: 2,
        phase: 'info',
        source: 'studio',
        name: 'visual_gap_1',
        label: 'Gap vs Figma',
        detail: 'feature rows lack check-circle icons',
      },
    ]);
    expect(steps.visual_mismatch?.text).toContain('Not matching with Figma');
    expect(steps.visual_mismatch?.text).toContain('no check icons');
    expect(steps.visual_gap_1?.text).toContain('check-circle');
  });

  it('builds unique thoughts for s-ai-processing', () => {
    const thoughts = activityToThoughts([
      { id: 1, phase: 'info', source: 'studio', name: 'a', label: 'One' },
      { id: 2, phase: 'info', source: 'studio', name: 'b', label: 'One' },
      { id: 3, phase: 'info', source: 'studio', name: 'c', label: 'Two' },
    ]);
    expect(thoughts).toEqual(['One', 'Two']);
  });

  it('chooses AiProcessing phase from studio status', () => {
    expect(aiProcessingPhase('running', false)).toBe('thinking');
    expect(aiProcessingPhase('awaiting', true)).toBe('typing');
    expect(aiProcessingPhase('done', true)).toBe('done');
    expect(aiProcessingPhase('idle', false)).toBe('resting');
  });

  it('collapses reasoning once files/proposal are ready', () => {
    expect(shouldCollapseReasoning('awaiting')).toBe(true);
    expect(shouldCollapseReasoning('done')).toBe(true);
    expect(shouldCollapseReasoning('running')).toBe(false);
    const headers = reasoningHeaders('awaiting', 'Preview ready', 4);
    expect(headers.completedHeader).toContain('Preview ready');
    expect(headers.inProgressHeader).toBe('');
  });

  it('starts near zero for a single in-flight step (not ~50%)', () => {
    expect(activityProgress([], 'idle')).toBe(0);
    expect(activityProgress(sampleActivity, 'awaiting')).toBe(100);
    expect(activityProgress(sampleActivity, 'done')).toBe(100);

    const justStarted = activityProgress(
      [{ id: 1, phase: 'start', source: 'studio', name: 'a', label: 'Start' }],
      'running',
    );
    // One active step must not look half-finished.
    expect(justStarted).toBeGreaterThan(0);
    expect(justStarted).toBeLessThan(15);

    const later = activityProgress(
      [
        { id: 1, phase: 'done', source: 'studio', name: 'a', label: 'Start' },
        { id: 2, phase: 'done', source: 'studio', name: 'b', label: 'Mid' },
        { id: 3, phase: 'start', source: 'studio', name: 'c', label: 'Almost' },
      ],
      'running',
    );
    expect(later).toBeGreaterThan(justStarted);
    expect(later).toBeLessThan(100);
  });
});
