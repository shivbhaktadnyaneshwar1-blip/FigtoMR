/** Normalize Figma / MCP binary or URL image payloads into browser-ready data URLs. */

export interface FigmaImageAsset {
  readonly mimeType: string;
  readonly dataUrl: string;
  readonly byteLength: number;
  readonly source: 'base64' | 'url';
  readonly tool?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function mimeFromPath(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const lower = path.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  return undefined;
}

export function toDataUrl(mimeType: string, base64: string): string {
  const cleaned = base64.replace(/\s+/g, '');
  if (cleaned.startsWith('data:')) {
    return cleaned;
  }
  return `data:${mimeType};base64,${cleaned}`;
}

/** Read PNG IHDR width/height. Returns undefined for non-PNG or truncated payloads. */
export function pngPixelSize(dataUrl: string): { width: number; height: number } | undefined {
  const payload = dataUrl.includes(',') ? dataUrl.slice(dataUrl.indexOf(',') + 1) : dataUrl;
  let bytes: Buffer;
  try {
    bytes = Buffer.from(payload, 'base64');
  } catch {
    return undefined;
  }
  if (bytes.length < 24 || bytes[0] !== 0x89 || bytes[1] !== 0x50) {
    return undefined;
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/** Figma sometimes returns a ~30×30 blank export. That is not a usable frame. */
export function isUsableFigmaScreenshot(image: FigmaImageAsset, minEdge = 64): boolean {
  if (image.byteLength < 400 && image.source === 'base64') {
    return false;
  }
  const size = pngPixelSize(image.dataUrl);
  if (!size) {
    // Non-PNG (jpeg/webp) — keep if the payload is large enough to be a frame.
    return image.byteLength > 2_000;
  }
  return size.width >= minEdge && size.height >= minEdge;
}

/** Pull image parts out of an MCP tool result content array / structured payload. */
export function extractFigmaImages(
  content: unknown,
  tool?: string,
): FigmaImageAsset[] {
  const found: FigmaImageAsset[] = [];
  const seen = new Set<string>();

  const push = (mimeType: string, dataOrUrl: string, source: 'base64' | 'url') => {
    const dataUrl =
      source === 'url' && !dataOrUrl.startsWith('data:')
        ? dataOrUrl
        : toDataUrl(mimeType, dataOrUrl);
    if (seen.has(dataUrl)) return;
    seen.add(dataUrl);
    found.push({
      mimeType,
      dataUrl,
      byteLength: dataUrl.length,
      source,
      tool,
    });
  };

  const visit = (node: unknown, depth = 0): void => {
    if (node == null || depth > 6) return;
    if (typeof node === 'string') {
      if (node.startsWith('data:image/')) {
        const mime = node.slice(5, node.indexOf(';')) || 'image/png';
        push(mime, node, 'base64');
      }
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }
    const obj = asRecord(node);
    if (!obj) return;

    const type = typeof obj.type === 'string' ? obj.type : undefined;
    if (type === 'image' || type === 'image_url' || type === 'media') {
      const mime =
        (typeof obj.mimeType === 'string' && obj.mimeType) ||
        (typeof obj.mediaType === 'string' && obj.mediaType) ||
        mimeFromPath(typeof obj.name === 'string' ? obj.name : undefined) ||
        'image/png';
      if (typeof obj.data === 'string' && obj.data.length > 8) {
        push(mime, obj.data, 'base64');
      }
      if (typeof obj.blob === 'string' && obj.blob.length > 8) {
        push(mime, obj.blob, 'base64');
      }
      const imageUrl = asRecord(obj.image_url);
      if (typeof imageUrl?.url === 'string') {
        push(mime, imageUrl.url, imageUrl.url.startsWith('data:') ? 'base64' : 'url');
      }
      if (typeof obj.url === 'string') {
        push(mime, obj.url, obj.url.startsWith('data:') ? 'base64' : 'url');
      }
    }

    // Common Figma MCP shapes
    if (typeof obj.image === 'string') {
      push('image/png', obj.image, obj.image.startsWith('data:') ? 'base64' : 'url');
    }
    if (typeof obj.screenshot === 'string') {
      push('image/png', obj.screenshot, obj.screenshot.startsWith('data:') ? 'base64' : 'url');
    }
    for (const key of ['content', 'contents', 'data', 'result', 'images', 'artifacts']) {
      if (key in obj) visit(obj[key], depth + 1);
    }
  };

  visit(content);
  return found;
}

const IMAGE_URL_RE = /https?:\/\/[^\s"'<>)\\]+/g;

/** URLs in an MCP text payload that are likely the screenshot, not the Figma file page. */
export function extractScreenshotUrls(content: unknown): string[] {
  const text = typeof content === 'string' ? content : JSON.stringify(content ?? '');
  const urls = text.match(IMAGE_URL_RE) ?? [];
  const cleaned = urls.map((url) => url.replace(/[),.;]+$/, ''));
  return [...new Set(cleaned)].filter((url) => {
    if (/figma\.com\/(design|file|proto|board|slides|make)\//i.test(url)) {
      return false;
    }
    return (
      /\.(png|jpe?g|webp|gif)(\?|$)/i.test(url) ||
      /screenshot|image|render|asset|amazonaws|cloudfront/i.test(url)
    );
  });
}

export async function downloadScreenshotUrl(url: string): Promise<FigmaImageAsset | undefined> {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) {
    return undefined;
  }
  const mimeType = (response.headers.get('content-type') ?? 'image/png').split(';')[0]!.trim();
  if (!mimeType.startsWith('image/')) {
    return undefined;
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 400) {
    return undefined;
  }
  const dataUrl = `data:${mimeType};base64,${bytes.toString('base64')}`;
  const asset: FigmaImageAsset = {
    mimeType,
    dataUrl,
    byteLength: dataUrl.length,
    source: 'url',
    tool: 'get_screenshot',
  };
  return isUsableFigmaScreenshot(asset) ? asset : undefined;
}
export function pickPrimaryFigmaImage(images: readonly FigmaImageAsset[]): FigmaImageAsset | undefined {
  const usable = images.filter((image) => isUsableFigmaScreenshot(image));
  const pool = usable.length > 0 ? usable : [];
  if (pool.length === 0) return undefined;
  return [...pool].sort((a, b) => b.byteLength - a.byteLength)[0];
}
