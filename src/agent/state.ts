import type { ParsedFigmaUrl } from '../utils/figma-url.js';
import type { TargetFrontendProfile } from '../target/frontend-profile.js';

export type GenerationMode = 'scaffold';

export interface AgentExecutionState {
  figmaUrl?: string;
  parsedUrl?: ParsedFigmaUrl;
  componentName?: string;
  mode?: GenerationMode;
  targetRepoPath?: string;
  targetProfile?: TargetFrontendProfile;
  dryRun: boolean;
  figmaInspection?: unknown;
  /** Primary Figma node screenshot captured during inspect (for UI + vision). */
  figmaScreenshot?: {
    mimeType: string;
    dataUrl: string;
    byteLength: number;
    source: 'base64' | 'url';
    tool?: string;
    fileKey?: string;
    nodeId?: string;
    capturedAt?: string;
  };
  /** Clipped Figma context used to generate and visually refine the frontend. */
  figmaDesignText?: string;
  generatedFiles?: Record<string, string>;
  validationIssues: string[];
  writtenFiles: string[];
  branchName?: string;
  mrUrl?: string;
  mrIid?: number;
}

export function createAgentState(input: {
  figmaUrl?: string;
  componentName?: string;
  targetRepoPath?: string;
  dryRun?: boolean;
}): AgentExecutionState {
  return {
    figmaUrl: input.figmaUrl,
    componentName: input.componentName,
    targetRepoPath: input.targetRepoPath,
    dryRun: input.dryRun ?? true,
    validationIssues: [],
    writtenFiles: [],
  };
}

export function summarizeState(state: AgentExecutionState): string {
  return JSON.stringify(
    {
      figmaUrl: state.figmaUrl,
      fileKey: state.parsedUrl?.fileKey,
      nodeId: state.parsedUrl?.nodeId,
      componentName: state.componentName,
      mode: state.mode,
      dryRun: state.dryRun,
      framework: state.targetProfile?.framework,
      componentRoot: state.targetProfile?.componentRoot,
      validationIssues: state.validationIssues,
      writtenFiles: state.writtenFiles,
      branchName: state.branchName,
      mrUrl: state.mrUrl,
      mrIid: state.mrIid,
    },
    null,
    2,
  );
}
