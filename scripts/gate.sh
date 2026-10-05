#!/usr/bin/env bash
# Must pass before every commit: typechecks (specs included), prettier,
# the frontend build, unit tests, and the functions and Worker deploy dry
# runs. See CLAUDE.md, Gates.
set -euo pipefail
cd "$(dirname "$0")/.."

step() { printf '\n== %s\n' "$1"; }

step typecheck
npm run typecheck
step format
npm run format:check
step "build frontend"
npm run build -w packages/frontend
step "unit tests"
npm run test:unit
step "functions deploy dry run"
bash scripts/deploy-functions.sh --dry-run
step "worker dry run"
npx wrangler deploy --dry-run --config infra/worker/wrangler.toml --outdir "${TMPDIR:-/tmp}/goblin-worker-dry"

printf '\ngate: green\n'
