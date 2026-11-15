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
import { CaptureService } from './capture/capture.service';
import { FIREBASE, initFirebase } from './firebase';
import { rememberModules } from './home/start-on';
import { LastPlaceService } from './launch/last-place.service';
import { NoteKeyService } from './notes/note-key.service';
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
    // Which modules are on, for Start on's next cold open (#219).
    provideEnvironmentInitializer(rememberModules),
    // The capture loop at boot, wherever a launch lands (#272): a draft
    // or a settle held from the last visit is written once the notes
    // load, on any screen, not only once the editor is opened.
    provideEnvironmentInitializer(() => void inject(CaptureService)),
    // The last place (#272), remembered from the first navigation on.
    provideEnvironmentInitializer(() => void inject(LastPlaceService)),
    // Refreshes this device's push token after each sign-in; never awaited.
    provideEnvironmentInitializer(() => void inject(PushService)),
    // Fetches the gardener's note key after sign-in, for sealed notes
    // (note encryption step 2); never awaited, never blocks.
    provideEnvironmentInitializer(() => void inject(NoteKeyService)),
  ],
};
