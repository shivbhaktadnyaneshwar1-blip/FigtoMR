import { randomBytes } from 'node:crypto';

export type PendingFigmaScreenshot = {
  readonly mimeType: string;
  readonly dataUrl: string;
  readonly byteLength: number;
  readonly fileKey?: string;
  readonly nodeId?: string;
  readonly capturedAt?: string;
};

export type PendingGenerate = {
  readonly id: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly figmaUrl: string;
  readonly componentName?: string;
  readonly createMr: boolean;
  readonly figmaScreenshot?: PendingFigmaScreenshot;
  readonly figmaDesignText?: string;
};

const pending = new Map<string, PendingGenerate>();
const TTL_MS = 2 * 60 * 60 * 1000;

function prune(): void {
  const cutoff = Date.now() - TTL_MS;
  for (const [id, job] of pending) {
    if (Date.parse(job.updatedAt) < cutoff) pending.delete(id);
  }
}

export function savePendingGenerate(
  input: Omit<PendingGenerate, 'id' | 'createdAt' | 'updatedAt'>,
): PendingGenerate {
  prune();
  const now = new Date().toISOString();
  const job: PendingGenerate = {
    ...input,
    id: randomBytes(12).toString('hex'),
    createdAt: now,
    updatedAt: now,
  };
  pending.set(job.id, job);
  return job;
}

export function getPendingGenerate(id: string): PendingGenerate | undefined {
  prune();
  return pending.get(id);
}

export function deletePendingGenerate(id: string): boolean {
  return pending.delete(id);
}
