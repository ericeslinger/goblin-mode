#!/usr/bin/env bash
# Builds the functions bundle and deploys it.
#
#   scripts/deploy-functions.sh --dry-run            (part of npm run gate)
#   scripts/deploy-functions.sh --project <id>       (real deploy)
#
# It is a script rather than config because the dry run must reproduce
# what the cloud builder does: stage the bundle with only its manifest,
# `npm install --omit=dev`, then import it and check the exports. That
# proves workspace code (@mossgoblin/schema) was inlined and every runtime
# dependency is declared, which the repo's hoisted node_modules would
# otherwise hide.
set -euo pipefail
cd "$(dirname "$0")/.."

dry_run=false
project=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) dry_run=true ;;
    --project) project="${2:?--project needs a value}"; shift ;;
    *) echo "error: unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done
if ! $dry_run && [ -z "$project" ]; then
  echo "error: a real deploy needs --project <id> (or use --dry-run)" >&2
  exit 2
fi

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

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
mkdir -p "$stage/lib"
cp "$bundle" "$stage/lib/"
cp "$manifest" "$stage/package.json"
(cd "$stage" && npm install --omit=dev --no-audit --no-fund --loglevel=error >/dev/null)
# A storage trigger reads its default bucket from FIREBASE_CONFIG when
# it loads, as the deploy provides; a placeholder stands in here.
(cd "$stage" && FIREBASE_CONFIG='{"projectId":"demo-dry-run","storageBucket":"demo-dry-run.appspot.com"}' node -e "
  const fns = require('./lib/index.js');
  const names = Object.keys(fns);
  if (names.length === 0) { console.error('error: bundle exports no functions'); process.exit(1); }
  console.log('functions bundle ok: ' + names.join(', '));
")

if $dry_run; then
  exit 0
fi

# Keep 7 days of function container images in Artifact Registry. Without
# a policy, a non-interactive deploy deploys the functions and then exits
# 1 asking for one. setpolicy --force only creates or updates the policy;
# it is not `deploy --force`, which would also delete functions that
# vanished from the code without asking.
# Every region with functions: us-central1, and the Storage trigger's
# region (STORAGE_REGION, the bucket's) when it differs.
region="us-central1"
regions="$region"
if [ -n "${STORAGE_REGION:-}" ] && [ "$STORAGE_REGION" != "$region" ]; then
  regions="$regions $STORAGE_REGION"
fi
setpolicies() {
  for r in $regions; do
    # A region's repository exists only after its first deploy; until
    # then this says so and does nothing.
    npx firebase functions:artifacts:setpolicy --project "$project" --location "$r" \
      --days 7 --force
  done
}
setpolicies

log="$(mktemp)"
if ! npx firebase deploy --only functions --non-interactive --project "$project" 2>&1 | tee "$log"; then
  # The first deploy to a new region deploys, then stops for the policy
  # its new repository lacks: set it now and carry on (2026-10-08).
  if grep -q "Functions successfully deployed but could not set up cleanup policy" "$log"; then
    setpolicies
  else
    exit 1
  fi
fi
