#!/usr/bin/env bash
# Native install of warehouse-queue WITHOUT Docker, on a clean Ubuntu/Debian
# server: Node.js + PostgreSQL + Redis + nginx + Let's Encrypt + systemd,
# plus git-based auto-deploy. Run as root:
#
#   curl -fsSL https://raw.githubusercontent.com/mnazarow/warehouse-queue/main/deploy/install-native.sh -o install-native.sh
#   sudo bash install-native.sh
#
# Requires: a domain whose DNS A/AAAA already points here, ports 80/443 open.
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/mnazarow/warehouse-queue.git}"
BRANCH="${BRANCH:-main}"
APP_DIR="${APP_DIR:-/opt/warehouse-queue}"
APP_USER="${APP_USER:-warehouse}"
DATA_DIR="${DATA_DIR:-/var/lib/warehouse-queue}"
ENV_FILE="${ENV_FILE:-/etc/warehouse-queue.env}"
SERVICE="warehouse-queue"
NODE_MAJOR="${NODE_MAJOR:-20}"
POLL_INTERVAL="${POLL_INTERVAL:-3min}"
PORT="${PORT:-3000}"

if [ "$(id -u)" -ne 0 ]; then echo "Please run as root:  sudo bash install-native.sh"; exit 1; fi
command -v apt-get >/dev/null || { echo "This installer targets Debian/Ubuntu (apt)."; exit 1; }

echo "== warehouse-queue: native (no-Docker) install =="

# 1. System packages ----------------------------------------------------------
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl git ca-certificates build-essential python3 \
                   postgresql postgresql-client redis-server \
                   nginx certbot python3-certbot-nginx

# Node.js (>= 18 needed for better-sqlite3); install Node $NODE_MAJOR if missing/old.
NEED_NODE=1
if command -v node >/dev/null 2>&1; then
  CUR="$(node -p 'process.versions.node.split(".")[0]')" || CUR=0
  [ "$CUR" -ge 18 ] && NEED_NODE=0
fi
if [ "$NEED_NODE" -eq 1 ]; then
  echo "==> Installing Node.js $NODE_MAJOR"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
fi

systemctl enable --now postgresql redis-server

# 2. App user + source --------------------------------------------------------
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin "$APP_USER"

if [ -d "$APP_DIR/.git" ]; then
  echo "==> Updating existing checkout"
  git -C "$APP_DIR" pull --ff-only origin "$BRANCH"
else
  echo "==> Cloning $REPO_URL"
  mkdir -p "$APP_DIR"
  git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
fi
mkdir -p "$DATA_DIR"
chown -R "$APP_USER":"$APP_USER" "$APP_DIR" "$DATA_DIR"

# 3. Dependencies (builds better-sqlite3 natively) ----------------------------
echo "==> Installing npm dependencies"
sudo -u "$APP_USER" -H npm --prefix "$APP_DIR" ci --omit=dev \
  || sudo -u "$APP_USER" -H npm --prefix "$APP_DIR" install --omit=dev
NODE_BIN="$(command -v node)"

# 4. Inputs -------------------------------------------------------------------
if [ -f "$ENV_FILE" ]; then
  echo "==> $ENV_FILE exists — keeping it"
  # `|| true` обязателен: при set -euo pipefail отсутствие строки в файле
  # обрывало установку без единого сообщения.
  DOMAIN="$(grep -E '^DOMAIN=' "$ENV_FILE" | head -1 | cut -d= -f2- || true)"
  PGPW="$(grep -E '^PGSQL_PASSWORD=' "$ENV_FILE" | head -1 | cut -d= -f2- || true)"
  EMAIL="$(grep -E '^CERTBOT_EMAIL=' "$ENV_FILE" | head -1 | cut -d= -f2- || true)"
  [ -n "$DOMAIN" ] || { echo "В $ENV_FILE нет строки DOMAIN= — добавьте её и повторите"; exit 1; }
  [ -n "$PGPW" ] || { echo "В $ENV_FILE нет строки PGSQL_PASSWORD= — добавьте её и повторите"; exit 1; }
else
  read -r -p "Domain (DNS must already point here): " DOMAIN
  read -r -p "Email for Let's Encrypt: " EMAIL
  read -r -s -p "PostgreSQL password to set: " PGPW; echo
  SESSION_SECRET="$(openssl rand -hex 32 2>/dev/null || head -c32 /dev/urandom | xxd -p | tr -d '\n')"
fi

# 5. PostgreSQL role + database (idempotent) ----------------------------------
echo "==> Configuring PostgreSQL"
sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='warehouse'" | grep -q 1 \
  && sudo -u postgres psql -c "ALTER ROLE warehouse LOGIN PASSWORD '$PGPW'" \
  || sudo -u postgres psql -c "CREATE ROLE warehouse LOGIN PASSWORD '$PGPW'"
sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='warehouse'" | grep -q 1 \
  || sudo -u postgres createdb -O warehouse warehouse

