import { describe, expect, it } from 'vitest';
import {
  MAX_DEPTH,
  MAX_INDENT,
  MAX_NESTING,
  STRETCH_LINES,
  escapeHtml,
  safeHref,
  shareBodyHtml,
  stretches,
  tooCostly,
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

// Review of #343: shapes the grammar is slow on, at the 200,000-character
// cap. Before any guard: '> ' x100000 29 s, '_a' x100000 10 s, '[a](b'
// x40000 9.8 s, '![a](' x30000 5.4 s; under the first guard, 16 nested
// ordered markers on each of 8,000 lines 32.8 s. Every shape here must
// render under CEILING_MS on this machine (the worst measured, alone, was
// about 1.9 s: a flat checklist of 200,000 characters), all of it
// escaped, so a regression fails the gate.
const CAP = 200_000;
// Five times the worst measured, so suites run side by side in the gate
// do not fail it (review of #343).
const CEILING_MS = 10_000;
const fill = (unit: string) => unit.repeat(Math.ceil(CAP / unit.length)).slice(0, CAP);
const lines = (f: (i: number) => string) => {
  const out: string[] = [];
  for (let i = 0, n = 0; n < CAP; i++) {
    const l = f(i);
    out.push(l);
    n += l.length + 1;
  }
  return out.join('\n').slice(0, CAP);
};

/** Renders `body`, checks it took under the ceiling and wrote only allowed tags. */
function renderedSafely(body: string): string {
  const started = performance.now();
  const html = shareBodyHtml(body);
  expect(performance.now() - started).toBeLessThan(CEILING_MS);
  expectOnlyAllowed(html.replace(/<\/?pre( class="plain")?>/g, ''));
  return html;
}

describe('bodies the grammar is slow on (review of #343)', () => {
  const shapes: [string, () => string][] = [
    ['nested quotes on one line', () => fill('> ')],
    ['16 nested ordered markers a line', () => lines((i) => `${'1. '.repeat(16)}x${i}`)],
    ['16 nested unordered markers a line', () => lines((i) => `${'- '.repeat(16)}x${i}`)],
    ['8 nested markers, indented', () => lines((i) => `  ${'- '.repeat(8)}x${i}`)],
    ['quotes inside lists', () => lines((i) => `${'- > '.repeat(8)}x${i}`)],
    ['an outline 16 deep', () => lines((i) => `${'  '.repeat(i % 16)}- x${i}`)],
    ['two nested markers a line', () => lines((i) => `- - x${i}`)],
    ['a flat checklist', () => lines((i) => `- [ ] item ${i}`)],
    ['prose', () => lines(() => 'Some words *here* and [a link](https://x.example)\n')],
    ['reference definitions', () => lines((i) => `[d${i}]: https://x.example/${i}`)],
    ['reference uses', () => fill('[d1] ')],
    [
      'definitions and uses',
      () => lines((i) => (i % 2 ? `[d${i}]: https://x.example/` : `[d${i - 1}] x`)),
    ],
    ['an emphasis run', () => fill('_a')],
    ['emphasis lines', () => lines(() => '*a'.repeat(60))],
    ['link openers', () => fill('[a](b')],
    ['image openers', () => fill('![a](')],
    ['backtick runs', () => lines(() => '``a`'.repeat(40))],
    [
      'a wide table',
      () =>
        [
          '|' + 'a|'.repeat(500),
          '|' + '-|'.repeat(500),
          ...Array.from({ length: 200 }, () => '|' + 'x|'.repeat(500)),
        ]
          .join('\n')
          .slice(0, CAP),
    ],
    ['lines and rules', () => lines((i) => (i % 2 ? '---' : 'x'))],
    ['fences', () => lines((i) => (i % 2 ? '```' : 'x'))],
  ];
  for (const [name, make] of shapes) {
    it(`${name}: under ${CEILING_MS} ms, escaped`, { timeout: 60_000 }, () => {
      renderedSafely(make());
    });
  }

  it('shows only the costly stretch as plain text; the rest keeps its formatting', () => {
    const body = `# Glaze\n\nTwo parts *feldspar*.\n\n${'_a'.repeat(5_000)}\n\nAfter **it**.`;
    const html = renderedSafely(body);
    expect(html).toContain('<h2>Glaze</h2>');
    expect(html).toContain('<strong>feldspar</strong>');
    expect(html).toContain('<pre class="plain">_a_a');
    expect(html).toContain('After <strong>it</strong>.');
  });

  it('keeps an honest long checklist and table formatted', { timeout: 60_000 }, () => {
    const checklist = Array.from({ length: 3_000 }, (_, i) => `- [ ] item ${i}`).join('\n');
    const list = renderedSafely(checklist);
    expect(list).not.toContain('class="plain"');
    expect(list.match(/type="checkbox"/g)).toHaveLength(3_000);
    const table = [
      '|a|b|c|d|e|f|g|h|',
      '|-|-|-|-|-|-|-|-|',
      ...Array.from({ length: 300 }, (_, i) => `|${i}|b|c|d|e|f|g|h|`),
    ].join('\n');
    const rows = renderedSafely(table);
    expect(rows).not.toContain('class="plain"');
    expect(rows.match(/<tr>/g)).toHaveLength(301);
  });

  it('flattens nesting past MAX_NESTING, never inside fenced code', () => {
    const [deep] = stretches(`${'> '.repeat(100)}x`);
    expect(deep.lines[0]).toBe(`${'> '.repeat(MAX_NESTING)}x`);
    const [indented] = stretches(`${' '.repeat(500)}- x`);
    expect(indented.lines[0]).toBe(`${' '.repeat(MAX_INDENT)}- x`);
    const code = '```\n' + `${' '.repeat(100)}kept\n` + `${'> '.repeat(40)}kept\n` + '```';
    expect(stretches(code)[0].lines.join('\n')).toBe(code);
    expect(shareBodyHtml(code)).toContain(`${' '.repeat(100)}kept`);
  });

  it('parses a note shorter than a stretch whole, as before', () => {
    const note = Array.from({ length: STRETCH_LINES - 1 }, (_, i) => `line ${i}`).join('\n');
    expect(stretches(note)).toHaveLength(1);
  });

  it('never cuts inside fenced code', () => {
    const body = '```\n' + 'x\n'.repeat(5 * STRETCH_LINES) + '```\nafter';
    const parts = stretches(body);
    expect(parts[0].lines.join('\n')).toContain('x\n'.repeat(5 * STRETCH_LINES - 1));
    expect(tooCostly(parts[0].lines)).toBe(false);
  });
});
