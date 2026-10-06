export type GitHost = 'github' | 'gitlab';

type Props = {
  readonly value: GitHost;
  readonly disabled?: boolean;
  readonly onChange: (value: GitHost) => void;
};

export function GitHostToggle({ value, disabled, onChange }: Props) {
  return (
    <div className="git-host-toggle" role="group" aria-label="Git host">
      {(['github', 'gitlab'] as const).map((host) => (
        <button
          key={host}
          type="button"
          className={value === host ? 'is-selected' : undefined}
          aria-pressed={value === host}
          disabled={disabled}
          onClick={() => onChange(host)}
        >
          {host === 'github' ? 'GitHub' : 'GitLab'}
        </button>
      ))}
    </div>
  );
}

export function reviewLabel(host: GitHost): string {
  return host === 'github' ? 'pull request' : 'merge request';
}
