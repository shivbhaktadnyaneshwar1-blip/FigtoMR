import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { requireGeminiConfig, type StudioEnv } from '../config/env.js';
import { buildGeminiAuthHeaders, geminiChatCompletionsUrl } from '../utils/gemini-http.js';
import { logger } from '../utils/logger.js';

export type VisualProgress = 'closer' | 'same' | 'farther' | 'unknown';

export type FileCheckpoint = ReadonlyMap<string, string | null>;

export type ScreenshotRef = {
  readonly mimeType: string;
  readonly dataUrl: string;
};

/** Snapshot allowlisted component files so a bad refine pass can be rolled back. */
export function checkpointFiles(
  repoPath: string,
  relativePaths: readonly string[],
): FileCheckpoint {
  const map = new Map<string, string | null>();
  for (const rel of relativePaths) {
    const normalized = rel.replace(/\\/g, '/');
    const absolute = join(repoPath, normalized);
    map.set(normalized, existsSync(absolute) ? readFileSync(absolute, 'utf8') : null);
  }
  return map;
}

/** Restore files to the checkpoint (creates parents; deletes by writing empty not supported — only restore content). */
export function restoreCheckpoint(repoPath: string, checkpoint: FileCheckpoint): string[] {
  const restored: string[] = [];
  for (const [rel, contents] of checkpoint) {
    const absolute = join(repoPath, rel);
    if (contents == null) {
      // File did not exist before this pass — leave as-is if refine created it;
      // best-effort: write was an addition we cannot safely delete here.
      continue;
    }
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, contents, 'utf8');
    restored.push(rel);
  }
  return restored;
}

export function parseVisualProgress(text: string): VisualProgress {
  const match = /\b(CLOSER|SAME|FARTHER)\b/i.exec(text);
  if (!match) return 'unknown';
  return match[1]!.toLowerCase() as VisualProgress;
}

function toDataUrl(shot: ScreenshotRef): string {
  if (shot.dataUrl.startsWith('data:')) return shot.dataUrl;
  const mime = shot.mimeType || 'image/png';
  return `data:${mime};base64,${shot.dataUrl}`;
}

/**
 * Host vision gate: is playground AFTER closer to Figma than playground BEFORE?
 * Prevents the refine loop from accepting regressions.
 */
export async function judgeVisualProgress(input: {
  readonly env: StudioEnv;
  readonly figma: ScreenshotRef;
  readonly before: ScreenshotRef;
  readonly after: ScreenshotRef;
}): Promise<{ progress: VisualProgress; reason: string; raw: string }> {
  const env = requireGeminiConfig(input.env);
  const headers = buildGeminiAuthHeaders(env);
  const url = geminiChatCompletionsUrl(env);

  const body = {
    model: env.ADK_MODEL,
    messages: [
      {
        role: 'system',
        content:
          'You compare UI screenshots. Answer with exactly one word on the first line: CLOSER, SAME, or FARTHER — whether image AFTER is closer to FIGMA than image BEFORE. Second line: one short reason. Prefer FARTHER if AFTER invents chrome not in FIGMA, drops content that was closer, shows wrong titles/numbers vs FIGMA, uses placeholder copy like "Metric 1", or looks more broken. Matching readable Figma data (labels, prices, KPI values) counts toward CLOSER.',
      },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'FIGMA is the design target. BEFORE is the playground before this refine pass. AFTER is the playground after the pass. Is AFTER closer to FIGMA?',
          },
          { type: 'text', text: 'FIGMA:' },
          { type: 'image_url', image_url: { url: toDataUrl(input.figma) } },
          { type: 'text', text: 'BEFORE:' },
          { type: 'image_url', image_url: { url: toDataUrl(input.before) } },
          { type: 'text', text: 'AFTER:' },
          { type: 'image_url', image_url: { url: toDataUrl(input.after) } },
        ],
      },
    ],
  };

  logger.info(`Visual progress judge → ${url} model=${env.ADK_MODEL}`);
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const rawText = await response.text();
  if (!response.ok) {
    logger.warn(`Visual progress judge failed (${response.status}): ${rawText.slice(0, 240)}`);
    return { progress: 'unknown', reason: `judge failed (${response.status})`, raw: rawText };
  }

  let content = '';
  try {
    const payload = JSON.parse(rawText) as {
      choices?: Array<{ message?: { content?: string | null } }>;
    };
    content = payload.choices?.[0]?.message?.content?.trim() ?? '';
  } catch {
    content = rawText.slice(0, 400);
  }

  const progress = parseVisualProgress(content);
  const reason =
    content
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line && !/^(CLOSER|SAME|FARTHER)\b/i.test(line)) ?? content.slice(0, 160);

  return { progress, reason, raw: content };
}
