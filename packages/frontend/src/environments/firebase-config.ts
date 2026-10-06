import type { FirebaseOptions } from 'firebase/app';

/** Project id the emulator suite runs as; `demo-` means no real resources. */
export const EMULATOR_PROJECT_ID = 'demo-mossgoblin';

// Supplied by the deploy, never committed: scripts/deploy.sh passes them
// with `ng build --define` from the GitHub variables FIREBASE_WEB_CONFIG
// and WEB_PUSH_PUBLIC_KEY (README, Run your own). Local and e2e builds
// leave them null; localhost always uses the emulators anyway.
declare const DEPLOY_FIREBASE_CONFIG: FirebaseOptions | null;
declare const DEPLOY_WEB_PUSH_KEY: string | null;

/**
 * The production Firebase web config. Not secret: every browser that
 * loads the app gets it; the rules are what protect the data.
 */
export const PRODUCTION_FIREBASE_CONFIG: FirebaseOptions | null = DEPLOY_FIREBASE_CONFIG;

/**
 * The public key of the project's Web Push certificate (Firebase console:
 * Project settings, Cloud Messaging, Web Push certificates). Public by
 * design. Without it, Settings says notifications are not set up yet.
 */
export const PRODUCTION_VAPID_KEY: string | null = DEPLOY_WEB_PUSH_KEY;
