import {
  ApplicationConfig,
  inject,
  isDevMode,
  provideBrowserGlobalErrorListeners,
  provideEnvironmentInitializer,
} from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideServiceWorker } from '@angular/service-worker';
import { routes } from './app.routes';
import { FIREBASE, initFirebase } from './firebase';
import { PushService } from './push/push.service';
import { ThemeSync } from './theme/theme-sync.service';
import { ThemeService } from './theme/theme.service';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes),
    { provide: FIREBASE, useFactory: () => initFirebase(location.hostname) },
    // sw.js takes shared files (#46), then loads Angular's ngsw-worker.js.
    provideServiceWorker('sw.js', {
      enabled: !isDevMode(),
      registrationStrategy: 'registerWhenStable:30000',
    }),
    // Paints the chosen theme before the first render.
    provideEnvironmentInitializer(() => void inject(ThemeService)),
    // Keeps it in the gardener's settings, across devices.
    provideEnvironmentInitializer(() => void inject(ThemeSync)),
    // Refreshes this device's push token after each sign-in; never awaited.
    provideEnvironmentInitializer(() => void inject(PushService)),
  ],
};
