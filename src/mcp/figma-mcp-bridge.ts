import type { ParsedFigmaUrl } from '../utils/figma-url.js';
import { requireNodeId, toColonNodeId } from '../utils/figma-url.js';
import {
  downloadScreenshotUrl,
  extractFigmaImages,
  extractScreenshotUrls,
  isUsableFigmaScreenshot,
  pickPrimaryFigmaImage,
} from '../utils/figma-media.js';
import { logger } from '../utils/logger.js';
import type { McpCallResult, McpClientManager } from './client-manager.js';

export interface FigmaNodeQuery {
  readonly fileKey: string;
  readonly nodeId: string;
}

export function toFigmaNodeQuery(parsed: ParsedFigmaUrl): FigmaNodeQuery {
  return {
    fileKey: parsed.fileKey,
    nodeId: requireNodeId(parsed),
  };
}

export class FigmaMcpBridge {
  constructor(private readonly manager: McpClientManager) {}

  async listTools() {
    return this.manager.listTools('figma');
  }

  async getDesignContext(
    query: FigmaNodeQuery,
    extra: Record<string, unknown> = {},
  ): Promise<McpCallResult> {
    const nodeId = toColonNodeId(query.nodeId);
    // Official schema: fileKey + nodeId are required. Extra unknown keys are rejected.
    const result = await this.manager.callFirstAvailable(
      'figma',
      'getDesignContext',
      {
        fileKey: query.fileKey,
        nodeId,
        clientLanguages: 'typescript',
        clientFrameworks: 'react',
        excludeScreenshot: false,
        ...extra,
      },
      ['get_design_context'],
    );
    return this.withDownloadedScreenshots(result);
  }

  async getMetadata(query: FigmaNodeQuery): Promise<McpCallResult> {
    return this.manager.callFirstAvailable(
      'figma',
      'getMetadata',
      { fileKey: query.fileKey, nodeId: toColonNodeId(query.nodeId) },
      ['get_metadata'],
    );
  }

  async getVariables(query: FigmaNodeQuery): Promise<McpCallResult> {
    return this.manager.callFirstAvailable(
      'figma',
      'getVariables',
      { fileKey: query.fileKey, nodeId: toColonNodeId(query.nodeId) },
      ['get_variable_defs'],
    );
  }

  async getScreenshot(query: FigmaNodeQuery): Promise<McpCallResult> {
    const nodeId = toColonNodeId(query.nodeId);
    // https://www.figma.com/design/:fileKey/:name?node-id=1-8512 → fileKey + nodeId "1:8512".
    // get_screenshot rejects unknown keys and returns a URL unless enableBase64Response is set.
    const attempts: Record<string, unknown>[] = [
      {
        fileKey: query.fileKey,
        nodeId,
        enableBase64Response: true,
        maxDimension: 1600,
      },
      { fileKey: query.fileKey, nodeId },
    ];
    let last: McpCallResult | undefined;
    for (const args of attempts) {
      try {
        const result = await this.withDownloadedScreenshots(
          await this.manager.callFirstAvailable('figma', 'getScreenshot', args, ['get_screenshot']),
        );
        last = result;
        const usable = (result.images ?? []).some((image) =>
          isUsableFigmaScreenshot({
            mimeType: image.mimeType,
            dataUrl: image.dataUrl,
            byteLength: image.byteLength,
            source: image.source,
          }),
        );
        if (!result.isError && usable) {
          logger.info(
            `Figma screenshot ok fileKey=${query.fileKey} nodeId=${nodeId} images=${result.images?.length ?? 0}`,
          );
          return result;
        }
        logger.warn(
          `Figma screenshot not usable yet fileKey=${query.fileKey} nodeId=${nodeId} isError=${Boolean(result.isError)}`,
        );
      } catch (error) {
        logger.warn(`Figma screenshot call failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return (
      last ?? {
        server: 'figma',
        tool: 'get_screenshot',
        content: {
          error: `get_screenshot failed for fileKey=${query.fileKey} nodeId=${nodeId}. Open that file in Figma desktop with Dev Mode MCP enabled.`,
        },
        isError: true,
      }
    );
  }

  /** Figma MCP often returns a short-lived PNG URL instead of pixels. Download it. */
  private async withDownloadedScreenshots(result: McpCallResult): Promise<McpCallResult> {
    const existing = [...(result.images ?? [])];
    const urls = extractScreenshotUrls(result.content);
    for (const url of urls.slice(0, 3)) {
      try {
        const downloaded = await downloadScreenshotUrl(url);
        if (!downloaded) continue;
        existing.push({
          mimeType: downloaded.mimeType,
          dataUrl: downloaded.dataUrl,
          byteLength: downloaded.byteLength,
          source: downloaded.source,
        });
      } catch (error) {
        logger.warn(
          `Could not download Figma screenshot URL: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    const inline = extractFigmaImages(result.content, result.tool).map(
      ({ mimeType, dataUrl, byteLength, source }) => ({ mimeType, dataUrl, byteLength, source }),
    );
    const images = [...existing, ...inline];
    const primary = pickPrimaryFigmaImage(
      images.map((image) => ({ ...image, tool: result.tool })),
    );
    return {
      ...result,
      images: primary
        ? [
            {
              mimeType: primary.mimeType,
              dataUrl: primary.dataUrl,
              byteLength: primary.byteLength,
              source: primary.source,
            },
          ]
        : images.length > 0
          ? images
          : undefined,
    };
  }

  async inspectDesign(query: FigmaNodeQuery): Promise<{
    designContext: McpCallResult;
    metadata?: McpCallResult;
    variables?: McpCallResult;
  }> {
    const designContext = await this.getDesignContext(query);
    const [metadata, variables] = await Promise.allSettled([
      this.getMetadata(query),
      this.getVariables(query),
    ]);
    return {
      designContext,
      metadata: metadata.status === 'fulfilled' ? metadata.value : undefined,
      variables: variables.status === 'fulfilled' ? variables.value : undefined,
    };
  }
}
