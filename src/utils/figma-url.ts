export interface ParsedFigmaUrl {
  readonly rawUrl: string;
  readonly fileKey: string;
  readonly nodeId?: string;
  readonly nodeIdDashed?: string;
  readonly title?: string;
  readonly branchKey?: string;
  readonly kind: 'design' | 'file' | 'proto' | 'make' | 'board' | 'slides';
}

const FILE_KEY_PATTERN = /^[0-9a-zA-Z]{22,128}$/;
const NODE_ID_PATTERN = /^(?:\d+[:-]\d+|[IT]\d+[:-]\d+(?:;\d+[:-]\d+)*)$/;

export function toColonNodeId(nodeId: string): string {
  const decoded = decodeURIComponent(nodeId).trim();
  const normalized = decoded.replace(/-/g, ':');
  if (!NODE_ID_PATTERN.test(normalized) && !/^\d+:\d+$/.test(normalized)) {
    throw new Error(`Invalid Figma node id: "${nodeId}".`);
  }
  return normalized;
}

export function toDashedNodeId(nodeId: string): string {
  return toColonNodeId(nodeId).replace(/:/g, '-');
}

function firstQueryValue(searchParams: URLSearchParams, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = searchParams.get(key);
    if (value) {
      return value;
    }
  }
  return undefined;
}

export function parseFigmaUrl(input: string): ParsedFigmaUrl {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error(`Not a valid URL: "${input}".`);
  }

  const host = url.hostname.replace(/^www\./, '');
  if (host !== 'figma.com') {
    throw new Error(`Expected a figma.com URL. Received host: "${url.hostname}".`);
  }

  const segments = url.pathname.split('/').filter(Boolean);
  const kindRaw = segments[0];
  const kind = (['design', 'file', 'proto', 'make', 'board', 'slides'] as const).includes(
    kindRaw as ParsedFigmaUrl['kind'],
  )
    ? (kindRaw as ParsedFigmaUrl['kind'])
    : undefined;

  if (!kind) {
    throw new Error(
      `Unsupported Figma URL path "/${segments.join('/')}". Expected /design, /file, /proto, /make, /board, or /slides.`,
    );
  }

  let fileKey: string | undefined;
  let branchKey: string | undefined;
  let title: string | undefined;

  if (kind === 'design' && segments[2] === 'branch' && segments[3]) {
    fileKey = segments[3];
    branchKey = segments[3];
    title = segments[4] ? decodeURIComponent(segments[4]) : undefined;
  } else {
    fileKey = segments[1];
    title = segments[2] ? decodeURIComponent(segments[2]) : undefined;
  }

  if (!fileKey || !FILE_KEY_PATTERN.test(fileKey)) {
    throw new Error(`Unable to extract a valid Figma file key from "${input}".`);
  }

  const nodeIdRaw = firstQueryValue(url.searchParams, ['node-id', 'node-ID', 'nodeId']);
  const nodeId = nodeIdRaw ? toColonNodeId(nodeIdRaw) : kind === 'make' ? '0:1' : undefined;

  return {
    rawUrl: url.toString(),
    fileKey,
    nodeId,
    nodeIdDashed: nodeId ? toDashedNodeId(nodeId) : undefined,
    title,
    branchKey,
    kind,
  };
}

export function requireNodeId(parsed: ParsedFigmaUrl): string {
  if (!parsed.nodeId) {
    throw new Error(
      'Figma URL is missing node-id. Provide a node-specific URL such as https://www.figma.com/design/:fileKey/:title?node-id=123-456.',
    );
  }
  return parsed.nodeId;
}
