#!/usr/bin/env bash
# Auto-deploy: pull the latest main from GitHub and, if there are new commits,
# rebuild and restart the stack. Invoked by the systemd timer installed by
# server-setup.sh. Safe to run by hand too.
set -euo pipefail

DEPLOY_PATH="${DEPLOY_PATH:-/opt/warehouse-queue}"
BRANCH="${BRANCH:-main}"
cd "$DEPLOY_PATH"

git fetch --quiet origin "$BRANCH"
LOCAL="$(git rev-parse HEAD)"
REMOTE="$(git rev-parse "origin/$BRANCH")"

if [ "$LOCAL" = "$REMOTE" ]; then
  echo "$(date -Is) up to date ($LOCAL)"
  exit 0
fi

echo "$(date -Is) new commit $REMOTE — deploying"
git pull --ff-only origin "$BRANCH"
docker compose up -d --build
docker image prune -f
echo "$(date -Is) deploy complete"
