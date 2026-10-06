import type { ComponentScaffoldInput } from './templates/index.js';

export interface LayoutMatch {
  readonly tag: string;
  readonly reason: string;
}

export interface ComposeScaffoldOptions {
  /**
   * Tags from design system MCP (the Figma layout). When present these win over
   * text heuristics — the host fallback must work for any Figma frame, not one demo.
   */
  readonly preferredTags?: readonly string[];
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
const SAMPLE_CHART_DATA = [4, 6, 5, 9, 7, 6, 10, 8, 7, 11, 8, 9];

/** Figma layer / docs tokens that must never become UI copy. */
const STRUCTURAL_LABELS = new Set(
  [
    'dialog',
    'contents',
    'content',
    'header',
    'dialog header',
    'footer',
    'slot',
    'frame',
    'group',
    'icon',
    'title',
    'titling',
    'chart',
    'carousel',
    'bar',
    'divider',
    'button',
    'button group',
    'button 1',
    'close button',
    'close button container',
    'background',
    'background close',
    'helper text',
    'label and tag',
    'text element',
    'kpi card',
    'kpi large',
    'kpi small',
    'kpi/kpi tag',
    'vertical bars',
    'bar chart',
    'line chart',
    'image',
    'vector',
    'rectangle',
    'ellipse',
    'instance',
    'component',
    'auto layout',
  ].map((s) => s.toLowerCase()),
);

/** Drop MCP component-doc appendices that pollute label mining. */
export function clipFigmaDesignText(raw: string, max = 24_000): string {
  const withoutDocs = raw
    .split(/\n(?=##\s)/)[0]
    ?.split(/\n(?=Components in the design)/i)[0]
    ?.split(/\n(?=SUPER IMPORTANT)/i)[0]
    ?.split(/\n(?=IMPORTANT:)/)[0]
    ?? raw;
  return withoutDocs.slice(0, max);
}

/** Strip escape junk Figma/MCP sometimes leaves on strings (trailing backslash, `\n`). */
export function sanitizeDesignLabel(raw: string): string {
  return raw
    .replace(/\\n/gi, ' ')
    .replace(/\\t/gi, ' ')
    .replace(/\\"/g, '"')
    .replace(/\\+'/g, "'")
    .replace(/\\+$/g, '')
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isStructuralLabel(text: string): boolean {
  const key = text.toLowerCase();
  if (STRUCTURAL_LABELS.has(key)) return true;
  if (/^(button|icon|bar|frame|group|layer|vector|rectangle)\b/i.test(text)) return true;
  if (/[/:]/.test(text) && /button|icon|kpi|ghost|resting/i.test(text)) return true;
  if (/\((boolean|string|number|default)\b/i.test(text)) return true;
  if (/^(data-name|className|node-id)\b/i.test(text)) return true;
  return false;
}

function isHumanLabel(value: string): boolean {
  const text = sanitizeDesignLabel(value);
  if (text.length < 2 || text.length > 64) return false;
  if (isStructuralLabel(text)) return false;
  if (/[{}<>;=]|className|function |import |const |props\.|data-name|data-node/i.test(text)) {
    return false;
  }
  if (/^https?:/i.test(text)) return false;
  if (!/[A-Za-z]/.test(text)) return false;
  return true;
}

/** Visible text including numeric KPI values / deltas (for metric pairing). */
export function extractVisibleTokens(designText: string): string[] {
  const source = clipFigmaDesignText(designText);
  const found: string[] = [];
  const seen = new Set<string>();
  for (const match of source.matchAll(/>([^<>{}]*?)</g)) {
    const text = sanitizeDesignLabel(match[1] ?? '');
    if (text.length < 1 || text.length > 64) continue;
    if (isStructuralLabel(text)) continue;
    if (/[{}<>;=]|className|data-name/i.test(text)) continue;
    const key = `${found.length}:${text.toLowerCase()}`;
    // Allow duplicate "from last month" / "0%" across KPI cards — use index key only for pure dups of structural?
    if (seen.has(text.toLowerCase()) && !/^[\d,.]+%?$/.test(text) && !/^from last/i.test(text)) {
      continue;
    }
    seen.add(text.toLowerCase());
    found.push(text);
  }
  return found.slice(0, 48);
}

/**
 * Pull visible UI copy from Figma design-context JSX.
 * Prefer text nodes (`>…<`) — never `data-name` / docs property names.
 */
export function extractDesignLabels(designText: string): string[] {
  return extractVisibleTokens(designText).filter(isHumanLabel).slice(0, 24);
}

/** Extract metric cards: caption + value + optional delta from ordered visible copy. */
export function extractMetricFixtures(
  designText: string,
): Array<{ label: string; value: string; delta: string }> {
  const tokens = extractVisibleTokens(designText);
  const metrics: Array<{ label: string; value: string; delta: string }> = [];
  const isValue = (s: string) => /^[\d,.]+%?$/.test(s);
  const isDelta = (s: string) => /^[+-]?[\d,.]+%$/.test(s);
  const isMonth = (s: string) => /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)$/i.test(s);
  const isNoise = (s: string) =>
    isMonth(s) || /^from last/i.test(s) || isActionLabel(s) || isStructuralLabel(s);

  for (let i = 0; i < tokens.length && metrics.length < 4; i++) {
    const label = tokens[i]!;
    if (!isHumanLabel(label) || isNoise(label) || isValue(label) || isDelta(label)) continue;

    let value: string | undefined;
    let delta = '0%';
    for (let j = i + 1; j < Math.min(i + 6, tokens.length); j++) {
      const next = tokens[j]!;
      // Another caption before a value → this label is not a KPI (don't steal later metrics).
      if (
        !value &&
        isHumanLabel(next) &&
        !isValue(next) &&
        !isDelta(next) &&
        !/^from last/i.test(next) &&
        !isNoise(next)
      ) {
        break;
      }
      if (!value && isValue(next)) {
        // Prefer bare numbers / percents as the main value; a trailing % delta comes next.
        value = next;
        continue;
      }
      if (value && isDelta(next)) {
        delta = next === '0%' || next.startsWith('+') || next.startsWith('-') ? next : `+${next}`;
        break;
      }
      if (value && isHumanLabel(next) && !isValue(next) && !/^from last/i.test(next)) {
        break;
      }
    }
    if (!value) continue;

    const following = tokens.slice(i + 1, i + 4);
    if (following.some(isMonth) && !following.some(isValue)) continue;

    metrics.push({ label, value, delta });
  }
  return metrics;
}

export function extractChartMonths(designText: string): string[] {
  const labels = extractDesignLabels(designText);
  const months = labels.filter((label) =>
    /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)$/i.test(label),
  );
  return months.length >= 3 ? months : [...MONTHS];
}

/**
 * Compact FIGMA-visible data for refine / compare prompts (copy + numbers, not chrome).
 */
export function summarizeFigmaDataHints(designText: string): string {
  const labels = extractDesignLabels(designText);
  const metrics = extractMetricFixtures(designText);
  const lines: string[] = [];
  if (labels.length > 0) {
    lines.push(`Visible copy: ${labels.slice(0, 12).join(' · ')}`);
  }
  for (const [index, metric] of metrics.slice(0, 4).entries()) {
    lines.push(
      `KPI ${index + 1}: ${metric.label} = ${metric.value}` +
        (metric.delta ? ` (${metric.delta})` : ''),
    );
  }
  const price = labels.find((label) => /^\$?[\d,]+$/.test(label.replace(/\s/g, '')));
  if (price) lines.push(`Price token: ${price}`);
  const fee = labels.find((label) => /activation fee|waived/i.test(label));
  if (fee) lines.push(`Fee line: ${fee}`);
  const months = labels.filter((label) =>
    /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)$/i.test(label),
  );
  if (months.length >= 3) lines.push(`Chart labels: ${months.join(', ')}`);
  return lines.length > 0 ? lines.join('\n') : 'No extractable copy — read labels/numbers from the FIGMA screenshot.';
}

/**
 * Human affordances visible in the Figma frame — used for AI Reasoning "ask" copy.
 * Prefer this over raw tag dumps like "aui-barchart, aui-kpi-large".
 */
export function describeFigmaLayoutAsk(designText: string): string {
  const clipped = clipFigmaDesignText(designText).toLowerCase();
  const labels = extractDesignLabels(designText);
  const bits: string[] = [];

  if (looksLikePricingCard(designText, labels)) {
    bits.push('pricing/action card', 'checklist', 'badge', 'primary CTA');
    return bits.join(' · ');
  }
  if (/data-name="dialog"|role="dialog"|modal overlay/.test(clipped)) bits.push('dialog');
  if (/bar\s*chart|barchart|column\s*chart/.test(clipped)) bits.push('bar chart');
  if (/line\s*chart|linechart/.test(clipped)) bits.push('line chart');
  if (/donut|pie\s*chart/.test(clipped)) bits.push('donut');
  if (/kpi\s*card|kpi\s*large|kpi\s*small|\bkpi\b|from last month|metric\s*tile/.test(clipped)) {
    bits.push('KPI tiles');
  }
  if (/\bbadge\b|\bpill\b|most popular/.test(clipped)) bits.push('badge');
  if (labels.some((label) => isActionLabel(label))) {
    bits.push(`CTA “${labels.find((label) => isActionLabel(label))}”`);
  }
  if (bits.length === 0) {
    const title = labels[0];
    return title ? `frame “${title}”` : 'layout chrome (s-box / s-icon)';
  }
  return bits.join(' · ');
}

/**
 * Lightweight text → HTML/CSS tag hints. Product-agnostic.
 * Real selection should come from design system MCP `preferredTags` when available.
 */
export function matchLayoutAffordances(designText: string): LayoutMatch[] {
  const text = clipFigmaDesignText(designText).toLowerCase();
  const matches: LayoutMatch[] = [
    { tag: 's-box', reason: 'Surface / card chrome' },
    { tag: 's-icon', reason: 'Glyphs' },
  ];

  const rules: Array<{ when: RegExp; tag: string; reason: string }> = [
    { when: /bar\s*chart|barchart|column\s*chart|data-name="bar chart"/, tag: 'aui-barchart', reason: 'Bar chart' },
    { when: /line\s*chart|linechart/, tag: 'aui-line-chart', reason: 'Line chart' },
    { when: /donut|pie\s*chart/, tag: 'aui-donut', reason: 'Donut / pie' },
    { when: /data-name="dialog"|role="dialog"|modal overlay/, tag: 's-dialog', reason: 'Modal chrome' },
    { when: /\balert\b|banner|toast|notification/, tag: 's-alert', reason: 'Status banner' },
    {
      when: /kpi\s*card|kpi\s*large|kpi\s*small|\bkpi\b|from last month|metric\s*tile/,
      tag: 'aui-kpi-large',
      reason: 'KPI tiles',
    },
    { when: /\bbadge\b|\bpill\b/, tag: 's-badge', reason: 'Count badge' },
  ];

  for (const rule of rules) {
    if (rule.when.test(text) && !matches.some((m) => m.tag === rule.tag && m.reason === rule.reason)) {
      matches.push({ tag: rule.tag, reason: rule.reason });
    }
  }

  if (/button|close|cta|primary|submit|save|cancel|continue/i.test(text)) {
    matches.push({
      tag: 'button.primary',
      reason: 'CTA is native <button className="primary">, not <s-button>',
    });
  }

  return matches;
}

function jsonDefault(value: unknown): string {
  return JSON.stringify(JSON.stringify(value));
}

function deltaChrome(delta: string): { tagColor: string; tagIconName: string } {
  if (/^-|down|↓/i.test(delta)) {
    return { tagColor: 'red-lighter', tagIconName: 'arrow-down' };
  }
  if (/^0%?$|no change|flat/i.test(delta)) {
    return { tagColor: 'gray-lightest', tagIconName: '' };
  }
  return { tagColor: 'green-lighter', tagIconName: 'arrow-up' };
}

function isActionLabel(label: string): boolean {
  return /^(close|done|save|cancel|submit|continue|ok|apply|next|back|get started|learn more|buy now|try now)$/i.test(
    label,
  );
}

function looksLikePricingCard(designText: string, labels: readonly string[]): boolean {
  const text = `${designText}\n${labels.join('\n')}`.toLowerCase();
  const hasPrice = /\$\s*[\d,]+|\/\s*year|\/\s*mo|activation fee|most popular/.test(text);
  const hasCta = labels.some((label) => isActionLabel(label));
  const hasChecklist =
    /check-circle|feature|certificate|jurisdiction|integration/.test(text) ||
    labels.filter((label) => label.length > 24).length >= 3;
  return hasPrice && (hasCta || hasChecklist);
}

/** Split "$291 activation fee | Waived…" into strike + note for Action-card chrome. */
export function splitActivationFeeLine(raw: string): { strike: string; note: string } {
  const text = raw.replace(/\s+/g, ' ').trim();
  if (!text) return { strike: '', note: '' };
  const parts = text.split(/\s*\|\s*/);
  if (parts.length >= 2 && /activation fee/i.test(parts[0] ?? '')) {
    return {
      strike: (parts[0] ?? '').trim(),
      note: parts.slice(1).join(' | ').trim(),
    };
  }
  if (/activation fee/i.test(text) && /waived/i.test(text)) {
    const waived = text.match(/waived.*/i)?.[0]?.trim() ?? '';
    const strike = text.replace(/\s*\|\s*/g, ' ').replace(waived, '').trim();
    return { strike, note: waived };
  }
  return { strike: '', note: text };
}

/**
 * Host safety-net scaffold when the model skips generate_component_scaffold.
 * Driven by MCP preferredTags + visible Figma copy — not layer names or docs.
 */
export function composeLayoutScaffold(
  pascalName: string,
  designText: string,
  options: ComposeScaffoldOptions = {},
): Omit<ComponentScaffoldInput, 'pascalName'> & { pascalName: string } {
  const labels = extractDesignLabels(designText);
  const heuristic = matchLayoutAffordances(designText);
  const tags = new Set(heuristic.map((match) => match.tag));
  const preferred = new Set(
    (options.preferredTags ?? []).map((tag) => tag.trim()).filter(Boolean),
  );
  for (const tag of preferred) {
    tags.add(tag);
  }

  const pricingCard = looksLikePricingCard(designText, labels);
  const useKpiLarge =
    !pricingCard &&
    (preferred.has('aui-kpi-large') ||
      (tags.has('aui-kpi-large') && !preferred.has('aui-kpi-small')));
  const useKpiSmall =
    !pricingCard &&
    !useKpiLarge &&
    (preferred.has('aui-kpi-small') || tags.has('aui-kpi-small'));

  const title =
    labels.find((label) => !isActionLabel(label) && !/^(jan|feb)/i.test(label)) ?? pascalName;
  const action =
    labels.find((label) => isActionLabel(label)) ??
    (pricingCard ? 'Get started' : 'Close');
  const section =
    labels.find(
      (label) =>
        label !== title &&
        label !== action &&
        !/^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)$/i.test(label) &&
        !/^[\d,.]+%?$/.test(label) &&
        !/^from last/i.test(label),
    ) ?? title;

  const chartMonths = extractChartMonths(designText);
  const extractedMetrics = pricingCard ? [] : extractMetricFixtures(designText);

  const clippedLower = clipFigmaDesignText(designText).toLowerCase();
  const chartInFrame =
    /bar\s*chart|barchart|column\s*chart|line\s*chart|linechart|donut|pie\s*chart/.test(
      clippedLower,
    );
  const wantsChart =
    !pricingCard &&
    (preferred.has('aui-barchart') ||
      preferred.has('aui-line-chart') ||
      preferred.has('aui-donut') ||
      tags.has('aui-barchart') ||
      tags.has('aui-line-chart') ||
      tags.has('aui-donut') ||
      chartInFrame);

  // Never invent "Metric 1/2/3" sample data. Prefer Figma-extracted fixtures;
  // if MCP prefers KPI tags but copy is thin, use visible labels (value placeholder "—").
  const preferredKpi =
    preferred.has('aui-kpi-large') ||
    preferred.has('aui-kpi-small') ||
    preferred.has('aui-meter');
  const metrics =
    extractedMetrics.length > 0
      ? extractedMetrics.slice(0, 3)
      : !pricingCard && preferredKpi
        ? labels
            .filter(
              (label) =>
                label !== title &&
                !isActionLabel(label) &&
                !/^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)$/i.test(label) &&
                !/^[\d,.]+%?$/.test(label) &&
                !/^from last/i.test(label),
            )
            .slice(0, 3)
            .map((label) => ({ label, value: '—', delta: '0%' }))
        : [];

  const wantsKpi =
    !pricingCard &&
    metrics.length > 0 &&
    (useKpiLarge ||
      useKpiSmall ||
      preferredKpi ||
      /from last month|\bkpi\b|metric\s*tile/i.test(designText));

  // Drop chart section title from looking like a metric when we already have KPIs.
  const metricList = metrics.filter((metric) => metric.label !== section || !wantsChart);

  if (pricingCard) {
    const featureLabels = labels.filter(
      (label) =>
        label !== title &&
        label !== action &&
        !/^most popular$/i.test(label) &&
        !/^\$?[\d,]+$/.test(label) &&
        !/^\/?\s*(year|mo|month)\*?$/i.test(label) &&
        !/activation fee|waived for/i.test(label) &&
        !/pricing shown|renews|not price-locked/i.test(label) &&
        label.length > 12,
    );
    const priceLabel =
      labels.find((label) => /^\$?[\d,]+$/.test(label.replace(/\s/g, ''))) ?? '970';
    const price = priceLabel.replace(/^\$/, '');
    const disclaimer =
      labels.find((label) => /pricing shown|renews|not price-locked/i.test(label)) ??
      '*Pricing shown is current standard pricing.';
    const activationRaw =
      labels.find((label) => /activation fee|waived/i.test(label)) ?? '';
    const activationParts = splitActivationFeeLine(activationRaw);
    const featureItems = featureLabels.length
      ? featureLabels.slice(0, 8)
      : ['Feature one', 'Feature two', 'Feature three'];

    const props: Array<ComponentScaffoldInput['props'][number]> = [
      {
        name: 'title',
        zod: 'z.string()',
        describe: 'Plan / card title from the Figma frame.',
        defaultValue: JSON.stringify(title),
      },
      {
        name: 'badgeLabel',
        zod: 'z.string()',
        describe: 'Optional badge (e.g. Most popular).',
        defaultValue: JSON.stringify(
          labels.find((label) => /^most popular$/i.test(label)) ?? 'Most popular',
        ),
      },
      {
        name: 'price',
        zod: 'z.string()',
        describe: 'Numeric price without currency symbol.',
        defaultValue: JSON.stringify(price),
      },
      {
        name: 'priceUnit',
        zod: 'z.string()',
        describe: 'Billing unit (year / month).',
        defaultValue: JSON.stringify('year'),
      },
      {
        name: 'activationStrike',
        zod: 'z.string()',
        describe: 'Struck-through activation fee segment (e.g. $291 activation fee).',
        defaultValue: JSON.stringify(activationParts.strike),
      },
      {
        name: 'activationNote',
        zod: 'z.string()',
        describe: 'Activation fee note after the strike (e.g. Waived for Aviator users).',
        defaultValue: JSON.stringify(activationParts.note),
      },
      {
        name: 'features',
        zod: 'z.string()',
        describe: 'JSON array of feature strings.',
        defaultValue: jsonDefault(featureItems),
      },
      {
        name: 'disclaimer',
        zod: 'z.string()',
        describe: 'Footer disclaimer copy.',
        defaultValue: JSON.stringify(disclaimer),
      },
      {
        name: 'actionLabel',
        zod: 'z.string()',
        describe: 'Primary CTA label.',
        defaultValue: JSON.stringify(action),
      },
    ];

    // Visual Action-card chrome using ONLY design system MCP/SDK tags + native HTML.
    // No custom SVG / invented design-system components — s-icon for checks, s-badge for tag, button.primary for CTA.
    const useTag =
      (options.preferredTags ?? []).includes('s-tag') &&
      !(options.preferredTags ?? []).includes('s-badge');
    const badgeJsx = useTag
      ? '    {props.badgeLabel ? <s-tag>{props.badgeLabel}</s-tag> : null}'
      : '    {props.badgeLabel ? <s-badge count={props.badgeLabel} /> : null}';

    const rendererJsx = [
      '<s-box className="padding-md flex-column gap-md action-card">',
      '  <div className="flex-row align-center space-between header-row">',
      '    <h5 className="card-title">{props.title}</h5>',
      badgeJsx,
      '  </div>',
      '  <div className="flex-row align-end gap-xs price-row">',
      '    <h2 className="price-value">${props.price}</h2>',
      '    <span className="price-unit">/{props.priceUnit}*</span>',
      '  </div>',
      '  {(props.activationStrike || props.activationNote) ? (',
      '    <p className="text-sm activation-line">',
      '      {props.activationStrike ? <s>{props.activationStrike}</s> : null}',
      '      {props.activationStrike && props.activationNote ? <span> | </span> : null}',
      '      {props.activationNote ? <span>{props.activationNote}</span> : null}',
      '    </p>',
      '  ) : null}',
      '  <ul className="feature-list">',
      '    {JSON.parse(props.features || "[]").map((feature: string) => (',
      '      <li key={feature}>',
      '        <s-icon name="check-circle" />',
      '        <span>{feature}</span>',
      '      </li>',
      '    ))}',
      '  </ul>',
      '  <p className="text-sm disclaimer">{props.disclaimer}</p>',
      '  <button type="button" className="primary full-width">{props.actionLabel}</button>',
      '</s-box>',
    ].join('\n');

    return {
      pascalName,
      description:
        'HTML/CSS Action/pricing card from MCP tags (s-box, s-badge/s-tag, s-icon check-circle, primary button) — no custom SVG.',
      titleDefault: title,
      props,
      rendererJsx,
    };
  }

  const props: Array<ComponentScaffoldInput['props'][number]> = [
    {
      name: 'title',
      zod: 'z.string()',
      describe: 'Frame title taken from the Figma node.',
      defaultValue: JSON.stringify(title),
    },
    {
      name: 'actionLabel',
      zod: 'z.string()',
      describe: 'Primary button label.',
      defaultValue: JSON.stringify(action),
    },
  ];

  // Prefer s-box shell; s-dialog when MCP asks or Figma frame is clearly a modal.
  const useDialog =
    !pricingCard &&
    (preferred.has('s-dialog') ||
      tags.has('s-dialog') ||
      /data-name="dialog"|role="dialog"|modal overlay/.test(clippedLower));
  const rootOpen = useDialog
    ? ['<s-dialog open>', '  <s-box className="padding-md flex-column gap-md">']
    : ['<s-box className="padding-md flex-column gap-md">'];
  const rootClose = useDialog ? ['  </s-box>', '</s-dialog>'] : ['</s-box>'];
  const pad = useDialog ? '    ' : '  ';

  const lines: string[] = [
    ...rootOpen,
    `${pad}<div className="flex-row align-center space-between header-row">`,
    `${pad}  <h5>{props.title}</h5>`,
    useDialog
      ? [
          `${pad}  <button type="button" className="ghost icon" aria-label="Close">`,
          `${pad}    <s-icon name="close" />`,
          `${pad}  </button>`,
        ].join('\n')
      : '',
    `${pad}</div>`,
  ];

  if (tags.has('s-alert') && preferred.has('s-alert')) {
    props.push({
      name: 'alertText',
      zod: 'z.string()',
      describe: 'Alert / banner copy from the Figma frame.',
      defaultValue: JSON.stringify(section),
    });
    lines.push(`${pad}<s-alert status="info">{props.alertText}</s-alert>`);
  }

  if (wantsChart) {
    const chartTag = tags.has('aui-donut')
      ? 'aui-donut'
      : tags.has('aui-line-chart') && !tags.has('aui-barchart')
        ? 'aui-line-chart'
        : 'aui-barchart';
    props.push(
      {
        name: 'sectionTitle',
        zod: 'z.string()',
        describe: 'Label above the chart.',
        defaultValue: JSON.stringify(section),
      },
      {
        name: 'chartLabels',
        zod: 'z.string()',
        describe: 'JSON array of chart category labels.',
        defaultValue: jsonDefault(chartMonths),
      },
      {
        name: 'chartData',
        zod: 'z.string()',
        describe: 'JSON array of chart values.',
        defaultValue: jsonDefault(SAMPLE_CHART_DATA),
      },
    );
    lines.push(
      `${pad}<p className="text-sm">{props.sectionTitle}</p>`,
      `${pad}<div className="chart-shell">`,
      `${pad}  <${chartTag}`,
      `${pad}    labels={props.chartLabels}`,
      `${pad}    data={props.chartData}`,
      `${pad}    hideLegend`,
      `${pad}    hideBarValues`,
      `${pad}  />`,
      `${pad}</div>`,
    );
  }

  metricList.forEach((metric, index) => {
    const n = index + 1;
    props.push(
      {
        name: `metric${n}Label`,
        zod: 'z.string()',
        describe: `Metric ${n} caption from the Figma frame.`,
        defaultValue: JSON.stringify(metric.label),
      },
      {
        name: `metric${n}Value`,
        zod: 'z.string()',
        describe: `Metric ${n} value (fixture).`,
        defaultValue: JSON.stringify(metric.value),
      },
      {
        name: `metric${n}Delta`,
        zod: 'z.string()',
        describe: `Metric ${n} delta / tag value (fixture).`,
        defaultValue: JSON.stringify(metric.delta),
      },
    );
  });

  if (metricList.length > 0) {
    lines.push(`${pad}<div className="kpi-row flex-row gap-lg">`);
    metricList.forEach((metric, index) => {
      const n = index + 1;
      if (useKpiLarge || (!useKpiSmall && wantsKpi)) {
        const chrome = deltaChrome(metric.delta);
        lines.push(
          `${pad}  <aui-kpi-large`,
          `${pad}    className="kpi-item"`,
          `${pad}    value={props.metric${n}Value}`,
          `${pad}    tagvalue={props.metric${n}Delta}`,
          `${pad}    tagcolor="${chrome.tagColor}"`,
          chrome.tagIconName ? `${pad}    tagiconname="${chrome.tagIconName}"` : '',
          `${pad}  >`,
          `${pad}    <div slot="label">{props.metric${n}Label}</div>`,
          `${pad}  </aui-kpi-large>`,
        );
      } else if (useKpiSmall) {
        lines.push(
          `${pad}  <aui-kpi-small`,
          `${pad}    className="kpi-item"`,
          `${pad}    value={props.metric${n}Value}`,
          `${pad}    status="other"`,
          `${pad}  >`,
          `${pad}    <div slot="label">{props.metric${n}Label}</div>`,
          `${pad}  </aui-kpi-small>`,
        );
      } else {
        lines.push(
          `${pad}  <div className="kpi-item flex-column gap-xs">`,
          `${pad}    <small>{props.metric${n}Label}</small>`,
          `${pad}    <h3>{props.metric${n}Value}</h3>`,
          `${pad}    <s-badge count={props.metric${n}Delta} />`,
          `${pad}  </div>`,
        );
      }
    });
    lines.push(`${pad}</div>`);
  } else if (!wantsChart && labels.length > 1) {
    const body =
      labels.find((label) => label !== title && label !== action && !isActionLabel(label)) ??
      section;
    props.push({
      name: 'bodyText',
      zod: 'z.string()',
      describe: 'Supporting copy from the Figma frame.',
      defaultValue: JSON.stringify(body),
    });
    lines.push(`${pad}<p>{props.bodyText}</p>`);
  }

  lines.push(
    `${pad}<button type="button" className="primary">{props.actionLabel}</button>`,
    ...rootClose,
  );

  const used = [
    useDialog ? 's-dialog' : 's-box',
    's-icon',
    wantsChart
      ? preferred.has('aui-line-chart') || tags.has('aui-line-chart')
        ? 'aui-line-chart'
        : preferred.has('aui-donut') || tags.has('aui-donut')
          ? 'aui-donut'
          : 'aui-barchart'
      : undefined,
    metricList.length
      ? useKpiSmall && !useKpiLarge
        ? 'aui-kpi-small'
        : 'aui-kpi-large'
      : undefined,
    preferred.has('s-badge') || tags.has('s-badge') ? 's-badge' : undefined,
  ].filter(Boolean);

  return {
    pascalName,
    description: `Host scaffold · ${used.join(', ')}`,
    titleDefault: title,
    props,
    rendererJsx: lines.filter((line) => line !== '').join('\n'),
  };
}

export function isPlaceholderRenderer(source: string): boolean {
  return /Placeholder — match the Figma frame/.test(source);
}

/** True when the agent (or host) produced real custom-component sources — not catalog stubs alone. */
export function hasCustomComponentScaffold(files: Record<string, string> | undefined): boolean {
  if (!files) {
    return false;
  }
  return Object.keys(files).some((path) => {
    const normalized = path.replace(/\\/g, '/');
    return (
      (normalized.includes('/custom-components/') || normalized.includes('/components/')) &&
      (normalized.endsWith('/render.tsx') ||
        normalized.endsWith('/api.ts') ||
        normalized.endsWith('/props.ts') ||
        /\.tsx$/.test(normalized))
    );
  });
}
