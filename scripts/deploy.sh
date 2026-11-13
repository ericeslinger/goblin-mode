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
#   OWNER_UID               the MCP server's one allowed account (step 7),
#                           and the episode proxy's (#180)
#   ANTHROPIC_FEDERATION_RULE_ID, ANTHROPIC_ORGANIZATION_ID,
#   ANTHROPIC_SERVICE_ACCOUNT_ID, ANTHROPIC_WORKSPACE_ID   Claude titles
#   NOTE_KEY_CALLERS        the service accounts the Worker's note key
#                           service answers, comma-separated; derived
#                           below from the project when unset
# Never passed through here: the note key service's Worker secret
# NOTE_KEYS_MASTER is set once by hand (README, Run your own), so the
# master exists only at Cloudflare and in the owner's own backup.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${FIREBASE_PROJECT_ID:?set FIREBASE_PROJECT_ID}"
: "${FIREBASE_WEB_CONFIG:?set FIREBASE_WEB_CONFIG (the web app config JSON)}"
: "${APP_DOMAIN:?set APP_DOMAIN}"
: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN}"

# A Google region is like us-east1, with no hyphen before the number;
# a wrong one fails only at the functions step, after rules have shipped.
if [ -n "${STORAGE_REGION:-}" ] && ! [[ "$STORAGE_REGION" =~ ^[a-z]+-[a-z]+[0-9]+$ ]]; then
  echo "error: STORAGE_REGION '$STORAGE_REGION' is not a region name like us-east1" >&2
  exit 1
fi

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
# APP_DOMAIN tells the functions where the Worker's note key service is.
functions_env="packages/functions/.env.$FIREBASE_PROJECT_ID"
trap 'rm -f "$functions_env"' EXIT
: > "$functions_env"
for name in APP_DOMAIN OWNER_UID ANTHROPIC_FEDERATION_RULE_ID ANTHROPIC_ORGANIZATION_ID \
  ANTHROPIC_SERVICE_ACCOUNT_ID ANTHROPIC_WORKSPACE_ID STORAGE_REGION; do
  if [ -n "${!name:-}" ]; then printf '%s=%s\n' "$name" "${!name}" >> "$functions_env"; fi
done
bash scripts/deploy-functions.sh --project "$FIREBASE_PROJECT_ID"

# The service accounts the functions that read notes run as, which the
# Worker's note key service answers (DESIGN.md, Note encryption, Key
# custody, 2026-11-13): goblin-titles, goblin-runner, and the default
# compute account for the rest. The project number is in the web
# config twice (messagingSenderId, and the middle of appId); both must
# agree, or NOTE_KEY_CALLERS must be set, or the service stays off.
if [ -z "${NOTE_KEY_CALLERS:-}" ]; then
  number="$(node -e '
    const c = JSON.parse(process.env.FIREBASE_WEB_CONFIG);
    const n = String(c.messagingSenderId ?? "");
    if (/^[0-9]+$/.test(n) && String(c.appId ?? "").split(":")[1] === n) process.stdout.write(n);')"
  if [ -n "$number" ]; then
    NOTE_KEY_CALLERS="$number-compute@developer.gserviceaccount.com"
    for account in goblin-titles goblin-runner; do
      NOTE_KEY_CALLERS+=",$account@$FIREBASE_PROJECT_ID.iam.gserviceaccount.com"
    done
  else
    echo "warning: no project number in FIREBASE_WEB_CONFIG; note keys stay off for the functions" >&2
  fi
fi

# The project id and the owner's uid let the Worker check ID tokens for
# the episode proxy (#180); without OWNER_UID the proxy stays off (503).
# APP_DOMAIN fixes the audience the functions' identity tokens must
# name, and NOTE_KEY_CALLERS who may present one; without either the
# functions' note key route stays off (503).
worker_vars=(--var "FUNCTIONS_ORIGIN:https://$region-$FIREBASE_PROJECT_ID.cloudfunctions.net"
  --var "FIREBASE_PROJECT_ID:$FIREBASE_PROJECT_ID" --var "APP_DOMAIN:$APP_DOMAIN")
if [ -n "${OWNER_UID:-}" ]; then worker_vars+=(--var "OWNER_UID:$OWNER_UID"); fi
if [ -n "${NOTE_KEY_CALLERS:-}" ]; then
  worker_vars+=(--var "NOTE_KEY_CALLERS:$(printf '%s' "$NOTE_KEY_CALLERS" | tr -d '[:space:]')")
fi
npx wrangler deploy --config infra/worker/wrangler.toml --domain "$APP_DOMAIN" "${worker_vars[@]}"

echo "deployed $sha"
