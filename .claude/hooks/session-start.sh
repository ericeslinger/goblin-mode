#!/usr/bin/env bash
# Fixes a cloud Claude Code container so gate and e2e can run.
# Runs only in cloud sessions; idempotent. See CLAUDE.md, Cloud sessions.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

NODE_VERSION="22.22.3"
CACHE_DIR="$HOME/.cache/goblin-mode"
NODE_DIR="$CACHE_DIR/node-v$NODE_VERSION"
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
CA_BUNDLE="/root/.ccr/ca-bundle.crt"

env_line() {
  if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
    echo "$1" >> "$CLAUDE_ENV_FILE"
  fi
}

# 1. Node. The container's Node is below the Angular CLI minimum.
if [ ! -x "$NODE_DIR/bin/node" ]; then
  mkdir -p "$CACHE_DIR"
  tarball="node-v$NODE_VERSION-linux-x64.tar.xz"
  base="https://nodejs.org/dist/v$NODE_VERSION"
  tmp="$(mktemp -d)"
  curl -fsSL "$base/$tarball" -o "$tmp/$tarball"
  curl -fsSL "$base/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
  (cd "$tmp" && grep " $tarball\$" SHASUMS256.txt | sha256sum -c -)
  tar -xJf "$tmp/$tarball" -C "$CACHE_DIR"
  mv "$CACHE_DIR/node-v$NODE_VERSION-linux-x64" "$NODE_DIR"
  rm -rf "$tmp"
fi
export PATH="$NODE_DIR/bin:$PATH"
env_line "PATH=$NODE_DIR/bin:\$PATH"

# 2. Proxy CA, so ng build font inlining and firebase-tools can fetch.
if [ -f "$CA_BUNDLE" ]; then
  export NODE_EXTRA_CA_CERTS="$CA_BUNDLE"
  env_line "NODE_EXTRA_CA_CERTS=$CA_BUNDLE"
fi

# 3. Dependencies.
cd "$PROJECT_DIR"
if [ -f package-lock.json ]; then
  npm ci --no-audit --no-fund --loglevel=error
fi

# 4. Playwright browsers: link the preinstalled ones under the names the
# pinned @playwright/test expects. Never download.
browsers_json="node_modules/playwright-core/browsers.json"
pw_root="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}"
if [ -f "$browsers_json" ] && [ -d /opt/pw-browsers ]; then
  node -e '
    const b = require("./'"$browsers_json"'").browsers;
    for (const x of b) if (["chromium","chromium-headless-shell"].includes(x.name))
      console.log(x.name.replace(/-/g, "_") + "-" + x.revision);
  ' | while read -r wanted; do
    name="${wanted%-*}"
    target="$pw_root/$wanted"
    if [ ! -e "$target" ]; then
      have="$(ls -d /opt/pw-browsers/"$name"-* 2>/dev/null | head -1 || true)"
      if [ -n "$have" ]; then
        ln -s "$have" "$target" 2>/dev/null || true
      fi
    fi
    if [ -d "$target" ]; then
      touch "$target/INSTALLATION_COMPLETE" "$target/DEPENDENCIES_VALIDATED" 2>/dev/null || true
    fi
  done
fi
