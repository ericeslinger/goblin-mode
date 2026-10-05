import { InjectionToken } from '@angular/core';
import { FirebaseApp, FirebaseOptions, initializeApp } from 'firebase/app';
import { Auth, connectAuthEmulator, getAuth } from 'firebase/auth';
import {
  Firestore,
  connectFirestoreEmulator,
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
} from 'firebase/firestore';
import { EMULATOR_PORTS } from '../environments/emulator-ports';
import { EMULATOR_PROJECT_ID, PRODUCTION_FIREBASE_CONFIG } from '../environments/firebase-config';

export interface FirebaseHandles {
  app: FirebaseApp;
  auth: Auth;
  db: Firestore;
  usingEmulators: boolean;
}

export const FIREBASE = new InjectionToken<FirebaseHandles>('firebase');

/**
 * Localhost always means the emulator suite and anywhere else always means
 * the real project. There is deliberately no switch: see CLAUDE.md,
 * Invariants.
 */
export function isLocalHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

/** The Firebase config for the host the page was served from. */
export function configFor(hostname: string): FirebaseOptions {
  if (isLocalHost(hostname)) {
    return { projectId: EMULATOR_PROJECT_ID, apiKey: 'emulator-api-key', authDomain: hostname };
  }
  if (!PRODUCTION_FIREBASE_CONFIG) {
    throw new Error('No production Firebase config is set; see QUESTIONS.md.');
  }
  return PRODUCTION_FIREBASE_CONFIG;
}

export function initFirebase(hostname: string): FirebaseHandles {
  const usingEmulators = isLocalHost(hostname);
  const app = initializeApp(configFor(hostname));
  const auth = getAuth(app);
  // The persistent cache is what makes Goblin Mode offline-first: writes
  // land in IndexedDB at once and sync when the network is back.
  const db = initializeFirestore(app, {
    localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
  });
  if (usingEmulators) {
    connectAuthEmulator(auth, `http://127.0.0.1:${EMULATOR_PORTS.auth}`, {
      disableWarnings: true,
    });
    connectFirestoreEmulator(db, '127.0.0.1', EMULATOR_PORTS.firestore);
  }
  return { app, auth, db, usingEmulators };
}
