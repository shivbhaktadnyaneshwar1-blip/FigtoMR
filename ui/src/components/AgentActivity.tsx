import type { ActivityItem, StudioStatus } from '../activity-reasoning';
import {
  activityProgress,
  activityToReasoningSteps,
  reasoningHeaders,
  shouldCollapseReasoning,
} from '../activity-reasoning';

type Props = {
  readonly activity: readonly ActivityItem[];
  readonly status: StudioStatus;
  readonly statusLabel: string;
  readonly summary?: string;
  readonly embedded?: boolean;
};

export function AgentActivity({ activity, status, statusLabel, summary, embedded = false }: Props) {
  const collapse = shouldCollapseReasoning(status);
  const stepsById = activityToReasoningSteps(activity, { collapse });
  const stepCount = Object.keys(stepsById).length;
  const headers = reasoningHeaders(status, statusLabel, stepCount);
  const summaryText =
    (summary || '').trim() ||
    (status === 'awaiting'
      ? 'Scaffold ready — review files in this thread.'
      : status === 'done'
        ? (statusLabel || '').trim() || 'Done.'
        : status === 'error'
          ? statusLabel || 'Something went wrong.'
          : '');
  const progress = activityProgress(activity, status);
  const showProgress = status === 'running';
  const showFallback = status === 'running' && stepCount > 0;

  const body = (
    <div className={embedded ? 'agent-activity-body chat-activity-body' : 'agent-activity-body'}>
      {showProgress ? (
        <div className="studio-progress" aria-label="Generation progress">
          <div className="studio-progress-bar" style={{ width: `${progress}%` }} />
        </div>
      ) : null}

      {summaryText ? <p className="agent-summary">{summaryText}</p> : null}

      {stepCount > 0 ? (
        <details className="activity-reasoning" open={status === 'running'}>
          <summary>{headers.inProgressHeader || headers.completedHeader || 'Reasoning'}</summary>
          <ol className="activity-fallback-list">
            {Object.entries(stepsById)
              .sort((a, b) => a[1].order - b[1].order)
              .map(([id, step]) => (
                <li key={id} data-status={step.status}>
                  <span className="activity-fallback-status">{step.status}</span>
                  <span>{step.text}</span>
                </li>
              ))}
          </ol>
        </details>
      ) : showFallback ? null : status === 'running' ? (
        <p className="text-secondary margin-all-none">Waiting for the first tool step…</p>
      ) : null}
    </div>
  );

  if (embedded) {
    return (
      <div className="chat-bubble chat-assistant chat-card chat-activity">
        <div className="flex flex-dir-row align-items-center space-between">
          <strong>{status === 'running' ? 'Studio · Thinking' : 'Studio · Reasoning'}</strong>
          {status === 'running' ? <span className="studio-spinner" aria-hidden="true" /> : null}
        </div>
        {body}
      </div>
    );
  }

  return (
    <section className="studio-card pad-all-md flex flex-dir-col studio-stack agent-activity-card">
      <div className="flex flex-dir-row align-items-center space-between agent-activity-header">
        <h5 className="margin-all-none">Agent activity</h5>
        {status === 'running' ? <span className="studio-spinner" aria-hidden="true" /> : null}
      </div>
      {body}
    </section>
  );
}
