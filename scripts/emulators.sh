#!/usr/bin/env bash
# Starts the dev emulator suite (firebase.json ports) for `ng serve`.
# Proxy variables are unset for the same reason as in scripts/e2e.sh.
set -euo pipefail
cd "$(dirname "$0")/.."
node scripts/build-functions.mjs
exec env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy \
  npx firebase emulators:start --only auth,firestore,functions
