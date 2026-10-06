export type StatusKind = 'idle' | 'running' | 'error' | 'done' | 'awaiting';

export type ProposedFile = {
  path: string;
  action: 'create' | 'update';
  summary?: string;
  contents: string;
  bytes: number;
};

export type FigmaScreenshot = {
  mimeType?: string;
  dataUrl: string;
  byteLength?: number;
  fileKey?: string;
  nodeId?: string;
  capturedAt?: string;
};

export type Proposal = {
  proposalId: string;
  componentName?: string;
  mode?: string;
  createMr: boolean;
  targetRepoPath: string;
  files: ProposedFile[];
  agentText: string;
  playgroundUrl?: string;
  figmaScreenshot?: FigmaScreenshot;
};

export type StreamEvent =
  | { type: 'status'; message: string }
  | { type: 'agent'; text: string; final?: boolean }
  | {
      type: 'tool';
      name?: string;
      detail?: string;
      phase?: 'start' | 'done' | 'error' | 'info';
      source?: 'agent' | 'figma-mcp' | 'studio';
      label?: string;
    }
  | ({ type: 'figma_screenshot' } & FigmaScreenshot)
  | {
      type: 'awaiting_figma_confirm';
      pendingId: string;
      figmaUrl: string;
      componentName?: string;
      hasScreenshot: boolean;
      message: string;
    }
  | { type: 'error'; message: string }
  | ({ type: 'proposal' } & Proposal)
  | {
      type: 'done';
      text: string;
      stateSummary: string;
      mrUrl?: string;
      branchName?: string;
      dryRun: boolean;
      proposalId?: string;
      awaitingApproval?: boolean;
      sessionId?: string;
      pendingId?: string;
      awaitingFigmaConfirm?: boolean;
    }
  | {
      type: 'staged';
      proposalId: string;
      written: string[];
      sessionId: string;
      playgroundUrl: string;
      playgroundReachable: boolean;
      playgroundStarted: boolean;
    }
  | {
      type: 'playground_screenshot';
      mimeType?: string;
      dataUrl: string;
      byteLength?: number;
      url?: string;
      capturedAt?: string;
      iteration?: number;
    }
  | {
      type: 'compare_iteration';
      iteration: number;
      maxIterations: number;
      visualMatch?: boolean;
      written: string[];
      gaps?: string[];
      mismatchSummary?: string;
      files?: ProposedFile[];
    }
  | {
      type: 'compare_result';
      ok: boolean;
      matched: boolean;
      iterations: number;
      written: string[];
      playgroundUrl: string;
      agentText?: string;
      gaps?: string[];
      mismatchSummary?: string;
      files?: ProposedFile[];
    };

export type FigmaAuthStatus = {
  authenticated: boolean;
  mcpUrl: string;
  callbackUrl: string;
  hasTokens: boolean;
  mode?: 'desktop' | 'remote';
  desktopReachable?: boolean;
  message?: string;
};

export type ChatEntry = { role: 'user' | 'assistant'; text: string };
export type ProposalTab = 'files' | 'playground';

export function parseSseChunk(buffer: string): { events: StreamEvent[]; rest: string } {
  const events: StreamEvent[] = [];
  const parts = buffer.split('\n\n');
  const rest = parts.pop() ?? '';
  for (const part of parts) {
    const dataLines: string[] = [];
    for (const line of part.split('\n')) {
      if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trim());
      }
    }
    if (dataLines.length) {
      events.push(JSON.parse(dataLines.join('\n')) as StreamEvent);
    }
  }
  return { events, rest };
}
