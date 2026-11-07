// The production stand-in for the feed fetcher: there is none. The
// emulator build (scripts/build-functions.mjs, MOSSGOBLIN_EMULATOR_BUILD)
// puts stand-in.emulator.ts in this module's place; the deploy dry run
// proves that one never reaches a production bundle.
import type { PageFetcher } from '../attachments/import';
import type { FeedFetcher } from './refresh';

/** Never a stand-in here: production fetches the real feed. */
export function standInFeedFetcher(_env: NodeJS.ProcessEnv): FeedFetcher | undefined {
  return undefined;
}

/** Never a stand-in here either: reader mode fetches the real page (#163). */
export function standInPageFetcher(_env: NodeJS.ProcessEnv): PageFetcher | undefined {
  return undefined;
}
