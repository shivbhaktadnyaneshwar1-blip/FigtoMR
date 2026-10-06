import { LlmAgent, type BaseTool, type BaseToolset } from '@google/adk';
import { requireGeminiConfig } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { SYSTEM_PROMPT } from './prompts/system-prompt.js';
import { createAgentRuntime, type AgentRuntime } from './runtime.js';
import { createFigmaTools } from './tools/figma-tools.js';
import { createValidatorTools } from './tools/validator-tool.js';
import { createWriterTools } from './tools/writer-tools.js';

export const AGENT_NAME = 'figto_mr';
export const APP_NAME = 'FigtoMR';

export function createFigtoMRAgent(runtime: AgentRuntime = createAgentRuntime()): LlmAgent {
  const env = requireGeminiConfig(runtime.env);
  logger.info(`Using Gemini model=${env.ADK_MODEL}`);

  const tools: Array<BaseTool | BaseToolset> = [
    ...createFigmaTools(runtime),
    ...createWriterTools(runtime),
    ...createValidatorTools(runtime),
  ];

  const figma = runtime.mcp.resolvedConfig.figma;
  if (figma.enabled) {
    logger.info(`Figma MCP configured: ${figma.transport} ${figma.url ?? '(stdio)'}`);
  }

  return new LlmAgent({
    name: AGENT_NAME,
    model: env.ADK_MODEL,
    description:
      'Maps Figma nodes to React components with standard CSS in a configurable target git repo (Gemini via ADK).',
    instruction: SYSTEM_PROMPT,
    tools,
  });
}

/** ADK DevTools entry: `npx @google/adk-devtools run agent.ts` */
export function createRootAgent(): LlmAgent {
  return createFigtoMRAgent(createAgentRuntime());
}

function geminiKeyPresent(): boolean {
  return Boolean(process.env.GEMINI_API_KEY?.trim() || process.env.GOOGLE_API_KEY?.trim());
}

/**
 * Built when a Gemini key is already loaded. The studio API imports this module
 * at boot; without a key, generation still fails later with a clear error.
 */
export const rootAgent: LlmAgent | undefined = geminiKeyPresent() ? createRootAgent() : undefined;
