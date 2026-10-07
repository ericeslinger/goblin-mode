import { type Routes, type UrlMatchResult, type UrlSegment } from '@angular/router';
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
  { matcher: launchMatcher, component: Launch },
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
    path: 'map/n/:id',
    loadComponent: () => import('./map/neighborhood-map').then((m) => m.NeighborhoodMap),
  },
  { path: 'history', loadComponent: () => import('./history/history').then((m) => m.History) },
  {
    path: 'oauth/authorize',
    loadComponent: () => import('./claude/authorize').then((m) => m.Authorize),
  },
  { path: 'settings', loadComponent: () => import('./settings/settings').then((m) => m.Settings) },
  {
    path: 'dev-sign-in',
    loadComponent: () => import('./dev-sign-in/dev-sign-in').then((m) => m.DevSignIn),
  },
  // A path this version does not know may be one a newer version does.
  { path: '**', component: UnknownRoute },
];
