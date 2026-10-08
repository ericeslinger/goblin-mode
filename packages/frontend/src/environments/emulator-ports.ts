// Emulator ports for `ng serve` and the dev emulator suite (firebase.json).
// The e2e build swaps in emulator-ports.e2e.ts so both can run at once.
export const EMULATOR_PORTS = { auth: 9099, firestore: 8080, functions: 5001, storage: 9098 };
