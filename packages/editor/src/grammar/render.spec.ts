import { describe, expect, it } from 'vitest';
import { renderNoteHtml } from './render';

describe('renderNoteHtml', () => {
  it('renders CommonMark and GFM task lists', () => {
    const html = renderNoteHtml('# Title\n\n- [ ] todo\n- [x] done');
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toMatch(/<input type="checkbox" disabled>\s*todo/);
    expect(html).toMatch(/<input type="checkbox" checked disabled>\s*done/);
  });

  it('renders wiki links as spans carrying their target', () => {
    expect(renderNoteHtml('see [[Project Hotswap|Hotswap]]')).toContain(
      '<span class="wikilink" data-target="Project Hotswap">Hotswap</span>',
    );
  });

  it('shows an attachment as its caption until it can be resolved', () => {
    expect(renderNoteHtml('![page one](attachment:abc)')).toContain(
      '<span class="attachment-placeholder">page one</span>',
    );
    const html = renderNoteHtml('![page one](attachment:abc)', {
      resolveAttachment: (id) => `https://files.test/${id}.webp`,
    });
    expect(html).toContain('<img src="https://files.test/abc.webp" alt="page one">');
  });

  it('never passes raw HTML or script URLs through', () => {
    const html = renderNoteHtml('<script>alert(1)</script>\n\n[x](javascript:alert(1))');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('javascript:');
  });
});
