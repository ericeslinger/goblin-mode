import { inject } from '@angular/core';
import { type CanActivateFn, Router, type Routes } from '@angular/router';
import { OLD_ANCHORS, SETTINGS_PAGES } from './settings-pages';
import { Settings } from './settings';

/** `/settings#downloads` and the rest, from before #290: on to the section's page. */
export const oldAnchorGuard: CanActivateFn = (route) => {
  const page = route.fragment ? OLD_ANCHORS[route.fragment] : undefined;
  return page ? inject(Router).createUrlTree(['/settings', page]) : true;
};

/**
 * The pages under the Settings shell (#290): `/settings` is the list
 * (and, beside it on a wide screen, the first page), `/settings/<id>`
 * one page, and an id this version does not know the list.
 */
export const SETTINGS_ROUTES: Routes = [
  { path: '', pathMatch: 'full', canActivate: [oldAnchorGuard], component: Settings },
  ...SETTINGS_PAGES.map(({ id }) => ({ path: id, component: Settings, data: { page: id } })),
  { path: '**', redirectTo: '' },
];
