import { useStudioController } from './hooks/useStudioController';
import { ConnectionsPanel } from './components/ConnectionsPanel';
import { StudioChat } from './components/StudioChat';

export function App() {
  const studio = useStudioController();

  return (
    <>
      <header className="studio-app-header">
        <div className="studio-app-header-inner">
          <strong className="studio-app-title">FigtoMR</strong>
          <span className="text-secondary text-sm">Figma → React</span>
        </div>
      </header>
      <main className="studio-shell flex flex-dir-col studio-stack-lg">
        <ConnectionsPanel
          figmaConnected={studio.figmaConnected}
          figmaAuth={studio.figmaAuth}
          authBusy={studio.authBusy}
          authNote={studio.authNote}
          onRefreshFigma={() => void studio.refreshFigmaAuth()}
          onDisconnectFigma={() => void studio.disconnectFigma()}
        />

        {studio.mrUrl ? (
          <div className="studio-card pad-all-md" role="status">
            Merge request opened —{' '}
            <a className="mr-link" href={studio.mrUrl} target="_blank" rel="noreferrer">
              open in git host
            </a>
          </div>
        ) : null}

        <StudioChat
          messages={studio.chatMessages}
          draft={studio.chatDraft}
          busy={studio.chatBusy || studio.running}
          createMr={studio.createMr}
          gitHost={studio.gitHost}
          figmaUrl={studio.figmaUrl}
          componentName={studio.componentName}
          selectedPath={studio.selectedPath}
          activity={studio.activity}
          status={studio.status}
          statusLabel={studio.statusLabel}
          agentSummary={studio.agentSummary}
          phase={studio.chatPhase}
          onDraftChange={studio.setChatDraft}
          onFigmaUrlChange={studio.setFigmaUrl}
          onComponentNameChange={studio.setComponentName}
          onCreateMrChange={studio.setCreateMr}
          onGitHostChange={studio.setGitHost}
          onSend={(e) => void studio.sendStudioChat(e)}
          onConfirmFigma={() => void studio.confirmFigmaFrame()}
          onRejectFigma={() => void studio.rejectFigmaFrame()}
          onSelectPath={studio.setSelectedPath}
          onApprove={() => void studio.approveProposal()}
          onRejectProposal={() => void studio.rejectProposal()}
        />
      </main>
    </>
  );
}
