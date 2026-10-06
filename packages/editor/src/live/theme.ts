// Editor styling. Colours, fonts and radii come from --gm-* custom
// properties the host app sets from its theme tokens; the fallbacks are
// neutral so the editor still reads without them.
import { EditorView } from '@codemirror/view';

export const noteTheme = EditorView.theme({
  '&': {
    color: 'var(--gm-ink, inherit)',
    backgroundColor: 'transparent',
    fontSize: '17px',
    height: '100%',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'inherit', lineHeight: '1.5' },
  '.cm-content': { padding: '16px', caretColor: 'var(--gm-accent, currentColor)' },
  '.cm-line': { padding: '0' },
  '.cm-placeholder': { color: 'var(--gm-quiet, inherit)' },
  '.gm-h1, .gm-h2, .gm-h3': { fontFamily: 'var(--gm-font-heading, inherit)' },
  '.gm-h1': { fontSize: '1.6em', fontWeight: '700' },
  '.gm-h2': { fontSize: '1.35em', fontWeight: '700' },
  '.gm-h3': { fontSize: '1.15em', fontWeight: '700' },
  '.gm-h4, .gm-h5, .gm-h6': { fontWeight: '700' },
  '.gm-strong': { fontWeight: '700' },
  '.gm-em': { fontStyle: 'italic' },
  '.gm-del': { textDecoration: 'line-through' },
  '.gm-code, .gm-codeblock': {
    fontFamily: 'var(--gm-font-mono, ui-monospace, monospace)',
    fontSize: '0.9em',
  },
  '.gm-codeblock': { backgroundColor: 'var(--gm-code-bg, transparent)' },
  '.gm-quote': {
    borderLeft: '3px solid var(--gm-rule, currentColor)',
    paddingLeft: '10px !important',
    color: 'var(--gm-quiet, inherit)',
  },
  '.gm-link': { color: 'var(--gm-accent, currentColor)', textDecoration: 'underline' },
  '.gm-wikilink, .gm-wikilink-source': { color: 'var(--gm-accent, currentColor)' },
  '.gm-wikilink': {
    padding: '0 4px',
    borderRadius: 'var(--gm-radius-chip, 4px)',
    backgroundColor: 'var(--gm-chip-bg, transparent)',
    cursor: 'pointer',
  },
  '.gm-done': { color: 'var(--gm-quiet, inherit)', textDecoration: 'line-through' },
  '.gm-checkbox': {
    width: '1.1em',
    height: '1.1em',
    margin: '0 6px 0 0',
    verticalAlign: '-0.15em',
    accentColor: 'var(--gm-accent, currentColor)',
  },
  '.gm-bullet': { color: 'var(--gm-quiet, inherit)', fontWeight: '700' },
  '.gm-list-number, .gm-list-marker': { color: 'var(--gm-quiet, inherit)' },
  '.gm-image': { maxWidth: '100%', display: 'block', margin: '4px 0' },
  '.gm-attachment-placeholder': {
    fontStyle: 'italic',
    color: 'var(--gm-quiet, inherit)',
  },
});
