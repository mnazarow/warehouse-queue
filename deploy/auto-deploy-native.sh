#!/usr/bin/env bash
# Native (no-Docker) auto-deploy: pull latest main, reinstall deps if they
# changed, restart the systemd service. Invoked by the timer from
# install-native.sh; safe to run by hand.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/warehouse-queue}"
APP_USER="${APP_USER:-warehouse}"
BRANCH="${BRANCH:-main}"
SERVICE="${SERVICE:-warehouse-queue}"
cd "$APP_DIR"

git fetch --quiet origin "$BRANCH"
BEFORE="$(git rev-parse HEAD)"
AFTER="$(git rev-parse "origin/$BRANCH")"

if [ "$BEFORE" = "$AFTER" ]; then
  echo "$(date -Is) up to date ($BEFORE)"
  exit 0
fi

echo "$(date -Is) new commit $AFTER — deploying"
git pull --ff-only origin "$BRANCH"

# Reinstall dependencies only when they changed (rebuilds better-sqlite3).
if git diff --name-only "$BEFORE" "$AFTER" | grep -qE '(^|/)package(-lock)?\.json$'; then
  echo "$(date -Is) dependencies changed — npm ci"
  sudo -u "$APP_USER" -H npm --prefix "$APP_DIR" ci --omit=dev
fi

systemctl restart "$SERVICE"
echo "$(date -Is) deploy complete"
