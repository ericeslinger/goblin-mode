// Editor styling. Colours come from CSS variables with fallbacks, so a
// host app restyles the editor by setting --gm-* (or its own tokens).
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
  '.cm-placeholder': { color: 'var(--gm-quiet, #888)' },
  '.gm-h1': { fontSize: '1.6em', fontWeight: '700' },
  '.gm-h2': { fontSize: '1.35em', fontWeight: '700' },
  '.gm-h3': { fontSize: '1.15em', fontWeight: '700' },
  '.gm-h4, .gm-h5, .gm-h6': { fontWeight: '700' },
  '.gm-strong': { fontWeight: '700' },
  '.gm-em': { fontStyle: 'italic' },
  '.gm-del': { textDecoration: 'line-through' },
  '.gm-code, .gm-codeblock': {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: '0.9em',
  },
  '.gm-codeblock': { backgroundColor: 'var(--gm-code-bg, rgba(127,127,127,0.1))' },
  '.gm-quote': {
    borderLeft: '3px solid var(--gm-rule, rgba(127,127,127,0.4))',
    paddingLeft: '10px !important',
    color: 'var(--gm-quiet, inherit)',
  },
  '.gm-link': { color: 'var(--gm-accent, #2f6f4f)', textDecoration: 'underline' },
  '.gm-wikilink, .gm-wikilink-source': { color: 'var(--gm-accent, #2f6f4f)' },
  '.gm-wikilink': {
    padding: '0 4px',
    borderRadius: '4px',
    backgroundColor: 'var(--gm-chip-bg, rgba(47,111,79,0.12))',
    cursor: 'pointer',
  },
  '.gm-done': { color: 'var(--gm-quiet, #888)', textDecoration: 'line-through' },
  '.gm-checkbox': {
    width: '1.1em',
    height: '1.1em',
    margin: '0 6px 0 0',
    verticalAlign: '-0.15em',
    accentColor: 'var(--gm-accent, #2f6f4f)',
  },
  '.gm-bullet': { color: 'var(--gm-quiet, inherit)', fontWeight: '700' },
  '.gm-list-number, .gm-list-marker': { color: 'var(--gm-quiet, inherit)' },
  '.gm-image': { maxWidth: '100%', display: 'block', margin: '4px 0' },
  '.gm-attachment-placeholder': {
    fontStyle: 'italic',
    color: 'var(--gm-quiet, #888)',
  },
});
