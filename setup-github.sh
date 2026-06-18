#!/usr/bin/env bash
# One-shot GitHub setup for warehouse-queue.
# Run this ON YOUR MAC (not inside Claude) from the project folder:
#
#   cd ~/path/to/warehouse-queue
#   chmod +x setup-github.sh
#   ./setup-github.sh
#
# It will: clean any partial .git, create a commit, create a GitHub repo and
# push, and (optionally) set the GitHub Actions secrets used by the auto-deploy
# workflow. Requires git and the GitHub CLI `gh` (https://cli.github.com).
set -euo pipefail

REPO_NAME="${REPO_NAME:-warehouse-queue}"
VISIBILITY="${VISIBILITY:-private}"   # private | public

cd "$(dirname "$0")"

echo "==> Checking prerequisites"
command -v git >/dev/null || { echo "ERROR: git is not installed."; exit 1; }
if ! command -v gh >/dev/null; then
  echo "ERROR: GitHub CLI 'gh' is not installed. Install it: https://cli.github.com"
  echo "       (macOS: brew install gh)"; exit 1
fi
if ! gh auth status >/dev/null 2>&1; then
  echo "==> You are not logged in to GitHub CLI. Launching login..."
  gh auth login
fi

echo "==> Preparing a clean git repository"
rm -rf .git
git init -q
git add -A
echo "    Files to be committed (must NOT include node_modules / warehouse.db / .env):"
git status --short | sed 's/^/      /'
if git ls-files | grep -Eq "node_modules/|warehouse\.db|(^|/)\.env$"; then
  echo "ERROR: something unwanted is staged. Check .gitignore."; exit 1
fi
git commit -q -m "warehouse-queue: initial commit"
git branch -M main

echo "==> Creating GitHub repo and pushing ($VISIBILITY)"
# Creates the repo under your account, adds it as 'origin', and pushes.
gh repo create "$REPO_NAME" "--$VISIBILITY" --source=. --remote=origin --push

OWNER="$(gh api user --jq .login)"
echo "==> Pushed to https://github.com/$OWNER/$REPO_NAME"

# ---------------------------------------------------------------------------
# Auto-deploy configuration (GitHub Actions secrets + optional server bootstrap)
# ---------------------------------------------------------------------------
echo
read -r -p "Configure auto-deploy now? (needs your server SSH access) [y/N] " ans
if [[ ! "${ans:-N}" =~ ^[Yy]$ ]]; then
  echo "==> Skipped. Configure later: secrets in Settings > Secrets > Actions,"
  echo "    server per DOCKER.md > Автодеплой из GitHub."
  echo
  echo "Done. Repo: https://github.com/$OWNER/$REPO_NAME"
  exit 0
fi

echo "-- Server connection --"
read -r -p "  Server host/IP (SSH_HOST): " SSH_HOST
read -r -p "  SSH user (SSH_USER): " SSH_USER
read -r -p "  SSH port [22]: " SSH_PORT; SSH_PORT="${SSH_PORT:-22}"
read -r -p "  Project path on server (DEPLOY_PATH) [/opt/warehouse-queue]: " DEPLOY_PATH
DEPLOY_PATH="${DEPLOY_PATH:-/opt/warehouse-queue}"
read -r -p "  Path to the SSH key you use to log in to the server [~/.ssh/id_ed25519]: " SSH_KEY_PATH
SSH_KEY_PATH="${SSH_KEY_PATH:-~/.ssh/id_ed25519}"; SSH_KEY_PATH="${SSH_KEY_PATH/#\~/$HOME}"
read -r -s -p "  GHCR token with read:packages (GHCR_PAT): " GHCR_PAT; echo

[ -f "$SSH_KEY_PATH" ] || { echo "ERROR: SSH key not found: $SSH_KEY_PATH"; exit 1; }

echo "==> Setting GitHub Actions secrets"
gh secret set SSH_HOST    -b "$SSH_HOST"
gh secret set SSH_USER    -b "$SSH_USER"
gh secret set SSH_PORT    -b "$SSH_PORT"
gh secret set DEPLOY_PATH -b "$DEPLOY_PATH"
gh secret set GHCR_PAT    -b "$GHCR_PAT"
gh secret set SSH_KEY     < "$SSH_KEY_PATH"
echo "    Secrets set."

echo
read -r -p "Bootstrap the server now over SSH (clone, .env, TLS, start)? [y/N] " bootstrap
if [[ ! "${bootstrap:-N}" =~ ^[Yy]$ ]]; then
  echo "==> Secrets done. Prepare the server later per DOCKER.md, then push to deploy."
  echo
  echo "Done. Repo: https://github.com/$OWNER/$REPO_NAME"
  exit 0
