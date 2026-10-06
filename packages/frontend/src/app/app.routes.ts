import { Routes } from '@angular/router';
import { Launch } from './launch/launch';

export const routes: Routes = [
  // Eager, not lazy: launch must never wait on a chunk (DESIGN.md, Editor).
  { path: '', component: Launch },
  { path: 'browse', loadComponent: () => import('./browse/browse').then((m) => m.Browse) },
  {
    path: 'right-now',
    loadComponent: () => import('./reminders/right-now').then((m) => m.RightNow),
  },
  { path: 'history', loadComponent: () => import('./history/history').then((m) => m.History) },
  { path: 'settings', loadComponent: () => import('./settings/settings').then((m) => m.Settings) },
  {
    path: 'dev-sign-in',
    loadComponent: () => import('./dev-sign-in/dev-sign-in').then((m) => m.DevSignIn),
  },
  { path: '**', redirectTo: '' },
];
