import type { FormEvent } from 'react';

type Props = {
  readonly figmaUrl: string;
  readonly componentName: string;
  readonly createMr: boolean;
  readonly running: boolean;
  readonly approving: boolean;
  readonly onFigmaUrlChange: (value: string) => void;
  readonly onComponentNameChange: (value: string) => void;
  readonly onCreateMrChange: (value: boolean) => void;
  readonly onSubmit: (event: FormEvent) => void;
};

export function GeneratePanel({
  figmaUrl,
  componentName,
  createMr,
  running,
  approving,
  onFigmaUrlChange,
  onComponentNameChange,
  onCreateMrChange,
  onSubmit,
}: Props) {
  return (
    <s-box className="pad-all-md flex flex-dir-col studio-stack studio-card">
      <h5 className="margin-all-none">Generate</h5>
      <form className="flex flex-dir-col studio-stack" onSubmit={onSubmit}>
        <label className="flex flex-dir-col studio-stack-sm">
          <span className="text-sm-strong">Figma URL</span>
          <input
            type="url"
            required
            value={figmaUrl}
            onChange={(e) => onFigmaUrlChange(e.target.value)}
            placeholder="https://www.figma.com/design/.../...?node-id=12-34"
            autoComplete="off"
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
            placeholder="SummaryMetrics"
          />
        </label>
        <label className="flex flex-dir-row align-items-center studio-stack-sm">
          <input
            type="checkbox"
            checked={createMr}
            onChange={(e) => onCreateMrChange(e.target.checked)}
          />
          <span>
            After Approve, create GitLab MR in <code>your target repo</code>
          </span>
        </label>
        <button type="submit" className="primary" disabled={running || approving}>
          {running ? 'Generating preview…' : 'Generate preview'}
        </button>
      </form>
    </s-box>
  );
}
