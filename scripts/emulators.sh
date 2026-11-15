#!/usr/bin/env bash
# Starts the dev emulator suite (firebase.json ports) for `ng serve`.
# Proxy variables are unset for the same reason as in scripts/e2e.sh.
#
# Beside it, the note key stand-in on 127.0.0.1:5099, which `ng serve`
# proxies `/api/note-key` to (packages/frontend/proxy.dev.json): note
# text is always sealed (2026-11-15), so without a key nothing typed on
# the dev server is saved. It goes when the emulators do.
set -euo pipefail
cd "$(dirname "$0")/.."
MOSSGOBLIN_EMULATOR_BUILD=1 node scripts/build-functions.mjs
node scripts/note-key-stand-in.mjs 5099 &
keys=$!
trap 'kill "$keys" 2>/dev/null || true' EXIT
env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy \
  npx firebase emulators:start --only auth,firestore,functions
