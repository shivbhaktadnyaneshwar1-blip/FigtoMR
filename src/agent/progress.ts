/** Live progress events surfaced to the Studio UI while the agent runs. */

export type ProgressSource = 'agent' | 'figma-mcp' | 'studio';
export type ProgressPhase = 'start' | 'done' | 'error' | 'info';

export interface ProgressEvent {
  readonly phase: ProgressPhase;
  readonly source: ProgressSource;
  readonly name: string;
  readonly label: string;
  readonly detail?: string;
  /** Optional Figma screenshot data URL for live UI preview. */
  readonly imageDataUrl?: string;
}

export type ProgressHandler = (event: ProgressEvent) => void;

const AGENT_TOOL_LABELS: Record<string, string> = {
  parse_figma_url: 'Parsing Figma URL',
  inspect_figma_node: 'Inspecting Figma node',
  list_figma_mcp_tools: 'Listing Figma MCP tools',
  map_figma_hints: 'Mapping Figma layout to HTML and CSS',
  visual_mismatch: 'Not matching with Figma — retrying',
  visual_gap: 'Gap vs Figma',
  visual_progress: 'Judging closer vs farther to Figma',
  generate_component_scaffold: 'Scaffolding React component files',
  write_generated_files: 'Planning file writes',
  validate_component_scaffold: 'Validating component scaffold',
  run_target_typecheck: 'Typechecking the target repo',
  read_target_file: 'Reading the target repo file',
  write_target_file: 'Writing component fix',
  run_target_lint: 'Running the target repo lint',
  run_target_tests: 'Running the target repo tests',
  run_target_build: 'Running the target repo build',
};

const MCP_TOOL_LABELS: Record<string, string> = {
  get_design_context: 'Fetching design context',
  getDesignContext: 'Fetching design context',
  get_metadata: 'Fetching node metadata',
  getMetadata: 'Fetching node metadata',
  get_variable_defs: 'Fetching design variables',
  get_variables: 'Fetching design variables',
  getVariables: 'Fetching design variables',
  get_screenshot: 'Capturing screenshot',
  getScreenshot: 'Capturing screenshot',
  get_code_connect_map: 'Fetching Code Connect map',
  whoami: 'Checking Figma auth',
};

export function labelAgentTool(name: string): string {
  return AGENT_TOOL_LABELS[name] ?? `Agent tool: ${name}`;
}

export function labelMcpTool(server: 'figma', tool: string): string {
  const friendly = MCP_TOOL_LABELS[tool] ?? tool;
  return `${server === 'figma' ? 'Figma' : 'HTML/CSS'} MCP · ${friendly}`;
}

/** Compact, UI-safe args summary (no huge payloads). */
export function summarizeArgs(args: Record<string, unknown> | undefined): string | undefined {
  if (!args || Object.keys(args).length === 0) {
    return undefined;
  }
  const bits: string[] = [];
  for (const key of ['url', 'fileKey', 'nodeId', 'pascalName', 'query', 'script', 'forceRefresh']) {
    const value = args[key];
    if (value === undefined || value === null || value === '') continue;
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    bits.push(`${key}=${text.length > 80 ? `${text.slice(0, 77)}…` : text}`);
  }
  if (bits.length === 0) {
    const keys = Object.keys(args).slice(0, 4).join(', ');
    return keys ? `{${keys}}` : undefined;
  }
  return bits.join(' · ');
}

/** Prefer actionable tsc/biome lines over the npm wrapper noise. */
export function summarizeToolResult(response: unknown): string | undefined {
  if (response == null) return undefined;
  if (typeof response === 'string') {
    try {
      return summarizeParsedResult(JSON.parse(response));
    } catch {
      return extractFailureSnippet(response);
    }
  }
  if (typeof response === 'object') {
    return summarizeParsedResult(response as Record<string, unknown>);
  }
  return String(response).slice(0, 160);
}

function extractFailureSnippet(log: string): string {
  const lines = log
    .replace(/\u001b\[[0-9;]*m/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const errors = lines.filter(
    (line) =>
      /error TS\d+/.test(line) ||
      /\berror\b/i.test(line) ||
      line.includes('Found ') ||
      /\.tsx?[:(]/.test(line),
  );
  if (errors.length > 0) {
    return errors.slice(0, 6).join(' · ').slice(0, 500);
  }
  return log.length > 240 ? `${log.slice(0, 237)}…` : log;
}

function summarizeParsedResult(value: Record<string, unknown>): string {
  // design system MCP: prefer asked vs provided tags over generic "ok · N components".
  const recommended = Array.isArray(value.recommendedTags)
    ? value.recommendedTags.filter((t): t is string => typeof t === 'string')
    : [];
  const asked =
    typeof value.query === 'string'
      ? value.query.trim()
      : undefined;
  if (asked || recommended.length > 0) {
    const parts: string[] = [];
    if (value.ok === false) parts.push('failed');
    if (asked) {
      parts.push(`asked: ${asked.length > 70 ? `${asked.slice(0, 67)}…` : asked}`);
    }
    parts.push(
      recommended.length > 0
        ? `provided: ${recommended.slice(0, 12).join(', ')}`
        : 'provided: (none)',
    );
    if (value.error) parts.push(String(value.error).slice(0, 80));
    else if (typeof value.warning === 'string') parts.push(value.warning.slice(0, 60));
    return parts.join(' · ').slice(0, 280);
  }

  const parts: string[] = [];
  if (value.ok === false) {
    parts.push('failed');
    if (typeof value.log === 'string') {
      parts.push(extractFailureSnippet(value.log));
      return parts.join(' — ').slice(0, 500);
    }
    if (value.error) {
      parts.push(String(value.error).slice(0, 200));
    }
  } else if (value.ok === true) {
    parts.push('ok');
  }
  if (typeof value.tool === 'string') parts.push(`mcp=${value.tool}`);
  if (Array.isArray(value.tools)) parts.push(`${value.tools.length} tool(s)`);
  if (typeof value.version === 'string') parts.push(`v${value.version}`);
  if (Array.isArray(value.components)) parts.push(`${value.components.length} components`);
  if (typeof value.elementCount === 'number') {
    parts.push(`${value.elementCount} sdk tag(s)`);
  } else if (Array.isArray(value.elements)) {
    parts.push(`${value.elements.length} sdk tag(s)`);
  }
  if (value.query && typeof value.query === 'object') {
    const q = value.query as Record<string, unknown>;
    if (q.fileKey) parts.push(`file=${String(q.fileKey).slice(0, 12)}…`);
    if (q.nodeId) parts.push(`node=${q.nodeId}`);
  }
  if (value.files && typeof value.files === 'object') {
    parts.push(`${Object.keys(value.files as object).length} file(s)`);
  }
  if (value.inspection) parts.push('inspection ready');
  if (parts.length === 0) {
    return JSON.stringify(value).slice(0, 160);
  }
  return parts.join(' · ');
}

/**
 * Async queue so MCP progress can be yielded while a long tool call is in flight
 * (otherwise the UI only updates after the tool returns).
 */
export class AsyncQueue<T> {
  private readonly items: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: item, done: false });
    } else {
      this.items.push(item);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()!({ value: undefined as unknown as T, done: true });
    }
  }

  next(): Promise<IteratorResult<T>> {
    if (this.items.length > 0) {
      return Promise.resolve({ value: this.items.shift()!, done: false });
    }
    if (this.closed) {
      return Promise.resolve({ value: undefined as unknown as T, done: true });
    }
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }
}
