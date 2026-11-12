// EMULATOR_ONLY: the note keys master for localhost (note encryption
// step 2). Fixed and public, so notes sealed against the emulator can
// be read by any checkout; never a deployment's. Used by the functions
// emulator's stand-in (stand-in.emulator.ts) and by the e2e static
// server (scripts/serve-static.mjs), which stands in for the Worker's
// `/api/note-key`. Nothing in a production bundle imports it: the
// emulator build swaps stand-in.emulator.ts in, and the deploy dry run
// fails if the marker reaches the bundle.

/** SHA-256 of "mossgoblin emulator note keys master, never a real one", base64. */
export const DEV_NOTE_KEYS_MASTER = 'ClxnhK/bRBf18Gc5ZcW7nPOcxQqDsf34f/vksG70OOs=';
