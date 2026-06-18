#!/usr/bin/env bash
# Native install with PostgreSQL as the DEFAULT backend (no Docker).
# Runs the standard native install, then migrates the schema + seed data into
# PostgreSQL and switches the app to it, so it runs on PG out of the box.
#
# On a clean Ubuntu/Debian server, as root:
#   curl -fsSL https://raw.githubusercontent.com/mnazarow/warehouse-queue/main/deploy/install-native-pg.sh -o install-native-pg.sh
#   sudo bash install-native-pg.sh
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/warehouse-queue}"
SERVICE="${SERVICE:-warehouse-queue}"
ENV_FILE="${ENV_FILE:-/etc/warehouse-queue.env}"
ADMIN_USER="${ADMIN_USER:-admin}"
ADMIN_PASS="${ADMIN_PASS:-admin123}"

if [ "$(id -u)" -ne 0 ]; then echo "Please run as root:  sudo bash install-native-pg.sh"; exit 1; fi

# 1. Run the standard native install (installs everything, app starts on SQLite).
DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd || echo /tmp)"
if [ -f "$DIR/install-native.sh" ]; then
  bash "$DIR/install-native.sh"
else
  curl -fsSL https://raw.githubusercontent.com/mnazarow/warehouse-queue/main/deploy/install-native.sh -o /tmp/install-native.sh
  bash /tmp/install-native.sh
fi

# 2. Determine the local app URL.
PORT="$(grep -E '^PORT=' "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2-)"; PORT="${PORT:-3000}"
APP_URL="http://127.0.0.1:$PORT"

echo "==> Waiting for the app to come up"
for i in $(seq 1 30); do
  curl -fsS "$APP_URL/api/warehouses" >/dev/null 2>&1 && break
  sleep 1
done

COOKIE="$(mktemp)"
trap 'rm -f "$COOKIE"' EXIT

echo "==> Logging in locally"
LOGIN="$(curl -fsS -c "$COOKIE" -H 'Content-Type: application/json' \
  -d "{\"username\":\"$ADMIN_USER\",\"password\":\"$ADMIN_PASS\"}" \
  "$APP_URL/api/manager/login" || true)"
echo "$LOGIN" | grep -q '"success":true' || {
  echo "ERROR: local login failed (admin password changed?). Set ADMIN_PASS and re-run, or switch to PostgreSQL from the UI."; exit 1; }

echo "==> Migrating schema + data into PostgreSQL"
MIG="$(curl -fsS -b "$COOKIE" -X POST "$APP_URL/api/manager/migrate/to-pgsql" || true)"
echo "    $MIG"
echo "$MIG" | grep -q '"success":true' || { echo "ERROR: migration failed. Check PostgreSQL settings/logs."; exit 1; }

echo "==> Switching active backend to PostgreSQL"
SW="$(curl -fsS -b "$COOKIE" -X POST "$APP_URL/api/manager/switch/to-pgsql" || true)"
echo "    $SW"
echo "$SW" | grep -q '"success":true' || { echo "ERROR: switch failed."; exit 1; }

echo "==> Restarting the service on PostgreSQL"
systemctl restart "$SERVICE"

DOMAIN="$(grep -E '^DOMAIN=' "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2-)"
echo
echo "Done. The app now runs on PostgreSQL by default."
echo "  Site: https://${DOMAIN:-<your-domain>}/manager.html (admin / admin123 — change it!)"
echo "  Verify backend: Настройки → PostgreSQL (active)."
