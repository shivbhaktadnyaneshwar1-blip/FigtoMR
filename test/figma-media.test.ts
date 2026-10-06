import { describe, expect, it } from 'vitest';
import { extractFigmaImages, extractScreenshotUrls, pickPrimaryFigmaImage, pngPixelSize, toDataUrl } from '../src/utils/figma-media.js';

describe('figma-media', () => {
  it('builds data URLs from raw base64', () => {
    expect(toDataUrl('image/png', 'abc123')).toBe('data:image/png;base64,abc123');
    expect(toDataUrl('image/png', 'data:image/png;base64,xyz')).toBe('data:image/png;base64,xyz');
  });

  it('extracts MCP image content blocks', () => {
    const images = extractFigmaImages(
      [
        { type: 'text', text: 'hello' },
        { type: 'image', mimeType: 'image/png', data: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYX' },
      ],
      'get_screenshot',
    );
    expect(images).toHaveLength(1);
    expect(images[0]?.dataUrl).toBe(
      'data:image/png;base64,AAECAwQFBgcICQoLDA0ODxAREhMUFRYX',
    );
    expect(images[0]?.tool).toBe('get_screenshot');
  });

  it('ignores the Figma file page URL and keeps screenshot asset URLs', () => {
    const urls = extractScreenshotUrls(
      'Open https://www.figma.com/design/SjWj5yIRnGznMEhQnPndvp/Agent-hub?node-id=1-8512 then curl https://www.figma.com/api/mcp/asset/abc123/screenshot.png',
    );
    expect(urls).toEqual(['https://www.figma.com/api/mcp/asset/abc123/screenshot.png']);
  });

  it('rejects the 30×30 blank Figma placeholder and keeps a real frame', () => {
    const blank =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAB4AAAAeCAYAAAA7MK6iAAAACXBIWXMAAAsTAAALEwEAmpwYAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAOdEVYdFNvZnR3YXJlAEZpZ21hnrGWYwAAABpJREFUeAHtwDEBAAAAwqD1T+1vBigAAAB4Aw4uAAHDJejPAAAAAElFTkSuQmCC';
    expect(pngPixelSize(blank)).toEqual({ width: 30, height: 30 });
    const primary = pickPrimaryFigmaImage([
      {
        mimeType: 'image/png',
        dataUrl: blank,
        byteLength: blank.length,
        source: 'base64',
        tool: 'get_screenshot',
      },
      {
        mimeType: 'image/jpeg',
        dataUrl: 'https://example.test/frame.jpg',
        byteLength: 80_000,
        source: 'url',
      },
    ]);
    expect(primary?.byteLength).toBe(80_000);
  });
});
