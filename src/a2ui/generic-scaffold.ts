import type { ComponentScaffoldInput } from './templates/index.js';
import {
  clipFigmaDesignText,
  composeLayoutScaffold,
  extractDesignLabels,
  hasCustomComponentScaffold,
  isPlaceholderRenderer,
  summarizeFigmaDataHints,
  type ComposeScaffoldOptions,
} from './figma-heuristics.js';

export {
  clipFigmaDesignText,
  extractDesignLabels,
  hasCustomComponentScaffold,
  isPlaceholderRenderer,
  summarizeFigmaDataHints,
};

/** Replace HTML/CSS / custom-element tags with semantic HTML + CSS classes. */
export function demoteDesignSystemJsx(jsx: string): string {
  let out = jsx;
  out = out.replace(/<\/?s-box\b[^>]*>/gi, (tag) =>
    tag.startsWith('</') ? '</div>' : tag.replace(/^<s-box\b/, '<div').replace(/\s*\/?>$/, '>'),
  );
  out = out.replace(/<s-badge\b([^>]*)>/gi, '<span className="badge"$1>');
  out = out.replace(/<\/s-badge>/gi, '</span>');
  out = out.replace(/<s-icon\b([^>]*)>/gi, '<span className="icon" aria-hidden="true"$1>');
  out = out.replace(/<\/s-icon>/gi, '</span>');
  out = out.replace(/<\/?s-dialog\b[^>]*>/gi, (tag) =>
    tag.startsWith('</') ? '</section>' : '<section className="dialog">',
  );
  out = out.replace(/<\/?s-row\b[^>]*>/gi, (tag) =>
    tag.startsWith('</') ? '</div>' : '<div className="row">',
  );
  out = out.replace(/<\/?s-col\b[^>]*>/gi, (tag) =>
    tag.startsWith('</') ? '</div>' : '<div className="col">',
  );
  out = out.replace(/<\/?aui-[a-z0-9-]+\b[^>]*>/gi, (tag) => {
    if (tag.startsWith('</')) return '</div>';
    const cls = tag.match(/aui-[a-z0-9-]+/i)?.[0] ?? 'chart';
    return `<div className="${cls}">`;
  });
  out = out.replace(/skylab-flex-row/g, 'flex-row');
  out = out.replace(/skylab-flex-column/g, 'flex-column');
  return out;
}

/**
 * Host safety-net scaffold: Figma heuristics + standard HTML/CSS (no design-system MCP).
 */
export function composeHostScaffold(
  pascalName: string,
  designText: string,
  options: ComposeScaffoldOptions = {},
): Omit<ComponentScaffoldInput, 'pascalName'> & { pascalName: string } {
  const base = composeLayoutScaffold(pascalName, designText, options);
  return {
    ...base,
    rendererJsx: demoteDesignSystemJsx(base.rendererJsx),
    description: base.description,
  };
}