fi

echo "-- App configuration (written to the server's .env) --"
read -r -p "  Domain (DNS A/AAAA must already point to the server): " DOMAIN
read -r -p "  Email for Let's Encrypt: " CERTBOT_EMAIL
read -r -s -p "  PostgreSQL password to set: " POSTGRES_PASSWORD; echo
SESSION_SECRET="$(openssl rand -hex 32 2>/dev/null || head -c32 /dev/urandom | xxd -p | tr -d '\n')"
IMAGE_LC="ghcr.io/${OWNER,,}/${REPO_NAME,,}:latest"

SSH="ssh -p $SSH_PORT -o StrictHostKeyChecking=accept-new -i $SSH_KEY_PATH $SSH_USER@$SSH_HOST"

echo "==> [server] Checking Docker"
$SSH 'command -v docker >/dev/null && docker compose version >/dev/null' \
  || { echo "ERROR: Docker / 'docker compose' not available on the server. Install Docker first."; exit 1; }

echo "==> [server] Authorizing the GitHub Actions key for SSH"
ACTIONS_PUBKEY="$(ssh-keygen -y -f "$SSH_KEY_PATH")"
$SSH "mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && grep -qxF '$ACTIONS_PUBKEY' ~/.ssh/authorized_keys || echo '$ACTIONS_PUBKEY' >> ~/.ssh/authorized_keys"

echo "==> [server] Creating a read-only deploy key for cloning the repo"
$SSH "test -f ~/.ssh/wh_deploy || ssh-keygen -t ed25519 -N '' -f ~/.ssh/wh_deploy -C wh-deploy >/dev/null"
DEPLOY_PUBKEY="$($SSH 'cat ~/.ssh/wh_deploy.pub')"
echo "$DEPLOY_PUBKEY" > /tmp/wh_deploy.pub
gh repo deploy-key add /tmp/wh_deploy.pub -t "wh-deploy-$(date +%s)" 2>/dev/null \
  && echo "    Deploy key added to the repo." \
  || echo "    (Deploy key may already exist — continuing.)"
rm -f /tmp/wh_deploy.pub

echo "==> [server] Cloning / updating the repository"
$SSH "if [ -d '$DEPLOY_PATH/.git' ]; then \
        cd '$DEPLOY_PATH' && GIT_SSH_COMMAND='ssh -i ~/.ssh/wh_deploy -o StrictHostKeyChecking=accept-new' git pull --ff-only; \
      else \
        sudo mkdir -p '$DEPLOY_PATH' 2>/dev/null || mkdir -p '$DEPLOY_PATH'; \
        sudo chown \$(id -u):\$(id -g) '$DEPLOY_PATH' 2>/dev/null || true; \
        GIT_SSH_COMMAND='ssh -i ~/.ssh/wh_deploy -o StrictHostKeyChecking=accept-new' git clone git@github.com:$OWNER/$REPO_NAME.git '$DEPLOY_PATH'; \
      fi"
# Make future git operations (incl. the CI deploy) use the deploy key.
$SSH "cd '$DEPLOY_PATH' && git config core.sshCommand 'ssh -i ~/.ssh/wh_deploy -o StrictHostKeyChecking=accept-new'"

echo "==> [server] Writing .env"
$SSH "cat > '$DEPLOY_PATH/.env'" <<EOF
DOMAIN=$DOMAIN
CERTBOT_EMAIL=$CERTBOT_EMAIL
SESSION_SECRET=$SESSION_SECRET
POSTGRES_DB=warehouse
POSTGRES_USER=warehouse
POSTGRES_PASSWORD=$POSTGRES_PASSWORD
APP_IMAGE=$IMAGE_LC
EOF

echo "==> [server] Logging in to GHCR (for future image pulls)"
$SSH "echo '$GHCR_PAT' | docker login ghcr.io -u '$OWNER' --password-stdin"

echo "==> [server] Building the initial image locally (CI image may not be ready yet)"
$SSH "cd '$DEPLOY_PATH' && docker compose build app"

echo "==> [server] Issuing TLS certificate (DNS for $DOMAIN must resolve to this server)"
$SSH "cd '$DEPLOY_PATH' && chmod +x deploy/init-letsencrypt.sh && ./deploy/init-letsencrypt.sh"

echo "==> [server] Starting the stack"
$SSH "cd '$DEPLOY_PATH' && docker compose up -d"

echo
echo "All done."
echo "  Repo:   https://github.com/$OWNER/$REPO_NAME"
echo "  Site:   https://$DOMAIN/manager.html  (login admin / admin123 — change it!)"
echo "  Deploy: every 'git push origin main' now builds and ships automatically."
