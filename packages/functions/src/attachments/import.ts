// Saving a link to read later (#48): the page is fetched by a function,
// never the browser (other sites forbid that), and kept as text beside
// the record; a link to a PDF becomes that PDF, whose text the upload
// trigger then reads. Over small interfaces, so it runs in specs.
import { BlockList, isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { TEXT_METADATA } from './process';

/** The most a page or PDF may weigh, as for uploads. */
export const MAX_IMPORT_BYTES = 25 * 1024 * 1024;

export interface Fetched {
  contentType: string;
  bytes: Uint8Array;
}

/** Fetches a public http(s) URL, or throws a reason to show. */
export type PageFetcher = (url: string) => Promise<Fetched>;

export interface ImportStore {
  write(
    path: string,
    bytes: Uint8Array,
    contentType: string,
    metadata?: Record<string, string>,
  ): Promise<void>;
  /** Merges fields into the attachment's record. */
  update(uid: string, id: string, fields: Record<string, unknown>): Promise<void>;
}

/** What import looks at in a new record. */
export interface LinkRecord {
  kind?: unknown;
  url?: unknown;
  name?: unknown;
  textPath?: unknown;
  importError?: unknown;
}

export type ImportOutcome = 'page' | 'pdf' | 'failed' | 'skipped';

/** A file name Storage and the rules take, from a URL's last part. */
export function fileNameFrom(url: string): string {
  const last = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '');
  const clean = last.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|-+$/g, '');
  const base = clean || 'document';
  return /\.pdf$/i.test(base) ? base : `${base}.pdf`;
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : whole;
    }
    return ENTITIES[code.toLowerCase()] ?? whole;
  });
}

/** A page's title and readable text, from its HTML. */
export function pageText(html: string): { title: string; text: string } {
  const title = decode(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  const body = html
    .replace(/<(script|style|noscript|template|svg|head)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article|\/blockquote)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  const text = decode(body)
    .split('\n')
    .map((l) => l.replace(/[ \t\r\f\v]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
  return { title, text };
}

/**
 * Imports a new link record: a PDF is stored as the attachment's file
 * (kind pdf), a page as its title and text. Anything else, or a fetch
 * that fails, is said in `importError`; the link itself stays.
 */
export async function importLink(
  store: ImportStore,
  fetchPage: PageFetcher,
  uid: string,
  id: string,
  record: LinkRecord,
): Promise<ImportOutcome> {
  if (record.kind !== 'link' || typeof record.url !== 'string') return 'skipped';
  if (record.textPath !== undefined || record.importError !== undefined) return 'skipped';
  const url = record.url;
  const name = typeof record.name === 'string' ? record.name.trim() : '';
  const named = name && name !== url;
  try {
    const page = await fetchPage(url);
    const head = new TextDecoder().decode(page.bytes.slice(0, 5));
    if (head === '%PDF-') {
      const file = fileNameFrom(url);
      const path = `users/${uid}/attachments/${id}/${file}`;
      // Unmarked, so the upload trigger checks it and reads its text.
      await store.write(path, page.bytes, 'application/pdf');
      await store.update(uid, id, {
        kind: 'pdf',
        path,
        contentType: 'application/pdf',
        size: page.bytes.length,
        ...(named ? {} : { name: file }),
      });
      return 'pdf';
    }
    if (!/^text\/html|^application\/xhtml\+xml|^text\/plain/i.test(page.contentType)) {
      await store.update(uid, id, { importError: `not a page or a PDF (${page.contentType})` });
      return 'failed';
    }
    const raw = new TextDecoder().decode(page.bytes);
    const { title, text } = /^text\/plain/i.test(page.contentType)
      ? { title: '', text: raw }
      : pageText(raw);
    const textPath = `users/${uid}/attachments/${id}/text_page.txt`;
    await store.write(
      textPath,
      new TextEncoder().encode(text),
      'text/plain; charset=utf-8',
      TEXT_METADATA,
    );
    await store.update(uid, id, { textPath, ...(named || !title ? {} : { name: title }) });
    return 'page';
  } catch (err) {
    await store.update(uid, id, { importError: err instanceof Error ? err.message : String(err) });
    return 'failed';
  }
}

/** Addresses a fetch must never reach: this machine, its network, metadata. */
const PRIVATE = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 3],
] as const) {
  PRIVATE.addSubnet(net, bits, 'ipv4');
}
for (const [net, bits] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  PRIVATE.addSubnet(net, bits, 'ipv6');
}

/** Whether an address is one a fetch may reach. */
export function isPublicAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  if (mapped) return isPublicAddress(mapped);
  const family = isIP(address);
  if (family === 0) return false;
  return !PRIVATE.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

/**
 * The real fetcher: http(s) only, every hop's host resolved and checked
 * public (no metadata server, no private network), at most five
 * redirects, 15 seconds and MAX_IMPORT_BYTES.
 */
export const publicFetch: PageFetcher = async (start) => {
  let url = new URL(start);
  for (let hop = 0; hop <= 5; hop++) {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('only http and https links can be saved');
    }
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
    if (!addresses.length || !addresses.every((a) => isPublicAddress(a.address))) {
      throw new Error(`${url.hostname} is not a public address`);
    }
    const res = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
      headers: { 'user-agent': 'Mossgoblin/1 (saving a link to read later)' },
    });
    if (res.status >= 300 && res.status < 400) {
      const next = res.headers.get('location');
      if (!next) throw new Error(`a redirect with nowhere to go (${res.status})`);
      url = new URL(next, url);
      continue;
    }
    if (!res.ok) throw new Error(`the page answered ${res.status}`);
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > MAX_IMPORT_BYTES) throw new Error('the page is over 25 MB');
    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_IMPORT_BYTES) {
        await reader.cancel();
        throw new Error('the page is over 25 MB');
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const c of chunks) {
      bytes.set(c, at);
      at += c.length;
    }
    return { contentType: res.headers.get('content-type') ?? '', bytes };
  }
  throw new Error('too many redirects');
};
