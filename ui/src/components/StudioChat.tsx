import { type FormEvent, useEffect, useRef } from 'react';
import type { ActivityItem, StudioStatus } from '../activity-reasoning';
import type { StudioChatMessage } from '../chat-types';
import type { ProposedFile } from '../studio-types';
import { AgentActivity } from './AgentActivity';
import { TypedChatReply } from './TypedChatReply';

type Props = {
  readonly messages: readonly StudioChatMessage[];
  readonly draft: string;
  readonly busy: boolean;
  readonly createMr: boolean;
  readonly figmaUrl: string;
  readonly componentName: string;
  readonly selectedPath: string | undefined;
  readonly activity: readonly ActivityItem[];
  readonly status: StudioStatus;
  readonly statusLabel: string;
  readonly agentSummary: string;
  readonly onDraftChange: (value: string) => void;
  readonly onFigmaUrlChange: (value: string) => void;
  readonly onComponentNameChange: (value: string) => void;
  readonly onCreateMrChange: (value: boolean) => void;
  readonly onSend: (event?: FormEvent) => void;
  readonly onConfirmFigma: () => void | Promise<void>;
  readonly onRejectFigma: () => void | Promise<void>;
  readonly onSelectPath: (path: string) => void;
  readonly onApprove: () => void;
  readonly onRejectProposal: () => void;
  readonly phase: 'compose' | 'generating' | 'confirm_figma' | 'review' | 'refine';
};

export function StudioChat({
  messages,
  draft,
  busy,
  createMr,
  figmaUrl,
  componentName,
  selectedPath,
  activity,
  status,
  statusLabel,
  agentSummary,
  onDraftChange,
  onFigmaUrlChange,
  onComponentNameChange,
  onCreateMrChange,
  onSend,
  onConfirmFigma,
  onRejectFigma,
  onSelectPath,
  onApprove,
  onRejectProposal,
  phase,
}: Props) {
  const endRef = useRef<HTMLDivElement | null>(null);
  // Live Thinking only while the agent is actively working on the current turn.
  // Completed turns are sealed into `kind: 'reasoning'` messages above concrete replies.
  const showThinking = status === 'running';

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length, busy, activity.length, statusLabel, status]);

  const placeholder =
    phase === 'compose'
      ? 'Paste a Figma URL (optional: ComponentName)…'
      : phase === 'confirm_figma'
        ? 'Type yes / no, or use the buttons…'
        : phase === 'refine' || phase === 'review'
          ? 'Ask for a layout/copy fix, or Approve below…'
          : 'Working…';

  return (
    <s-box className="pad-all-md flex flex-dir-col studio-stack studio-card studio-chat">
      <div className="flex flex-dir-row align-items-center space-between flex-wrap studio-stack-sm">
        <h2 className="margin-all-none proposal-title">Studio chat</h2>
        <s-badge
          count={
            phase === 'compose'
              ? 'New scaffold'
              : phase === 'generating'
                ? 'Generating'
                : phase === 'confirm_figma'
                  ? 'Confirm Figma'
                  : phase === 'refine'
                    ? 'Refine'
                    : 'Review'
          }
        />
      </div>

      {phase === 'compose' ? (
        <div className="studio-chat-starter flex flex-dir-col studio-stack-sm">
          <label className="flex flex-dir-col studio-stack-sm">
            <span className="text-sm-strong">Figma node URL</span>
            <input
              type="url"
              value={figmaUrl}
              onChange={(e) => onFigmaUrlChange(e.target.value)}
              placeholder="https://www.figma.com/design/…?node-id=…"
              autoComplete="off"
              disabled={busy}
            />
          </label>
          <label className="flex flex-dir-col studio-stack-sm">
            <span className="text-sm-strong">
              Component name <span className="text-secondary">(optional)</span>
            </span>
            <input
              type="text"
              value={componentName}
              onChange={(e) => onComponentNameChange(e.target.value)}
              placeholder="EcmProPlanCard"
              disabled={busy}
            />
          </label>
          <label className="flex flex-dir-row align-items-center studio-stack-sm">
            <input
              type="checkbox"
              checked={createMr}
              onChange={(e) => onCreateMrChange(e.target.checked)}
              disabled={busy}
            />
            <span className="text-sm">
              After Approve, open GitLab MR in <code>your target repo</code>
            </span>
          </label>
        </div>
      ) : null}

      <div className="studio-chat-log" role="log" aria-live="polite">
        {messages.length === 0 && !showThinking ? (
          <p className="text-secondary margin-all-none">
            Everything happens in this thread — progress, Figma screenshot, proposed files, playground
            link, then refine. Paste a Figma node URL and generate.
          </p>
        ) : null}

        {messages.map((message, index) => (
          <ChatBubble
            key={message.id}
            message={message}
            isLatest={index === messages.length - 1}
            selectedPath={selectedPath}
            onConfirmFigma={onConfirmFigma}
            onRejectFigma={onRejectFigma}
            onSelectPath={onSelectPath}
            onApprove={onApprove}
            onRejectProposal={onRejectProposal}
          />
        ))}

        {showThinking ? (
          <AgentActivity
            embedded
            activity={activity}
            status={status}
            statusLabel={statusLabel}
            summary={agentSummary}
          />
        ) : null}

        <div ref={endRef} />
      </div>

      <form className="chat-form" onSubmit={(e) => onSend(e)}>
        <input
          value={draft}
          onChange={(e) => onDraftChange(e.target.value)}
          placeholder={placeholder}
          disabled={busy && phase === 'generating'}
        />
        <button
          type="submit"
          className="primary"
          disabled={busy || (!draft.trim() && !(phase === 'compose' && figmaUrl.trim()))}
        >
          {busy ? 'Working…' : phase === 'compose' ? 'Generate' : 'Send'}
        </button>
      </form>
    </s-box>
  );
}

