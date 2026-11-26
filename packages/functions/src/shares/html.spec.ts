import { describe, expect, it } from 'vitest';
import {
  MAX_DEPTH,
  MAX_INDENT,
  MAX_NESTING,
  boundNesting,
  escapeHtml,
  safeHref,
  shareBodyHtml,
  tooManyMarks,
} from './html';

/** Every tag the renderer may write, by name. */
const ALLOWED = new Set([
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'p',
  'ul',
  'ol',
  'li',
  'input',
  'label',
  'blockquote',
  'pre',
  'code',
  'em',
  'strong',
  'del',
  'br',
  'hr',
  'a',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
]);
const ATTRIBUTES = new Set([
  'href',
  'rel',
  'start',
  'class',
  'type',
  'disabled',
  'checked',
  'align',
]);

/** Every tag and attribute in `html`, checked against what may be written. */
function expectOnlyAllowed(html: string): void {
  for (const [, name, attrs] of html.matchAll(/<\/?([a-zA-Z0-9]+)([^>]*)>/g)) {
    expect(ALLOWED, `tag <${name}>`).toContain(name.toLowerCase());
    // Every attribute is a name, and a value in double quotes or none.
    expect(attrs, `attributes of <${name}>`).toMatch(/^(\s[a-z]+(="[^"<>]*")?)*$/);
    for (const [, attr] of attrs.matchAll(/\s([a-zA-Z-]+)(?:="[^"]*")?/g)) {
      expect(ATTRIBUTES, `attribute ${attr} on <${name}>`).toContain(attr.toLowerCase());
    }
  }
  // Every href is http, https or mailto.
  for (const [, href] of html.matchAll(/href="([^"]*)"/g)) {
    expect(href).toMatch(/^(https?:\/\/|mailto:)/);
  }
}

describe('shareBodyHtml', () => {
  it('writes the app’s dialect: *bold*, _italic_, headings under the title', () => {
    const html = shareBodyHtml('# Glaze\n\nTwo parts *feldspar*, _one_ part ~~silica~~.');
    expect(html).toBe(
      '<h2>Glaze</h2>\n<p>Two parts <strong>feldspar</strong>, <em>one</em> part ' +
        '<del>silica</del>.</p>\n',
    );
  });

  it('writes lists, task lists as disabled checkboxes, quotes, code and rules', () => {
    const html = shareBodyHtml(
      '- eggs\n- milk\n\n3. three\n4. four\n\n- [ ] buy clay\n- [x] fire kiln\n\n' +
        '> a quote\n\n```\nlet x = 1 < 2;\n```\n\n---\n\nsay `a<b`',
    );
    expect(html).toContain('<ul>\n<li>eggs</li>\n<li>milk</li>\n</ul>');
    expect(html).toContain('<ol start="3">\n<li>three</li>');
    expect(html).toContain(
      '<li class="task"><label><input type="checkbox" disabled> buy clay</label></li>',
    );
    expect(html).toContain(
      '<li class="task"><label><input type="checkbox" disabled checked> fire kiln</label></li>',
    );
    expect(html).toContain('<blockquote>\n<p>a quote</p>\n</blockquote>');
    expect(html).toContain('<pre><code>let x = 1 &lt; 2;</code></pre>');
    expect(html).toContain('<hr>');
    expect(html).toContain('<code>a&lt;b</code>');
    expectOnlyAllowed(html);
  });

  it('shows raw HTML as its text, never as markup', () => {
    const hostile = [
      '<script>alert(1)</script>',
      'inline <img src=x onerror=alert(1)> here',
      '<iframe src="https://evil.example"></iframe>',
      '<style>body{display:none}</style>',
      '<a href="javascript:alert(1)">x</a>',
      '<div onclick="alert(1)">click</div>',
      '<!-- a comment --> and <svg onload=alert(1)>',
      '<meta http-equiv="refresh" content="0;url=https://evil.example">',
      '<base href="https://evil.example/">',
      '<form action="https://evil.example"><input name=p></form>',
    ].join('\n\n');
    const html = shareBodyHtml(hostile);
    expect(html).not.toMatch(/<(script|img|iframe|style|div|svg|meta|base|form|!--)/i);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    // Words like onerror= stay as words, never inside a tag.
    expectOnlyAllowed(html);
  });

  it('links only http, https and mailto; anything else is its text', () => {
    const html = shareBodyHtml(
      [
        '[ok](https://example.com/a?b=1&c=2)',
        '[mail](mailto:me@example.com)',
        '[js](javascript:alert(1))',
        '[js2](JaVaScRiPt:alert(1))',
        '[js3]( javascript:alert(1))',
        '[tab](java\tscript:alert(1))',
        '[data](data:text/html;base64,PHNjcmlwdD4=)',
        '[vb](vbscript:msgbox)',
        '[rel](/settings)',
        '[proto](//evil.example/x)',
        '[file](file:///etc/passwd)',
        '<javascript:alert(1)>',
        'https://bare.example/x',
      ].join('\n\n'),
    );
    expect(html).toContain(
      '<a href="https://example.com/a?b=1&amp;c=2" rel="noopener noreferrer nofollow">ok</a>',
    );
    expect(html).toContain('<a href="mailto:me@example.com" rel="noopener noreferrer nofollow">');
    expect(html).toContain('<a href="https://bare.example/x"');
    for (const word of ['js', 'js2', 'js3', 'data', 'vb', 'rel', 'proto', 'file']) {
      expect(html).toContain(`<p>${word}</p>`);
    }
    expect(html).not.toMatch(/href="(?!https?:|mailto:)/);
    expect(html).not.toMatch(/javascript:alert\(1\)"/i);
    expectOnlyAllowed(html);
  });

  it('escapes every character HTML reads, entities included', () => {
    const html = shareBodyHtml('Tom & Jerry say "hi" & \'bye\' &lt;b&gt; &amp; &#x3C;script&#x3E;');
    expect(html).not.toContain('<b>');
    expect(html).not.toContain('<script');
    expect(html).toContain('Tom &amp; Jerry say &quot;hi&quot; &amp; &#39;bye&#39;');
    // An entity in the note is read as markdown reads it, then escaped again.
    expect(html).toContain('&lt;b&gt;');
    expect(html).toContain('&lt;script&gt;');
    expectOnlyAllowed(html);
  });

  it('keeps an attribute closed whatever the link holds', () => {
    const html = shareBodyHtml('[x](https://a.example/"onmouseover="alert(1))');
    expect(html).not.toMatch(/"\s*onmouseover/);
    expectOnlyAllowed(html);
  });

  it('gives an image its alt text, a link on the web, never an <img>', () => {
    const html = shareBodyHtml(
      '![a kiln](https://img.example/k.jpg) ![](attachment:abc) ![x](javascript:alert(1))',
    );
    expect(html).not.toContain('<img');
    expect(html).toContain(
      '<a href="https://img.example/k.jpg" rel="noopener noreferrer nofollow">a kiln</a>',
    );
    expectOnlyAllowed(html);
  });

  it('keeps a note’s lines as lines', () => {
    expect(shareBodyHtml('one\ntwo <b>')).toBe('<p>one<br>\ntwo &lt;b&gt;</p>\n');
  });

  it('writes wiki links and #tags as words', () => {
    expect(shareBodyHtml('See [[Kiln log|the log]] and [[Glaze]] #pottery')).toBe(
      '<p>See the log and Glaze #pottery</p>\n',
    );
  });

  it('survives nested markdown tricks without letting markup through', () => {
    const tricks = [
      '*[<b>](javascript:x)*',
      '[a](https://ok.example "<script>")',
      '[![x](javascript:y)](https://ok.example)',
      '`<script>` *`</code><script>`*',
      '> > > <img src=x>',
      '- [ ] <input type=text autofocus onfocus=alert(1)>',
      '| a | <b>b</b> |\n| - | - |\n| [x](javascript:1) | c |',
      '[ref]\n\n[ref]: javascript:alert(1)',
      'footnote[^1]\n\n[^1]: <script>x</script>',
    ].join('\n\n');
    const html = shareBodyHtml(tricks);
    expect(html).not.toMatch(/<(script|img|b>|input type="text")/i);
    expectOnlyAllowed(html);
  });

  it('shows nesting past MAX_DEPTH as text, and does not run away on deep input', () => {
    const deep = '>'.repeat(500) + ' deep';
    const html = shareBodyHtml(deep);
    expect(html).toContain('deep');
    expect((html.match(/<blockquote>/g) ?? []).length).toBeLessThanOrEqual(MAX_DEPTH);
    expectOnlyAllowed(html);
    const list = Array.from({ length: 200 }, (_, i) => `${'  '.repeat(i)}- item ${i}`).join('\n');
    expectOnlyAllowed(shareBodyHtml(list));
  });

  it('renders a long body, all of it escaped', () => {
    // About 60,000 characters; a typical note of 5,000 takes some 30 ms
    // in Node (DESIGN.md, Sharing a public copy, The Worker's cost).
    const long = 'a <script>x</script> *word*\n\n'.repeat(2_000);
    const started = Date.now();
    const html = shareBodyHtml(long);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(html).not.toContain('<script>');
    expect(html.match(/<strong>word<\/strong>/g)).toHaveLength(2_000);
    // One line of 100,000 characters, one paragraph.
    const line = shareBodyHtml(`<b>${'x'.repeat(100_000)}`);
    expect(line.startsWith('<p>&lt;b&gt;xxx')).toBe(true);
  });
});

describe('escapeHtml and safeHref', () => {
  it('escapes the five', () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
      '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;',
    );
  });

  it('takes only absolute http, https and mailto addresses', () => {
    expect(safeHref('https://a.example')).toBe('https://a.example/');
    expect(safeHref('mailto:x@y.example')).toBe('mailto:x@y.example');
    for (const bad of ['javascript:x', 'data:x', '/x', '//x.example', 'ftp://x', 'https://']) {
      expect(safeHref(bad)).toBeUndefined();
    }
  });
});

// Review of #343: shapes the grammar is slow on, measured at 200,000
// characters before this guard: '> ' x100000 29 s, '_a' x100000 10 s,
// '[a](b' x40000 9.8 s, '![a](' x30000 5.4 s.
describe('bodies the grammar is slow on', () => {
  it('shows a block with too many marks as its plain text, escaped, at once', () => {
    for (const body of [
      '_a'.repeat(100_000),
      '[a](b'.repeat(40_000),
      '![a]('.repeat(30_000),
      `<script>${'*a'.repeat(5_000)}`,
    ]) {
      expect(tooManyMarks(body)).toBe(true);
      const started = Date.now();
      const html = shareBodyHtml(body);
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(html.startsWith('<pre class="plain">')).toBe(true);
      expect(html).not.toMatch(/<(?!\/?pre)/);
    }
  });

  it('flattens nesting past MAX_NESTING before the parse', () => {
    expect(boundNesting(`${'> '.repeat(100)}x`)).toBe(`${'> '.repeat(MAX_NESTING)}x`);
    expect(boundNesting(`${' '.repeat(500)}- x`)).toBe(`${' '.repeat(MAX_INDENT)}- x`);
    expect(boundNesting('> - 1. quoted list')).toBe('> - 1. quoted list');
    const started = Date.now();
    const html = shareBodyHtml('> '.repeat(100_000));
    expect(Date.now() - started).toBeLessThan(2_000);
    expect((html.match(/<blockquote>/g) ?? []).length).toBeLessThanOrEqual(MAX_NESTING);
  });

  it('keeps an ordinary note as markdown, a checklist of hundreds included', () => {
    const list = Array.from({ length: 500 }, (_, i) => `- [ ] item ${i}`).join('\n');
    expect(tooManyMarks(list)).toBe(false);
    expect(shareBodyHtml(list)).toContain('<ul class="tasks">');
  });

  it('renders the worst blocks under the limit within a few seconds', () => {
    for (const block of ['*a'.repeat(999), '[a](b'.repeat(399), '![a]('.repeat(333)]) {
      const body = `${block}\n\n`.repeat(99).slice(0, 200_000);
      expect(tooManyMarks(body)).toBe(false);
      const started = Date.now();
      shareBodyHtml(body);
      // About 1.6 s at most in Node here; the function's timeout is 30 s.
      expect(Date.now() - started).toBeLessThan(10_000);
    }
  });
});
