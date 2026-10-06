import { FunctionTool } from '@google/adk';
import { z } from 'zod';
import { clipFigmaDesignText, mapFigmaHints, type FigmaLayoutHints } from '../../generation/figma-scaffold.js';
import { parseFigmaUrl, requireNodeId } from '../../utils/figma-url.js';
import {
  extractFigmaImages,
  pickPrimaryFigmaImage,
  pngPixelSize,
  type FigmaImageAsset,
} from '../../utils/figma-media.js';
import type { AgentRuntime } from '../runtime.js';

function clipForModel(value: unknown, max = 8_000): unknown {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  const clippedDocs = typeof value === 'string' ? clipFigmaDesignText(text, max * 2) : text;
  const source = typeof value === 'string' ? clippedDocs : text;
  if (!source || source.length <= max) {
    return typeof value === 'string' ? clippedDocs : value;
  }
  return `${source.slice(0, max)}\n…[truncated ${source.length - max} chars — use this structure, do not wait for the rest]`;
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

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

export function createFigmaTools(runtime: AgentRuntime): FunctionTool[] {
  const parseUrl = new FunctionTool({
    name: 'parse_figma_url',
    description:
      'Parse a Figma URL into fileKey, colon nodeId, dashed nodeId, title, and kind. Always call this before Figma MCP tools.',
    parameters: z.object({
      url: z.string().describe('Full Figma URL, including node-id when available.'),
    }),
    execute: ({ url }) => {
      const parsed = parseFigmaUrl(url);
      runtime.state.figmaUrl = url;
      runtime.state.parsedUrl = parsed;
      return json({ ok: true, parsed, nodeIdRequiredNext: !parsed.nodeId });
    },
  });

  const inspectNode = new FunctionTool({
    name: 'inspect_figma_node',
    description:
      'Connect to the Figma MCP server and fetch design context, metadata, variables, AND a node screenshot. Always call with includeScreenshot=true (default) so Studio can show the Figma frame and the model can match layout.',
    parameters: z.object({
      url: z.string().optional().describe('Figma URL. Used when fileKey/nodeId are not supplied.'),
      fileKey: z.string().optional(),
      nodeId: z.string().optional(),
      includeScreenshot: z
        .boolean()
        .optional()
        .default(true)
        .describe('Fetch get_screenshot for the node. Defaults to true.'),
    }),
    execute: async ({ url, fileKey, nodeId, includeScreenshot }) => {
      const parsed = url ? parseFigmaUrl(url) : runtime.state.parsedUrl;
      const resolvedFileKey = fileKey ?? parsed?.fileKey;
      const resolvedNodeId = nodeId ?? (parsed ? requireNodeId(parsed) : undefined);
      if (!resolvedFileKey || !resolvedNodeId) {
        return json({
          ok: false,
          error: 'fileKey and nodeId are required. Call parse_figma_url first.',
        });
      }
      const query = { fileKey: resolvedFileKey, nodeId: resolvedNodeId };
      const inspection = await runtime.figma.inspectDesign(query);
      const screenshotResult =
        includeScreenshot !== false
          ? await runtime.figma.getScreenshot(query).catch((error: unknown) => ({
              server: 'figma' as const,
              tool: 'get_screenshot',
              content: { error: String(error) },
              images: undefined as undefined,
              isError: true as const,
            }))
          : undefined;

      const images = collectImages(
        {
          tool: inspection.designContext.tool,
          content: inspection.designContext.content,
          images: inspection.designContext.images as FigmaImageAsset[] | undefined,
        },
        screenshotResult
          ? {
              tool: screenshotResult.tool,
              content: screenshotResult.content,
              images: screenshotResult.images as FigmaImageAsset[] | undefined,
            }
          : undefined,
      );
      const primary = pickPrimaryFigmaImage(images);
      const pixelSize = primary ? pngPixelSize(primary.dataUrl) : undefined;
      if (primary) {
        runtime.state.figmaScreenshot = {
          mimeType: primary.mimeType,
          dataUrl: primary.dataUrl,
          byteLength: primary.byteLength,
          source: primary.source,
          tool: primary.tool ?? 'get_screenshot',
          fileKey: resolvedFileKey,
          nodeId: resolvedNodeId,
          capturedAt: new Date().toISOString(),
        };
        runtime.emitProgress({
          phase: 'done',
          source: 'figma-mcp',
          name: 'figma_screenshot',
          label: 'Figma screenshot ready',
          detail: pixelSize
            ? `${pixelSize.width}×${pixelSize.height} · ${Math.round(primary.byteLength / 1024)} KB`
            : `${Math.round(primary.byteLength / 1024)} KB · ${primary.mimeType}`,
          imageDataUrl: primary.dataUrl,
        });
      } else if (images.length > 0) {
        runtime.emitProgress({
          phase: 'error',
          source: 'figma-mcp',
          name: 'figma_screenshot',
          label: 'Figma returned a blank placeholder, not the frame',
          detail: 'Ignored images smaller than 64px. Check the node is visible in the open Figma file.',
        });
      }

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
      runtime.state.figmaDesignText = designText;

      runtime.state.figmaInspection = {
        query,
        inspection,
        screenshot: screenshotResult
          ? {
              tool: screenshotResult.tool,
              isError: screenshotResult.isError,
              imageCount: images.length,
            }
          : undefined,
        imageCount: images.length,
      };

      // Do not put megabyte base64 into the LLM tool JSON — attach via _figmaImages for Gemini vision.
      return json({
        ok: true,
        query,
        tools: (await runtime.figma.listTools()).map((tool) => tool.name),
        inspection: {
          designContext: clipForModel(inspection.designContext.content),
          metadata: clipForModel(inspection.metadata?.content, 4_000),
          variables: clipForModel(inspection.variables?.content, 4_000),
        },
        screenshot: {
          captured: Boolean(primary),
          width: pixelSize?.width,
          height: pixelSize?.height,
          tool: primary?.tool ?? screenshotResult?.tool,
          mimeType: primary?.mimeType,
          byteLength: primary?.byteLength,
          isError: screenshotResult?.isError,
          rejectedPlaceholderCount: images.length - (primary ? 1 : 0),
          hint: primary
            ? 'A real Figma frame image is attached. Then generate_component_scaffold, then generate_component_scaffold — match this frame with MCP-validated tags plus native HTML.'
            : 'No usable screenshot (Figma often returns a 30×30 blank PNG). Still call generate_component_scaffold from the design context.',
        },
        _figmaImages: primary
          ? [{ mimeType: primary.mimeType, dataUrl: primary.dataUrl }]
          : [],
      });
    },
  });

  const mapHints = new FunctionTool({
    name: 'map_figma_hints',
    description:
      'Map Figma AutoLayout, typography, and fill hints to semantic layout names and CSS variables.',
    parameters: z.object({
      hints: z
        .object({
          layoutMode: z.string().optional().nullable(),
          itemSpacing: z.number().optional().nullable(),
          padding: z.number().optional().nullable(),
          primaryAxisAlignItems: z.string().optional().nullable(),
          counterAxisAlignItems: z.string().optional().nullable(),
          layoutWrap: z.string().optional().nullable(),
          fontSize: z.number().optional().nullable(),
          fontWeight: z.number().optional().nullable(),
          name: z.string().optional().nullable(),
          type: z.string().optional().nullable(),
          fills: z
            .array(
              z.object({
                type: z.string().optional(),
                color: z.string().optional(),
                hex: z.string().optional(),
              }),
            )
            .optional(),
        })
        .describe('Subset of Figma node fields used for mapping.'),
    }),
    execute: ({ hints }) => {
      return json({ ok: true, mapped: mapFigmaHints(hints as FigmaLayoutHints) });
    },
  });

  const listFigmaTools = new FunctionTool({
    name: 'list_figma_mcp_tools',
    description: 'List tools advertised by the connected Figma MCP server.',
    parameters: z.object({}),
    execute: async () => {
      const tools = await runtime.figma.listTools();
      return json({ ok: true, tools });
    },
  });

  return [parseUrl, inspectNode, mapHints, listFigmaTools];
}
