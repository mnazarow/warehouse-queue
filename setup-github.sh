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

OWNER="$(gh api user --jq .login)"
if gh repo view "$OWNER/$REPO_NAME" >/dev/null 2>&1; then
  echo "==> Repo $OWNER/$REPO_NAME already exists — pushing to it"
  git remote remove origin >/dev/null 2>&1 || true
  git remote add origin "https://github.com/$OWNER/$REPO_NAME.git"
  if ! git push -u origin main; then
    echo "ERROR: push was rejected (the remote repo already has commits). Choose one:"
    echo "   git pull --rebase origin main && git push -u origin main   # keep remote history"
    echo "   git push --force-with-lease origin main                    # overwrite remote with local"
    exit 1
  fi
else
  echo "==> Creating GitHub repo and pushing ($VISIBILITY)"
  gh repo create "$REPO_NAME" "--$VISIBILITY" --source=. --remote=origin --push
fi
echo "==> Pushed to https://github.com/$OWNER/$REPO_NAME"

# ---------------------------------------------------------------------------
# Optional server bootstrap over SSH (clone + start the full stack).
# After this, updates are deployed on the server by Watchtower automatically —
# no GitHub Actions SSH secrets are needed (CI only publishes the image).
# ---------------------------------------------------------------------------
echo
read -r -p "Bootstrap the server now over SSH (clone, .env, TLS, start)? [y/N] " ans
if [[ ! "${ans:-N}" =~ ^[Yy]$ ]]; then
  echo "==> Skipped. Deploy on the server later with deploy/bootstrap.sh (see DOCKER.md)."
  echo
  echo "Done. Repo: https://github.com/$OWNER/$REPO_NAME"
  echo "Push to main builds the image; Watchtower on the server ships it."
  exit 0
fi

echo "-- Server connection --"
read -r -p "  Server host/IP: " SSH_HOST
read -r -p "  SSH user: " SSH_USER
read -r -p "  SSH port [22]: " SSH_PORT; SSH_PORT="${SSH_PORT:-22}"
read -r -p "  Install path on server [/opt/warehouse-queue]: " DEPLOY_PATH
DEPLOY_PATH="${DEPLOY_PATH:-/opt/warehouse-queue}"
read -r -p "  SSH key to log in to the server [~/.ssh/id_ed25519]: " SSH_KEY_PATH
SSH_KEY_PATH="${SSH_KEY_PATH:-~/.ssh/id_ed25519}"; SSH_KEY_PATH="${SSH_KEY_PATH/#\~/$HOME}"
read -r -s -p "  GitHub token (read:packages; for image pull): " GHCR_PAT; echo
[ -f "$SSH_KEY_PATH" ] || { echo "ERROR: SSH key not found: $SSH_KEY_PATH"; exit 1; }

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

SRV_HOME="$($SSH 'echo $HOME')"
echo "==> [server] Writing .env"
$SSH "cat > '$DEPLOY_PATH/.env'" <<EOF
DOMAIN=$DOMAIN
CERTBOT_EMAIL=$CERTBOT_EMAIL
SESSION_SECRET=$SESSION_SECRET
POSTGRES_DB=warehouse
POSTGRES_USER=warehouse
POSTGRES_PASSWORD=$POSTGRES_PASSWORD
APP_IMAGE=$IMAGE_LC
DOCKER_CONFIG_JSON=$SRV_HOME/.docker/config.json
EOF

echo "==> [server] Logging in to GHCR (image pulls + Watchtower)"
$SSH "echo '$GHCR_PAT' | docker login ghcr.io -u '$OWNER' --password-stdin"

echo "==> [server] Building the initial image locally (CI image may not be ready yet)"
$SSH "cd '$DEPLOY_PATH' && docker compose build app"

echo "==> [server] Issuing TLS certificate (DNS for $DOMAIN must resolve to this server)"
$SSH "cd '$DEPLOY_PATH' && chmod +x deploy/init-letsencrypt.sh && ./deploy/init-letsencrypt.sh"

echo "==> [server] Starting the stack"
$SSH "cd '$DEPLOY_PATH' && docker compose --profile ghcr up -d"

echo
echo "All done."
echo "  Repo:   https://github.com/$OWNER/$REPO_NAME"
echo "  Site:   https://$DOMAIN/manager.html  (login admin / admin123 — change it!)"
echo "  Deploy: every 'git push origin main' now builds and ships automatically."
