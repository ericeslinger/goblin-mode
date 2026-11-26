import { createHash } from 'node:crypto';
import { NOT_FOUND_PAGE, SHARE_HEADERS, SHARE_STYLE, SHARE_STYLE_HASH } from '@mossgoblin/schema';
import { describe, expect, it, vi } from 'vitest';
import {
  type PublicShare,
  answerShare,
  loadShare,
  recipeJsonLd,
  renderSharePage,
  scriptJson,
} from './page';

const ID = 'AbCdEfGhIjKlMnOpQrStUvWxYz012-_9';
const OTHER = 'ZZCdEfGhIjKlMnOpQrStUvWxYz012-_9';
const OWNER = 'owner-uid-123';

/** A share's document as the admin SDK reads it. */
const doc = (fields: Record<string, unknown>) => ({
  owner: OWNER,
  noteId: 'noteIdXYZ',
  sharedAt: { seconds: 1 },
  updatedAt: { seconds: 1 },
  ...fields,
});

/** A reader that answers `docs` by id, nothing for any other, recording its calls. */
const reader = (docs: Record<string, Record<string, unknown>>) =>
  vi.fn(async (id: string) => docs[id]);

const GLAZE = doc({ kind: 'note', title: 'Glaze recipe', body: 'Two parts *feldspar*.' });
const GRATIN_BODY =
  '## Ingredients\n\n- 1 kg potatoes, sliced\n- 300 ml *cream*\n- 1 clove garlic\n\n' +
  '## Method\n\n1. Heat the oven to 180C.\n2. Layer the potatoes & pour the cream over.\n' +
  '3. Bake 1 hour.\n\n## Notes\n\nGood with </script> salad.';

describe('loadShare', () => {
  it('reads the copy, and only what is shown', async () => {
    expect(await loadShare(ID, reader({ [ID]: GLAZE }), OWNER)).toEqual({
      kind: 'note',
      title: 'Glaze recipe',
      body: 'Two parts *feldspar*.',
    });
  });

  it('checks the id by shape before any read', async () => {
    const read = reader({ [ID]: GLAZE });
    for (const bad of ['', 'short', `${ID}x`, '..%2F..%2Fusers', `${ID.slice(1)}/`]) {
      expect(await loadShare(bad, read, OWNER)).toBe('missing');
    }
    expect(read).not.toHaveBeenCalled();
  });

  it('shows only the deployment owner’s shares', async () => {
    const stranger = doc({ kind: 'note', title: 'Spam', body: 'buy now', owner: 'someone-else' });
    expect(await loadShare(ID, reader({ [ID]: stranger }), OWNER)).toBe('missing');
    // With no owner set, nothing is shown.
    expect(await loadShare(ID, reader({ [ID]: GLAZE }), undefined)).toBe('missing');
  });

  it('says missing for one not there or of another shape, unavailable when it cannot read', async () => {
    expect(await loadShare(OTHER, reader({}), OWNER)).toBe('missing');
    const odd = doc({ kind: 'concept', title: 'x', body: '' });
    expect(await loadShare(ID, reader({ [ID]: odd }), OWNER)).toBe('missing');
    const down = vi.fn(async () => Promise.reject(new Error('unavailable')));
    expect(await loadShare(ID, down, OWNER)).toBe('unavailable');
  });

  it('keeps a recipe’s source only when it is an http or https link', async () => {
    const bad = doc({ kind: 'recipe', title: 'x', body: '', source: 'javascript:alert(1)' });
    expect(await loadShare(ID, reader({ [ID]: bad }), OWNER)).toEqual({
      kind: 'recipe',
      title: 'x',
      body: '',
    });
  });
});