function ChatBubble({
  message,
  isLatest,
  selectedPath,
  onConfirmFigma,
  onRejectFigma,
  onSelectPath,
  onApprove,
  onRejectProposal,
}: {
  readonly message: StudioChatMessage;
  readonly isLatest: boolean;
  readonly selectedPath: string | undefined;
  readonly onConfirmFigma: () => void | Promise<void>;
  readonly onRejectFigma: () => void | Promise<void>;
  readonly onSelectPath: (path: string) => void;
  readonly onApprove: () => void;
  readonly onRejectProposal: () => void;
}) {
  if (message.kind === 'text') {
    if (message.role === 'assistant') {
      return <TypedChatReply text={message.text} instant={!isLatest} />;
    }
    return (
      <div className="chat-bubble chat-user">
        <strong>You</strong>
        <pre>{message.text}</pre>
      </div>
    );
  }

  if (message.kind === 'progress') {
    return null;
  }

  if (message.kind === 'reasoning') {
    return (
      <AgentActivity
        embedded
        activity={message.activity}
        status="done"
        statusLabel={message.statusLabel}
        summary={message.summary}
      />
    );
  }

  if (message.kind === 'figma') {
    return (
      <div className="chat-bubble chat-assistant chat-card">
        <strong>Studio · Figma frame</strong>
        <p className="text-secondary margin-all-none text-sm">
          {message.nodeId ? `node ${message.nodeId}` : 'Captured from your URL'}
          {message.status === 'confirmed' ? ' · confirmed' : null}
          {message.status === 'rejected' ? ' · rejected' : null}
        </p>
        <img className="studio-chat-shot" src={message.dataUrl} alt="Figma frame" />
        {message.status === 'pending' ? (
          <div className="flex flex-dir-row flex-wrap studio-stack-sm">
            <button type="button" className="primary" onClick={onConfirmFigma}>
              Looks good — continue
            </button>
            <button type="button" className="secondary" onClick={onRejectFigma}>
              Wrong frame
            </button>
          </div>
        ) : null}
      </div>
    );
  }

  if (message.kind === 'files') {
    const selected = message.files.find((f) => f.path === selectedPath) ?? message.files[0];
    return (
      <div className="chat-bubble chat-assistant chat-card">
        <strong>
          Studio · Proposed changes
          {message.componentName ? ` — ${message.componentName}` : ''}
        </strong>
        <div className="proposal-layout chat-files">
          <div className="file-list" role="listbox" aria-label="Proposed files">
            {message.files.map((file: ProposedFile) => {
              const isSelected = file.path === selected?.path;
              return (
                <div
                  key={file.path}
                  role="option"
                  tabIndex={0}
                  aria-selected={isSelected}
                  className={`file-item${isSelected ? ' is-selected' : ''}`}
                  title={file.path}
                  onClick={() => onSelectPath(file.path)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      onSelectPath(file.path);
                    }
                  }}
                >
                  <span className="file-action">{file.action}</span>
                  <span className="file-path">{file.path}</span>
                </div>
              );
            })}
          </div>
          <pre className="file-preview">{selected?.contents ?? ''}</pre>
        </div>
      </div>
    );
  }

  if (message.kind === 'playground') {
    return (
      <div className="chat-bubble chat-assistant chat-card">
        <strong>Studio · Playground</strong>
        <p className="text-secondary margin-all-none text-sm">
          Open the live the target repo playground to review the render
          {message.visualMatch === true
            ? ' · visual match'
            : message.visualMatch === false
              ? ' · still diverging'
              : ''}
          .
        </p>
        <a className="mr-link" href={message.url} target="_blank" rel="noreferrer">
          Open playground
        </a>
      </div>
    );
  }

  return (
    <div className="chat-bubble chat-assistant chat-card">
      <strong>Studio · Ready for approval</strong>
      <p className="text-secondary margin-all-none text-sm">
        {message.visualMatch === true
          ? 'Visual compare matched. '
          : message.visualMatch === false
            ? 'Visual compare still diverging — refine in chat or approve anyway. '
            : ''}
        {message.createMr
          ? 'Approve writes files, repairs lint/tests, and opens an MR.'
          : 'Approve keeps the local stage (no MR).'}
      </p>
      <div className="flex flex-dir-row flex-wrap studio-stack-sm">
        <button type="button" className="primary" disabled={message.approving} onClick={onApprove}>
          {message.approving
            ? message.createMr
              ? 'Writing → MR…'
              : 'Applying…'
            : message.createMr
              ? 'Approve & open MR'
              : 'Approve (local)'}
        </button>
        <button
          type="button"
          className="secondary"
          disabled={message.approving}
          onClick={onRejectProposal}
        >
          Reject
        </button>
      </div>
    </div>
  );
}
