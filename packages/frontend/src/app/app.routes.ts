import { type Routes, type UrlMatchResult, type UrlSegment } from '@angular/router';
import { startOnGuard } from './home/start-on';
import { Launch } from './launch/launch';
import { UnknownRoute } from './unknown-route';

/**
 * `/` (the capture note) and `/n/<id>` (any note) are one route, so
 * moving between them reuses the launch screen instead of rebuilding it.
 */
export function launchMatcher(segments: UrlSegment[]): UrlMatchResult | null {
  if (segments.length === 0) return { consumed: [] };
  if (segments.length === 2 && segments[0].path === 'n') {
    return { consumed: segments, posParams: { id: segments[1] } };
  }
  return null;
}

export const routes: Routes = [
  // Eager, not lazy: launch must never wait on a chunk (DESIGN.md, Editor).
  // A cold open of / goes where Start on says (#219); a new note unless chosen.
  { matcher: launchMatcher, component: Launch, canActivate: [startOnGuard] },
  { path: 'home', loadComponent: () => import('./home/home').then((m) => m.Home) },
  { path: 'browse', loadComponent: () => import('./browse/browse').then((m) => m.Browse) },
  {
    path: 'browse/:lens',
    loadComponent: () => import('./browse/browse').then((m) => m.Browse),
  },
  {
    path: 'right-now',
    loadComponent: () => import('./reminders/right-now').then((m) => m.RightNow),
  },
  {
    path: 'map',
    loadComponent: () => import('./map/garden-map').then((m) => m.GardenMap),
  },
  {
    path: 'map/timeline',
    data: { layout: 'timeline' },
    loadComponent: () => import('./map/garden-map').then((m) => m.GardenMap),
  },
  {
    path: 'map/n/:id',
    loadComponent: () => import('./map/neighborhood-map').then((m) => m.NeighborhoodMap),
  },
  {
    path: 'activity',
    loadComponent: () => import('./claude/activity').then((m) => m.Activity),
  },
  {
    path: 'reading',
    loadComponent: () => import('./reading/reading').then((m) => m.Reading),
  },
  { path: 'history', loadComponent: () => import('./history/history').then((m) => m.History) },
  {
    path: 'oauth/authorize',
    loadComponent: () => import('./claude/authorize').then((m) => m.Authorize),
  },
  { path: 'settings', loadComponent: () => import('./settings/settings').then((m) => m.Settings) },
  {
    path: 'kitchen',
    loadComponent: () => import('./kitchen/kitchen-week').then((m) => m.KitchenWeek),
  },
  // Kitchen's tabs (#220), before a day, which they are not.
  {
    path: 'kitchen/shopping',
    loadComponent: () => import('./kitchen/kitchen-shopping').then((m) => m.KitchenShopping),
  },
  {
    path: 'kitchen/recipes',
    loadComponent: () => import('./kitchen/kitchen-recipes').then((m) => m.KitchenRecipes),
  },
  {
    path: 'kitchen/pantry',
    loadComponent: () => import('./kitchen/kitchen-pantry').then((m) => m.KitchenPantry),
  },
  {
    path: 'kitchen/:day',
    loadComponent: () => import('./kitchen/kitchen-week').then((m) => m.KitchenWeek),
  },
  // The Reader opens on All (#220); its folders are a tab of their own.
  {
    path: 'reader',
    loadComponent: () => import('./reader/reader-list').then((m) => m.ReaderList),
  },
  {
    path: 'reader/folders',
    loadComponent: () => import('./reader/reader').then((m) => m.Reader),
  },
  {
    path: 'reader/feeds',
    loadComponent: () => import('./reader/reader-feeds').then((m) => m.ReaderFeeds),
  },
  {
    path: 'reader/downloads',
    loadComponent: () => import('./reader/reader-downloads').then((m) => m.ReaderDownloads),
  },
  {
    path: 'reader/f/:folder',
    loadComponent: () => import('./reader/reader-list').then((m) => m.ReaderList),
  },
  {
    path: 'reader/s/:feedId',
    loadComponent: () => import('./reader/reader-list').then((m) => m.ReaderList),
  },
  {
    path: 'reader/a/:id',
    loadComponent: () => import('./reader/reader-article').then((m) => m.ReaderArticle),
  },
  {
    path: 'reader/done',
    loadComponent: () => import('./reader/reader-done').then((m) => m.ReaderDone),
  },
  {
    path: 'dev-sign-in',
    loadComponent: () => import('./dev-sign-in/dev-sign-in').then((m) => m.DevSignIn),
  },
  // A path this version does not know may be one a newer version does.
  { path: '**', component: UnknownRoute },
];
