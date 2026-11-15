/**
 * Which emulator stack this Playwright worker drives (2026-11-15).
 * scripts/e2e.sh starts one full stack (emulators and static server)
 * per worker; stack n serves the app on 4300 + n and its emulators on
 * the base ports (firebase.e2e.json) plus 10 n, the same rule as the
 * e2e build's emulator-ports.e2e.ts. A worker keeps its parallel index
 * when it is replaced after a failure, so it stays on its own stack.
 */
export const STACK = Number(process.env['TEST_PARALLEL_INDEX'] ?? 0);

const offset = 10 * STACK;

export const APP_URL = `http://localhost:${4300 + STACK}`;
export const AUTH_EMULATOR = `127.0.0.1:${9199 + offset}`;
export const FIRESTORE_EMULATOR = `127.0.0.1:${8180 + offset}`;
export const STORAGE_EMULATOR = `127.0.0.1:${9198 + offset}`;
