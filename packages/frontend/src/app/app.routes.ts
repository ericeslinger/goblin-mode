import { Routes } from '@angular/router';
import { Launch } from './launch/launch';

export const routes: Routes = [
  // Eager, not lazy: launch must never wait on a chunk (DESIGN.md, Editor).
  { path: '', component: Launch },
  { path: 'settings', loadComponent: () => import('./settings/settings').then((m) => m.Settings) },
  {
    path: 'dev-sign-in',
    loadComponent: () => import('./dev-sign-in/dev-sign-in').then((m) => m.DevSignIn),
  },
  { path: '**', redirectTo: '' },
];
