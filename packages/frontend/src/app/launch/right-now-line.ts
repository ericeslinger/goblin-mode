/**
 * Right Now as one line under a saved note on a phone (Eric,
 * 2026-11-15, #287): how many are due and the first one's words, e.g.
 * "2 due · Pick up glazed mugs". With nothing due, what is new in the
 * Reader and Podcasts, as Home's row says it; with nothing at all, the
 * panel's own "Nothing to tend". It always opens to the full panel.
 */
export function rightNowLine(due: readonly string[], readerNew = 0, podcastsNew = 0): string {
  if (due.length) return `${due.length} due · ${due[0]}`;
  const fresh = [
    ...(readerNew ? [`${readerNew} new in the Reader`] : []),
    ...(podcastsNew ? [`${podcastsNew} new in Podcasts`] : []),
  ];
  return ['Right Now', ...(fresh.length ? fresh : ['Nothing to tend'])].join(' · ');
}
