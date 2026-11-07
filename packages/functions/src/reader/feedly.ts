// Feedly's read-later saves and boards (#176), sent by the app from
// Feedly's full export in batches: each becomes a saved, read article,
// its boards its tags (Eric, 2026-11-07). Pure over a store; the
// callable in functions.ts counts the day's imports. The HTML is a
// page's words, so it goes through the same markdown as a feed's
// content, escaped (CLAUDE.md, page text), and no model reads it.
import {
  SAVES_FEED_ID,
  cleanTags,
  feedId,
  feedItemId,
  isWebLink,
  normalizeFeedUrl,
} from '@mossgoblin/schema';
import { decode } from '../attachments/import';
import { CONTENT_MAX, htmlToMarkdown, summaryOf } from './markdown';
import type { NewItem } from './refresh';
import { termsOf } from './terms';

/** Entries in one call; the app sends no more. */
export const IMPORT_BATCH = 100;
/** Articles added a day per gardener, counted in the usage record (`imports`). */
export const DAILY_IMPORTS = 5000;
/** An entry's HTML past this is cut before it is read: the content keeps 20k anyway. */
export const HTML_MAX = 100_000;

/** One saved article as the app sends it, already read out of the export. */
export interface SavedEntry {
  url: string;
  title: string;
  /** The feed it came from, sent only when the gardener follows it. */
  feedUrl?: string;
  /** The feed's own id for it (Feedly's `originId`), so a fetch later finds it known. */
  guid?: string;
  /** Milliseconds. */
  published?: number;
  author?: string;
  html?: string;
  tags: string[];
}

/** An article the import writes: a fetcher's item, saved and read, with tags. */
export interface SavedItem extends NewItem {
  tags: string[];
}

export interface SavesStore {
  /** The stored ones among these ids, with their tags. */
  existing(uid: string, ids: string[]): Promise<Map<string, string[]>>;
  /** Makes the Feedly saves feed if it is not there yet. */
  ensureSavesFeed(uid: string): Promise<void>;
  /** Writes new articles, saved and read. */
  write(uid: string, items: SavedItem[]): Promise<void>;
  /** Sets the tags of stored articles; nothing else on them changes. */
  setTags(uid: string, updates: { id: string; tags: string[] }[]): Promise<void>;
}

export interface SavesOutcome {
  added: number;
  known: number;
  /** Entries that were no article (no web link): left out. */
  skipped: number;
  /** The articles added, for the app to put the newest in the reading queue. */
  fresh: { id: string; link: string; published: number }[];
}

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : undefined);

/** A title or a name as plain words, as the feed parser keeps them. */
const plain = (value: string) =>
  decode(value.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();

/**
 * The call's entries, read defensively: anything that is no object or
 * has no web link is dropped (and counted), the rest cut to size.
 * Throws when there is no list or it is longer than a batch.
 */
export function readEntries(data: unknown): { entries: SavedEntry[]; skipped: number } {
  const raw = (data as { entries?: unknown } | null)?.entries;
  if (!Array.isArray(raw)) throw new Error('entries must be a list');
  if (raw.length > IMPORT_BATCH) throw new Error(`at most ${IMPORT_BATCH} entries a call`);
  const entries: SavedEntry[] = [];
  let skipped = 0;
  for (const e of raw as Record<string, unknown>[]) {
    const url = str(e?.['url'], 2000)?.trim();
    if (!url || !isWebLink(url)) {
      skipped++;
      continue;
    }
    const feedUrl = normalizeFeedUrl(str(e['feedUrl'], 2000) ?? '');
    const published = e['published'];
    entries.push({
      url,
      title: plain(str(e['title'], 1000) ?? ''),
      ...(feedUrl ? { feedUrl } : {}),
      ...(str(e['guid'], 2000)?.trim() ? { guid: str(e['guid'], 2000)!.trim() } : {}),
      ...(typeof published === 'number' && Number.isFinite(published) && published > 0
        ? { published }
        : {}),
      ...(str(e['author'], 200)?.trim() ? { author: plain(str(e['author'], 200)!) } : {}),
      ...(str(e['html'], HTML_MAX) ? { html: str(e['html'], HTML_MAX) } : {}),
      tags: cleanTags(Array.isArray(e['tags']) ? e['tags'] : []),
    });
  }
  return { entries, skipped };
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
};

/** Where an entry is filed: its feed's id and its item's, the fetcher's way. */
export function savedIds(entry: SavedEntry): { feedId: string; id: string } {
  if (entry.feedUrl) {
    const feed = feedId(entry.feedUrl);
    return { feedId: feed, id: feedItemId(feed, entry.guid || entry.url) };
  }
  return { feedId: SAVES_FEED_ID, id: feedItemId(SAVES_FEED_ID, entry.url) };
}

/**
 * Imports a batch: new articles written saved and read, with no
 * `expireAt` (saved ones are kept); stored ones left as they are but
 * for the tags they lack. Importing the same file twice is once.
 */
export async function importSaves(
  store: SavesStore,
  uid: string,
  entries: SavedEntry[],
  now: number,
): Promise<Omit<SavesOutcome, 'skipped'>> {
  // One entry an id: the export can list an article in the saves and in
  // a board, and the app merges those, but two links can still meet.
  const byId = new Map<string, { entry: SavedEntry; feedId: string }>();
  for (const entry of entries) {
    const { feedId: feed, id } = savedIds(entry);
    const had = byId.get(id);
    if (had) had.entry = { ...had.entry, tags: cleanTags([...had.entry.tags, ...entry.tags]) };
    else byId.set(id, { entry, feedId: feed });
  }
  const ids = [...byId.keys()];
  const stored = ids.length ? await store.existing(uid, ids) : new Map<string, string[]>();
  const fresh: SavedItem[] = [];
  const retag: { id: string; tags: string[] }[] = [];
  for (const [id, { entry, feedId: feed }] of byId) {
    const have = stored.get(id);
    if (have) {
      const tags = cleanTags([...have, ...entry.tags]);
      if (tags.length > have.length) retag.push({ id, tags });
      continue;
    }
    const content = htmlToMarkdown(entry.html ?? '', entry.url).slice(0, CONTENT_MAX + 3);
    const title = entry.title || hostOf(entry.url);
    fresh.push({
      id,
      feedId: feed,
      title,
      link: entry.url,
      ...(entry.author ? { author: entry.author } : {}),
      // A date ahead of now is a wrong clock; now is the best guess.
      published: Math.min(entry.published ?? now, now),
      summary: summaryOf(content),
      content,
      // The word index (#175), as the fetcher writes it, so search finds an imported save.
      terms: termsOf(title, content),
      tags: entry.tags,
    });
  }
  if (fresh.some((i) => i.feedId === SAVES_FEED_ID)) await store.ensureSavesFeed(uid);
  if (fresh.length) await store.write(uid, fresh);
  if (retag.length) await store.setTags(uid, retag);
  return {
    added: fresh.length,
    known: byId.size - fresh.length,
    fresh: fresh.map((i) => ({ id: i.id, link: i.link, published: i.published })),
  };
}
