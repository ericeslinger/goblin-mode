// Emulator ports for e2e journeys (firebase.e2e.json and, since
// 2026-11-15, the extra stacks scripts/e2e.sh starts for parallel
// journeys). Stack n serves the app on 4300 + n and its emulators on the
// base ports plus 10 n (packages/e2e/src/stack.ts); the page finds its
// stack from the port it was served on. Only the e2e build has this
// file, and it still always means the emulators.
const APP_PORT = 4300;
const STACKS = 8;
const STRIDE = 10;

function stackOf(port: string | undefined): number {
  const n = Number(port) - APP_PORT;
  return Number.isInteger(n) && n >= 0 && n < STACKS ? n : 0;
}

const offset = STRIDE * stackOf(globalThis.location?.port);

export const EMULATOR_PORTS = {
  auth: 9199 + offset,
  firestore: 8180 + offset,
  functions: 5101 + offset,
  storage: 9198 + offset,
};
