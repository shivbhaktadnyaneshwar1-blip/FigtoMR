import { clipFigmaDesignText } from '../generation/figma-scaffold.js';
import { createAgentRuntime } from '../agent/runtime.js';
import type { StudioStreamEvent } from '../agent/runner.js';
import { loadEnv, type StudioEnv } from '../config/env.js';
import {
  extractFigmaImages,
  pickPrimaryFigmaImage,
  pngPixelSize,
  type FigmaImageAsset,
} from '../utils/figma-media.js';
import { parseFigmaUrl, requireNodeId } from '../utils/figma-url.js';
import { savePendingGenerate } from './pending-generate-store.js';

function collectImages(
  ...results: Array<{ tool?: string; content?: unknown; images?: readonly FigmaImageAsset[] } | undefined>
): FigmaImageAsset[] {
  const all: FigmaImageAsset[] = [];
  for (const result of results) {
    if (!result) continue;
    if (result.images?.length) {
      all.push(...result.images);
      continue;
    }
    all.push(...extractFigmaImages(result.content, result.tool));
  }
  return all;
}

/**
 * Human-in-the-loop phase 1: inspect Figma only, then stop for user confirm.
 * No scaffold / HTML/CSS / compare / LLM scaffolding until `/api/generate/continue`.
 */
export async function* streamInspectForConfirm(input: {
  readonly figmaUrl: string;
  readonly componentName?: string;
  readonly createMr?: boolean;
  readonly env?: StudioEnv;
}): AsyncGenerator<StudioStreamEvent> {
  const env = input.env ?? loadEnv();
  const runtime = createAgentRuntime({
    figmaUrl: input.figmaUrl,
    componentName: input.componentName,
    dryRun: true,
    env,
  });

  yield {
    type: 'status',
    message: 'Inspecting Figma node — scaffolding waits until you confirm the frame…',
  };

  try {
    const parsed = parseFigmaUrl(input.figmaUrl);
    const fileKey = parsed.fileKey;
    const nodeId = requireNodeId(parsed);
    const query = { fileKey, nodeId };

    yield {
      type: 'tool',
      name: 'inspect_figma_node',
      label: 'Inspecting Figma node',
      phase: 'start',
      source: 'figma-mcp',
      detail: `file=${fileKey.slice(0, 10)}… · node=${nodeId}`,
    };

    const inspection = await runtime.figma.inspectDesign(query);
    const screenshotResult = await runtime.figma.getScreenshot(query).catch((error: unknown) => ({
      server: 'figma' as const,
      tool: 'get_screenshot',
      content: { error: String(error) },
      images: undefined as undefined,
      isError: true as const,
    }));

    const images = collectImages(
      {
        tool: inspection.designContext.tool,
        content: inspection.designContext.content,
        images: inspection.designContext.images as FigmaImageAsset[] | undefined,
      },
      {
        tool: screenshotResult.tool,
        content: screenshotResult.content,
        images: screenshotResult.images as FigmaImageAsset[] | undefined,
      },
    );
    const primary = pickPrimaryFigmaImage(images);
    const pixelSize = primary ? pngPixelSize(primary.dataUrl) : undefined;

    const designText = clipFigmaDesignText(
      [
        typeof inspection.designContext.content === 'string'
          ? inspection.designContext.content
          : JSON.stringify(inspection.designContext.content ?? ''),
        typeof inspection.metadata?.content === 'string'
          ? inspection.metadata.content
          : JSON.stringify(inspection.metadata?.content ?? ''),
      ].join('\n'),
    );

    if (!primary) {
      yield {
        type: 'tool',
        name: 'inspect_figma_node',
        label: 'Figma inspect finished (no usable screenshot)',
        phase: 'error',
        source: 'figma-mcp',
        detail: 'Could not capture a real frame image — confirm to scaffold from design text anyway.',
      };
    } else {
      yield {
        type: 'figma_screenshot',
        mimeType: primary.mimeType,
        dataUrl: primary.dataUrl,
        byteLength: primary.byteLength,
        fileKey,
        nodeId,
        capturedAt: new Date().toISOString(),
      };
      yield {
        type: 'tool',
        name: 'inspect_figma_node',
        label: 'Figma screenshot ready',
        phase: 'done',
        source: 'figma-mcp',
        detail: pixelSize
          ? `${pixelSize.width}×${pixelSize.height} · ${Math.round(primary.byteLength / 1024)} KB`
          : `${Math.round(primary.byteLength / 1024)} KB`,
      };
    }

    const job = savePendingGenerate({
      figmaUrl: input.figmaUrl,
      componentName: input.componentName,
      createMr: Boolean(input.createMr),
      figmaDesignText: designText,
      figmaScreenshot: primary
        ? {
            mimeType: primary.mimeType,
            dataUrl: primary.dataUrl,
            byteLength: primary.byteLength,
            fileKey,
            nodeId,
            capturedAt: new Date().toISOString(),
          }
        : undefined,
    });

    yield {
      type: 'awaiting_figma_confirm',
      pendingId: job.id,
      figmaUrl: job.figmaUrl,
      componentName: job.componentName,
      hasScreenshot: Boolean(primary),
      message:
        'Confirm this Figma frame to continue scaffolding. Nothing else runs until you respond.',
    };

    yield {
      type: 'done',
      text: 'Awaiting Figma confirm',
      stateSummary: JSON.stringify({ pendingId: job.id, phase: 'awaiting_figma_confirm' }),
      dryRun: true,
      awaitingApproval: false,
      pendingId: job.id,
      awaitingFigmaConfirm: true,
    };
  } finally {
    await runtime.mcp.close().catch(() => undefined);
  }
}
