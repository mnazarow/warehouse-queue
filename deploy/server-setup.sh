#!/usr/bin/env bash
# Full setup of warehouse-queue on a CLEAN server (Ubuntu/Debian) from the
# public GitHub repo, plus automatic deployment of future changes.
#
# On the server (as root):
#   curl -fsSL https://raw.githubusercontent.com/mnazarow/warehouse-queue/main/deploy/server-setup.sh -o server-setup.sh
#   sudo bash server-setup.sh
#
# What it does:
#   1. installs Docker + compose plugin (if missing)
#   2. clones the repo to /opt/warehouse-queue
#   3. asks for domain / email / DB password and writes .env
#   4. builds the image, issues a Let's Encrypt certificate, starts the stack
#   5. installs a systemd timer that polls GitHub and redeploys on new commits
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/mnazarow/warehouse-queue.git}"
BRANCH="${BRANCH:-main}"
DEPLOY_PATH="${DEPLOY_PATH:-/opt/warehouse-queue}"
POLL_INTERVAL="${POLL_INTERVAL:-3min}"   # how often to check GitHub

if [ "$(id -u)" -ne 0 ]; then
  echo "Please run as root:  sudo bash server-setup.sh"; exit 1
fi

echo "== warehouse-queue: clean-server setup =="

# 1. Docker --------------------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  echo "==> Installing Docker (get.docker.com)"
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "ERROR: 'docker compose' plugin not available. Install Docker Compose v2."; exit 1
fi
command -v git >/dev/null 2>&1 || { apt-get update -y && apt-get install -y git; }

# 2. Clone / update ------------------------------------------------------------
if [ -d "$DEPLOY_PATH/.git" ]; then
  echo "==> Updating existing checkout in $DEPLOY_PATH"
  git -C "$DEPLOY_PATH" pull --ff-only origin "$BRANCH"
else
  echo "==> Cloning $REPO_URL into $DEPLOY_PATH"
  mkdir -p "$DEPLOY_PATH"
  git clone --branch "$BRANCH" "$REPO_URL" "$DEPLOY_PATH"
fi
cd "$DEPLOY_PATH"

# 3. .env ----------------------------------------------------------------------
if [ -f .env ]; then
  echo "==> .env already exists — keeping it"
  DOMAIN="$(grep -E '^DOMAIN=' .env | head -1 | cut -d= -f2-)"
else
  read -r -p "Domain (DNS A/AAAA must already point to this server): " DOMAIN
  read -r -p "Email for Let's Encrypt: " CERTBOT_EMAIL
  read -r -s -p "PostgreSQL password to set: " POSTGRES_PASSWORD; echo
  SESSION_SECRET="$(openssl rand -hex 32 2>/dev/null || head -c32 /dev/urandom | xxd -p | tr -d '\n')"
  cat > .env <<EOF
DOMAIN=$DOMAIN
CERTBOT_EMAIL=$CERTBOT_EMAIL
SESSION_SECRET=$SESSION_SECRET
POSTGRES_DB=warehouse
POSTGRES_USER=warehouse
POSTGRES_PASSWORD=$POSTGRES_PASSWORD
EOF
  echo "==> .env written"
fi

# 4. Build + TLS + start -------------------------------------------------------
echo "==> Building the app image"
docker compose build

if [ ! -f .tls_initialized ]; then
  echo "==> Issuing TLS certificate for $DOMAIN (DNS must resolve here)"
  chmod +x deploy/init-letsencrypt.sh
  ./deploy/init-letsencrypt.sh
  touch .tls_initialized
else
  echo "==> TLS already initialized — skipping certificate issuance"
fi

echo "==> Starting the stack"
docker compose up -d

# 5. Auto-deploy systemd timer -------------------------------------------------
echo "==> Installing auto-deploy timer (poll every $POLL_INTERVAL)"
chmod +x deploy/auto-deploy.sh

cat > /etc/systemd/system/warehouse-queue-deploy.service <<EOF
[Unit]
Description=warehouse-queue auto-deploy from GitHub
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
Environment=DEPLOY_PATH=$DEPLOY_PATH
Environment=BRANCH=$BRANCH
ExecStart=$DEPLOY_PATH/deploy/auto-deploy.sh
EOF

cat > /etc/systemd/system/warehouse-queue-deploy.timer <<EOF
[Unit]
Description=Poll GitHub for warehouse-queue changes

[Timer]
OnBootSec=2min
OnUnitActiveSec=$POLL_INTERVAL
Persistent=true

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now warehouse-queue-deploy.timer

echo
echo "All done."
echo "  Site:        https://$DOMAIN/manager.html   (login admin / admin123 — change it!)"
echo "  Auto-deploy: every $POLL_INTERVAL the server checks $REPO_URL ($BRANCH) and rebuilds on new commits."
echo "  Status:      systemctl list-timers warehouse-queue-deploy.timer"
echo "  Logs:        journalctl -u warehouse-queue-deploy.service -f"
echo "  Deploy now:  systemctl start warehouse-queue-deploy.service"
