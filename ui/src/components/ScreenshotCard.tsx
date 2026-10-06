type Props = {
  readonly title: string;
  readonly dataUrl?: string;
  readonly caption?: string;
  readonly emptyHint?: string;
};

/** Figma / preview screenshot inside HTML/CSS `<s-card-ai>`. */
export function ScreenshotCard({ title, dataUrl, caption, emptyHint }: Props) {
  return (
    <s-card-ai className="studio-shot-card">
      <span slot="header-title" className="text-sm-strong">
        {title}
      </span>
      <span slot="header-badge">{dataUrl ? <s-badge count="Figma" /> : null}</span>
      <div slot="content" className="flex flex-dir-col studio-stack-sm studio-shot-content">
        {dataUrl ? (
          <>
            <img className="studio-shot" src={dataUrl} alt={title} />
            {caption ? <small className="text-secondary">{caption}</small> : null}
          </>
        ) : (
          <s-alert status="info">{emptyHint ?? 'Screenshot will appear after Figma inspection.'}</s-alert>
        )}
      </div>
    </s-card-ai>
  );
}
