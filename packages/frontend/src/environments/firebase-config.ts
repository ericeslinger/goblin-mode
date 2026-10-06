import type { FirebaseOptions } from 'firebase/app';

/** Project id the emulator suite runs as; `demo-` means no real resources. */
export const EMULATOR_PROJECT_ID = 'demo-goblin-mode';

/**
 * The production Firebase web config, baked into the build (there is no
 * Firebase Hosting init.json). Not secret: every browser that loads the
 * app gets it; the rules are what protect the data.
 */
export const PRODUCTION_FIREBASE_CONFIG: FirebaseOptions | null = {
  apiKey: 'AIzaSyCeU5pFODUAwkYQ0CkHpIfk1f8EQXi4d9w',
  authDomain: 'mossgoblin-garden.firebaseapp.com',
  projectId: 'mossgoblin-garden',
  storageBucket: 'mossgoblin-garden.firebasestorage.app',
  messagingSenderId: '579728131419',
  appId: '1:579728131419:web:a41bc4d18434855bcc067e',
};

/**
 * The public key of the project's Web Push certificate (Firebase console:
 * Project settings, Cloud Messaging, Web Push certificates). Public by
 * design, like the config above (set 2026-10-06). Without it, Settings
 * says notifications are not set up yet.
 */
export const PRODUCTION_VAPID_KEY: string | null =
  'BJkXc9JszShs5959cEA7j-2ZuAHPhh5S3huq8hJM0sZyhWwwMM8zJfvfmoep2MidX7UrtlhHYkZMro5P3xBo4nk';
