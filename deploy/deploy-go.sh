#!/usr/bin/env bash
# Деплой Go-версии warehouse-queue на Linux-сервер (systemd, без Docker).
# Использование:
#   sudo bash deploy/deploy-go.sh                 # SQLite (по умолчанию)
#   sudo DB_BACKEND=postgres \
#        DB_DSN='postgres://warehouse:pass@127.0.0.1:5432/warehouse?sslmode=disable' \
#        bash deploy/deploy-go.sh                 # PostgreSQL
#
# Переменные окружения (необязательные):
#   APP_DIR     каталог установки           (по умолчанию /opt/warehouse-queue)
#   SERVICE     имя systemd-сервиса         (по умолчанию warehouse-go)
#   PORT        порт                        (по умолчанию 3000)
#   GO_VERSION  версия Go для установки      (по умолчанию 1.22.5)
#   RUN_USER    системный пользователь       (по умолчанию warehouse)
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/warehouse-queue}"
SERVICE="${SERVICE:-warehouse-go}"
PORT="${PORT:-3000}"
GO_VERSION="${GO_VERSION:-1.22.5}"
RUN_USER="${RUN_USER:-warehouse}"
DB_BACKEND="${DB_BACKEND:-sqlite}"
DB_DSN="${DB_DSN:-}"
REPO="${REPO:-https://github.com/mnazarow/warehouse-queue.git}"

log(){ echo -e "\033[1;32m==>\033[0m $*"; }
err(){ echo -e "\033[1;31m✗\033[0m $*" >&2; }

if [ "$(id -u)" -ne 0 ]; then err "Запустите через sudo/root"; exit 1; fi

# 1. Системный пользователь
if ! id "$RUN_USER" &>/dev/null; then
  log "Создаю пользователя $RUN_USER"
  useradd --system --create-home --shell /usr/sbin/nologin "$RUN_USER"
fi

# 2. Go toolchain
if ! command -v go &>/dev/null || ! go version | grep -q "go${GO_VERSION%.*}"; then
  log "Устанавливаю Go ${GO_VERSION}"
  ARCH=$(dpkg --print-architecture 2>/dev/null || echo amd64)
  case "$ARCH" in amd64) GOARCH=amd64;; arm64) GOARCH=arm64;; *) GOARCH=amd64;; esac
  TARBALL="go${GO_VERSION}.linux-${GOARCH}.tar.gz"
  curl -fsSL "https://go.dev/dl/${TARBALL}" -o "/tmp/${TARBALL}"
  rm -rf /usr/local/go && tar -C /usr/local -xzf "/tmp/${TARBALL}"
  export PATH=$PATH:/usr/local/go/bin
fi
export PATH=$PATH:/usr/local/go/bin

# 3. Код (clone или pull)
if [ -d "$APP_DIR/.git" ]; then
  log "Обновляю репозиторий в $APP_DIR"
  git -C "$APP_DIR" pull --ff-only
else
  log "Клонирую $REPO в $APP_DIR"
  git clone "$REPO" "$APP_DIR"
fi

# 4. Сборка
log "Собираю go-service"
cd "$APP_DIR/go-service"
/usr/local/go/bin/go mod tidy
/usr/local/go/bin/go build -o "$APP_DIR/warehouse-go" ./...

chown -R "$RUN_USER":"$RUN_USER" "$APP_DIR"

# 5. systemd-сервис
log "Создаю сервис $SERVICE"
ENV_LINES="Environment=PORT=${PORT}
Environment=DB_BACKEND=${DB_BACKEND}
Environment=STATIC_DIR=${APP_DIR}/public
Environment=PRIVATE_DIR=${APP_DIR}/private
Environment=BACKUP_DIR=${APP_DIR}/backups"
if [ -n "$DB_DSN" ]; then ENV_LINES="${ENV_LINES}
Environment=DB_DSN=${DB_DSN}"; fi

cat >/etc/systemd/system/${SERVICE}.service <<EOF
[Unit]
Description=warehouse-queue (Go)
After=network.target postgresql.service redis-server.service

[Service]
Type=simple
User=${RUN_USER}
WorkingDirectory=${APP_DIR}/go-service
ExecStart=${APP_DIR}/warehouse-go
${ENV_LINES}
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "$SERVICE"
systemctl restart "$SERVICE"
sleep 1
systemctl --no-pager --full status "$SERVICE" | head -n 12 || true

log "Готово. Сервис '$SERVICE' слушает порт ${PORT}."
log "Логи:    journalctl -u ${SERVICE} -f"
log "Запись:  http://<server>:${PORT}/    Кабинет: http://<server>:${PORT}/manager.html (admin/admin123 — смените пароль)"
