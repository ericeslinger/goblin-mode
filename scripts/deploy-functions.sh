#!/usr/bin/env bash
# Builds the functions bundle and deploys it. With --dry-run (part of
# gate) it stops after checking the bundle is exactly what would ship.
set -euo pipefail
cd "$(dirname "$0")/.."

manifest=packages/functions/package.json
# The deploy runs `npm install --omit=dev` against this manifest, and npm
# still resolves peers of devDependencies there and crashes ("reading
# 'edgesOut'"). Build tools belong in the root package.json.
if node -e "process.exit(require('./$manifest').devDependencies ? 0 : 1)"; then
  echo "error: $manifest must not declare devDependencies (see CLAUDE.md)" >&2
  exit 1
fi

node scripts/build-functions.mjs

bundle=packages/functions/lib/index.js
if grep -q "EMULATOR_ONLY" "$bundle"; then
  echo "error: emulator-only code reached the production bundle" >&2
  exit 1
fi

# The bundle must load and export its triggers with only runtime deps.
node -e "
  const fns = require('./$bundle');
  const names = Object.keys(fns);
  if (names.length === 0) { console.error('error: bundle exports no functions'); process.exit(1); }
  console.log('functions bundle ok: ' + names.join(', '));
"

if [ "${1:-}" = "--dry-run" ]; then
  exit 0
fi

npx firebase deploy --only functions --non-interactive "$@"
