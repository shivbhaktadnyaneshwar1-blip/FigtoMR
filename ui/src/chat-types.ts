import type { ProposedFile } from './studio-types';
import type { ActivityItem } from './activity-reasoning';

export type StudioChatMessage =
  | {
      id: number;
      kind: 'text';
      role: 'user' | 'assistant';
      text: string;
    }
  | {
      id: number;
      kind: 'figma';
      dataUrl: string;
      nodeId?: string;
      status: 'pending' | 'confirmed' | 'rejected';
    }
  | {
      id: number;
      kind: 'files';
      files: readonly ProposedFile[];
      componentName?: string;
      selectedPath?: string;
    }
  | {
      id: number;
      kind: 'playground';
      url: string;
      visualMatch?: boolean | null;
    }
  | {
      id: number;
      kind: 'progress';
      label: string;
    }
  | {
      id: number;
      kind: 'approve';
      createMr: boolean;
      approving: boolean;
      visualMatch?: boolean | null;
    }
  | {
      /** Completed AI-reasoning turn sealed above a concrete Studio response. */
      id: number;
      kind: 'reasoning';
      activity: readonly ActivityItem[];
      statusLabel: string;
      summary?: string;
    };

const FIGMA_URL_RE = /https?:\/\/(?:www\.)?figma\.com\/[^\s]+/i;

/** Pull a Figma design URL and optional PascalCase / quoted component name from free text. */
export function parseChatGenerateIntent(text: string): {
  figmaUrl?: string;
  componentName?: string;
} {
  const figmaUrl = text.match(FIGMA_URL_RE)?.[0];
  const named =
    text.match(/(?:component\s*(?:name)?|name)\s*[:=]\s*["']?([A-Za-z][A-Za-z0-9]*)/i)?.[1] ??
    text.match(/\bas\s+([A-Z][A-Za-z0-9]+)\b/)?.[1] ??
    text.match(/["']([A-Z][A-Za-z0-9]+)["']/)?.[1];
  return {
    figmaUrl,
    componentName: named,
  };
}

export function isAffirmative(text: string): boolean {
  return /^(y|yes|yeah|yep|ok|okay|looks good|good|confirm|continue|proceed|lgtm)\b/i.test(
    text.trim(),
  );
}

export function isNegative(text: string): boolean {
  return /^(n|no|nope|wrong|reject|cancel|stop|redo|not good|looks off)\b/i.test(text.trim());
}
