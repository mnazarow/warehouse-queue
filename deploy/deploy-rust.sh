#!/usr/bin/env bash
# Деплой Rust-версии warehouse-queue на Linux-сервер (systemd, без Docker).
# Использование:
#   sudo bash deploy/deploy-rust.sh                # SQLite (по умолчанию)
#   sudo DB_BACKEND=postgres \
#        DB_DSN='postgres://warehouse:pass@127.0.0.1:5432/warehouse?sslmode=disable' \
#        bash deploy/deploy-rust.sh                # PostgreSQL
#
# Переменные окружения (необязательные):
#   APP_DIR   каталог установки      (по умолчанию /opt/warehouse-queue)
#   SERVICE   имя systemd-сервиса    (по умолчанию warehouse-rs)
#   PORT      порт                   (по умолчанию 3000)
#   RUN_USER  системный пользователь  (по умолчанию warehouse)
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/warehouse-queue}"
SERVICE="${SERVICE:-warehouse-rs}"
PORT="${PORT:-3000}"
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

# 2. Зависимости сборки (rusqlite bundled требует C-компилятор; rustls — без OpenSSL)
log "Устанавливаю build-essential, pkg-config, git, curl"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y build-essential pkg-config git curl ca-certificates

# 3. Rust toolchain (через rustup, ставится пользователю RUN_USER)
RUSTUP_HOME="/home/${RUN_USER}/.rustup"
CARGO_HOME="/home/${RUN_USER}/.cargo"
if [ ! -x "${CARGO_HOME}/bin/cargo" ]; then
  log "Устанавливаю Rust (rustup) для $RUN_USER"
  sudo -u "$RUN_USER" RUSTUP_HOME="$RUSTUP_HOME" CARGO_HOME="$CARGO_HOME" \
    bash -c 'curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal'
fi
CARGO="${CARGO_HOME}/bin/cargo"

# 4. Код (clone или pull)
if [ -d "$APP_DIR/.git" ]; then
  log "Обновляю репозиторий в $APP_DIR"
  git -C "$APP_DIR" pull --ff-only
else
  log "Клонирую $REPO в $APP_DIR"
  git clone "$REPO" "$APP_DIR"
fi
chown -R "$RUN_USER":"$RUN_USER" "$APP_DIR"

# 5. Сборка release
log "Собираю rust-service (release) — первая сборка может занять несколько минут"
cd "$APP_DIR/rust-service"
sudo -u "$RUN_USER" RUSTUP_HOME="$RUSTUP_HOME" CARGO_HOME="$CARGO_HOME" \
  "$CARGO" build --release
install -m 0755 "$APP_DIR/rust-service/target/release/warehouse-rs" "$APP_DIR/warehouse-rs"
chown "$RUN_USER":"$RUN_USER" "$APP_DIR/warehouse-rs"

# 6. systemd-сервис
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
Description=warehouse-queue (Rust)
After=network.target postgresql.service redis-server.service

[Service]
Type=simple
User=${RUN_USER}
WorkingDirectory=${APP_DIR}/rust-service
ExecStart=${APP_DIR}/warehouse-rs
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
