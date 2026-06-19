#!/usr/bin/env bash
# ============================================================================
#  warehouse-queue — установка Go-варианта на ЧИСТЫЙ сервер (Ubuntu/Debian),
#  без Docker. Ставит всё с нуля: системные пакеты, Go, PostgreSQL (создаёт
#  БД и роль), Redis, собирает бинарник, поднимает systemd-сервис и (опц.) nginx.
#
#  Запуск (от root / через sudo):
#     sudo bash deploy/install-go-server.sh
#
#  Полезные переменные окружения (все необязательные):
#     DB_BACKEND=postgres|sqlite   какую СУБД использовать (по умолчанию postgres)
#     PG_DB / PG_USER / PG_PASSWORD  параметры создаваемой БД PostgreSQL
#     INSTALL_REDIS=1|0            ставить ли Redis (по умолчанию 1)
#     WITH_NGINX=1 DOMAIN=...      поднять nginx-прокси для домена (опционально)
#     PORT=3000                    порт приложения
#     APP_DIR=/opt/warehouse-queue каталог установки
#     REPO=https://github.com/mnazarow/warehouse-queue.git
#     GO_VERSION=1.22.5            версия Go
#     RUN_USER=warehouse           системный пользователь сервиса
# ============================================================================
set -euo pipefail

DB_BACKEND="${DB_BACKEND:-postgres}"
PG_DB="${PG_DB:-warehouse}"
PG_USER="${PG_USER:-warehouse}"
PG_PASSWORD="${PG_PASSWORD:-warehouse}"
INSTALL_REDIS="${INSTALL_REDIS:-1}"
WITH_NGINX="${WITH_NGINX:-0}"
DOMAIN="${DOMAIN:-}"
PORT="${PORT:-3000}"
APP_DIR="${APP_DIR:-/opt/warehouse-queue}"
SERVICE="${SERVICE:-warehouse-go}"
REPO="${REPO:-https://github.com/mnazarow/warehouse-queue.git}"
GO_VERSION="${GO_VERSION:-1.22.5}"
RUN_USER="${RUN_USER:-warehouse}"

log(){ echo -e "\033[1;32m==>\033[0m $*"; }
warn(){ echo -e "\033[1;33m!\033[0m $*"; }
err(){ echo -e "\033[1;31m✗\033[0m $*" >&2; }

if [ "$(id -u)" -ne 0 ]; then err "Запустите через sudo/root"; exit 1; fi
if ! command -v apt-get &>/dev/null; then
  err "Скрипт рассчитан на Ubuntu/Debian (apt). Для других систем ставьте пакеты вручную."
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive

# ---------------------------------------------------------------------------
log "1/8  Базовые пакеты"
apt-get update -y
apt-get install -y git curl ca-certificates ufw

# ---------------------------------------------------------------------------
log "2/8  Системный пользователь $RUN_USER"
if ! id "$RUN_USER" &>/dev/null; then
  useradd --system --create-home --shell /usr/sbin/nologin "$RUN_USER"
fi

# ---------------------------------------------------------------------------
log "3/8  Go ${GO_VERSION}"
if ! command -v go &>/dev/null || ! go version | grep -q "go${GO_VERSION%.*}"; then
  ARCH=$(dpkg --print-architecture 2>/dev/null || echo amd64)
  case "$ARCH" in arm64) GOARCH=arm64;; *) GOARCH=amd64;; esac
  TARBALL="go${GO_VERSION}.linux-${GOARCH}.tar.gz"
  curl -fsSL "https://go.dev/dl/${TARBALL}" -o "/tmp/${TARBALL}"
  rm -rf /usr/local/go && tar -C /usr/local -xzf "/tmp/${TARBALL}"
fi
export PATH=$PATH:/usr/local/go/bin
GO=/usr/local/go/bin/go

# ---------------------------------------------------------------------------
DB_DSN=""
if [ "$DB_BACKEND" = "postgres" ]; then
  log "4/8  PostgreSQL (установка + БД/роль)"
  apt-get install -y postgresql postgresql-client
  systemctl enable --now postgresql

  # Создаём роль и БД идемпотентно.
  sudo -u postgres psql -v ON_ERROR_STOP=1 <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${PG_USER}') THEN
    CREATE ROLE ${PG_USER} LOGIN PASSWORD '${PG_PASSWORD}';
  ELSE
    ALTER ROLE ${PG_USER} WITH LOGIN PASSWORD '${PG_PASSWORD}';
  END IF;
