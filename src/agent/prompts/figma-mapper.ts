export const FIGMA_MAPPER_RULES = `
## Figma → React mapping
- AutoLayout vertical → \`flex-column\` class; horizontal → \`flex-row\` / \`header-row\`
- Text layers → semantic headings and paragraphs with real copy from Figma
- Buttons → \`<button type="button" className="primary">\` (or secondary) with label text from Figma
- Lists / feature rows → \`<ul className="feature-list">\` with \`<li>\` rows
- Cards → \`<section className="<kebab>">\` wrapper + inner \`div\` rows
- Badges → \`<span className="badge">\`
- Icons → \`<span className="icon" aria-hidden="true">\` or an \`<img>\` when Figma exports an asset URL

Studio **always** scaffolds \`src/components/<kebab>/\` for approval and git commit to TARGET_REPO_PATH.
`.trim();
