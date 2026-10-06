import express, { type Express, type Request, type Response } from 'express';
import type { Server } from 'node:http';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv, studioPreviewUrl } from '../config/env.js';
import { streamFigtoMRAgent } from '../agent/runner.js';
import { applyApprovedProposal, streamApplyApprovedProposal } from './apply-proposal.js';
import {
  deleteProposal,
  getProposal,
  proposalPublicView,
  buildComponentPreviewUrl,
} from './proposal-store.js';
// import { streamRefineSessionChat } from './refine-session.js';
import { dispatchMrChat } from './intent-router.js';
import { streamStageProposal } from './stage-proposal.js';
import { streamVisualCompareLoop } from './compare-loop.js';
import {
  capturePlaygroundScreenshot,
  ensurePlaygroundRunning,
  isPlaygroundReachable,
} from './playground-lifecycle.js';
import { getStudioSession, sessionPublicView } from './session-store.js';
import { resolveTargetRepoPath } from '../config/env.js';
import {
  clearFigmaAuth,
  figmaAuthStatus,
  finishFigmaOAuth,
  startFigmaOAuth,
} from '../mcp/figma-oauth.js';
import { streamInspectForConfirm } from './inspect-figma.js';
import { deletePendingGenerate, getPendingGenerate } from './pending-generate-store.js';
import { logger } from '../utils/logger.js';
import { parseGitHost } from '../gitlab/create-mr.js';
import { attachMergeRequestSession } from './mr-session.js';
import { inspectTargetFrontendProfile } from '../target/frontend-profile.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const UI_DIST = join(__dirname, '../../../ui/dist');
const UI_DIST_FALLBACK = join(__dirname, '../../ui/dist');
const RESOLVED_UI_DIST = existsSync(UI_DIST) ? UI_DIST : UI_DIST_FALLBACK;

