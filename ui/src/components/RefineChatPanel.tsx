import type { FormEvent } from 'react';
import type { ChatEntry } from '../studio-types';

type Props = {
  readonly mrUrl: string | undefined;
  readonly sessionChat: readonly ChatEntry[];
  readonly chatDraft: string;
  readonly chatBusy: boolean;
  readonly onDraftChange: (value: string) => void;
  readonly onSubmit: (event: FormEvent) => void;
};

export function RefineChatPanel({
  mrUrl,
  sessionChat,
  chatDraft,
  chatBusy,
  onDraftChange,
  onSubmit,
}: Props) {
  return (
    <s-box className="pad-all-md flex flex-dir-col studio-stack studio-card">
      <div className="flex flex-dir-row align-items-center space-between">
        <h2 className="margin-all-none proposal-title">Refine from playground</h2>
        {mrUrl ? (
          <a className="mr-link" href={mrUrl} target="_blank" rel="noreferrer">
            Open MR
          </a>
        ) : (
          <s-badge count="Local only" />
        )}
      </div>
      <s-alert status="info">
        Compare is already run automatically after stage. Use chat for layout, copy, HTML/CSS tags, or
        CSS fixes. Studio edits the local the target repo files
        {mrUrl ? ' and pushes to the MR branch' : ''}.
      </s-alert>
      <div className="chat-log">
        {sessionChat.length === 0 ? (
          <p className="text-secondary margin-all-none">
            Example: “Use aui-kpi-large in a horizontal row and match the Figma title”
          </p>
        ) : (
          sessionChat.map((entry, index) => (
            <div
              key={`${entry.role}-${index}`}
              className={`chat-bubble ${entry.role === 'user' ? 'chat-user' : 'chat-assistant'}`}
            >
              <strong>{entry.role === 'user' ? 'You' : 'Studio'}</strong>
              <pre>{entry.text}</pre>
            </div>
          ))
        )}
      </div>
      <form className="chat-form" onSubmit={onSubmit}>
        <input
          value={chatDraft}
          onChange={(e) => onDraftChange(e.target.value)}
          placeholder="Describe the change…"
          disabled={chatBusy}
        />
        <button type="submit" className="primary" disabled={chatBusy || !chatDraft.trim()}>
          {chatBusy ? 'Applying…' : 'Send & push'}
        </button>
      </form>
    </s-box>
  );
}
