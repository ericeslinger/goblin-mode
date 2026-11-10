import { UNCATEGORIZED, folderList } from '@mossgoblin/schema';
import type { ItemRecord } from '../reader/items.service';
import type { FeedRecord } from '../reader/reader.service';

/**
 * A show as the Shows grid and the folder view draw it (#246): its
 * feed, how many of its episodes are at hand and how many of those are
 * unheard (not `played`), its newest episode's date, and its artwork.
 * Counted from the episodes loaded, each show's newest hundred, never
 * from the feed's whole archive.
 */
export interface ShowSummary {
  feed: FeedRecord;
  episodes: number;
  unheard: number;
  /** Milliseconds: the newest episode at hand, else the fetcher's newest item, else 0. */
  newest: number;
  /** The feed's own image, else its newest episode's that has one. */
  art?: string;
}

/** The folder of the shows in none (#246), as the folder view and the chips name it. */
export const NO_FOLDER = UNCATEGORIZED;
export const NO_FOLDER_NAME = 'Not in a folder';

/** A folder's name as shown: "Not in a folder" for the shows in none. */
export const folderName = (name: string) => (name === NO_FOLDER ? NO_FOLDER_NAME : name);

/**
 * The shows, newest episode first (#246), each with its counts and its
 * artwork; shows with nothing yet go last, by name.
 */
export function showSummaries(
  feeds: readonly FeedRecord[],
  episodes: readonly ItemRecord[],
): ShowSummary[] {
  const byShow = new Map<string, ItemRecord[]>();
  for (const e of episodes) byShow.set(e.feedId, [...(byShow.get(e.feedId) ?? []), e]);
  return feeds
    .map((feed) => {
      const own = [...(byShow.get(feed.id) ?? [])].sort((a, b) => b.published - a.published);
      const art = feed.image ?? own.find((e) => e.image)?.image;
      return {
        feed,
        episodes: own.length,
        unheard: own.filter((e) => !e.played).length,
        newest: own[0]?.published ?? feed.lastItemAt ?? 0,
        ...(art ? { art } : {}),
      };
    })
    .sort(
      (a, b) =>
        b.newest - a.newest ||
        a.feed.title.localeCompare(b.feed.title, undefined, { sensitivity: 'base' }),
    );
}

/** Whether a show is in a folder; `NO_FOLDER` holds the shows in none. */
export function inFolder(show: ShowSummary, folder: string): boolean {
  return folder === NO_FOLDER ? show.feed.folders.length === 0 : show.feed.folders.includes(folder);
}

/** One folder of shows (#246): its name, its shows newest first, and their unheard episodes. */
export interface ShowFolder {
  name: string;
  shows: ShowSummary[];
  unheard: number;
}

/**
 * The shows by folder (#246), as the Reader files its feeds (a feed's
 * `folders`, #159): the folders by name, "Not in a folder" last; a show
 * in two folders is in both. Each folder's shows keep the grid's order.
 */
export function showFolders(shows: readonly ShowSummary[]): ShowFolder[] {
  const rank = new Map(shows.map((s, n) => [s.feed.id, n]));
  const byId = new Map(shows.map((s) => [s.feed.id, s]));
  return folderList(shows.map((s) => s.feed)).map(({ name, feeds }) => {
    const own = feeds
      .map((f) => byId.get(f.id)!)
      .sort((a, b) => rank.get(a.feed.id)! - rank.get(b.feed.id)!);
    return { name, shows: own, unheard: own.reduce((n, s) => n + s.unheard, 0) };
  });
}

/** "4 shows · 9 unheard", for a folder's heading. */
export function folderLine(folder: ShowFolder): string {
  const n = folder.shows.length;
  return `${n} ${n === 1 ? 'show' : 'shows'} · ${folder.unheard} unheard`;
}