# 6. Environment file for the service -----------------------------------------
if [ ! -f "$ENV_FILE" ]; then
  echo "==> Writing $ENV_FILE"
  cat > "$ENV_FILE" <<EOF
PORT=$PORT
NODE_ENV=production
DB_PATH=$DATA_DIR/warehouse.db
SESSION_SECRET=$SESSION_SECRET
# Приложение стоит за nginx: адрес клиента берётся из X-Forwarded-For,
# TRUST_PROXY_HOPS — сколько своих прокси перед приложением.
TRUST_PROXY=1
TRUST_PROXY_HOPS=1
# Ставится в 1 после успешного выпуска сертификата (см. конец установки):
# cookie сессии тогда не уходит по открытому HTTP.
COOKIE_SECURE=0
SEED_CONNECTORS=1
PGSQL_HOST=127.0.0.1
PGSQL_PORT=5432
PGSQL_DATABASE=warehouse
PGSQL_USER=warehouse
PGSQL_PASSWORD=$PGPW
REDIS_HOST=127.0.0.1
REDIS_PORT=6379
REDIS_ENABLED=1
DOMAIN=$DOMAIN
CERTBOT_EMAIL=$EMAIL
EOF
  chmod 600 "$ENV_FILE"
fi

# 7. systemd service for the app ----------------------------------------------
echo "==> Installing systemd service '$SERVICE'"
cat > /etc/systemd/system/$SERVICE.service <<EOF
[Unit]
Description=warehouse-queue (Node app)
After=network-online.target postgresql.service redis-server.service
Wants=network-online.target

[Service]
User=$APP_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$NODE_BIN server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now $SERVICE

# 8. nginx reverse proxy + TLS ------------------------------------------------
echo "==> Configuring nginx for $DOMAIN"
cat > /etc/nginx/sites-available/$SERVICE <<EOF
server {
    listen 80;
    server_name $DOMAIN;
    # Схемы проезда (картинки) и восстановление из резервной копии.
    client_max_body_size 64m;
    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF
ln -sf /etc/nginx/sites-available/$SERVICE /etc/nginx/sites-enabled/$SERVICE
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

echo "==> Obtaining Let's Encrypt certificate"
if certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos \
     -m "${EMAIL:-admin@$DOMAIN}" --redirect; then
  # Сертификат получен — включаем защищённую cookie сессии.
  if grep -q '^COOKIE_SECURE=' "$ENV_FILE"; then
    sed -i 's/^COOKIE_SECURE=.*/COOKIE_SECURE=1/' "$ENV_FILE"
  else
    echo "COOKIE_SECURE=1" >> "$ENV_FILE"
  fi
  systemctl restart $SERVICE
  echo "==> HTTPS is on, COOKIE_SECURE=1"
else
  echo "WARN: certbot failed (check DNS/ports). App is still served over HTTP."
  echo "      After fixing TLS set COOKIE_SECURE=1 in $ENV_FILE and restart $SERVICE."
fi

# 9. Auto-deploy timer --------------------------------------------------------
if [ -f "$APP_DIR/deploy/auto-deploy-native.sh" ]; then
echo "==> Installing auto-deploy timer (poll every $POLL_INTERVAL)"
chmod +x "$APP_DIR/deploy/auto-deploy-native.sh"
cat > /etc/systemd/system/$SERVICE-deploy.service <<EOF
[Unit]
Description=warehouse-queue native auto-deploy from GitHub
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
Environment=APP_DIR=$APP_DIR
Environment=APP_USER=$APP_USER
Environment=BRANCH=$BRANCH
Environment=SERVICE=$SERVICE
ExecStart=$APP_DIR/deploy/auto-deploy-native.sh
EOF
cat > /etc/systemd/system/$SERVICE-deploy.timer <<EOF
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
systemctl enable --now $SERVICE-deploy.timer
else
  echo "WARN: deploy/auto-deploy-native.sh not found — auto-deploy timer skipped."
  echo "      Update manually:  cd $APP_DIR && ./update.sh"
fi

echo
echo "All done."
echo "  Site:        https://$DOMAIN/manager.html"
echo "  Login:       admin, password is in $APP_DIR/ADMIN-PASSWORD.txt"
echo "               (log in, change it in the cabinet, then delete the file)"
echo "  App service: systemctl status $SERVICE   |   journalctl -u $SERVICE -f"
echo "  Auto-deploy: every $POLL_INTERVAL, pulls $REPO_URL ($BRANCH) and restarts on changes."
echo "  Deploy now:  systemctl start $SERVICE-deploy.service"
echo "  Self-test:   cd $APP_DIR && node test/passwords.test.js && node test/timezone.test.js"
echo "  PostgreSQL:  switch in the manager UI (Настройки → PostgreSQL → Мигрировать → Переключиться)."
echo "  Uninstall:   sudo bash $APP_DIR/deploy/uninstall.sh   (add PURGE_DATA=1 DROP_DB=1 to wipe data)"
