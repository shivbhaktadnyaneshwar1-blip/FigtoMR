import type { Proposal, ProposalTab, ProposedFile } from '../studio-types';

type Props = {
  readonly proposal: Proposal;
  readonly createMr: boolean;
  readonly approving: boolean;
  readonly proposalTab: ProposalTab;
  readonly selectedFile: ProposedFile | undefined;
  readonly playgroundUrl: string | undefined;
  readonly playgroundReachable: boolean | null;
  readonly playgroundBusy: boolean;
  readonly visualMatch: boolean | null;
  readonly compareIter: string | undefined;
  readonly onTabChange: (tab: ProposalTab) => void;
  readonly onSelectPath: (path: string) => void;
  readonly onApprove: () => void;
  readonly onReject: () => void;
  readonly onStartPlayground: () => void;
};

export function ProposalPanel({
  proposal,
  createMr,
  approving,
  proposalTab,
  selectedFile,
  playgroundUrl,
  playgroundReachable,
  playgroundBusy,
  visualMatch,
  compareIter,
  onTabChange,
  onSelectPath,
  onApprove,
  onReject,
  onStartPlayground,
}: Props) {
  return (
    <s-box className="pad-all-md flex flex-dir-col studio-stack studio-card">
      <div className="flex flex-dir-row align-items-center space-between flex-wrap studio-stack-sm">
        <h2 className="margin-all-none proposal-title">
          Expected the target repo changes
          {proposal.componentName ? ` — ${proposal.componentName}` : ''}
        </h2>
        <div className="flex flex-dir-row studio-stack-sm">
          {visualMatch === true ? (
            <s-badge count="Visual match" />
          ) : visualMatch === false ? (
            <s-badge count="Still diverging" />
          ) : compareIter ? (
            <s-badge count={`Comparing ${compareIter}`} />
          ) : null}
          <s-badge count="Needs approval" />
        </div>
      </div>
      <p className="text-secondary margin-all-none">
        Repo: <code>{proposal.targetRepoPath}</code>
        {proposal.mode ? ` · Mode: ${proposal.mode}` : ''}
        {proposal.createMr ? ' · Opens a merge request on approve' : ' · Write only (no MR)'}
        {' · Visual compare runs automatically after stage'}
      </p>
      <div className="flex flex-dir-row flex-wrap studio-stack-sm">
        <button
          type="button"
          className={proposalTab === 'files' ? 'primary' : 'secondary'}
          onClick={() => onTabChange('files')}
        >
          Files
        </button>
        <button
          type="button"
          className={proposalTab === 'playground' ? 'primary' : 'secondary'}
          onClick={() => onTabChange('playground')}
        >
          Playground
        </button>
      </div>

      {proposalTab === 'playground' ? (
        <PlaygroundTab
          proposal={proposal}
          playgroundUrl={playgroundUrl}
          playgroundReachable={playgroundReachable}
          playgroundBusy={playgroundBusy}
          onStartPlayground={onStartPlayground}
        />
      ) : (
        <FilesTab
          files={proposal.files}
          selectedPath={selectedFile?.path}
          selectedContents={selectedFile?.contents ?? ''}
          onSelectPath={onSelectPath}
        />
      )}

      <div className="flex flex-dir-row flex-wrap studio-stack-sm">
        <button type="button" className="primary" disabled={approving} onClick={onApprove}>
          {approving
            ? createMr
              ? 'Writing → repair → MR…'
              : 'Applying…'
            : createMr
              ? 'Approve & open MR'
              : 'Approve (already staged locally)'}
        </button>
        <button type="button" className="secondary" disabled={approving} onClick={onReject}>
          Reject
        </button>
      </div>
    </s-box>
  );
}

function FilesTab({
  files,
  selectedPath,
  selectedContents,
  onSelectPath,
}: {
  readonly files: readonly ProposedFile[];
  readonly selectedPath: string | undefined;
  readonly selectedContents: string;
  readonly onSelectPath: (path: string) => void;
}) {
  return (
    <div className="proposal-layout">
      <div className="file-list" role="listbox" aria-label="Proposed files">
        {files.map((file) => {
          const selected = file.path === selectedPath;
          return (
            <div
              key={file.path}
              role="option"
              tabIndex={0}
              aria-selected={selected}
              className={`file-item${selected ? ' is-selected' : ''}`}
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
      <pre className="file-preview">{selectedContents}</pre>
    </div>
  );
}

function PlaygroundTab({
  proposal,
  playgroundUrl,
  playgroundReachable,
  playgroundBusy,
  onStartPlayground,
}: {
  readonly proposal: Proposal;
  readonly playgroundUrl: string | undefined;
  readonly playgroundReachable: boolean | null;
  readonly playgroundBusy: boolean;
  readonly onStartPlayground: () => void;
}) {
  const url = playgroundUrl || proposal.playgroundUrl;
  return (
    <div className="flex flex-dir-col studio-stack-sm">
      <s-alert status="info">
        Component files are staged in the local target repo. Visual compare against Figma runs
        automatically once after stage. Approve writes the component and can open a merge request.
      </s-alert>
      <div className="flex flex-dir-row align-items-center flex-wrap studio-stack-sm">
        <s-badge count={playgroundReachable ? 'Playground up' : 'Playground offline'} />
        {!playgroundReachable ? (
          <button
            type="button"
            className="secondary"
            disabled={playgroundBusy}
            onClick={onStartPlayground}
          >
            {playgroundBusy ? 'Starting…' : 'Start playground'}
          </button>
        ) : null}
        {url ? (
          <a className="mr-link" href={url} target="_blank" rel="noreferrer">
            Open playground link
          </a>
        ) : null}
      </div>
      {url && playgroundReachable ? (
        <iframe className="playground-frame" title="Component preview" src={url} />
      ) : null}
    </div>
  );
}
