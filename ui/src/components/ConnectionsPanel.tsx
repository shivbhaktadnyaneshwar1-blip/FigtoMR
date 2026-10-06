import type { FigmaAuthStatus } from '../studio-types';

type Props = {
  readonly figmaConnected: boolean;
  readonly figmaAuth: FigmaAuthStatus | null;
  readonly authBusy: boolean;
  readonly authNote: string;
  readonly onRefreshFigma: () => void;
  readonly onDisconnectFigma: () => void;
};

export function ConnectionsPanel({
  figmaConnected,
  figmaAuth,
  authBusy,
  authNote,
  onRefreshFigma,
  onDisconnectFigma,
}: Props) {
  return (
    <section className="studio-card pad-all-md studio-stack-sm">
      <h2 className="margin-all-none text-lg">Connections</h2>
      <div className="flex flex-dir-row align-items-center gap-md flex-wrap">
        <span className={figmaConnected ? 'badge badge-success' : 'badge'}>
          Figma MCP {figmaConnected ? 'connected' : 'offline'}
        </span>
        <button type="button" className="btn-secondary" disabled={authBusy} onClick={onRefreshFigma}>
          Refresh Figma auth
        </button>
        {figmaAuth?.authenticated ? (
          <button type="button" className="btn-secondary" disabled={authBusy} onClick={onDisconnectFigma}>
            Disconnect Figma
          </button>
        ) : null}
      </div>
      {authNote ? <p className="text-secondary margin-all-none text-sm">{authNote}</p> : null}
    </section>
  );
}
