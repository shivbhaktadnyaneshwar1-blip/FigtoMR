import { loadEnv, type StudioEnv } from '../config/env.js';
import { FigmaMcpBridge } from '../mcp/figma-mcp-bridge.js';
import { McpClientManager } from '../mcp/client-manager.js';
import type { ProgressEvent, ProgressHandler } from './progress.js';
import { createAgentState, type AgentExecutionState } from './state.js';

export type { ProgressHandler } from './progress.js';

export interface AgentRuntime {
  readonly env: StudioEnv;
  readonly mcp: McpClientManager;
  readonly figma: FigmaMcpBridge;
  readonly state: AgentExecutionState;
  setProgressHandler(handler: ProgressHandler | undefined): void;
  emitProgress(event: ProgressEvent): void;
}

export function createAgentRuntime(
  input: {
    figmaUrl?: string;
    componentName?: string;
    targetRepoPath?: string;
    dryRun?: boolean;
    env?: StudioEnv;
  } = {},
): AgentRuntime {
  const env = input.env ?? loadEnv();
  const mcp = new McpClientManager();
  const repoPath =
    input.targetRepoPath ??
    env.TARGET_REPO_PATH ??
    process.cwd();
  const state = createAgentState({
    figmaUrl: input.figmaUrl,
    componentName: input.componentName,
    targetRepoPath: repoPath,
    dryRun: input.dryRun ?? env.STUDIO_DRY_RUN ?? true,
  });

  let progressHandler: ProgressHandler | undefined;

  const runtime: AgentRuntime = {
    env,
    mcp,
    figma: new FigmaMcpBridge(mcp),
    state,
    setProgressHandler(handler) {
      progressHandler = handler;
      mcp.setProgressHandler(handler);
    },
    emitProgress(event) {
      progressHandler?.(event);
    },
  };

  return runtime;
}
