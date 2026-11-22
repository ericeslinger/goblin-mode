import { DestroyRef, Injectable, inject } from '@angular/core';
import { type CanMatchFn, Router, type UrlMatchResult, type UrlSegment } from '@angular/router';

/**
 * The width from which the Reader is panes (#289, part 3, 2026-11-16):
 * three from 1320 until 2026-11-22, the rail 176, the folders 192, the
 * list 352 and the article at 70 of its characters (560 px at 16 px)
 * with 16 px either side. Two since (Eric, 2026-11-22: "too many
 * columns"): the rail 176, the list 384 with the header over it, and
 * the article's 592 come to 1152; 1200 leaves the article 640, takes
 * in a 1280 laptop, and keeps an iPad on its side (1180, 1194) the
 * screens it was. Under it the Reader is those screens.
 */
export const READER_PANES_MIN = 1200;
export const READER_PANES_QUERY = `(min-width: ${READER_PANES_MIN}px)`;

/** Whether the window is wide enough for the panes now. */
export function panesFit(): boolean {
  return typeof matchMedia === 'function' && matchMedia(READER_PANES_QUERY).matches;
}

/**
 * The addresses the panes show, one route so moving between
 * them keeps the panes, and the list in them, as they were (as
 * `launchMatcher` does for the note screen): `/reader`,
 * `/reader/f/<folder>`, `/reader/s/<feedId>`, `/reader/a/<id>`,
 * `/reader/done` and, since 2026-11-22, `/reader/folders`, the folders
 * in the list pane.
 */
export function readerPanesMatcher(segments: UrlSegment[]): UrlMatchResult | null {
  if (segments[0]?.path !== 'reader') return null;
  if (segments.length === 1) return { consumed: segments };
  if (segments.length === 2 && ['done', 'folders'].includes(segments[1].path)) {
    return { consumed: segments };
  }
  if (segments.length !== 3) return null;
  const name = { f: 'folder', s: 'feedId', a: 'id' }[segments[1].path];
  return name ? { consumed: segments, posParams: { [name]: segments[2] } } : null;
}

/**
 * Takes a Reader address to the panes or back to its own screen when
 * the window crosses the width, since which route an address matches
 * is chosen as it is navigated to.
 */
@Injectable({ providedIn: 'root' })
export class PanesWidth {
  constructor() {
    const query = typeof matchMedia === 'function' ? matchMedia(READER_PANES_QUERY) : undefined;
    if (!query) return;
    const router = inject(Router);
    const onChange = () => {
      const url = router.parseUrl(router.url);
      const segments = url.root.children['primary']?.segments ?? [];
      if (!readerPanesMatcher(segments)) return;
      void router.navigateByUrl(url, { onSameUrlNavigation: 'reload', replaceUrl: true });
    };
    query.addEventListener?.('change', onChange);
    inject(DestroyRef).onDestroy(() => query.removeEventListener?.('change', onChange));
  }
}

/** The panes' route matches only from READER_PANES_MIN; under it the Reader's own routes do. */
export const panesWide: CanMatchFn = () => {
  inject(PanesWidth);
  return panesFit();
};
