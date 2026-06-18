#!/usr/bin/env bash
# Deploy warehouse-queue ON A FRESH SERVER straight from GitHub.
#
# Copy just this one file to the server and run it; it clones the rest:
#   scp deploy/bootstrap.sh user@server:/tmp/
#   ssh user@server 'bash /tmp/bootstrap.sh'
#
# Requires Docker + 'docker compose' on the server, ports 80/443 open, and the
# domain's DNS A/AAAA record already pointing at this server.
set -euo pipefail

echo "== warehouse-queue server bootstrap =="

# --- prerequisites ---
command -v docker >/dev/null || { echo "ERROR: Docker is not installed."; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "ERROR: 'docker compose' (v2) is required."; exit 1; }
command -v git >/dev/null || { echo "ERROR: git is not installed."; exit 1; }

# --- inputs ---
read -r -p "GitHub repo (owner/name) [e.g. yourname/warehouse-queue]: " SLUG
[ -n "$SLUG" ] || { echo "ERROR: repo is required"; exit 1; }
read -r -s -p "GitHub token (repo + read:packages; for private clone & image pull): " GH_TOKEN; echo
read -r -p "Install path [/opt/warehouse-queue]: " DEPLOY_PATH; DEPLOY_PATH="${DEPLOY_PATH:-/opt/warehouse-queue}"
read -r -p "Domain (DNS must already resolve here): " DOMAIN
read -r -p "Email for Let's Encrypt: " CERTBOT_EMAIL
read -r -s -p "PostgreSQL password to set: " POSTGRES_PASSWORD; echo

OWNER="${SLUG%%/*}"
SLUG_LC="$(echo "$SLUG" | tr '[:upper:]' '[:lower:]')"
APP_IMAGE="ghcr.io/${SLUG_LC}:latest"
SESSION_SECRET="$(openssl rand -hex 32 2>/dev/null || head -c32 /dev/urandom | xxd -p | tr -d '\n')"

# --- clone or update ---
if [ -d "$DEPLOY_PATH/.git" ]; then
  echo "==> Updating existing checkout in $DEPLOY_PATH"
  git -C "$DEPLOY_PATH" pull --ff-only
else
  echo "==> Cloning $SLUG into $DEPLOY_PATH"
  if [ ! -d "$DEPLOY_PATH" ]; then
    sudo mkdir -p "$DEPLOY_PATH" 2>/dev/null || mkdir -p "$DEPLOY_PATH"
    sudo chown "$(id -u):$(id -g)" "$DEPLOY_PATH" 2>/dev/null || true
  fi
  if [ -n "$GH_TOKEN" ]; then
    git clone "https://${OWNER}:${GH_TOKEN}@github.com/${SLUG}.git" "$DEPLOY_PATH"
    # Don't leave the token embedded in the remote URL.
    git -C "$DEPLOY_PATH" remote set-url origin "https://github.com/${SLUG}.git"
  else
    git clone "https://github.com/${SLUG}.git" "$DEPLOY_PATH"
  fi
fi

cd "$DEPLOY_PATH"

# --- GHCR login (for image pull + Watchtower) ---
if [ -n "$GH_TOKEN" ]; then
  echo "==> Logging in to GHCR"
  echo "$GH_TOKEN" | docker login ghcr.io -u "$OWNER" --password-stdin
fi
DOCKER_CONFIG_JSON="${HOME}/.docker/config.json"

# --- write .env ---
echo "==> Writing .env"
cat > .env <<EOF
DOMAIN=$DOMAIN
CERTBOT_EMAIL=$CERTBOT_EMAIL
SESSION_SECRET=$SESSION_SECRET
POSTGRES_DB=warehouse
POSTGRES_USER=warehouse
POSTGRES_PASSWORD=$POSTGRES_PASSWORD
APP_IMAGE=$APP_IMAGE
DOCKER_CONFIG_JSON=$DOCKER_CONFIG_JSON
EOF

# --- build initial image (CI image may not exist yet), issue TLS, start ---
echo "==> Building the app image locally for the first start"
docker compose build app

echo "==> Issuing TLS certificate for $DOMAIN"
chmod +x deploy/init-letsencrypt.sh
./deploy/init-letsencrypt.sh

echo "==> Starting the full stack"
docker compose up -d

echo
echo "Done. Site: https://$DOMAIN/manager.html  (login admin / admin123 — change it!)"
echo "Auto-update: Watchtower will pull new images from $APP_IMAGE and redeploy the app."
