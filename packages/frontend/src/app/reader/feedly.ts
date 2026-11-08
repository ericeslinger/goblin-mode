// Feedly's full export (#176), read on the device: a zip holding the
// OPML of the feeds followed and JSON files of entries, the read-later
// saves and one per board. The file names differ between export
// versions, so this goes by what a file holds: an `.opml` is the
// feeds, and a JSON file is read when it is a list of entries (or an
// object holding one under `items` or `entries`), an entry being an
// object with an `id` and a web link (`alternate[0].href`,
// `canonicalUrl` or `originId`). Boards become tags (Eric,
// 2026-11-07). Pure; no library: the zip is read here, stored and
// deflated entries, through the browser's DecompressionStream.
import { cleanTags, isWebLink } from '@mossgoblin/schema';

/** One saved article, as the app sends it to `importFeedlySaves`. */
export interface FeedlyEntry {
  url: string;
  title: string;
  /** The feed it came from (`origin.streamId`, `feed/<url>`). */
  feedUrl?: string;
  /** The feed's own id for it (`originId`). */
  guid?: string;
  /** Milliseconds. */
  published?: number;
  author?: string;
  html?: string;
  tags: string[];
}

export interface FeedlyExport {
  /** The OPML's text, when the file holds one. */
  opml?: string;
  entries: FeedlyEntry[];
  /** Files in the zip left unread for their size (review on #199). */
  tooLarge?: number;
}

/**
 * The zip's bounds (review on #199): a Feedly export of tens of
 * megabytes is a few dozen files, so anything far past these is no
 * export, or one built to fill the device's memory.
 */
export const ZIP_FILES_MAX = 5000;
export const ZIP_FILE_BYTES_MAX = 64 * 1024 * 1024;
export const ZIP_TOTAL_BYTES_MAX = 256 * 1024 * 1024;
/** What a deflated file may come to past the size it declares. */
const INFLATE_SLACK = 64 * 1024;

/** A zip, or a file in one, past the bounds; its message is for the gardener. */
export class ZipTooLarge extends Error {}

/** An entry's HTML past this is cut on the device: the server keeps less. */
export const ENTRY_HTML_MAX = 100_000;

interface ZipFile {
  name: string;
  /** The size it says it unpacks to, in bytes. */
  size: number;
  /** Its bytes; throws ZipTooLarge past its declared size or the bound for one file. */
  read(): Promise<Uint8Array>;
}

const u16 = (v: DataView, at: number) => v.getUint16(at, true);
const u32 = (v: DataView, at: number) => v.getUint32(at, true);

/** The bytes inflated, stopping with ZipTooLarge once past `limit`. */
async function inflate(bytes: Uint8Array, limit: number, name: string): Promise<Uint8Array> {
  const stream = new DecompressionStream('deflate-raw');
  const writer = stream.writable.getWriter();
  // A damaged stream fails the read below; the write's own failure is the same one.
  void writer
    .write(bytes as Uint8Array<ArrayBuffer>)
    .then(() => writer.close())
    .catch(() => undefined);
  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    length += value.length;
    if (length > limit) {
      void reader.cancel().catch(() => undefined);
      throw new ZipTooLarge(`${name} unpacks to more than it says`);
    }
  }
  const out = new Uint8Array(length);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/**
 * The files in a zip, by its central directory: names, and a reader
 * for each that is stored or deflated (any other method throws when
 * read). No ZIP64 and no encryption: a Feedly export needs neither.
 */
