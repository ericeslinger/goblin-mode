// Editor styling. Colours, fonts and radii come from --mg-* custom
// properties the host app sets from its theme tokens; the fallbacks are
// neutral so the editor still reads without them.
import { EditorView } from '@codemirror/view';

export const noteTheme = EditorView.theme({
  '&': {
    color: 'var(--mg-ink, inherit)',
    backgroundColor: 'transparent',
    fontSize: '17px',
    height: '100%',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'inherit', lineHeight: '1.5' },
  '.cm-content': { padding: '16px', caretColor: 'var(--mg-accent, currentColor)' },
  '.cm-line': { padding: '0' },
  '.cm-placeholder': { color: 'var(--mg-quiet, inherit)' },
  '.mg-h1, .mg-h2, .mg-h3': { fontFamily: 'var(--mg-font-heading, inherit)' },
  '.mg-h1': { fontSize: '1.6em', fontWeight: '700' },
  '.mg-h2': { fontSize: '1.35em', fontWeight: '700' },
  '.mg-h3': { fontSize: '1.15em', fontWeight: '700' },
  '.mg-h4, .mg-h5, .mg-h6': { fontWeight: '700' },
  '.mg-strong': { fontWeight: '700' },
  '.mg-em': { fontStyle: 'italic' },
  '.mg-del': { textDecoration: 'line-through' },
  '.mg-code, .mg-codeblock': {
    fontFamily: 'var(--mg-font-mono, ui-monospace, monospace)',
    fontSize: '0.9em',
  },
  '.mg-codeblock': { backgroundColor: 'var(--mg-code-bg, transparent)' },
  '.mg-quote': {
    borderLeft: '3px solid var(--mg-rule, currentColor)',
    paddingLeft: '10px !important',
    color: 'var(--mg-quiet, inherit)',
  },
  '.mg-link': { color: 'var(--mg-accent, currentColor)', textDecoration: 'underline' },
  '.mg-wikilink, .mg-wikilink-source': { color: 'var(--mg-accent, currentColor)' },
  '.mg-wikilink': {
    padding: '0 4px',
    borderRadius: 'var(--mg-radius-chip, 4px)',
    backgroundColor: 'var(--mg-chip-bg, transparent)',
    cursor: 'pointer',
  },
  '.mg-done': { color: 'var(--mg-quiet, inherit)', textDecoration: 'line-through' },
  '.mg-checkbox': {
    width: '1.1em',
    height: '1.1em',
    margin: '0 6px 0 0',
    verticalAlign: '-0.15em',
    accentColor: 'var(--mg-accent, currentColor)',
  },
  '.mg-bullet': { color: 'var(--mg-quiet, inherit)', fontWeight: '700' },
  '.mg-list-number, .mg-list-marker': { color: 'var(--mg-quiet, inherit)' },
  '.mg-image': { maxWidth: '100%', display: 'block', margin: '4px 0' },
  '.mg-file': {
    font: 'inherit',
    color: 'var(--ink, inherit)',
    background: 'var(--chip-bg, transparent)',
    border: '1px solid var(--rule, currentColor)',
    borderRadius: '999px',
    padding: '2px 10px',
    margin: '2px 0',
    cursor: 'pointer',
  },
  // The `[[` suggestions.
  '.cm-tooltip': {
    color: 'var(--mg-ink, inherit)',
    backgroundColor: 'var(--mg-surface, Canvas)',
    border: '1px solid var(--mg-rule, currentColor)',
    borderRadius: 'var(--mg-radius-card, 6px)',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul': { fontFamily: 'inherit', maxHeight: '14em' },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li': { padding: '6px 10px' },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    color: 'var(--mg-ink, inherit)',
    backgroundColor: 'var(--mg-chip-bg, Highlight)',
  },
  '.cm-completionDetail': { color: 'var(--mg-quiet, inherit)', fontStyle: 'normal' },
  '.mg-attachment-placeholder': {
    fontStyle: 'italic',
    color: 'var(--mg-quiet, inherit)',
  },
});
