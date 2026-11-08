import {
  type FeedlyEntry,
  ZIP_FILES_MAX,
  ZipTooLarge,
  entryTags,
  readFeedlyExport,
  toEntry,
  unzip,
} from './feedly';
import { zipOf } from '../testing/zip';

const OPML = `<?xml version="1.0"?><opml version="1.0"><body>
  <outline text="Design"><outline text="Design notes" xmlUrl="https://design.test/feed.xml"/></outline>
</body></opml>`;

const entry = (n: number, more: Record<string, unknown> = {}) => ({
  id: `entry-${n}`,
  originId: `tag:design.test,${n}`,
  title: `Article ${n}`,
  alternate: [{ href: `https://design.test/a${n}`, type: 'text/html' }],
  origin: { streamId: 'feed/https://design.test/feed.xml', title: 'Design notes' },
  published: 1_762_000_000_000 + n,
  summary: { content: `<p>Summary ${n}</p>` },
  ...more,
});

const SAVED = 'user/u1/tag/global.saved';

describe('Feedly’s export (#176)', () => {
  it('reads a zip’s stored and deflated files by its directory', async () => {
    for (const deflated of [false, true]) {
      const zip = await zipOf({ 'a.txt': 'hello', 'dir/b.txt': 'wörld'.repeat(50) }, deflated);
      const files = unzip(await zip.arrayBuffer());
      expect(files.map((f) => f.name)).toEqual(['a.txt', 'dir/b.txt']);
      const text = new TextDecoder().decode(await files[1].read());
      expect(text).toBe('wörld'.repeat(50));
    }
    expect(() => unzip(new ArrayBuffer(40))).toThrow('not a zip file');
  });

  it('skips a file past the bound for one, or past the size it declares, and counts it (review on #199)', async () => {
    const saves = JSON.stringify([entry(1)]);
    // Over 64 KB of slack, so a file that says it is empty is caught lying.
    const big = JSON.stringify([entry(2, { summary: { content: 'x'.repeat(100_000) } })]);
    for (const deflated of [false, true]) {
      const zip = await zipOf(
        { 'x/saved.json': saves, 'x/huge-saved.json': saves, 'x/liar-saved.json': big },
        deflated,
        { 'x/huge-saved.json': 65 * 1024 * 1024, 'x/liar-saved.json': 0 },
      );
      const out = await readFeedlyExport(Object.assign(zip, { name: 'feedly.zip' }));
      expect(out.tooLarge).toBe(2);
      expect(out.entries.map((e) => e.url)).toEqual(['https://design.test/a1']);
    }
  });

  it('refuses an archive of more files than an export could hold (review on #199)', async () => {
    const end = new Uint8Array(26);
    end.set([0x50, 0x4b, 0x03, 0x04]);
    const view = new DataView(end.buffer);
    view.setUint32(4, 0x06054b50, true);
    view.setUint16(14, ZIP_FILES_MAX + 1, true);
    expect(() => unzip(end.buffer)).toThrow(ZipTooLarge);
    await expect(readFeedlyExport(new Blob([end]))).rejects.toThrow(
      'That zip holds 5,001 files, more than the 5,000 a Feedly export could; it was not read.',
    );
  });

  it('maps an entry: its link, feed, guid, date, author and HTML', () => {
    expect(
      toEntry({
        ...entry(1),
        author: 'Ada',
        content: { content: '<p>Full</p>' },
        tags: [{ id: SAVED, label: 'Saved For Later' }],
      }),
    ).toEqual<FeedlyEntry>({
      url: 'https://design.test/a1',
      title: 'Article 1',
      feedUrl: 'https://design.test/feed.xml',
      guid: 'tag:design.test,1',
      published: 1_762_000_000_001,
      author: 'Ada',
      html: '<p>Full</p>',
      tags: [],
    });
    // No alternate: the canonical link; seconds read as seconds.
    expect(
      toEntry({ id: 'x', canonicalUrl: 'https://c.test/x', published: 1_762_000_000 }),
    ).toMatchObject({ url: 'https://c.test/x', published: 1_762_000_000_000, tags: [] });
  });

  it('keeps human labels as tags and drops Feedly’s own', () => {
    expect(
      entryTags({
        tags: [
          { id: SAVED, label: 'Saved For Later' },
          { id: 'user/u1/tag/global.read' },
          { id: 'user/u1/tag/Pottery', label: 'Pottery' },
          { id: 'user/u1/tag/Glaze%20tests' },
          'global.must',
        ],
        categories: [{ id: 'user/u1/category/Design', label: 'Design' }],
      }),
    ).toEqual(['Pottery', 'Glaze tests']);
  });

  it('reads the OPML, the saves and a board, the board’s name a tag, one article once', async () => {
    const zip = await zipOf(
      {
        'feedly-export/feedly.opml': OPML,
        'feedly-export/saved.json': JSON.stringify([
          entry(1, { tags: [{ id: SAVED }] }),
          entry(2, { tags: [{ id: SAVED }, { id: 'user/u1/tag/Kiln', label: 'Kiln' }] }),
        ]),
        'feedly-export/boards/Pottery.json': JSON.stringify({
          id: 'user/u1/tag/Pottery',
          label: 'Pottery',
          items: [entry(2), entry(3)],
        }),
        // Everything read: not what was saved, unless Feedly says so.
        'feedly-export/read.json': JSON.stringify([entry(4), entry(5, { tags: [{ id: SAVED }] })]),
        'feedly-export/profile.json': JSON.stringify({ id: 'u1', email: 'x@y.test' }),
      },
      true,
    );
    const out = await readFeedlyExport(Object.assign(zip, { name: 'feedly.zip' }));
    expect(out.opml).toContain('design.test/feed.xml');
    expect(out.entries.map((e) => [e.url, e.tags])).toEqual([
      ['https://design.test/a1', []],
      ['https://design.test/a2', ['Kiln', 'Pottery']],
      ['https://design.test/a3', ['Pottery']],
      ['https://design.test/a5', []],
    ]);
  });

  it('reads one JSON file on its own, and an OPML file as before', async () => {
    const json = new Blob([JSON.stringify({ items: [entry(1)] })]);
    const one = await readFeedlyExport(Object.assign(json, { name: 'Saved For Later.json' }));
    expect(one.entries.map((e) => e.url)).toEqual(['https://design.test/a1']);
    expect(one.opml).toBeUndefined();
    const opml = await readFeedlyExport(Object.assign(new Blob([OPML]), { name: 'f.opml' }));
    expect(opml).toEqual({ opml: OPML, entries: [] });
  });
});
