import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { studioPreviewUrl, type StudioEnv } from '../config/env.js';
import type { TargetFrontendProfile } from '../target/frontend-profile.js';
import { logger } from '../utils/logger.js';

let playgroundChild: ChildProcess | undefined;

function chromeExecutable(): string | undefined {
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
  return candidates.find((path) => existsSync(path));
}

export async function isPlaygroundReachable(baseUrl: string): Promise<boolean> {
  const base = baseUrl.replace(/\/$/, '');
  try {
    const response = await fetch(base, { signal: AbortSignal.timeout(2500) });
    return response.ok;
  } catch {
    return false;
  }
}

/** Start the detected target-repo preview command if it is not already reachable. */
export async function ensurePlaygroundRunning(input: {
  readonly repoPath: string;
  readonly env: StudioEnv;
  readonly profile: TargetFrontendProfile;
  readonly waitMs?: number;
}): Promise<{ reachable: boolean; started: boolean; url: string; message: string }> {
  const url = studioPreviewUrl(input.env);
  if (await isPlaygroundReachable(url)) {
    return { reachable: true, started: false, url, message: 'Playground already running.' };
  }

  if (playgroundChild && !playgroundChild.killed) {
    logger.info('Playground process still starting; waiting…');
  } else {
    const script = input.profile.scripts.preview;
    if (!script) {
      return {
        reachable: false,
        started: false,
        url,
        message: 'No preview script detected in the target repository.',
      };
    }
    logger.info(`Starting target repo preview (${script}) in ${input.repoPath}…`);
    playgroundChild = spawn('npm', ['run', script], {
      cwd: input.repoPath,
      detached: true,
      stdio: 'ignore',
      env: { ...process.env },
    });
    playgroundChild.unref();
    playgroundChild.on('exit', (code) => {
      logger.warn(`Playground process exited with code ${code ?? '?'}`);
      playgroundChild = undefined;
    });
  }

  const deadline = Date.now() + (input.waitMs ?? 45_000);
  while (Date.now() < deadline) {
    if (await isPlaygroundReachable(url)) {
      return {
        reachable: true,
        started: true,
        url,
        message: 'Playground started and is reachable.',
      };
    }
    await delay(1500);
  }

  return {
    reachable: false,
    started: true,
    url,
    message: `Started playground process but ${url} is not reachable yet. Check the target repo logs.`,
  };
}

export type PlaygroundScreenshot = {
  readonly mimeType: string;
  readonly dataUrl: string;
  readonly byteLength: number;
  readonly url: string;
  readonly capturedAt: string;
};

/**
 * Capture a PNG of the playground deep-link via system Chrome headless.
 * Falls back with a clear error if Chrome is missing.
 */
export async function capturePlaygroundScreenshot(input: {
  readonly url: string;
  readonly settleMs?: number;
}): Promise<PlaygroundScreenshot> {
  const chrome = chromeExecutable();
  if (!chrome) {
    throw new Error(
      'Google Chrome / Chromium not found — cannot capture playground screenshot.',
    );
  }

  const dir = mkdtempSync(join(tmpdir(), 'figto-mr-preview-'));
  const outPath = join(dir, 'playground.png');
  const settleMs = input.settleMs ?? 8_000;

  try {
    // Give the target preview server a moment to settle after navigation.
    await delay(Math.min(2000, settleMs));

    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        chrome,
        [
          '--headless=new',
          '--disable-gpu',
          '--hide-scrollbars',
          '--no-first-run',
          '--no-default-browser-check',
          `--window-size=1280,900`,
          `--screenshot=${outPath}`,
          `--virtual-time-budget=${Math.max(settleMs, 5000)}`,
          input.url,
        ],
        { stdio: 'ignore' },
      );
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('Playground screenshot timed out.'));
      }, settleMs + 20_000);
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        if (code === 0 || existsSync(outPath)) resolve();
        else reject(new Error(`Chrome exited with code ${code ?? '?'}`));
      });
    });

    if (!existsSync(outPath)) {
      throw new Error('Chrome did not write a screenshot file.');
    }
    const bytes = readFileSync(outPath);
    const dataUrl = `data:image/png;base64,${bytes.toString('base64')}`;
    return {
      mimeType: 'image/png',
      dataUrl,
      byteLength: bytes.byteLength,
      url: input.url,
      capturedAt: new Date().toISOString(),
    };
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
}
