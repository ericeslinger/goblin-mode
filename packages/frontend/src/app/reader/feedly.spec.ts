import { type FeedlyEntry, entryTags, readFeedlyExport, toEntry, unzip } from './feedly';

/** The bytes of a stream through a CompressionStream, for the deflated entries. */
async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new CompressionStream('deflate-raw');
  const writer = stream.writable.getWriter();
  void writer.write(bytes as Uint8Array<ArrayBuffer>).then(() => writer.close());
  const reader = stream.readable.getReader();
  const parts: number[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(...value);
  }
  return new Uint8Array(parts);
}

/**
 * A small zip, as Feedly's export is one: each file stored, or deflated
 * when asked. The reader goes by the central directory and never checks
 * the CRC, so it is left 0 here.
 */
async function zipOf(files: Record<string, string>, deflated = false): Promise<Blob> {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const [name, body] of Object.entries(files)) {
    const nameBytes = enc.encode(name);
    const raw = enc.encode(body);
    const data = deflated ? await deflate(raw) : raw;
    const local = new Uint8Array(30 + nameBytes.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, deflated ? 8 : 0, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(data, 30 + nameBytes.length);
    const dir = new Uint8Array(46 + nameBytes.length);
    const dv = new DataView(dir.buffer);
    dv.setUint32(0, 0x02014b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(6, 20, true);
    dv.setUint16(10, deflated ? 8 : 0, true);
    dv.setUint32(20, data.length, true);
    dv.setUint32(24, raw.length, true);
    dv.setUint16(28, nameBytes.length, true);
    dv.setUint32(42, offset, true);
    dir.set(nameBytes, 46);
    locals.push(local);
    central.push(dir);
    offset += local.length;
  }
  const size = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, central.length, true);
  ev.setUint16(10, central.length, true);
  ev.setUint32(12, size, true);
  ev.setUint32(16, offset, true);
  return new Blob([...locals, ...central, end] as BlobPart[]);
}

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