function writeSse(res: Response, event: { type: string } & Record<string, unknown>): void {
  res.write(`event: ${event.type}\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

/** Express app: React UI (`ui/dist`) + streamable generate API. */
export function createStudioApp(): Express {
  const app = express();

  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  });

  app.use(express.json({ limit: '2mb' }));

  app.get('/api/playground/status', async (_req, res) => {
    const env = loadEnv();
    const base = studioPreviewUrl(env);
    const reachable = await isPlaygroundReachable(base);
    res.json({
      ok: true,
      reachable,
      url: base,
      hint: reachable
        ? 'Playground is reachable.'
        : 'Playground offline — Studio can start it via POST /api/playground/start',
    });
  });

  app.post('/api/playground/start', async (_req, res) => {
    try {
      const env = loadEnv();
      const repoPath = resolveTargetRepoPath(env);
      const result = await ensurePlaygroundRunning({
        repoPath,
        env,
        profile: inspectTargetFrontendProfile(repoPath),
      });
      res.json({ ok: true, ...result });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.post('/api/playground/screenshot', async (req, res) => {
    try {
      const env = loadEnv();
      const body = (req.body ?? {}) as { url?: string; componentName?: string };
      const url =
        body.url?.trim() ||
        (body.componentName
          ? buildComponentPreviewUrl(
              studioPreviewUrl(env),
              body.componentName,
              inspectTargetFrontendProfile(resolveTargetRepoPath(env)),
            )
          : studioPreviewUrl(env));
      if (!(await isPlaygroundReachable(studioPreviewUrl(env)))) {
        const repoPath = resolveTargetRepoPath(env);
        await ensurePlaygroundRunning({
          repoPath,
          env,
          profile: inspectTargetFrontendProfile(repoPath),
        });
      }
      const shot = await capturePlaygroundScreenshot({ url });
      res.json({ ok: true, screenshot: shot });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.get('/api/figma/auth/status', async (_req, res) => {
    res.json({ ok: true, ...(await figmaAuthStatus()) });
  });

  app.post('/api/figma/auth/start', async (_req, res) => {
    try {
      const result = await startFigmaOAuth({ openBrowser: true });
      res.json({ ok: true, ...result });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.post('/api/figma/auth/logout', async (_req, res) => {
    clearFigmaAuth();
    res.json({ ok: true, ...(await figmaAuthStatus()) });
  });

  app.get('/api/figma/oauth/callback', async (req: Request, res: Response) => {
    const code = typeof req.query.code === 'string' ? req.query.code : undefined;
    const state = typeof req.query.state === 'string' ? req.query.state : undefined;
    const error = typeof req.query.error === 'string' ? req.query.error : undefined;

    if (error) {
      res
        .status(400)
        .type('html')
        .send(
          `<!doctype html><meta charset="utf-8" /><title>Figma auth failed</title>
           <body style="font-family:system-ui;padding:2rem">
           <h1>Figma authorization failed</h1>
           <p>${error}</p>
           <p>You can close this window and try Connect Figma again.</p>
           </body>`,
        );
      return;
    }

    if (!code) {
      res.status(400).type('html').send('Missing authorization code.');
      return;
    }

    try {
      await finishFigmaOAuth({ code, state });
      res
        .status(200)
        .type('html')
        .send(
          `<!doctype html><meta charset="utf-8" /><title>Figma connected</title>
           <body style="font-family:system-ui;padding:2rem">
           <h1>Figma MCP connected</h1>
           <p>You can close this window and return to FigtoMR.</p>
           <script>setTimeout(() => window.close(), 1500);</script>
           </body>`,
        );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`Figma OAuth callback failed: ${message}`);
      res
        .status(500)
        .type('html')
        .send(
          `<!doctype html><meta charset="utf-8" /><title>Figma auth error</title>
           <body style="font-family:system-ui;padding:2rem">
           <h1>Could not finish Figma OAuth</h1>
           <p>${message}</p>
           </body>`,
        );
    }
  });

  app.get('/api/proposals/:id', (req, res) => {
    const id = String(req.params.id ?? '');
    const proposal = getProposal(id);
    if (!proposal) {
      res.status(404).json({ ok: false, error: 'Proposal not found or expired.' });
      return;
    }
    res.json({ ok: true, proposal: proposalPublicView(proposal) });
  });

  app.post('/api/proposals/:id/reject', (req, res) => {
    const id = String(req.params.id ?? '');
    deleteProposal(id);
    res.json({ ok: true, rejected: true });
  });

  app.post('/api/proposals/:id/stage', async (req: Request, res: Response) => {
    const wantsStream =
      String(req.headers.accept ?? '').includes('text/event-stream') || req.query.stream === '1';
    try {
      const env = loadEnv();
      if (!wantsStream) {
        const { stageProposal } = await import('./stage-proposal.js');
        const result = await stageProposal({
          proposalId: String(req.params.id ?? ''),
          env,
          captureScreenshot: true,
        });
        res.json({ ok: true, ...result });
        return;
      }

      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders?.();
      res.write(': connected\n\n');

      for await (const event of streamStageProposal({
        proposalId: String(req.params.id ?? ''),
        env,
        captureScreenshot: true,
      })) {
        writeSse(res, event);
      }
      res.end();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!res.headersSent) {
        res.status(400).json({ ok: false, error: message });
        return;
      }
      writeSse(res, { type: 'error', message });
      res.end();
    }
  });

  app.post('/api/proposals/:id/approve', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { createMr?: boolean; gitHost?: unknown };
    const wantsStream =
      String(req.headers.accept ?? '').includes('text/event-stream') || req.query.stream === '1';

    try {
      const env = loadEnv();
      const gitHost = parseGitHost(body.gitHost);
      if (!wantsStream) {
        const result = await applyApprovedProposal({
          proposalId: String(req.params.id ?? ''),
          createMr: body.createMr,
          gitHost,
          env,
        });
        logger.info(
          `Approved proposal ${result.proposalId}: wrote ${result.written.length} file(s)` +
            (result.mrUrl ? `; MR ${result.mrUrl}` : ''),
        );
        res.json({ ok: true, ...result });
        return;
      }

      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders?.();
      res.write(': connected\n\n');

      let resultWritten = false;
      for await (const event of streamApplyApprovedProposal({
        proposalId: String(req.params.id ?? ''),
        createMr: body.createMr,
        gitHost,
        env,
      })) {
        if (event.type === 'result') {
          resultWritten = true;
          const { type: _t, ...result } = event;
          logger.info(
            `Approved proposal ${result.proposalId}: wrote ${result.written.length} file(s)` +
              (result.mrUrl ? `; MR ${result.mrUrl}` : ''),
          );
          res.write(`event: result\n`);
          res.write(`data: ${JSON.stringify({ ok: true, ...result })}\n\n`);
        } else if (event.type === 'status') {
          writeSse(res, event);
        } else if (event.type === 'tool') {
          writeSse(res, event);
        } else if (event.type === 'agent') {
          writeSse(res, event);
        } else if (event.type === 'error') {
          writeSse(res, event);
        }
      }
      if (!resultWritten) {
        res.write(`event: error\n`);
        res.write(
          `data: ${JSON.stringify({ type: 'error', message: 'Apply finished without result.' })}\n\n`,
        );
      }
      res.end();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (wantsStream && !res.headersSent) {
        res.status(200);
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.flushHeaders?.();
      }
      if (wantsStream && res.headersSent) {
        res.write(`event: error\n`);
        res.write(`data: ${JSON.stringify({ type: 'error', message })}\n\n`);
        res.end();
        return;
      }
      res.status(400).json({
        ok: false,
        error: message,
      });
    }
  });

  app.get('/api/sessions/:id', (req, res) => {
    const session = getStudioSession(String(req.params.id ?? ''));
    if (!session) {
      res.status(404).json({ ok: false, error: 'Session not found or expired.' });
      return;
    }
    res.json({ ok: true, session: sessionPublicView(session) });
  });

  app.post('/api/mr-chat/attach', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { mrUrl?: string };
    const mrUrl = body.mrUrl?.trim();
    if (!mrUrl) {
      res.status(400).json({ ok: false, error: 'GitLab MR URL is required.' });
      return;
    }

    try {
      const session = await attachMergeRequestSession({
        mrUrl,
        env: loadEnv(),
      });
      res.json({ ok: true, session: sessionPublicView(session) });
    } catch (error) {
      res.status(400).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.post('/api/sessions/:id/chat', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { message?: string };
    const env = loadEnv();
    const wantsStream = String(req.headers.accept ?? '').includes('text/event-stream');

    try {
      if (!wantsStream) {
        let result: Record<string, unknown> | undefined;
        for await (const event of dispatchMrChat({
          sessionId: String(req.params.id ?? ''),
          message: body.message ?? '',
          env,
        })) {
          if (event.type === 'result') {
            const { type: _t, ...rest } = event;
            result = rest;
          }
        }
        if (!result) {
          res.status(400).json({ ok: false, error: 'Refine finished without a result.' });
          return;
        }
        res.json({ ...result, ok: Boolean(result.ok) });
        return;
      }

      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders?.();
      res.write(': connected\n\n');

      let resultWritten = false;
      for await (const event of dispatchMrChat({
        sessionId: String(req.params.id ?? ''),
        message: body.message ?? '',
        env,
      })) {
        if (event.type === 'result') {
          resultWritten = true;
          const { type: _t, ...result } = event;
          res.write(`event: result\n`);
          res.write(`data: ${JSON.stringify({ ...result, ok: result.ok !== false })}\n\n`);
        } else {
          writeSse(res, event);
        }
      }
      if (!resultWritten) {
        res.write(`event: error\n`);
        res.write(
          `data: ${JSON.stringify({ type: 'error', message: 'Agent finished without a result.' })}\n\n`,
        );
      }
      res.end();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (wantsStream && res.headersSent) {
        res.write(`event: error\n`);
        res.write(`data: ${JSON.stringify({ type: 'error', message })}\n\n`);
        res.end();
        return;
      }
      res.status(400).json({ ok: false, error: message });
    }
  });

  app.post('/api/sessions/:id/compare-loop', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as {
      maxIterations?: number;
      figmaScreenshot?: {
        mimeType?: string;
        dataUrl?: string;
        byteLength?: number;
        capturedAt?: string;
      };
      proposalId?: string;
    };
    const env = loadEnv();
    const sessionId = String(req.params.id ?? '');
    const session = getStudioSession(sessionId);
    if (!session) {
      res.status(404).json({ ok: false, error: 'Session not found or expired.' });
      return;
    }

    const fromBody = body.figmaScreenshot?.dataUrl
      ? {
          mimeType: body.figmaScreenshot.mimeType || 'image/png',
          dataUrl: body.figmaScreenshot.dataUrl,
          byteLength: body.figmaScreenshot.byteLength || body.figmaScreenshot.dataUrl.length,
          capturedAt: body.figmaScreenshot.capturedAt,
        }
      : undefined;
    const fromSession = session.figmaScreenshot;
    const fromProposal = body.proposalId
      ? getProposal(body.proposalId)?.figmaScreenshot
      : undefined;
    const figmaScreenshot = fromBody ?? fromSession ?? fromProposal;
    if (!figmaScreenshot?.dataUrl) {
      res.status(400).json({
        ok: false,
        error: 'figmaScreenshot (dataUrl) is required to run the visual compare loop.',
      });
      return;
    }

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    res.write(': connected\n\n');

    try {
      for await (const event of streamVisualCompareLoop({
        sessionId,
        env,
        figmaScreenshot: {
          mimeType: figmaScreenshot.mimeType,
          dataUrl: figmaScreenshot.dataUrl,
          byteLength: figmaScreenshot.byteLength,
          capturedAt: figmaScreenshot.capturedAt,
        },
        maxIterations: body.maxIterations,
      })) {
        writeSse(res, event);
      }
      res.end();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeSse(res, { type: 'error', message });
      res.end();
    }
  });

  app.post('/api/generate', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as {
      figmaUrl?: string;
      componentName?: string;
      message?: string;
      createMr?: boolean;
      /** When false, run full agent without HITL pause (CLI / tests). Default true for UI. */
      waitForFigmaConfirm?: boolean;
    };

    if (!body.figmaUrl?.trim()) {
      res.status(400).json({ ok: false, error: 'figmaUrl is required.' });
      return;
    }

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    res.write(': connected\n\n');

    const createMr = Boolean(body.createMr);
    const waitForFigmaConfirm = body.waitForFigmaConfirm !== false;
    try {
      const stream = waitForFigmaConfirm
        ? streamInspectForConfirm({
            figmaUrl: body.figmaUrl.trim(),
            componentName: body.componentName?.trim() || undefined,
            createMr,
          })
        : streamFigtoMRAgent({
            figmaUrl: body.figmaUrl.trim(),
            componentName: body.componentName?.trim() || undefined,
            createMr,
            previewOnly: true,
            dryRun: true,
            message:
              body.message?.trim() ||
              `Turn this Figma node into a React component scaffold for approval. Call inspect_figma_node with includeScreenshot=true, then generate_component_scaffold. Match the Figma screenshot with semantic HTML and CSS classes only. Do not finish without a scaffold. Do not write files yourself — the host stages them locally after the proposal.`,
          });

      for await (const event of stream) {
        writeSse(res, event);
      }
    } catch (error) {
      writeSse(res, {
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
      writeSse(res, {
        type: 'done',
        text: '',
        stateSummary: '{}',
        dryRun: true,
      });
    }

    res.end();
  });

  /** After HITL Figma confirm: resume scaffold with stored inspect context. */
  app.post('/api/generate/continue', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { pendingId?: string };
    const pendingId = body.pendingId?.trim();
    if (!pendingId) {
      res.status(400).json({ ok: false, error: 'pendingId is required.' });
      return;
    }

    const job = getPendingGenerate(pendingId);
    if (!job) {
      res.status(404).json({
        ok: false,
        error: 'Pending generate not found or expired. Paste the Figma URL again.',
      });
      return;
    }
    deletePendingGenerate(pendingId);

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    res.write(': connected\n\n');

    try {
      for await (const event of streamFigtoMRAgent({
        figmaUrl: job.figmaUrl,
        componentName: job.componentName,
        createMr: job.createMr,
        previewOnly: true,
        dryRun: true,
        hostFirst: true,
        autoCompare: true,
        compareMaxIterations: 3,
        prefetchedFigma: {
          designText: job.figmaDesignText,
          screenshot: job.figmaScreenshot,
        },
        message:
          'Host scaffold from confirmed Figma (HTML + CSS), then visual-match loop vs screenshot.',
      })) {
        writeSse(res, event);
      }
    } catch (error) {
      writeSse(res, {
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
      writeSse(res, {
        type: 'done',
        text: '',
        stateSummary: '{}',
        dryRun: true,
      });
    }

    res.end();
  });

  app.post('/api/generate/cancel', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { pendingId?: string };
    const pendingId = body.pendingId?.trim();
    if (!pendingId) {
      res.status(400).json({ ok: false, error: 'pendingId is required.' });
      return;
    }
    const deleted = deletePendingGenerate(pendingId);
    res.json({ ok: true, deleted });
  });

  if (existsSync(RESOLVED_UI_DIST)) {
    app.use(express.static(RESOLVED_UI_DIST));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api')) {
        next();
        return;
      }
      res.sendFile(join(RESOLVED_UI_DIST, 'index.html'), (err) => {
        if (err) next(err);
      });
    });
  } else {
    app.get('/', (_req, res) => {
      res
        .status(200)
        .type('html')
        .send(
          `<!doctype html><meta charset="utf-8" /><title>FigtoMR</title>
           <p>React UI is not built yet. Run <code>npm run build:ui</code> or
           <code>npm run dev:ui</code> (Vite on :5173) alongside the API.</p>`,
        );
    });
  }

  return app;
}

/** @deprecated Use createStudioApp(). */
export function createStudioServer(): Express {
  return createStudioApp();
}

export function startStudioServer(): Server {
  const env = loadEnv();
  const app = createStudioApp();
  return app.listen(env.PORT, env.HOST, () => {
    logger.info(`FigtoMR (Express) listening on http://${env.HOST}:${env.PORT}`);
    if (!existsSync(RESOLVED_UI_DIST)) {
      logger.warn('ui/dist missing — run `npm run build:ui` or `npm run dev:ui` for the React UI.');
    }
  });
}
