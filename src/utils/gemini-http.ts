import { requireGeminiConfig, type StudioEnv } from '../config/env.js';

const DEFAULT_GEMINI_OPENAI_BASE =
  'https://generativelanguage.googleapis.com/v1beta/openai';

export function resolveGeminiOpenAiBaseUrl(env: StudioEnv = requireGeminiConfig()): string {
  const override = process.env.GEMINI_OPENAI_BASE_URL?.trim();
  return (override || DEFAULT_GEMINI_OPENAI_BASE).replace(/\/$/, '');
}

export function buildGeminiAuthHeaders(env: StudioEnv = requireGeminiConfig()): Record<string, string> {
  const key = env.GEMINI_API_KEY?.trim() || env.GOOGLE_API_KEY?.trim();
  if (!key) {
    throw new Error('Missing GEMINI_API_KEY or GOOGLE_API_KEY');
  }
  return {
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
  };
}

export function geminiChatCompletionsUrl(env: StudioEnv = requireGeminiConfig()): string {
  return `${resolveGeminiOpenAiBaseUrl(env)}/chat/completions`;
}
