#!/usr/bin/env bash
# Builds and deploys everything: Firestore and Storage rules, functions,
# and the Worker with the PWA. Used by .github/workflows/deploy.yml; can
# also run from a laptop with the same environment.
#
# Needs: FIREBASE_PROJECT_ID, Google credentials for firebase-tools
# (GOOGLE_APPLICATION_CREDENTIALS), CLOUDFLARE_API_TOKEN and
# CLOUDFLARE_ACCOUNT_ID.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${FIREBASE_PROJECT_ID:?set FIREBASE_PROJECT_ID}"
: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN}"

sha="$(git rev-parse --short HEAD)"
time="$(date -u +%Y-%m-%dT%H:%MZ)"
region="us-central1"

npm run build -w packages/frontend -- --define "BUILD_SHA=\"$sha\"" --define "BUILD_TIME=\"$time\""

npx firebase deploy --project "$FIREBASE_PROJECT_ID" --non-interactive \
  --only firestore:rules,firestore:indexes,storage
bash scripts/deploy-functions.sh --project "$FIREBASE_PROJECT_ID"

npx wrangler deploy --config infra/worker/wrangler.toml \
  --var "FUNCTIONS_ORIGIN:https://$region-$FIREBASE_PROJECT_ID.cloudfunctions.net"

echo "deployed $sha"
