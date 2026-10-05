import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', loadComponent: () => import('./launch/launch').then((m) => m.Launch) },
  { path: 'settings', loadComponent: () => import('./settings/settings').then((m) => m.Settings) },
  {
    path: 'dev-sign-in',
    loadComponent: () => import('./dev-sign-in/dev-sign-in').then((m) => m.DevSignIn),
  },
  { path: '**', redirectTo: '' },
];
