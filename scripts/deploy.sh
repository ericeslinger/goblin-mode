#!/usr/bin/env bash
# Builds and deploys everything: Firestore and Storage rules, functions,
# and the Worker with the PWA. Used by .github/workflows/deploy.yml; can
# also run from a laptop with the same environment.
#
# Everything specific to one deployment comes from the environment (the
# workflow maps GitHub variables and secrets onto it); nothing about a
# deployment is committed. README, Run your own, lists them.
#
# Required:
#   FIREBASE_PROJECT_ID     the Firebase project
#   FIREBASE_WEB_CONFIG     the web app's config, as JSON
#   APP_DOMAIN              the domain the Worker serves, e.g. notes.example.com
#   CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID
#   Google credentials for firebase-tools (GOOGLE_APPLICATION_CREDENTIALS)
# Optional (the feature stays off without them):
#   WEB_PUSH_PUBLIC_KEY     notifications
#   OWNER_UID               the MCP server's one allowed account (step 7)
#   ANTHROPIC_FEDERATION_RULE_ID, ANTHROPIC_ORGANIZATION_ID,
#   ANTHROPIC_SERVICE_ACCOUNT_ID, ANTHROPIC_WORKSPACE_ID   Claude titles
set -euo pipefail
cd "$(dirname "$0")/.."

: "${FIREBASE_PROJECT_ID:?set FIREBASE_PROJECT_ID}"
: "${FIREBASE_WEB_CONFIG:?set FIREBASE_WEB_CONFIG (the web app config JSON)}"
: "${APP_DOMAIN:?set APP_DOMAIN}"
: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN}"

# Fail here, not in every browser: the config must parse and name this project.
node -e '
  const c = JSON.parse(process.env.FIREBASE_WEB_CONFIG);
  if (c.projectId !== process.env.FIREBASE_PROJECT_ID) {
    console.error(`error: FIREBASE_WEB_CONFIG is for ${c.projectId}, not ${process.env.FIREBASE_PROJECT_ID}`);
    process.exit(1);
  }
  // Photos (#44) upload to the default bucket; without it every upload
  // fails and photos wait on the device forever.
  if (!c.storageBucket) {
    console.error("error: FIREBASE_WEB_CONFIG has no storageBucket (Project settings, Your apps)");
    process.exit(1);
  }'
web_config="$(node -e 'process.stdout.write(JSON.stringify(JSON.parse(process.env.FIREBASE_WEB_CONFIG)))')"
push_key="$(node -e 'process.stdout.write(JSON.stringify(process.env.WEB_PUSH_PUBLIC_KEY || null))')"

sha="$(git rev-parse --short HEAD)"
time="$(date -u +%Y-%m-%dT%H:%MZ)"
region="us-central1"

npm run build -w packages/frontend -- \
  --define "BUILD_SHA=\"$sha\"" --define "BUILD_TIME=\"$time\"" \
  --define "DEPLOY_FIREBASE_CONFIG=$web_config" --define "DEPLOY_WEB_PUSH_KEY=$push_key"

npx firebase deploy --project "$FIREBASE_PROJECT_ID" --non-interactive \
  --only firestore:rules,firestore:indexes,storage

# Functions read their settings from .env.<project> in their source
# directory, which the Firebase CLI deploys as environment variables.
# Written here from the environment, removed afterwards, never committed.
functions_env="packages/functions/.env.$FIREBASE_PROJECT_ID"
trap 'rm -f "$functions_env"' EXIT
: > "$functions_env"
for name in OWNER_UID ANTHROPIC_FEDERATION_RULE_ID ANTHROPIC_ORGANIZATION_ID \
  ANTHROPIC_SERVICE_ACCOUNT_ID ANTHROPIC_WORKSPACE_ID STORAGE_REGION; do
  if [ -n "${!name:-}" ]; then printf '%s=%s\n' "$name" "${!name}" >> "$functions_env"; fi
done
bash scripts/deploy-functions.sh --project "$FIREBASE_PROJECT_ID"

npx wrangler deploy --config infra/worker/wrangler.toml --domain "$APP_DOMAIN" \
  --var "FUNCTIONS_ORIGIN:https://$region-$FIREBASE_PROJECT_ID.cloudfunctions.net"

echo "deployed $sha"
