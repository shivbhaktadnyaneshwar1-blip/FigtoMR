import { type FormEvent, useEffect, useRef, useState } from 'react';
import type { ActivityItem } from '../activity-reasoning';
import {
  isAffirmative,
  isNegative,
  parseChatGenerateIntent,
  type StudioChatMessage,
} from '../chat-types';
import {
  type FigmaAuthStatus,
  type FigmaScreenshot,
  type Proposal,
  type ProposedFile,
  type ProposalTab,
  type StatusKind,
  parseSseChunk,
} from '../studio-types';

export type ChatPhase = 'compose' | 'generating' | 'confirm_figma' | 'review' | 'refine';

const GITLAB_MR_URL_RE = /https?:\/\/[^\s/]+\/[^\s]+\/-\/merge_requests\/\d+/i;

export function useStudioController() {
  const [figmaUrl, setFigmaUrl] = useState('');
  const [componentName, setComponentName] = useState('');
  const [createMr, setCreateMr] = useState(true);
  const [gitHost, setGitHost] = useState<'github' | 'gitlab'>('gitlab');
  const [log, setLog] = useState('');
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [status, setStatus] = useState<StatusKind>('idle');
  const [statusLabel, setStatusLabel] = useState('Idle');
  const [agentSummary, setAgentSummary] = useState('');
  const [mrUrl, setMrUrl] = useState<string | undefined>();
  const [sessionId, setSessionId] = useState<string | undefined>();
  const [sessionChat, setSessionChat] = useState<
    Array<{ role: 'user' | 'assistant'; text: string }>
  >([]);
  const [chatDraft, setChatDraft] = useState('');
  const [chatBusy, setChatBusy] = useState(false);
  const [running, setRunning] = useState(false);
  const [approving, setApproving] = useState(false);
  const [figmaAuth, setFigmaAuth] = useState<FigmaAuthStatus | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [authNote, setAuthNote] = useState('');
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | undefined>();
  const [playgroundUrl, setPlaygroundUrl] = useState<string | undefined>();
  const [playgroundReachable, setPlaygroundReachable] = useState<boolean | null>(null);
  const [proposalTab, setProposalTab] = useState<ProposalTab>('files');
  const [liveScreenshot, setLiveScreenshot] = useState<FigmaScreenshot | null>(null);
  const [playgroundScreenshot, setPlaygroundScreenshot] = useState<FigmaScreenshot | null>(null);
  const [playgroundBusy, setPlaygroundBusy] = useState(false);
  const [visualMatch, setVisualMatch] = useState<boolean | null>(null);
  const [compareIter, setCompareIter] = useState<string | undefined>();
  const [chatMessages, setChatMessages] = useState<StudioChatMessage[]>([]);
  const [figmaConfirm, setFigmaConfirm] = useState<'idle' | 'pending' | 'confirmed' | 'rejected'>(
    'idle',
  );
  const [pendingGenerateId, setPendingGenerateId] = useState<string | undefined>();
  const figmaConfirmRef = useRef(figmaConfirm);
  figmaConfirmRef.current = figmaConfirm;
  const pendingGenerateIdRef = useRef(pendingGenerateId);
  pendingGenerateIdRef.current = pendingGenerateId;
  const activityRef = useRef<ActivityItem[]>([]);
  const pendingFigmaShotRef = useRef<{ dataUrl: string; nodeId?: string } | null>(null);
  const chatIdRef = useRef(0);
  const authInitializationStarted = useRef(false);

  function nextChatId(): number {
    chatIdRef.current += 1;
    return chatIdRef.current;
  }

  type ChatMessageInput = StudioChatMessage extends infer M
    ? M extends StudioChatMessage
      ? Omit<M, 'id'>
      : never
    : never;

  function pushChat(message: ChatMessageInput): number {
    const id = nextChatId();
    setChatMessages((prev) => [...prev, { ...message, id } as StudioChatMessage]);
    return id;
  }

  /**
   * End the current AI-reasoning turn: snapshot steps into the chat timeline,
   * then clear live Thinking. Call this *before* pushing the concrete response.
   */
  function sealReasoningTurn(statusLabel: string, opts: { readonly summary?: string } = {}): void {
    const snapshot = activityRef.current;
    if (snapshot.length === 0) return;
    activityRef.current = [];
    setActivity([]);
    pushChat({
      kind: 'reasoning',
      activity: snapshot,
      statusLabel,
      summary: opts.summary,
    });
  }

  function pushProgress(label: string) {
    setChatMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last?.kind === 'progress') {
        return [...prev.slice(0, -1), { ...last, label }];
      }
      return [...prev, { id: nextChatId(), kind: 'progress', label }];
    });
  }

  function revealProposalCards(
    nextProposal: Proposal,
    opts: { playgroundUrl?: string; match?: boolean | null } = {},
  ) {
    setChatMessages((prev) => {
      const withoutCards = prev.filter(
        (message) =>
          message.kind !== 'files' && message.kind !== 'playground' && message.kind !== 'approve',
      );
      const cards: StudioChatMessage[] = [
        ...withoutCards,
        {
          id: nextChatId(),
          kind: 'files',
          files: nextProposal.files,
          componentName: nextProposal.componentName,
          selectedPath:
            nextProposal.files.find((f) => f.path.endsWith('/render.tsx'))?.path ??
            nextProposal.files[0]?.path,
        },
      ];
      const url = opts.playgroundUrl || nextProposal.playgroundUrl;
      if (url) {
        cards.push({
          id: nextChatId(),
          kind: 'playground',
          url,
          visualMatch: opts.match ?? null,
        });
      }
      cards.push({
        id: nextChatId(),
        kind: 'approve',
        createMr,
        approving: false,
        visualMatch: opts.match ?? null,
      });
      return cards;
    });
  }

  /** Keep proposal panel + chat file card in sync with on-disk refine/compare output. */
  function mergeProposalFiles(base: Proposal, files: ProposedFile[]): Proposal {
    return {
      ...base,
      files,
    };
  }

  function refreshProposalFiles(files: ProposedFile[]): Proposal | null {
    if (!files.length) return null;
    let next: Proposal | null = null;
    setProposal((prev) => {
      if (!prev) return prev;
      next = mergeProposalFiles(prev, files);
      return next;
    });
    setSelectedPath((prev) =>
      files.some((file) => file.path === prev)
        ? prev
        : (files.find((file) => file.path.endsWith('/render.tsx'))?.path ?? files[0]?.path),
    );
    setChatMessages((prev) =>
      prev.map((message) => {
        if (message.kind !== 'files') return message;
        const keep =
          message.selectedPath && files.some((file) => file.path === message.selectedPath)
            ? message.selectedPath
            : (files.find((file) => file.path.endsWith('/render.tsx'))?.path ?? files[0]?.path);
        return { ...message, files, selectedPath: keep };
      }),
    );
    return next;
  }

  function applyRefreshedFiles(
    files: ProposedFile[] | undefined,
    pending: Proposal | null,
  ): Proposal | null {
    if (!Array.isArray(files) || files.length === 0) return pending;
    const updated = refreshProposalFiles(files);
    if (updated) return updated;
    if (pending) return mergeProposalFiles(pending, files);
    return pending;
  }

  function pushActivity(item: Omit<ActivityItem, 'id'>) {
    const id = (activityRef.current[activityRef.current.length - 1]?.id ?? 0) + 1;
    const next = [...activityRef.current.slice(-79), { ...item, id }];
    activityRef.current = next;
    setActivity(next);
    if (item.phase === 'start' || item.phase === 'info') {
      setStatusLabel(item.label);
    }
  }

  async function refreshFigmaAuth() {
    setAuthBusy(true);
    try {
      const response = await fetch('/api/figma/auth/status');
      const data = (await response.json()) as FigmaAuthStatus & { ok?: boolean };
      setFigmaAuth(data);
      if (data.mode === 'desktop') {
        setAuthNote(
          data.desktopReachable
            ? 'Desktop MCP is reachable.'
            : 'Desktop MCP not reachable — enable it in Figma Dev Mode.',
        );
      }
      return data;
    } finally {
      setAuthBusy(false);
    }
  }

  async function refreshPlaygroundStatus() {
    try {
      const response = await fetch('/api/playground/status');
      const data = (await response.json()) as { reachable?: boolean; url?: string };
      setPlaygroundReachable(Boolean(data.reachable));
      if (data.url && !playgroundUrl) {
        // keep existing deep-link if we already have one
      }
    } catch {
      setPlaygroundReachable(false);
    }
  }

  async function startPlayground() {
    setPlaygroundBusy(true);
    try {
      const response = await fetch('/api/playground/start', { method: 'POST' });
      const data = (await response.json()) as {
        reachable?: boolean;
        started?: boolean;
        message?: string;
        url?: string;
      };
      setPlaygroundReachable(Boolean(data.reachable));
      pushActivity({
        phase: data.reachable ? 'done' : 'error',
        source: 'studio',
        name: 'playground',
        label: data.message ?? (data.reachable ? 'Playground running' : 'Playground start failed'),
      });
      return data;
    } finally {
      setPlaygroundBusy(false);
    }
  }

  async function capturePlaygroundShot(url?: string) {
    setPlaygroundBusy(true);
    try {
      const response = await fetch('/api/playground/screenshot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: url ?? playgroundUrl ?? proposal?.playgroundUrl,
          componentName: proposal?.componentName || componentName || undefined,
        }),
      });
      const data = (await response.json()) as {
        ok?: boolean;
        error?: string;
        screenshot?: FigmaScreenshot & { url?: string };
      };
      if (!response.ok || !data.screenshot?.dataUrl) {
        throw new Error(data.error || 'Playground screenshot failed');
      }
      setPlaygroundScreenshot({
        mimeType: data.screenshot.mimeType,
        dataUrl: data.screenshot.dataUrl,
        byteLength: data.screenshot.byteLength,
        capturedAt: data.screenshot.capturedAt,
      });
      pushActivity({
        phase: 'done',
        source: 'studio',
        name: 'playground_screenshot',
        label: 'Playground screenshot captured',
      });
      return data.screenshot;
    } finally {
      setPlaygroundBusy(false);
    }
  }

  async function runCompareLoop() {
    if (!sessionId || playgroundBusy) return;
    const figma = proposal?.figmaScreenshot ?? liveScreenshot;
    if (!figma?.dataUrl) {
      pushActivity({
        phase: 'error',
        source: 'studio',
        name: 'compare',
        label: 'Need a Figma screenshot before compare loop',
      });
      return;
    }
    setPlaygroundBusy(true);
    setStatus('running');
    setStatusLabel('Visual compare loop…');
    setVisualMatch(null);
    try {
      const response = await fetch(`/api/sessions/${sessionId}/compare-loop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({
          maxIterations: 4,
          proposalId: proposal?.proposalId,
          figmaScreenshot: {
            mimeType: figma.mimeType,
            dataUrl: figma.dataUrl,
            byteLength: figma.byteLength,
            capturedAt: figma.capturedAt,
          },
        }),
      });
      if (!response.ok || !response.body) {
        throw new Error((await response.text()) || `HTTP ${response.status}`);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parsed = parseSseChunk(buffer);
        buffer = parsed.rest;
        for (const data of parsed.events) {
          if (data.type === 'status') {
            pushActivity({ phase: 'info', source: 'studio', name: 'compare', label: data.message });
            setStatusLabel(data.message);
          } else if (data.type === 'tool') {
            pushActivity({
              phase: data.phase || 'info',
              source: data.source || 'studio',
              name: data.name || 'tool',
              label: data.label || data.name || 'tool',
              detail: data.detail,
            });
          } else if (data.type === 'playground_screenshot' && data.dataUrl) {
            setPlaygroundScreenshot({
              mimeType: data.mimeType,
              dataUrl: data.dataUrl,
              byteLength: data.byteLength,
              capturedAt: data.capturedAt,
            });
            setProposalTab('files');
          } else if (data.type === 'compare_iteration') {
            setCompareIter(`${data.iteration}/${data.maxIterations}`);
            if (typeof data.visualMatch === 'boolean') setVisualMatch(data.visualMatch);
            if (Array.isArray(data.files) && data.files.length > 0) {
              refreshProposalFiles(data.files);
            }
            if (data.visualMatch === false) {
              const summary =
                data.mismatchSummary ||
                `Not matching with Figma — retrying (${data.iteration}/${data.maxIterations})`;
              setAgentSummary(summary);
              setStatusLabel(summary);
              pushActivity({
                phase: 'info',
                source: 'studio',
                name: 'visual_mismatch',
                label: `Not matching with Figma — retrying (${data.iteration}/${data.maxIterations})`,
                detail:
                  Array.isArray(data.gaps) && data.gaps.length > 0
                    ? data.gaps.slice(0, 5).join('; ')
                    : data.mismatchSummary,
              });
              if (Array.isArray(data.gaps)) {
                for (const [index, gap] of data.gaps.slice(0, 6).entries()) {
                  pushActivity({
                    phase: 'info',
                    source: 'studio',
                    name: `visual_gap_${index + 1}`,
                    label: 'Gap vs Figma',
                    detail: gap,
                  });
                }
              }
            } else {
              pushActivity({
                phase: data.visualMatch ? 'done' : 'info',
                source: 'studio',
                name: 'compare',
                label: `Compare iter ${data.iteration}/${data.maxIterations}`,
              });
            }
          } else if (data.type === 'compare_result') {
            setVisualMatch(data.matched);
            setCompareIter(`${data.iterations} done`);
            setPlaygroundUrl(data.playgroundUrl);
            setStatus('awaiting');
            if (Array.isArray(data.files) && data.files.length > 0) {
              refreshProposalFiles(data.files);
            }
            if (data.matched) {
              setStatusLabel('Visual match — refine or Approve');
              setAgentSummary(`Matched Figma after ${data.iterations} visual pass(es).`);
            } else {
              const summary =
                data.mismatchSummary ||
                `Not matching with Figma after ${data.iterations} pass(es)` +
                  (Array.isArray(data.gaps) && data.gaps.length
                    ? `: ${data.gaps.slice(0, 5).join('; ')}`
                    : '');
              setStatusLabel(summary);
              setAgentSummary(summary);
              pushActivity({
                phase: 'error',
                source: 'studio',
                name: 'visual_mismatch',
                label: `Not matching with Figma after ${data.iterations} pass(es)`,
                detail:
                  Array.isArray(data.gaps) && data.gaps.length > 0
                    ? data.gaps.slice(0, 5).join('; ')
                    : undefined,
              });
              if (Array.isArray(data.gaps)) {
                for (const [index, gap] of data.gaps.slice(0, 6).entries()) {
                  pushActivity({
                    phase: 'info',
                    source: 'studio',
                    name: `visual_gap_${index + 1}`,
                    label: 'Still diverging',
                    detail: gap,
                  });
                }
              }
            }
          } else if (data.type === 'error') {
            pushActivity({
              phase: 'error',
              source: 'studio',
              name: 'compare',
              label: data.message,
            });
          } else if (data.type === 'agent' && data.text) {
            setAgentSummary((prev) => `${prev}${data.text}`.slice(-1200));
          }
        }
      }
    } catch (error) {
      pushActivity({
        phase: 'error',
        source: 'studio',
        name: 'compare',
        label: error instanceof Error ? error.message : String(error),
      });
      setStatus('awaiting');
    } finally {
      setPlaygroundBusy(false);
    }
  }

  useEffect(() => {
    if (authInitializationStarted.current) return;

    authInitializationStarted.current = true;
    void refreshFigmaAuth().catch(() => undefined);
    void refreshPlaygroundStatus().catch(() => undefined);
  }, []);

  async function disconnectFigma() {
    setAuthBusy(true);
    try {
      await fetch('/api/figma/auth/logout', { method: 'POST' });
      setAuthNote('Cleared any stored remote OAuth tokens.');
      await refreshFigmaAuth();
    } finally {
      setAuthBusy(false);
    }
  }

  async function startGenerate(overrides?: { figmaUrl?: string; componentName?: string }) {
    const url = (overrides?.figmaUrl ?? figmaUrl).trim();
    const name = (overrides?.componentName ?? componentName).trim();
    if (!url) {
      pushChat({
        kind: 'text',
        role: 'assistant',
        text: 'Paste a Figma node URL first (Dev Mode link with node-id).',
      });
      return;
    }
    if (overrides?.figmaUrl) setFigmaUrl(url);
    if (overrides?.componentName !== undefined) setComponentName(name);

    setLog('');
    setActivity([]);
    activityRef.current = [];
    setAgentSummary('');
    setMrUrl(undefined);
    setProposal(null);
    setSelectedPath(undefined);
    setPlaygroundUrl(undefined);
    setLiveScreenshot(null);
    setPlaygroundScreenshot(null);
    setSessionId(undefined);
    setSessionChat([]);
    setProposalTab('files');
    setFigmaConfirm('idle');
    setPendingGenerateId(undefined);
    setVisualMatch(null);
    setCompareIter(undefined);
    setChatMessages([]);
    pushChat({
      kind: 'text',
      role: 'user',
      text: name ? `${url}\nComponent: ${name}` : url,
    });
    pushChat({
      kind: 'text',
      role: 'assistant',
      text: 'Inspecting the Figma node. I’ll pause for your OK before any scaffolding or LLM work.',
    });
    setStatus('running');
    setStatusLabel('Inspecting Figma');
    setRunning(true);

    try {
      const response = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({
          figmaUrl: url,
          componentName: name || undefined,
          createMr,
        }),
      });

      if (!response.ok || !response.body) {
        throw new Error((await response.text()) || `HTTP ${response.status}`);
      }

      await consumeStudioSse(response.body);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      setLog((prev) => `${prev}✗ ${msg}\n`);
      pushChat({ kind: 'text', role: 'assistant', text: `Generate failed: ${msg}` });
      setStatus('error');
      setStatusLabel('Error');
    } finally {
      setRunning(false);
    }
  }

  async function consumeStudioSse(body: ReadableStream<Uint8Array>) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let pendingProposal: Proposal | null = null;
    let pendingPlayground: string | undefined;
    let pendingMatch: boolean | null = null;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parsed = parseSseChunk(buffer);
      buffer = parsed.rest;

      for (const data of parsed.events) {
        switch (data.type) {
          case 'status':
            pushActivity({
              phase: 'info',
              source: 'studio',
              name: 'status',
              label: data.message,
            });
            pushProgress(data.message);
            setLog((prev) => `${prev}• ${data.message}\n`);
            break;
          case 'agent':
            setLog((prev) => `${prev}${data.text}\n`);
            setAgentSummary((prev) => `${prev}${data.text}`.slice(-1200));
            break;
          case 'tool': {
            const phase = data.phase ?? 'info';
            const source = data.source ?? 'agent';
            const label = data.label ?? data.name ?? 'tool';
            pushActivity({
              phase,
              source,
              name: data.name ?? 'tool',
              label,
              detail: data.detail,
            });
            if (phase === 'start' || phase === 'info') {
              pushProgress(label);
            }
            const glyph =
              phase === 'start' ? '→' : phase === 'error' ? '✗' : phase === 'done' ? '✓' : '•';
            const sourceTag =
              source === 'figma-mcp' ? 'figma' : source === 'agent' ? 'agent' : 'studio';
            setLog(
              (prev) =>
                `${prev}${glyph} [${sourceTag}] ${label}${data.detail ? ` — ${data.detail}` : ''}\n`,
            );
            break;
          }
          case 'figma_screenshot':
            setLiveScreenshot({
              mimeType: data.mimeType,
              dataUrl: data.dataUrl,
              byteLength: data.byteLength,
              fileKey: data.fileKey,
              nodeId: data.nodeId,
            });
            if (figmaConfirmRef.current !== 'confirmed') {
              pendingFigmaShotRef.current = {
                dataUrl: data.dataUrl,
                nodeId: data.nodeId,
              };
            }
            pushActivity({
              phase: 'done',
              source: 'figma-mcp',
              name: 'figma_screenshot',
              label: 'Figma screenshot captured',
              detail: data.byteLength ? `${Math.round(data.byteLength / 1024)} KB` : data.nodeId,
            });
            setLog(
              (prev) =>
                `${prev}✓ [figma] Screenshot captured${data.nodeId ? ` · node ${data.nodeId}` : ''}\n`,
            );
            break;
          case 'awaiting_figma_confirm':
            setPendingGenerateId(data.pendingId);
            setFigmaConfirm('pending');
            pushActivity({
              phase: 'done',
              source: 'studio',
              name: 'awaiting_figma_confirm',
              label: 'Ready for your confirm',
            });
            // End this Studio turn: Thinking → sealed, then concrete screenshot + ask.
            sealReasoningTurn('Inspected Figma frame', { summary: data.message });
            {
              const shot = pendingFigmaShotRef.current;
              pendingFigmaShotRef.current = null;
              if (shot?.dataUrl) {
                pushChat({
                  kind: 'figma',
                  dataUrl: shot.dataUrl,
                  nodeId: shot.nodeId,
                  status: 'pending',
                });
              }
              pushChat({
                kind: 'text',
                role: 'assistant',
                text: data.hasScreenshot
                  ? 'Is this the right Figma frame? Confirm to start scaffolding — nothing else runs until you respond.'
                  : `${data.message} Reply “looks good” to continue or “wrong frame” to cancel.`,
              });
            }
            setStatus('awaiting');
            setStatusLabel('Waiting for Figma confirm');
            setLog((prev) => `${prev}⏸ ${data.message}\n`);
            break;
          case 'proposal': {
            const nextProposal: Proposal = {
              proposalId: data.proposalId,
              componentName: data.componentName,
              mode: data.mode,
              createMr: data.createMr,
              targetRepoPath: data.targetRepoPath,
              files: data.files,
              agentText: data.agentText,
              playgroundUrl: data.playgroundUrl,
              figmaScreenshot: data.figmaScreenshot,
            };
            setProposal(nextProposal);
            pendingProposal = nextProposal;
            if (data.figmaScreenshot?.dataUrl) {
              setLiveScreenshot(data.figmaScreenshot);
            }
            setSelectedPath(
              data.files.find((f) => f.path.endsWith('.tsx'))?.path ?? data.files[0]?.path,
            );
            setPlaygroundUrl(data.playgroundUrl);
            pendingPlayground = data.playgroundUrl;
            setProposalTab('files');
            void refreshPlaygroundStatus();
            setStatus('running');
            setStatusLabel('Staging files locally…');
            pushProgress(`Proposal ready (${data.files.length} files) — staging locally…`);
            pushActivity({
              phase: 'done',
              source: 'studio',
              name: 'proposal',
              label: `Proposal ready (${data.files.length} files)`,
            });
            setLog(
              (prev) =>
                `${prev}\n• Proposed ${data.files.length} the target repo change(s) — staging locally to the target repo…\n`,
            );
            // Files stay sealed until this Studio turn finishes (see `done` / awaitingApproval).
            break;
          }
          case 'staged':
            setSessionId(data.sessionId);
            setSessionChat([]);
            setPlaygroundUrl(data.playgroundUrl);
            pendingPlayground = data.playgroundUrl;
            setPlaygroundReachable(data.playgroundReachable);
            // Stay "running" — visual compare may follow; seal Thinking only on final response.
            setStatus('running');
            setStatusLabel('Staged locally — comparing…');
            pushProgress(`Staged ${data.written.length} file(s) locally`);
            pushActivity({
              phase: 'done',
              source: 'studio',
              name: 'stage',
              label: `Staged ${data.written.length} file(s) locally`,
              detail: `${data.written.length} component file(s)`,
            });
            setLog(
              (prev) =>
                `${prev}✓ Staged locally (${data.written.length} files). Chat refine + playground ready.\n`,
            );
            break;
          case 'playground_screenshot':
            if (data.dataUrl) {
              setPlaygroundScreenshot({
                mimeType: data.mimeType,
                dataUrl: data.dataUrl,
                byteLength: data.byteLength,
                capturedAt: data.capturedAt,
              });
              pushActivity({
                phase: 'done',
                source: 'studio',
                name: 'playground_screenshot',
                label:
                  typeof data.iteration === 'number'
                    ? `Playground screenshot (iter ${data.iteration})`
                    : 'Playground screenshot captured',
              });
            }
            break;
          case 'compare_iteration':
            setStatus('running');
            setCompareIter(`${data.iteration}/${data.maxIterations}`);
            setStatusLabel(
              data.visualMatch === true
                ? `Visual match ${data.iteration}/${data.maxIterations}`
                : data.mismatchSummary ||
                    `Not matching with Figma — retrying (${data.iteration}/${data.maxIterations})`,
            );
            if (typeof data.visualMatch === 'boolean') {
              setVisualMatch(data.visualMatch);
            }
            pendingProposal = applyRefreshedFiles(data.files, pendingProposal);
            if (data.visualMatch === false) {
              const summary =
                data.mismatchSummary ||
                `Not matching with Figma — retrying (${data.iteration}/${data.maxIterations})`;
              setAgentSummary(summary);
              pushProgress(summary);
              pushActivity({
                phase: 'info',
                source: 'studio',
                name: 'visual_mismatch',
                label: `Not matching with Figma — retrying (${data.iteration}/${data.maxIterations})`,
                detail:
                  Array.isArray(data.gaps) && data.gaps.length > 0
                    ? data.gaps.slice(0, 5).join('; ')
                    : data.mismatchSummary,
              });
              if (Array.isArray(data.gaps)) {
                for (const [index, gap] of data.gaps.slice(0, 6).entries()) {
                  pushActivity({
                    phase: 'info',
                    source: 'studio',
                    name: `visual_gap_${index + 1}`,
                    label: 'Gap vs Figma',
                    detail: gap,
                  });
                }
              }
            } else {
              pushProgress(`Visual compare ${data.iteration}/${data.maxIterations}`);
              pushActivity({
                phase: data.visualMatch ? 'done' : 'info',
                source: 'studio',
                name: 'compare',
                label: `Compare iter ${data.iteration}/${data.maxIterations}`,
                detail:
                  data.visualMatch === true
                    ? 'VISUAL_MATCH'
                    : data.written.length
                      ? `wrote ${data.written.length} file(s)`
                      : 'no file changes',
              });
            }
            break;
          case 'compare_result':
            setVisualMatch(data.matched);
            pendingMatch = data.matched;
            setCompareIter(`${data.iterations} done`);
            setPlaygroundUrl(data.playgroundUrl);
            pendingPlayground = data.playgroundUrl;
            // Compare finished — keep running until `done` seals the turn + shows files.
            setStatus('running');
            pendingProposal = applyRefreshedFiles(data.files, pendingProposal);
            if (data.matched) {
              setStatusLabel('Visual match — finishing…');
              setAgentSummary(`Matched Figma after ${data.iterations} visual pass(es).`);
              pushProgress(`Visual match after ${data.iterations} iter(s)`);
              pushActivity({
                phase: 'done',
                source: 'studio',
                name: 'compare_result',
                label: `Matched Figma after ${data.iterations} iter(s)`,
                detail: data.written.length ? `${data.written.length} files touched` : undefined,
              });
            } else {
              const summary =
                data.mismatchSummary ||
                `Not matching with Figma after ${data.iterations} pass(es)` +
                  (Array.isArray(data.gaps) && data.gaps.length
                    ? `: ${data.gaps.slice(0, 5).join('; ')}`
                    : '');
              setStatusLabel(summary);
              setAgentSummary(summary);
              pushProgress(summary);
              pushActivity({
                phase: 'error',
                source: 'studio',
                name: 'visual_mismatch',
                label: `Not matching with Figma after ${data.iterations} pass(es)`,
                detail:
                  Array.isArray(data.gaps) && data.gaps.length > 0
                    ? data.gaps.slice(0, 5).join('; ')
                    : undefined,
              });
              if (Array.isArray(data.gaps)) {
                for (const [index, gap] of data.gaps.slice(0, 6).entries()) {
                  pushActivity({
                    phase: 'info',
                    source: 'studio',
                    name: `visual_gap_${index + 1}`,
                    label: 'Still diverging',
                    detail: gap,
                  });
                }
              }
            }
            if (data.agentText && data.matched) {
              setAgentSummary((prev) => `${prev}\n${data.agentText}`.slice(-1200));
            }
            break;
          case 'error':
            pushActivity({
              phase: 'error',
              source: 'studio',
              name: 'error',
              label: data.message,
            });
            pushChat({ kind: 'text', role: 'assistant', text: `Error: ${data.message}` });
            setLog((prev) => `${prev}✗ ${data.message}\n`);
            setStatus('error');
            setStatusLabel('Error');
            break;
          case 'done':
            if (data.sessionId) {
              setSessionId(data.sessionId);
            }
            if (data.awaitingFigmaConfirm || data.pendingId) {
              if (data.pendingId) setPendingGenerateId(data.pendingId);
              setFigmaConfirm('pending');
              // Reasoning already sealed on awaiting_figma_confirm.
              setStatus('awaiting');
              setStatusLabel('Waiting for Figma confirm');
            } else if (data.awaitingApproval) {
              sealReasoningTurn('Scaffold ready for review', {
                summary:
                  'Proposed the target repo files and playground are ready. Refine in chat or Approve.',
              });
              const ready = pendingProposal ?? proposal;
              if (ready) {
                revealProposalCards(ready, {
                  playgroundUrl: pendingPlayground ?? ready.playgroundUrl,
                  match: pendingMatch,
                });
              }
              setStatus('awaiting');
              setStatusLabel(
                data.sessionId ? 'Staged — refine or Approve MR' : 'Awaiting approval',
              );
            } else if (data.mrUrl) {
              sealReasoningTurn('Merge request opened');
              setMrUrl(data.mrUrl);
              setLog((prev) => `${prev}\nMR: ${data.mrUrl}\n`);
              setStatus('done');
              setStatusLabel('MR ready');
              pushChat({
                kind: 'text',
                role: 'assistant',
                text: `Merge request opened: ${data.mrUrl}`,
              });
            } else {
              setLog((prev) => `${prev}\nDone.\n`);
              setStatus((prev) => (prev === 'awaiting' || prev === 'error' ? prev : 'done'));
              setStatusLabel((prev) =>
                prev === 'Waiting for Figma confirm' || prev.startsWith('Staged')
                  ? prev
                  : data.dryRun
                    ? 'Preview done'
                    : 'Done',
              );
            }
            break;
        }
      }
    }
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    await startGenerate();
  }

  async function confirmFigmaFrame() {
    const pendingId = pendingGenerateIdRef.current;
    setFigmaConfirm('confirmed');
    setChatMessages((prev) =>
      prev.map((message) =>
        message.kind === 'figma' && message.status === 'pending'
          ? { ...message, status: 'confirmed' }
          : message,
      ),
    );
    pushChat({
      kind: 'text',
      role: 'user',
      text: 'Looks good — continue',
    });

    if (!pendingId) {
      pushChat({
        kind: 'text',
        role: 'assistant',
        text: 'Confirm recorded, but the inspect session expired. Paste the Figma URL again to restart.',
      });
      setStatus('idle');
      setStatusLabel('Idle');
      return;
    }

    pushChat({
      kind: 'text',
      role: 'assistant',
      text: 'Confirmed. Matching design system MCP primitives, scaffolding, then visual-match loop vs Figma…',
    });
    setPendingGenerateId(undefined);
    setStatus('running');
    setStatusLabel('Scaffolding after confirm');
    setRunning(true);
    setAgentSummary('');
    setActivity([]);
    activityRef.current = [];

    try {
      const response = await fetch('/api/generate/continue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({ pendingId }),
      });

      if (!response.ok || !response.body) {
        throw new Error((await response.text()) || `HTTP ${response.status}`);
      }

      await consumeStudioSse(response.body);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      setLog((prev) => `${prev}✗ ${msg}\n`);
      pushChat({ kind: 'text', role: 'assistant', text: `Continue failed: ${msg}` });
      setStatus('error');
      setStatusLabel('Error');
    } finally {
      setRunning(false);
    }
  }

  async function rejectFigmaFrame() {
    const pendingId = pendingGenerateIdRef.current;
    setFigmaConfirm('rejected');
    setPendingGenerateId(undefined);
    setChatMessages((prev) =>
      prev.map((message) =>
        message.kind === 'figma' && message.status === 'pending'
          ? { ...message, status: 'rejected' }
          : message,
      ),
    );
    pushChat({ kind: 'text', role: 'user', text: 'Wrong frame' });
    pushChat({
      kind: 'text',
      role: 'assistant',
      text: 'OK — paste a different Figma node URL (with the right node-id) to start again.',
    });
    setProposal(null);
    setSessionId(undefined);
    setStatus('idle');
    setStatusLabel('Idle');
    if (pendingId) {
      void fetch('/api/generate/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pendingId }),
      }).catch(() => undefined);
    }
  }

  async function sendStudioChat(event?: FormEvent) {
    event?.preventDefault();
    const text = chatDraft.trim();
    const urlFromFields = figmaUrl.trim();

    if (figmaConfirm === 'pending') {
      if (!text && !isAffirmative(text) && !isNegative(text)) return;
      setChatDraft('');
      if (isNegative(text) || /^wrong/i.test(text)) {
        rejectFigmaFrame();
        return;
      }
      if (!text || isAffirmative(text)) {
        await confirmFigmaFrame();
        return;
      }
    }

    if (!sessionId && !running) {
      const mrUrlFromChat = text.match(GITLAB_MR_URL_RE)?.[0];
      if (mrUrlFromChat) {
        await sendRefineChat(event, { mrUrl: mrUrlFromChat });
        return;
      }

      const parsed = parseChatGenerateIntent(text || urlFromFields);
      const url = parsed.figmaUrl || urlFromFields;
      const name = parsed.componentName || componentName.trim();
      if (!url) {
        if (text) {
          pushChat({ kind: 'text', role: 'user', text });
          setChatDraft('');
          pushChat({
            kind: 'text',
            role: 'assistant',
            text: 'I need a Figma design URL with node-id to scaffold. Paste one above or in the message.',
          });
        }
        return;
      }
      setChatDraft('');
      await startGenerate({ figmaUrl: url, componentName: name });
      return;
    }

    if (sessionId) {
      await sendRefineChat(event);
      return;
    }
  }

  async function approveProposal() {
    if (!proposal) return;
    setApproving(true);
    setChatMessages((prev) =>
      prev.map((message) =>
        message.kind === 'approve' ? { ...message, approving: true } : message,
      ),
    );
    setStatus('running');
    setStatusLabel('Applying…');
    setAgentSummary('');
    setActivity([]);
    activityRef.current = [];
    pushChat({
      kind: 'text',
      role: 'user',
      text: createMr ? `Approve & open ${gitHost === 'github' ? 'PR' : 'MR'}` : 'Approve (local)',
    });
    pushActivity({
      phase: 'start',
      source: 'studio',
      name: 'approve',
      label: createMr
        ? `Approve → open ${gitHost === 'github' ? 'pull request' : 'merge request'}`
        : 'Approve → write files',
    });
    try {
      const response = await fetch(`/api/proposals/${proposal.proposalId}/approve`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
        body: JSON.stringify({ createMr, gitHost }),
      });

      if (!response.ok || !response.body) {
        const fallback = (await response.text()) || `HTTP ${response.status}`;
        throw new Error(fallback);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let finished = false;

      while (!finished) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() ?? '';

        for (const part of parts) {
          const dataLines: string[] = [];
          let eventName = 'message';
          for (const line of part.split('\n')) {
            if (line.startsWith('event:')) eventName = line.slice(6).trim();
            if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
          }
          if (!dataLines.length) continue;
          const data = JSON.parse(dataLines.join('\n')) as Record<string, unknown>;

          if (eventName === 'result' || data.type === 'result' || data.ok === true) {
            const result = data as {
              ok?: boolean;
              error?: string;
              written?: string[];
              mrUrl?: string;
              branchName?: string;
              playgroundUrl?: string;
              sessionId?: string;
            };
            if (result.ok === false) {
              throw new Error(String(result.error || 'Approve failed'));
            }
            setLog(
              (prev) =>
                `${prev}\n✓ Applied ${result.written?.length ?? 0} file(s) to the target repo` +
                (result.branchName ? ` on ${result.branchName}` : '') +
                '\n' +
                (result.written ?? []).map((f) => `  - ${f}`).join('\n') +
                '\n' +
                (result.playgroundUrl ? `Playground: ${result.playgroundUrl}\n` : '') +
                (result.mrUrl ? `MR: ${result.mrUrl}\n` : '\n') +
                (result.sessionId
                  ? `Chat refine session: ${result.sessionId} (ask for layout/copy fixes below)\n`
                  : ''),
            );
            if (result.playgroundUrl) {
              setPlaygroundUrl(result.playgroundUrl);
            }
            if (result.sessionId) {
              setSessionId(result.sessionId);
              setSessionChat([]);
            }
            const doneLabel = result.mrUrl ? 'MR ready' : 'Applied';
            sealReasoningTurn(doneLabel, {
              summary: result.mrUrl
                ? `MR opened: ${result.mrUrl}`
                : `Applied ${(result.written ?? []).length} file(s) locally.`,
            });
            if (result.mrUrl) {
              setMrUrl(result.mrUrl);
              setStatusLabel('MR ready');
              pushChat({
                kind: 'text',
                role: 'assistant',
                text: `Approved. MR opened: ${result.mrUrl}`,
              });
            } else {
              setStatusLabel('Applied');
              pushChat({
                kind: 'text',
                role: 'assistant',
                text: `Approved — applied ${(result.written ?? []).length} file(s) locally.`,
              });
            }
            setStatus('done');
            setProposal(null);
            setChatMessages((prev) => prev.filter((message) => message.kind !== 'approve'));
            void refreshPlaygroundStatus();
            finished = true;
            continue;
          }

          if (data.type === 'status' || eventName === 'status') {
            const message = String(data.message ?? '');
            setStatusLabel(message || 'Applying…');
            pushActivity({
              phase: 'info',
              source: 'studio',
              name: 'approve',
              label: message,
            });
            pushProgress(message);
            setLog((prev) => `${prev}• ${message}\n`);
            continue;
          }

          if (data.type === 'tool' || eventName === 'tool') {
            const phase = (data.phase as ActivityItem['phase']) ?? 'info';
            const source = (data.source as ActivityItem['source']) ?? 'agent';
            const label = String(data.label ?? data.name ?? 'tool');
            pushActivity({
              phase,
              source,
              name: String(data.name ?? 'tool'),
              label,
              detail: data.detail ? String(data.detail) : undefined,
            });
            continue;
          }

          if (data.type === 'agent' || eventName === 'agent') {
            if (data.text) {
              setLog((prev) => `${prev}${String(data.text)}\n`);
            }
            continue;
          }

          if (data.type === 'error' || eventName === 'error') {
            throw new Error(String(data.message ?? 'Approve failed'));
          }
        }
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      sealReasoningTurn('Approve failed', { summary: msg });
      setLog((prev) => `${prev}✗ Approve failed: ${msg}\n`);
      pushChat({ kind: 'text', role: 'assistant', text: `Approve failed: ${msg}` });
      setStatus('error');
      setStatusLabel('Error');
    } finally {
      setApproving(false);
      setChatMessages((prev) =>
        prev.map((message) =>
          message.kind === 'approve' ? { ...message, approving: false } : message,
        ),
      );
    }
  }

  async function rejectProposal() {
    if (!proposal) return;
    await fetch(`/api/proposals/${proposal.proposalId}/reject`, { method: 'POST' });
    setLog((prev) => `${prev}• Proposal rejected — nothing written to the target repo.\n`);
    pushChat({ kind: 'text', role: 'user', text: 'Reject proposal' });
    pushChat({
      kind: 'text',
      role: 'assistant',
      text: 'Proposal rejected — nothing written. Paste a new Figma URL to start again.',
    });
    setProposal(null);
    setSessionId(undefined);
    setFigmaConfirm('idle');
    setStatus('idle');
    setStatusLabel('Idle');
  }

  async function sendRefineChat(event?: FormEvent, options?: { mrUrl?: string }) {
    event?.preventDefault();
    if (!chatDraft.trim() || chatBusy) return;
    const message = chatDraft.trim();
    let activeSessionId = sessionId;
    setChatDraft('');
    setChatBusy(true);
    setStatus('running');
    setStatusLabel(activeSessionId ? 'Routing request…' : 'Attaching merge request…');
    setAgentSummary('');
    setActivity([]);
    activityRef.current = [];
    setSessionChat((prev) => [...prev, { role: 'user', text: message }]);
    pushChat({ kind: 'text', role: 'user', text: message });
    pushActivity({
      phase: 'start',
      source: 'studio',
      name: 'refine',
      label: activeSessionId ? 'Routing your request…' : 'Loading merge request context…',
    });
    try {
      if (!activeSessionId) {
        if (!options?.mrUrl) {
          throw new Error('Include a GitLab MR URL in the message.');
        }

        const attachResponse = await fetch('/api/mr-chat/attach', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mrUrl: options.mrUrl }),
        });
        const attached = (await attachResponse.json()) as {
          ok?: boolean;
          error?: string;
          session?: {
            id: string;
            componentName: string;
            mrUrl?: string;
            playgroundUrl?: string;
          };
        };
        if (!attachResponse.ok || !attached.session) {
          throw new Error(attached.error || `Unable to attach MR (HTTP ${attachResponse.status}).`);
        }

        activeSessionId = attached.session.id;
        setSessionId(attached.session.id);
        setComponentName(attached.session.componentName);
        setMrUrl(attached.session.mrUrl);
        if (attached.session.playgroundUrl) {
          setPlaygroundUrl(attached.session.playgroundUrl);
        }
        pushActivity({
          phase: 'done',
          source: 'studio',
          name: 'attach_mr',
          label: `Attached ${attached.session.componentName} merge request`,
        });
        setStatusLabel('Routing request…');
      }

      const response = await fetch(`/api/sessions/${activeSessionId}/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
        body: JSON.stringify({ message }),
      });
      if (!response.ok || !response.body) {
        throw new Error((await response.text()) || `HTTP ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let finished = false;

      while (!finished) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() ?? '';

        for (const part of parts) {
          const dataLines: string[] = [];
          let eventName = 'message';
          for (const line of part.split('\n')) {
            if (line.startsWith('event:')) eventName = line.slice(6).trim();
            if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
          }
          if (!dataLines.length) continue;
          const data = JSON.parse(dataLines.join('\n')) as Record<string, unknown>;

          if (eventName === 'result' || data.type === 'result') {
            const result = data as {
              ok?: boolean;
              error?: string;
              agentText?: string;
              playgroundUrl?: string;
              pushed?: boolean;
              awaitingPushConfirmation?: boolean;
              commitSha?: string;
              written?: string[];
              files?: ProposedFile[];
            };
            if (result.ok === false) {
              throw new Error(String(result.error || result.agentText || 'Agent request failed'));
            }
            if (Array.isArray(result.files) && result.files.length > 0) {
              refreshProposalFiles(result.files);
            }
            const reply =
              result.agentText ||
              (result.pushed
                ? `Pushed ${result.written?.length ?? 0} file(s)${result.commitSha ? ` (${result.commitSha.slice(0, 8)})` : ''}.`
                : 'No changes pushed.');
            sealReasoningTurn('Refine finished', {
              summary: reply.slice(0, 400),
            });
            setSessionChat((prev) => [...prev, { role: 'assistant', text: reply }]);
            pushChat({ kind: 'text', role: 'assistant', text: reply });
            if (result.playgroundUrl) {
              setPlaygroundUrl(
                `${result.playgroundUrl}${result.playgroundUrl.includes('?') ? '&' : '?'}t=${Date.now()}`,
              );
              pushChat({
                kind: 'playground',
                url: result.playgroundUrl,
                visualMatch,
              });
              void capturePlaygroundShot(result.playgroundUrl).catch(() => undefined);
            }
            setLog(
              (prev) =>
                `${prev}\n✓ Chat refine` +
                (result.pushed ? ' pushed to MR branch' : ' (no git push)') +
                (result.playgroundUrl ? `\nPlayground: ${result.playgroundUrl}\n` : '\n'),
            );
            setStatus('awaiting');
            setStatusLabel(
              result.awaitingPushConfirmation
                ? 'Waiting for push confirmation'
                : 'Ready — refine or Approve',
            );
            finished = true;
            continue;
          }

          if (data.type === 'status' || eventName === 'status') {
            const label = String(data.message ?? '');
            setStatusLabel(label || 'Refining…');
            pushActivity({
              phase: 'info',
              source: 'studio',
              name: 'refine',
              label,
            });
            pushProgress(label);
          } else if (data.type === 'tool' || eventName === 'tool') {
            pushActivity({
              phase: (data.phase as ActivityItem['phase']) || 'info',
              source: (data.source as ActivityItem['source']) || 'agent',
              name: String(data.name ?? 'tool'),
              label: String(data.label ?? data.name ?? 'tool'),
              detail: data.detail ? String(data.detail) : undefined,
            });
          } else if (data.type === 'agent' || eventName === 'agent') {
            if (typeof data.text === 'string' && data.text.trim()) {
              setAgentSummary((prev) => `${prev}${data.text}`.slice(-1200));
            }
          } else if (data.type === 'error' || eventName === 'error') {
            throw new Error(String(data.message ?? 'Refine error'));
          }
        }
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      sealReasoningTurn('Refine failed', { summary: msg });
      setSessionChat((prev) => [...prev, { role: 'assistant', text: msg }]);
      pushChat({ kind: 'text', role: 'assistant', text: msg });
      setLog((prev) => `${prev}✗ Refine failed: ${msg}\n`);
      setStatus('error');
      setStatusLabel('Error');
    } finally {
      setChatBusy(false);
    }
  }

  const figmaConnected = Boolean(figmaAuth?.authenticated);
  const selectedFile = proposal?.files.find((f) => f.path === selectedPath) ?? proposal?.files[0];

  const chatPhase: ChatPhase = running
    ? 'generating'
    : figmaConfirm === 'pending'
      ? 'confirm_figma'
      : sessionId
        ? 'refine'
        : proposal && figmaConfirm === 'confirmed'
          ? 'review'
          : 'compose';

  return {
    figmaUrl,
    setFigmaUrl,
    componentName,
    setComponentName,
    createMr,
    setCreateMr,
    gitHost,
    setGitHost,
    activity,
    status,
    statusLabel,
    agentSummary,
    mrUrl,
    running,
    approving,
    figmaAuth,
    authBusy,
    authNote,
    figmaConnected,
    refreshFigmaAuth,
    disconnectFigma,
    proposal,
    selectedPath,
    setSelectedPath,
    selectedFile,
    playgroundUrl,
    playgroundReachable,
    playgroundBusy,
    visualMatch,
    compareIter,
    startPlayground,
    chatDraft,
    setChatDraft,
    chatBusy: chatBusy || running,
    chatMessages,
    chatPhase,
    confirmFigmaFrame,
    rejectFigmaFrame,
    sendStudioChat,
    onSubmit,
    startGenerate,
    approveProposal,
    rejectProposal,
    sendRefineChat,
  };
}