END \$\$;
SQL
  if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='${PG_DB}'" | grep -q 1; then
    sudo -u postgres createdb -O "${PG_USER}" "${PG_DB}"
  fi
  sudo -u postgres psql -v ON_ERROR_STOP=1 -c "GRANT ALL PRIVILEGES ON DATABASE ${PG_DB} TO ${PG_USER};"
  DB_DSN="postgres://${PG_USER}:${PG_PASSWORD}@127.0.0.1:5432/${PG_DB}?sslmode=disable"
  log "    DSN: postgres://${PG_USER}:***@127.0.0.1:5432/${PG_DB}"
else
  log "4/8  SQLite (внешняя СУБД не нужна)"
  DB_DSN="${APP_DIR}/data/warehouse.db"
  mkdir -p "${APP_DIR}/data"
fi

# ---------------------------------------------------------------------------
if [ "$INSTALL_REDIS" = "1" ]; then
  log "5/8  Redis (кэш слотов)"
  apt-get install -y redis-server
  systemctl enable --now redis-server
  warn "Redis установлен. Включите кэш в кабинете: Настройки → Redis → Включить."
else
  log "5/8  Redis пропущен (INSTALL_REDIS=0)"
fi

# ---------------------------------------------------------------------------
log "6/8  Код и сборка"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" pull --ff-only
else
  git clone "$REPO" "$APP_DIR"
fi
cd "$APP_DIR/go-service"
"$GO" mod tidy
"$GO" build -o "$APP_DIR/warehouse-go" ./...
mkdir -p "$APP_DIR/backups"
chown -R "$RUN_USER":"$RUN_USER" "$APP_DIR"

# ---------------------------------------------------------------------------
log "7/8  systemd-сервис $SERVICE"
ENV_LINES="Environment=PORT=${PORT}
Environment=DB_BACKEND=${DB_BACKEND}
Environment=DB_DSN=${DB_DSN}
Environment=STATIC_DIR=${APP_DIR}/public
Environment=PRIVATE_DIR=${APP_DIR}/private
Environment=BACKUP_DIR=${APP_DIR}/backups"

cat >/etc/systemd/system/${SERVICE}.service <<EOF
[Unit]
Description=warehouse-queue (Go)
After=network.target postgresql.service redis-server.service
Wants=redis-server.service

[Service]
Type=simple
User=${RUN_USER}
WorkingDirectory=${APP_DIR}/go-service
ExecStart=${APP_DIR}/warehouse-go
${ENV_LINES}
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=full

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "$SERVICE"
systemctl restart "$SERVICE"

# ---------------------------------------------------------------------------
log "8/8  nginx / фаервол"
if [ "$WITH_NGINX" = "1" ] && [ -n "$DOMAIN" ]; then
  apt-get install -y nginx
  cat >/etc/nginx/sites-available/${SERVICE}.conf <<EOF
server {
    listen 80;
    server_name ${DOMAIN};
    location / {
        proxy_pass http://127.0.0.1:${PORT};
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF
  ln -sf /etc/nginx/sites-available/${SERVICE}.conf /etc/nginx/sites-enabled/${SERVICE}.conf
  nginx -t && systemctl reload nginx
  command -v ufw &>/dev/null && ufw allow 'Nginx Full' >/dev/null 2>&1 || true
  warn "HTTPS: выпустите сертификат — apt install certbot python3-certbot-nginx && certbot --nginx -d ${DOMAIN}"
else
  # без nginx открываем порт приложения
  command -v ufw &>/dev/null && ufw allow "${PORT}/tcp" >/dev/null 2>&1 || true
fi

sleep 1
systemctl --no-pager --full status "$SERVICE" | head -n 12 || true

echo
log "Готово!"
if [ "$WITH_NGINX" = "1" ] && [ -n "$DOMAIN" ]; then
  echo "  Запись:  http://${DOMAIN}/"
  echo "  Кабинет: http://${DOMAIN}/manager.html"
else
  echo "  Запись:  http://<IP-сервера>:${PORT}/"
  echo "  Кабинет: http://<IP-сервера>:${PORT}/manager.html"
fi
echo "  Вход:    admin / admin123  ← ОБЯЗАТЕЛЬНО смените пароль"
echo "  Логи:    journalctl -u ${SERVICE} -f"
echo "  СУБД:    ${DB_BACKEND}"
