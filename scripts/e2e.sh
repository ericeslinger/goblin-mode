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
#
# Parallel journeys (2026-11-15): one full stack (the four emulators and
# the static server) per Playwright worker, E2E_WORKERS of them (default
# 2; E2E_WORKERS=1 runs serially). Stack n serves the app on 4300 + n
# and its emulators on firebase.e2e.json's ports plus 10 n
# (packages/e2e/src/stack.ts); stack 0 is firebase.e2e.json itself.
# Two, because memory, not CPU, is the limit on the 15 GB cloud
# container: each stack's functions emulator keeps a Node process of
# about 115 MB for every function it has run, and three stacks ran the
# container out of memory (DESIGN.md, Delivery, 2026-11-15).
set -euo pipefail
cd "$(dirname "$0")/.."

WORKERS="${E2E_WORKERS:-2}"
if ! [[ "$WORKERS" =~ ^[1-8]$ ]]; then
  echo "error: E2E_WORKERS must be 1 to 8" >&2
  exit 1
fi
export E2E_WORKERS="$WORKERS"

# Stack 0's emulators, for the rules and functions-emulator specs.
export FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9199
export FIRESTORE_EMULATOR_HOST=127.0.0.1:8180
export FIREBASE_STORAGE_EMULATOR_HOST=127.0.0.1:9198
LOG_DIR="${TMPDIR:-/tmp}/mossgoblin-e2e"
mkdir -p "$LOG_DIR"

# The ports a stack's journeys reach, then the emulator suite's own
# (hub, logging, Firestore websocket, Eventarc, Cloud Tasks).
stack_ports() {
  local o=$((10 * $1))
  echo $((4300 + $1)) $((9199 + o)) $((8180 + o)) $((5101 + o)) $((9198 + o)) \
    $((4400 + o)) $((4500 + o)) $((9150 + o)) $((9299 + o)) $((9499 + o))
}

# The functions emulator reads .env.local over any other .env file: the
# journeys' owner (packages/e2e/src/personas.ts) is the MCP owner here.
# Every param is given too: a suite that finds one missing writes its
# default into this file, and with several stacks starting at once the
# others then fail to load any function (seen 2026-11-15).
functions_env=packages/functions/.env.local
printf 'OWNER_UID=e2e-owner\nSTORAGE_REGION=us-central1\n' > "$functions_env"

pids=()
cleanup() {
  for pid in "${pids[@]}"; do
    kill -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
  done
  rm -f "$functions_env" firebase.e2e-[1-9].json
}
trap cleanup EXIT

port_in_use() {
  (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null
}

for stack in $(seq 0 $((WORKERS - 1))); do
  for port in $(stack_ports "$stack"); do
    if port_in_use "$port"; then
      echo "error: port $port is already in use; is another e2e run (or a stray emulator) up?" >&2
      exit 1
    fi
  done
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
MOSSGOBLIN_EMULATOR_BUILD=1 node scripts/build-functions.mjs

# Stack n > 0 gets its own copy of firebase.e2e.json with every port
# moved by 10 n. firebase-tools reads a config only from the project
# root, so the copies live there until cleanup.
stack_config() {
  local n=$1
  if [ "$n" = 0 ]; then echo firebase.e2e.json; return; fi
  node -e '
    const fs = require("node:fs");
    const n = Number(process.argv[1]);
    const c = JSON.parse(fs.readFileSync("firebase.e2e.json", "utf8"));
    const e = c.emulators;
    const o = 10 * n;
    for (const k of ["auth", "firestore", "functions", "storage"]) e[k].port += o;
    e.firestore.websocketPort = 9150 + o;
    e.hub = { port: 4400 + o };
    e.logging = { port: 4500 + o };
    e.eventarc = { port: 9299 + o };
    e.tasks = { port: 9499 + o };
    fs.writeFileSync(`firebase.e2e-${n}.json`, JSON.stringify(c, null, 2));
  ' "$n"
  echo "firebase.e2e-$n.json"
}

for stack in $(seq 0 $((WORKERS - 1))); do
  read -r app _ _ functions _ < <(stack_ports "$stack")
  config=$(stack_config "$stack")
  # Each suite writes its hub locator (hub-<project>.json) to TMPDIR,
  # which would otherwise be shared by every stack.
  tmp="$LOG_DIR/tmp-$stack"
  mkdir -p "$tmp"
  suffix=$([ "$stack" = 0 ] || echo "-$stack")
  # firebase-tools sends emulator-to-emulator calls through HTTPS_PROXY
  # and ignores NO_PROXY, so start each suite with every proxy variable
  # unset, in its own process group so it can be stopped cleanly.
  setsid env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy TMPDIR="$tmp" \
    npx firebase emulators:start --config "$config" --only auth,firestore,functions,storage \
    > "$LOG_DIR/emulators$suffix.log" 2>&1 &
  pids+=($!)

  setsid env FUNCTIONS_EMULATOR_BASE="http://127.0.0.1:$functions/demo-mossgoblin/us-central1" \
    node scripts/serve-static.mjs "$PWD/packages/frontend/dist/frontend/browser" "$app" \
    > "$LOG_DIR/serve$suffix.log" 2>&1 &
  pids+=($!)
done

for stack in $(seq 0 $((WORKERS - 1))); do
  read -r app auth firestore functions storage _ < <(stack_ports "$stack")
  wait_for_port "$auth" "auth emulator (stack $stack)"
  wait_for_port "$firestore" "firestore emulator (stack $stack)"
  wait_for_port "$functions" "functions emulator (stack $stack)"
  wait_for_port "$storage" "storage emulator (stack $stack)"
  wait_for_port "$app" "static server (stack $stack)"
done

# An open functions port is not loaded functions: wait until each
# stack's health function answers, and stop if its suite says the
# definitions failed to load (they then never will).
wait_for_functions() {
  local stack=$1 port=$2 log=$3
  for _ in $(seq 1 120); do
    if curl -sf --noproxy '*' -o /dev/null "http://127.0.0.1:$port/demo-mossgoblin/us-central1/health"; then
      return 0
    fi
    if grep -q "Failed to load function definition" "$log"; then
      echo "error: stack $stack's functions did not load (see $log)" >&2
      exit 1
    fi
    sleep 1
  done
  echo "error: stack $stack's functions did not answer on :$port (see $log)" >&2
  exit 1
}
for stack in $(seq 0 $((WORKERS - 1))); do
  read -r _ _ _ functions _ < <(stack_ports "$stack")
  suffix=$([ "$stack" = 0 ] || echo "-$stack")
  wait_for_functions "$stack" "$functions" "$LOG_DIR/emulators$suffix.log"
done

# The specs run against stack 0 before any journey starts: they clear
# its emulators as they go.
npx vitest run --project rules --project functions-emulator
npx playwright test -c packages/e2e/playwright.config.ts "$@"
