#!/usr/bin/env bash
# Builds the app for e2e, starts the e2e emulator suite, serves the app,
# runs the rules tests, the functions' Firestore tests and the
# Playwright journeys, and tears it all down.
# Playwright arguments pass through: npm run e2e -- --grep sign-in
#
# A script rather than Playwright webServer config, because readiness,
# proxy-free emulators and process-group teardown need orchestration.
# Isolated from the dev stack: its own ports (firebase.e2e.json), build
# and app port, so `npm run emulators` can keep running alongside.
set -euo pipefail
cd "$(dirname "$0")/.."

export FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9199
export FIRESTORE_EMULATOR_HOST=127.0.0.1:8180
export FIREBASE_STORAGE_EMULATOR_HOST=127.0.0.1:9198
APP_PORT=4300
LOG_DIR="${TMPDIR:-/tmp}/goblin-e2e"
mkdir -p "$LOG_DIR"

pids=()
cleanup() {
  for pid in "${pids[@]}"; do
    kill -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
  done
}
trap cleanup EXIT

port_in_use() {
  (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null
}

for port in 9199 8180 5101 9198 "$APP_PORT"; do
  if port_in_use "$port"; then
    echo "error: port $port is already in use; is another e2e run (or a stray emulator) up?" >&2
    exit 1
  fi
done

wait_for_port() {
  local port=$1 name=$2
  for _ in $(seq 1 120); do
    if port_in_use "$port"; then return 0; fi
    sleep 1
  done
  echo "error: $name did not come up on :$port (logs in $LOG_DIR)" >&2
  exit 1
}

npm run build -w packages/frontend -- -c production,e2e --define 'BUILD_SHA="e2e"' --define 'BUILD_TIME="e2e"'
node scripts/build-functions.mjs

# firebase-tools sends emulator-to-emulator calls through HTTPS_PROXY and
# ignores NO_PROXY, so start the suite with every proxy variable unset, in
# its own process group so it can be stopped cleanly.
setsid env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy \
  npx firebase emulators:start --config firebase.e2e.json --only auth,firestore,functions,storage \
  > "$LOG_DIR/emulators.log" 2>&1 &
pids+=($!)

setsid node scripts/serve-static.mjs "$PWD/packages/frontend/dist/frontend/browser" "$APP_PORT" \
  > "$LOG_DIR/serve.log" 2>&1 &
pids+=($!)

wait_for_port 9199 "auth emulator"
wait_for_port 8180 "firestore emulator"
wait_for_port 5101 "functions emulator"
wait_for_port 9198 "storage emulator"
wait_for_port "$APP_PORT" "static server"

npx vitest run --project rules --project functions-emulator
npx playwright test -c packages/e2e/playwright.config.ts "$@"
