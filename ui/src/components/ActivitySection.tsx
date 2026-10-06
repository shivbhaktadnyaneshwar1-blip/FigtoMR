import type { ActivityItem, StudioStatus } from '../activity-reasoning';
import type { FigmaScreenshot, Proposal } from '../studio-types';
import { AgentActivity } from './AgentActivity';
import { ScreenshotCard } from './ScreenshotCard';

type Props = {
  readonly activity: readonly ActivityItem[];
  readonly status: StudioStatus;
  readonly statusLabel: string;
  readonly agentSummary: string;
  readonly proposal: Proposal | null;
  readonly liveScreenshot: FigmaScreenshot | null;
};

export function ActivitySection({
  activity,
  status,
  statusLabel,
  agentSummary,
  proposal,
  liveScreenshot,
}: Props) {
  const shot = proposal?.figmaScreenshot ?? liveScreenshot;
  return (
    <section className="studio-grid studio-grid-activity" aria-live="polite">
      <AgentActivity
        activity={activity}
        status={status}
        statusLabel={statusLabel}
        summary={agentSummary || proposal?.agentText}
      />
      <ScreenshotCard
        title="Figma screenshot"
        dataUrl={shot?.dataUrl}
        caption={shot?.nodeId ? `node ${shot.nodeId}` : undefined}
        emptyHint="Live Figma frame appears here after inspect_figma_node."
      />
    </section>
  );
}