describe('answerShare', () => {
  it('answers the page with a policy that allows its one stylesheet and nothing else', async () => {
    const res = await answerShare('GET', `/s/${ID}`, reader({ [ID]: GLAZE }), OWNER);
    expect(res.status).toBe(200);
    expect(res.headers).toEqual(SHARE_HEADERS);
    expect(res.headers['content-security-policy']).toBe(
      `default-src 'none'; style-src ${SHARE_STYLE_HASH}; img-src 'self' data:; ` +
        "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    expect(res.headers['x-robots-tag']).toBe('noindex, nofollow');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.headers).not.toHaveProperty('access-control-allow-origin');
    const html = res.body!;
    expect(html).toContain('<meta name="robots" content="noindex,nofollow">');
    expect(html).toContain('<meta property="og:title" content="Glaze recipe">');
    expect(html).not.toContain('og:description');
    expect(html).toContain('<p>Two parts <strong>feldspar</strong>.</p>');
    expect(html).toContain('<footer>Shared from Mossgoblin</footer>');
  });

  it('pins the style hash to the stylesheet the page carries', () => {
    const b64 = createHash('sha256').update(SHARE_STYLE).digest('base64');
    expect(SHARE_STYLE_HASH).toBe(`'sha256-${b64}'`);
    expect(renderSharePage({ kind: 'note', title: 't', body: '' })).toContain(
      `<style>${SHARE_STYLE}</style>`,
    );
  });

  it('carries no script, and names no owner, uid, note id or other share', async () => {
    const html = (await answerShare('GET', `/s/${ID}`, reader({ [ID]: GLAZE }), OWNER)).body!;
    expect(html).not.toMatch(/<script/i);
    for (const secret of [OWNER, 'noteIdXYZ', ID, OTHER, 'sharedAt']) {
      expect(html).not.toContain(secret);
    }
    expect(html).not.toMatch(/href="\//);
  });

  it('answers the same 404 for a share not there, a stranger’s, and a malformed id', async () => {
    const read = reader({ [ID]: GLAZE, [OTHER]: { ...GLAZE, owner: 'stranger' } });
    const paths = [`/s/${'A'.repeat(32)}`, `/s/${OTHER}`, '/s/nope', '/s/', '/s', `/s/${ID}/more`];
    for (const p of paths) {
      const res = await answerShare('GET', p, read, OWNER);
      expect({ status: res.status, body: res.body, headers: res.headers }).toEqual({
        status: 404,
        body: NOT_FOUND_PAGE,
        headers: SHARE_HEADERS,
      });
    }
    expect(NOT_FOUND_PAGE).not.toMatch(/<script|href=/i);
  });

  it('takes a trailing slash, and HEAD, and refuses anything but GET and HEAD', async () => {
    const read = reader({ [ID]: GLAZE });
    expect((await answerShare('GET', `/s/${ID}/`, read, OWNER)).status).toBe(200);
    const head = await answerShare('HEAD', `/s/${ID}`, read, OWNER);
    expect(head.status).toBe(200);
    expect(head.body).toBeNull();
    const post = await answerShare('POST', `/s/${ID}`, read, OWNER);
    expect(post.status).toBe(405);
    expect(post.headers['allow']).toBe('GET, HEAD');
  });

  it('says to try again when the share cannot be read', async () => {
    const down = vi.fn(async () => Promise.reject(new Error('x')));
    const res = await answerShare('GET', `/s/${ID}`, down, OWNER);
    expect(res.status).toBe(503);
    expect(res.headers['cache-control']).toBe('private, no-store');
  });

  it('escapes a hostile title and body', async () => {
    const evil = doc({
      kind: 'note',
      title: '</title><script>alert(1)</script>',
      body: '<img src=x onerror=alert(1)>\n\n[x](javascript:alert(1))',
    });
    const html = (await answerShare('GET', `/s/${ID}`, reader({ [ID]: evil }), OWNER)).body!;
    expect(html).not.toMatch(/<script|<img/i);
    expect(html).toContain('<title>&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;</title>');
    expect(html).not.toContain('href="javascript');
  });
});

describe('a recipe’s page', () => {
  const recipe: PublicShare = {
    kind: 'recipe',
    title: 'Potato gratin',
    body: GRATIN_BODY,
    source: 'https://recipes.example/gratin',
  };

  it('says where it came from, by a link with no referrer', () => {
    expect(renderSharePage(recipe)).toContain(
      '<p class="from">From <a href="https://recipes.example/gratin" ' +
        'rel="noopener noreferrer nofollow">recipes.example</a></p>',
    );
  });

  it('carries schema.org Recipe JSON-LD from its Ingredients and Method', () => {
    expect(recipeJsonLd(recipe)).toEqual({
      '@context': 'https://schema.org',
      '@type': 'Recipe',
      name: 'Potato gratin',
      recipeIngredient: ['1 kg potatoes, sliced', '300 ml cream', '1 clove garlic'],
      recipeInstructions: [
        { '@type': 'HowToStep', text: 'Heat the oven to 180C.' },
        { '@type': 'HowToStep', text: 'Layer the potatoes & pour the cream over.' },
        { '@type': 'HowToStep', text: 'Bake 1 hour.' },
      ],
      isBasedOn: 'https://recipes.example/gratin',
    });
  });

  it('writes the JSON-LD so nothing in it can end the script element', () => {
    const json = scriptJson({ a: '</script><script>alert(1)</script>', b: '<!-- & \u2028\u2029' });
    expect(json).not.toMatch(/[<>&\u2028\u2029]/);
    expect(JSON.parse(json)).toEqual({
      a: '</script><script>alert(1)</script>',
      b: '<!-- & \u2028\u2029',
    });
    const html = renderSharePage({
      ...recipe,
      title: '</script><script>alert(1)</script>',
      body: '## Ingredients\n\n- </script><script>alert(2)</script>\n\n## Method\n\n1. <!--x',
    });
    expect(html.match(/<script/g)).toHaveLength(1);
    expect(html).toContain('<script type="application/ld+json">');
    expect(html.match(/<\/script>/g)).toHaveLength(1);
  });

  it('a plain note carries no JSON-LD', () => {
    expect(
      renderSharePage({ kind: 'note', title: 'x', body: '## Ingredients\n\n- a' }),
    ).not.toMatch(/<script/);
  });

  it('renders the largest body a share may hold well within the function’s time', () => {
    const body = 'Some words *here* and [a link](https://x.example)\n\n'.repeat(3_900);
    expect(body.length).toBeLessThanOrEqual(200_000);
    const started = Date.now();
    renderSharePage({ kind: 'note', title: 'Long', body });
    // 30 s is the function's timeout.
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  it('checks the source’s scheme itself, whoever calls it', () => {
    for (const source of ['javascript:alert(1)', 'data:text/html,x', 'mailto:a@b.example', '/x']) {
      const html = renderSharePage({ ...recipe, source });
      expect(html).not.toContain(source);
      expect(html).not.toContain('class="from"');
      expect(recipeJsonLd({ ...recipe, source: undefined })).not.toHaveProperty('isBasedOn');
      expect(html).not.toContain('isBasedOn');
    }
  });
});