export function unzip(buffer: ArrayBuffer): ZipFile[] {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  // The end-of-central-directory record: within the last 64 KB and 22 bytes.
  let end = -1;
  for (let at = buffer.byteLength - 22; at >= Math.max(0, buffer.byteLength - 65_557); at--) {
    if (u32(view, at) === 0x06054b50) {
      end = at;
      break;
    }
  }
  if (end < 0) throw new Error('not a zip file');
  const count = u16(view, end + 10);
  if (count > ZIP_FILES_MAX) {
    throw new ZipTooLarge(
      `That zip holds ${count.toLocaleString('en-US')} files, more than the ${ZIP_FILES_MAX.toLocaleString('en-US')} a Feedly export could; it was not read.`,
    );
  }
  let at = u32(view, end + 16);
  const names = new TextDecoder();
  const files: ZipFile[] = [];
  for (let n = 0; n < count; n++) {
    if (u32(view, at) !== 0x02014b50) throw new Error('the zip directory is damaged');
    const method = u16(view, at + 10);
    const size = u32(view, at + 20);
    const unpacked = u32(view, at + 24);
    const nameLength = u16(view, at + 28);
    const extra = u16(view, at + 30);
    const comment = u16(view, at + 32);
    const local = u32(view, at + 42);
    const name = names.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    at += 46 + nameLength + extra + comment;
    if (name.endsWith('/')) continue;
    files.push({
      name,
      size: unpacked,
      read: async () => {
        if (unpacked > ZIP_FILE_BYTES_MAX) throw new ZipTooLarge(`${name} is too large`);
        if (u32(view, local) !== 0x04034b50) throw new Error(`${name}: damaged`);
        const start = local + 30 + u16(view, local + 26) + u16(view, local + 28);
        const data = bytes.subarray(start, start + size);
        if (method === 0) {
          if (data.length > unpacked + INFLATE_SLACK) {
            throw new ZipTooLarge(`${name} is larger than it says`);
          }
          return data;
        }
        if (method === 8)
          return inflate(data, Math.min(unpacked + INFLATE_SLACK, ZIP_FILE_BYTES_MAX), name);
        throw new Error(`${name}: compressed in a way this cannot read`);
      },
    });
  }
  return files;
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

/** The entry's web link: its alternate, its canonical link, or its origin id when that is one. */
function linkOf(e: Json): string {
  const alternate = Array.isArray(e['alternate']) ? e['alternate'] : [];
  const candidates = [
    ...alternate.map((a) => (isObject(a) ? text(a['href']) : '')),
    text(e['canonicalUrl']),
    ...(Array.isArray(e['canonical'])
      ? e['canonical'].map((c) => (isObject(c) ? text(c['href']) : ''))
      : []),
    text(e['originId']),
    text(e['url']),
  ];
  return candidates.find((c) => c && isWebLink(c)) ?? '';
}

/** Whether a value looks like a Feedly entry: an object with an id and a web link. */
function isEntry(v: unknown): v is Json {
  return isObject(v) && (!!text(v['id']) || !!text(v['originId'])) && !!linkOf(v);
}

/** The entries a JSON file holds, and the board's own name when it gives one. */
function entriesIn(data: unknown): { list: Json[]; label?: string; board?: boolean } | undefined {
  const list = Array.isArray(data)
    ? data
    : isObject(data)
      ? [data['items'], data['entries']].find(Array.isArray)
      : undefined;
  if (!list || !list.length || !list.some(isEntry)) return undefined;
  // A board's stream says so by its id (`user/…/tag/Pottery`), as the API's does.
  const tag = isObject(data) ? /\/tag\/(?!global\.)(.+)$/.exec(text(data['id']))?.[1] : undefined;
  const label = isObject(data)
    ? text(data['label']) || (tag ? text(data['title']) || tagName(tag) : '')
    : '';
  return {
    list: list.filter(isEntry),
    ...(label ? { label } : {}),
    ...(tag ? { board: true } : {}),
  };
}

function tagName(tail: string): string {
  try {
    return decodeURIComponent(tail);
  } catch {
    return tail;
  }
}

/**
 * Feedly's labels on an entry, as tags: its `tags` (boards are tags in
 * Feedly) by label, or by the name at the end of the tag's id. Feedly's
 * own (`global.saved`, `global.read` and the like) are left out, and so
 * are `categories`, which are the feed's collections: the OPML's
 * folders already say that.
 */
export function entryTags(e: Json): string[] {
  const tags = Array.isArray(e['tags']) ? e['tags'] : [];
  return cleanTags(
    tags.map((t) => {
      if (typeof t === 'string') return /global\./.test(t) ? '' : t;
      if (!isObject(t)) return '';
      const id = text(t['id']);
      if (/\/(tag|category)\/global\./.test(id) || /^global\./.test(id)) return '';
      const label = text(t['label']);
      if (label) return label;
      const tail = /\/tag\/(.+)$/.exec(id)?.[1];
      return tail ? tagName(tail) : '';
    }),
  );
}

function when(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v < 1e11 ? v * 1000 : v;
  if (typeof v === 'string' && v) {
    const ms = Date.parse(v);
    return Number.isNaN(ms) ? undefined : ms;
  }
  return undefined;
}

/** One Feedly entry as the app sends it. */
export function toEntry(e: Json, board?: string): FeedlyEntry {
  const url = linkOf(e);
  const origin = isObject(e['origin']) ? e['origin'] : {};
  const stream = text(origin['streamId']);
  const feedUrl = stream.startsWith('feed/') ? stream.slice(5) : '';
  const originId = text(e['originId']);
  const published = when(e['published']) ?? when(e['crawled']);
  const author = text(e['author']);
  const content = isObject(e['content']) ? text(e['content']['content']) : '';
  const summary = isObject(e['summary']) ? text(e['summary']['content']) : '';
  const html = (content || summary).slice(0, ENTRY_HTML_MAX);
  return {
    url,
    title: text(e['title']),
    ...(isWebLink(feedUrl) ? { feedUrl } : {}),
    ...(originId ? { guid: originId } : {}),
    ...(published ? { published } : {}),
    ...(author ? { author } : {}),
    ...(html ? { html } : {}),
    tags: cleanTags([...(board ? [board] : []), ...entryTags(e)]),
  };
}

/**
 * A board's name from its file's, when the file is a board's: in a
 * `boards` folder (`boards/Pottery.json` is Pottery), or named for one
 * (`board-Pottery.json`).
 */
function boardName(path: string): string | undefined {
  const parts = path.split('/');
  const base = (parts.pop() ?? '').replace(/\.json$/i, '');
  const inBoards = parts.some((p) => /^boards?$/i.test(p));
  const named = /^boards?[-_ ]+(.+)$/i.exec(base)?.[1];
  const name = (named ?? (inBoards ? base : '')).trim();
  return name || undefined;
}

/** Whether a file of entries is the read-later saves, by its name. */
const isSaves = (path: string) => /saved|read[-_ ]?later/i.test(path.split('/').pop() ?? '');

/**
 * Reads entries out of one JSON file. A board's entries carry its name
 * as a tag; the saves file's are all kept; any other file's entries are
 * kept only when Feedly marked them saved or put them on a board, so a
 * file of everything read is not taken for what was saved.
 */
function fromJson(path: string, data: unknown): FeedlyEntry[] {
  const found = entriesIn(data);
  if (!found) return [];
  const named = boardName(path);
  const board = named || found.board ? found.label || named : undefined;
  const saves = !board && isSaves(path);
  return found.list
    .filter(
      (e) =>
        board ||
        saves ||
        (Array.isArray(e['tags']) &&
          e['tags'].some((t) =>
            /global\.saved|\/tag\/(?!global\.)/.test(isObject(t) ? text(t['id']) : ''),
          )),
    )
    .map((e) => toEntry(e, board));
}

/** The same article from the saves and from a board is one, with both tags. */
function merge(entries: FeedlyEntry[]): FeedlyEntry[] {
  const byUrl = new Map<string, FeedlyEntry>();
  for (const e of entries) {
    const had = byUrl.get(e.url);
    if (had) byUrl.set(e.url, { ...e, ...had, tags: cleanTags([...had.tags, ...e.tags]) });
    else byUrl.set(e.url, e);
  }
  return [...byUrl.values()];
}

const isZip = (b: Uint8Array) => b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;

/**
 * What a chosen file holds: Feedly's full export (a zip), one of its
 * JSON files on its own, or an OPML file as before.
 */
export async function readFeedlyExport(file: Blob & { name?: string }): Promise<FeedlyExport> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const decoder = new TextDecoder();
  if (!isZip(bytes)) {
    const body = decoder.decode(bytes);
    if (/^\s*[[{]/.test(body))
      return { entries: merge(fromJson(file.name ?? '', JSON.parse(body))) };
    return { opml: body, entries: [] };
  }
  let opml: string | undefined;
  const entries: FeedlyEntry[] = [];
  let total = 0;
  let tooLarge = 0;
  // A file past a bound is skipped and counted, not the whole import.
  const read = async (f: ZipFile): Promise<string | undefined> => {
    if (f.size > ZIP_FILE_BYTES_MAX || total + f.size > ZIP_TOTAL_BYTES_MAX) {
      tooLarge++;
      return undefined;
    }
    try {
      const out = await f.read();
      total += out.length;
      return decoder.decode(out);
    } catch (err) {
      if (!(err instanceof ZipTooLarge)) throw err;
      tooLarge++;
      return undefined;
    }
  };
  for (const f of unzip(buffer)) {
    if (/(^|\/)(__MACOSX|\.)/.test(f.name)) continue;
    if (/\.opml$/i.test(f.name) || (/\.xml$/i.test(f.name) && !opml)) {
      const body = await read(f);
      if (body && /<opml\b/i.test(body)) opml = body;
    } else if (/\.json$/i.test(f.name)) {
      const body = await read(f);
      if (body === undefined) continue;
      let data: unknown;
      try {
        data = JSON.parse(body);
      } catch {
        continue;
      }
      entries.push(...fromJson(f.name, data));
    }
  }
  return {
    ...(opml ? { opml } : {}),
    entries: merge(entries),
    ...(tooLarge ? { tooLarge } : {}),
  };
}
