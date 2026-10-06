export type ActivityPhase = 'start' | 'done' | 'error' | 'info';
export type ActivitySource = 'agent' | 'figma-mcp' | 'studio' | 'status';

export type ActivityItem = {
  id: number;
  phase: ActivityPhase;
  source: ActivitySource;
  name: string;
  label: string;
  detail?: string;
};

export type StudioStatus = 'idle' | 'running' | 'error' | 'done' | 'awaiting';

type ReasoningStatus = 'in-progress' | 'done' | 'error';

export type ReasoningStep = {
  order: number;
  text: string;
  status: ReasoningStatus;
  error?: { errorText: string };
};

export type AiProcessingPhase = 'resting' | 'thinking' | 'typing' | 'done';

export type ReasoningStepsOptions = {
  /** When true, no step stays in-progress so `<s-ai-reasoning>` can collapse. */
  readonly collapse?: boolean;
};

function isDesignTransparency(item: ActivityItem): boolean {
  return (
    item.source === 'studio' &&
    (/^visual_gap_/.test(item.name) ||
      /Not matching with Figma|Gap vs Figma|Still diverging/i.test(item.label))
  );
}

/** Drop MCP/JSON dumps so chat reasoning stays human-readable. */
export function sanitizeActivityCopy(raw: string | undefined, maxLen = 110): string {
  if (!raw) return '';
  let text = raw.replace(/\s+/g, ' ').trim();
  // Cut at embedded JSON / result payloads.
  text = text.replace(/\s*[·:-]?\s*\{[\s\S]*$/, '').trim();
  text = text.replace(/\s*"result"\s*:.*/i, '').trim();
  text = text.replace(/\s*MCP returned an error for \w[\w-]*/gi, ' (MCP hiccup)').trim();
  // Prefer the label before a long path dump.
  if (text.length > maxLen) text = `${text.slice(0, maxLen - 1).trim()}…`;
  return text;
}

function isNoisyDetail(detail: string | undefined, allowLongTags = false): boolean {
  if (!detail) return false;
  const d = detail.trim();
  if (allowLongTags && /^(s-|aui-)/.test(d.split(',')[0]?.trim() ?? '')) {
    // Tag lists like "s-box, s-icon, s-badge" are intentional transparency.
    return d.startsWith('{') || d.includes('"result"') || d.includes('"ok":');
  }
  return (
    d.startsWith('{') ||
    d.includes('"result"') ||
    d.includes('"ok":') ||
    d.length > 160 ||
    /wrote \/Users\//i.test(d)
  );
}

function humanStepText(item: ActivityItem): string {
  const skylab = isDesignTransparency(item);
  const max = skylab ? 160 : 110;
  const label = sanitizeActivityCopy(item.label, max) || sanitizeActivityCopy(item.name, max) || 'Working…';
  if (!item.detail || isNoisyDetail(item.detail, skylab)) return label;
  const detail = sanitizeActivityCopy(item.detail, skylab ? 180 : 110);
  if (!detail || detail === label) return label;
  return `${label} · ${detail}`;
}

/** Collapse activity feed into HTML/CSS `<s-ai-reasoning>` stepsById. */
export function activityToReasoningSteps(
  activity: readonly ActivityItem[],
  options: ReasoningStepsOptions = {},
): Record<string, ReasoningStep> {
  const order = new Map<string, number>();
  const latest = new Map<string, ActivityItem>();

  for (const item of activity) {
    const key = (item.name || item.label).slice(0, 64) || `step-${item.id}`;
    if (!order.has(key)) {
      order.set(key, order.size);
    }
    latest.set(key, item);
  }

  const stepsById: Record<string, ReasoningStep> = {};
  for (const [key, item] of latest) {
    let status: ReasoningStatus = 'done';
    if (item.phase === 'error') status = 'error';
    else if (!options.collapse && item.phase === 'start') status = 'in-progress';
    else if (!options.collapse && item.phase === 'info') status = 'in-progress';

    const text = humanStepText(item);
    const maxText = isDesignTransparency(item) ? 200 : 120;
    stepsById[key] = {
      order: order.get(key) ?? 0,
      text: text.slice(0, maxText),
      status,
      ...(status === 'error'
        ? { error: { errorText: sanitizeActivityCopy(item.detail) || item.label } }
        : {}),
    };
  }

  if (!options.collapse) {
    // Ensure at most one in-progress step (prefer the highest order).
    const inFlight = Object.entries(stepsById)
      .filter(([, step]) => step.status === 'in-progress')
      .sort((a, b) => b[1].order - a[1].order);
    for (let i = 1; i < inFlight.length; i++) {
      const id = inFlight[i]![0];
      stepsById[id] = { ...stepsById[id]!, status: 'done' };
    }
  }

  return stepsById;
}

/** Recent labels for HTML/CSS `<s-ai-processing>` thought carousel. */
export function activityToThoughts(activity: readonly ActivityItem[]): string[] {
  const seen = new Set<string>();
  const thoughts: string[] = [];
  for (const item of activity) {
    const text = humanStepText(item);
    if (!text || seen.has(text)) continue;
    // Skip ultra-noisy tool dumps that survived sanitization poorly.
    if (/^\{|"ok"|tool\(s\)/i.test(text)) continue;
    seen.add(text);
    thoughts.push(text.slice(0, isDesignTransparency(item) ? 120 : 80));
  }
  if (thoughts.length === 0) {
    return ['Inspecting Figma…', 'Matching HTML/CSS components…', 'Scaffolding the target repo…'];
  }
  return thoughts.slice(-6);
}

/**
 * Progress 0–100 from live activity.
 *
 * Important: do **not** use completed/currentStepCount — early runs often have
 * 1 in-progress step and that wrongly jumps the bar to ~50%. Instead grow from
 * a small floor by absolute completed work (asymptotic toward 96 while running).
 */
export function activityProgress(
  activity: readonly ActivityItem[],
  status: StudioStatus,
): number {
  if (status === 'idle') return 0;
  if (status === 'done' || status === 'awaiting' || status === 'error') return 100;

  const steps = activityToReasoningSteps(activity);
  const values = Object.values(steps);
  if (values.length === 0) return 2;

  let completed = 0;
  let inProgress = 0;
  for (const step of values) {
    if (step.status === 'done' || step.status === 'error') completed += 1;
    else if (step.status === 'in-progress') inProgress += 1;
  }

  // ~4 completed unique steps ≈ halfway; in-progress adds a little nudge.
  const work = completed + inProgress * 0.25;
  const curved = 1 - Math.exp(-work / 4);
  return Math.max(2, Math.min(96, Math.round(curved * 96)));
}

export function aiProcessingPhase(
  status: StudioStatus,
  hasSummary: boolean,
): AiProcessingPhase {
  if (status === 'running') return 'thinking';
  // Live await: type the summary once. Sealed/history turns stay on `done`
  // so `<s-ai-processing>` does not re-animate every re-render.
  if (status === 'awaiting') return hasSummary ? 'typing' : 'done';
  if (status === 'done' || status === 'error') return 'done';
  return 'resting';
}

/** True once files/proposal are ready — accordion should minimize. */
export function shouldCollapseReasoning(status: StudioStatus): boolean {
  return status === 'awaiting' || status === 'done' || status === 'error';
}

export function reasoningHeaders(
  status: StudioStatus,
  statusLabel: string,
  stepCount = 0,
): {
  inProgressHeader: string;
  description: string;
  completedHeader: string;
} {
  if (status === 'error') {
    return {
      inProgressHeader: '',
      description: '',
      completedHeader: statusLabel || 'Something went wrong',
    };
  }
  if (status === 'done') {
    return {
      inProgressHeader: '',
      description: '',
      completedHeader: statusLabel || 'Ready',
    };
  }
  if (status === 'awaiting') {
    const n = stepCount > 0 ? ` · ${stepCount} steps` : '';
    return {
      inProgressHeader: '',
      description: '',
      completedHeader: statusLabel ? `${sanitizeActivityCopy(statusLabel)}${n}` : `Preview ready${n}`,
    };
  }
  if (status === 'running') {
    return {
      inProgressHeader: sanitizeActivityCopy(statusLabel) || 'Working…',
      description: 'Matching Figma → scaffolding the target repo…',
      completedHeader: '',
    };
  }
  return {
    inProgressHeader: '',
    description: '',
    completedHeader: 'Idle — paste a Figma URL to generate',
  };
}
