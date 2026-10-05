import type { FirebaseOptions } from 'firebase/app';

/** Project id the emulator suite runs as; `demo-` means no real resources. */
export const EMULATOR_PROJECT_ID = 'demo-goblin-mode';

/**
 * The production Firebase web config, baked into the build (there is no
 * Firebase Hosting init.json). Filled in once the project exists; see
 * QUESTIONS.md.
 */
export const PRODUCTION_FIREBASE_CONFIG: FirebaseOptions | null = null;
