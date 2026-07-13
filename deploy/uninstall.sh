#!/usr/bin/env bash
# Удаление warehouse-queue, установленного нативными install-скриптами
# (install-native.sh — Node, install-go-server.sh — Go, install-rust-server.sh — Rust).
#
# По умолчанию удаляет ТОЛЬКО сервисы, бинарники/чекаут и конфиг nginx,
# СОХРАНЯЯ данные (БД SQLite/PostgreSQL, env-файл, бэкапы). Это безопасный
# режим: приложение перестаёт работать, но данные остаются.
#
# Использование (запускать под root):
#   sudo bash uninstall.sh                     # интерактивно, спросит про данные/БД
#   sudo VARIANT=go bash uninstall.sh          # удалить только Go-вариант
#   sudo PURGE_DATA=1 DROP_DB=1 REMOVE_USER=1 ASSUME_YES=1 bash uninstall.sh   # полная очистка без вопросов
#
# Переменные окружения:
#   VARIANT       node|go|rust|all  (по умолчанию: автоопределение установленных сервисов)
#   PURGE_DATA    1 — удалить каталог приложения, каталог данных, env-файл, бэкапы (по умолчанию 0)
#   DROP_DB       1 — удалить роль и базу PostgreSQL 'warehouse' (по умолчанию 0)
#   REMOVE_USER   1 — удалить системного пользователя 'warehouse' (по умолчанию 0)
#   REMOVE_PKGS   1 — удалить пакеты nginx/postgresql/redis (по умолчанию 0 — они общие для системы)
#   ASSUME_YES    1 — не задавать вопросов, использовать значения по умолчанию/переменные
#
#   APP_DIR       каталог установки (по умолчанию /opt/warehouse-queue)
#   DATA_DIR      каталог данных Node (по умолчанию /var/lib/warehouse-queue)
#   ENV_FILE      env-файл Node (по умолчанию /etc/warehouse-queue.env)
#   APP_USER      системный пользователь (по умолчанию warehouse)
#   PG_DB / PG_USER   имя базы и роли PostgreSQL (по умолчанию warehouse)
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/warehouse-queue}"
DATA_DIR="${DATA_DIR:-/var/lib/warehouse-queue}"
ENV_FILE="${ENV_FILE:-/etc/warehouse-queue.env}"
APP_USER="${APP_USER:-warehouse}"
PG_DB="${PG_DB:-warehouse}"
PG_USER="${PG_USER:-warehouse}"

PURGE_DATA="${PURGE_DATA:-0}"
DROP_DB="${DROP_DB:-0}"
REMOVE_USER="${REMOVE_USER:-0}"
REMOVE_PKGS="${REMOVE_PKGS:-0}"
ASSUME_YES="${ASSUME_YES:-0}"

# Сервисы каждого варианта
NODE_SERVICE="warehouse-queue"
GO_SERVICE="warehouse-go"
RUST_SERVICE="warehouse-rs"

log()  { echo -e "\033[1;32m==>\033[0m $*"; }
warn() { echo -e "\033[1;33m[!]\033[0m $*"; }

if [ "$(id -u)" -ne 0 ]; then echo "Запустите под root:  sudo bash uninstall.sh"; exit 1; fi
command -v systemctl >/dev/null || { echo "Нужен systemd (Debian/Ubuntu)."; exit 1; }

ask() {  # ask "вопрос" default_var_name   -> устанавливает переменную в 0/1
  local q="$1" var="$2" cur="${!2}"
  if [ "$ASSUME_YES" = "1" ]; then return; fi
  local def="n"; [ "$cur" = "1" ] && def="y"
  local ans; read -r -p "$q [y/N] " ans || true
  ans="${ans:-$def}"
  case "$ans" in y|Y|yes|YES) printf -v "$var" '1' ;; *) printf -v "$var" '0' ;; esac
}

svc_exists() { systemctl list-unit-files "$1.service" 2>/dev/null | grep -q "$1.service" || [ -f "/etc/systemd/system/$1.service" ]; }

# --- Определяем варианты для удаления --------------------------------------
VARIANT="${VARIANT:-}"
if [ -z "$VARIANT" ]; then
  DETECTED=()
  svc_exists "$NODE_SERVICE" && DETECTED+=("node")
  svc_exists "$GO_SERVICE"   && DETECTED+=("go")
  svc_exists "$RUST_SERVICE" && DETECTED+=("rust")
  if [ "${#DETECTED[@]}" -eq 0 ]; then
    warn "Установленные сервисы warehouse-queue не найдены. Будет выполнена только очистка по флагам."
    VARIANT="none"
  else
    VARIANT="$(IFS=,; echo "${DETECTED[*]}")"
    log "Обнаружены варианты: $VARIANT"
  fi
fi
[ "$VARIANT" = "all" ] && VARIANT="node,go,rust"

want() { case ",$VARIANT," in *",$1,"*) return 0;; *) return 1;; esac; }

echo
warn "Будут остановлены и удалены systemd-сервисы и конфиг nginx для: $VARIANT"
warn "Пакеты БД/кэша (postgresql, redis, nginx) по умолчанию НЕ удаляются."
echo

ask "Удалить данные (каталог приложения $APP_DIR, данные $DATA_DIR, $ENV_FILE, бэкапы)?" PURGE_DATA
ask "Удалить базу и роль PostgreSQL '$PG_DB' (НЕОБРАТИМО)?" DROP_DB
ask "Удалить системного пользователя '$APP_USER'?" REMOVE_USER
ask "Удалить пакеты nginx/postgresql/redis (обычно НЕ нужно)?" REMOVE_PKGS

if [ "$ASSUME_YES" != "1" ]; then
  echo
  read -r -p "Продолжить удаление? [y/N] " GO || true
  case "${GO:-n}" in y|Y|yes|YES) : ;; *) echo "Отменено."; exit 0 ;; esac
fi

remove_service() {  # remove_service <service-name>
  local s="$1"
  if svc_exists "$s"; then
    log "Останавливаю и отключаю $s"
    systemctl stop "$s" 2>/dev/null || true
    systemctl disable "$s" 2>/dev/null || true
    rm -f "/etc/systemd/system/$s.service"
  fi
}

remove_nginx_site() {  # remove_nginx_site <name>
  local n="$1" removed=0
  for p in "/etc/nginx/sites-enabled/$n" "/etc/nginx/sites-available/$n" \
           "/etc/nginx/sites-enabled/$n.conf" "/etc/nginx/sites-available/$n.conf"; do
    [ -e "$p" ] && { rm -f "$p"; removed=1; }
  done
  [ "$removed" = "1" ] && log "Удалён конфиг nginx: $n"
}

# --- Node --------------------------------------------------------------------
if want node; then
  remove_service "$NODE_SERVICE-deploy.timer"
  remove_service "$NODE_SERVICE-deploy.service"
  # У .timer нет .service-обёртки в svc_exists — снимем таймер напрямую
  systemctl stop "$NODE_SERVICE-deploy.timer" 2>/dev/null || true
  systemctl disable "$NODE_SERVICE-deploy.timer" 2>/dev/null || true
  rm -f "/etc/systemd/system/$NODE_SERVICE-deploy.timer" "/etc/systemd/system/$NODE_SERVICE-deploy.service"
  remove_service "$NODE_SERVICE"
  remove_nginx_site "$NODE_SERVICE"
fi

# --- Go ----------------------------------------------------------------------
if want go; then
  remove_service "$GO_SERVICE"
  remove_nginx_site "$GO_SERVICE"
fi

# --- Rust --------------------------------------------------------------------
if want rust; then
  remove_service "$RUST_SERVICE"
  remove_nginx_site "$RUST_SERVICE"
fi

systemctl daemon-reload
if command -v nginx >/dev/null 2>&1 && [ "$REMOVE_PKGS" != "1" ]; then
  nginx -t >/dev/null 2>&1 && systemctl reload nginx 2>/dev/null || warn "nginx не перезагружен (проверьте конфиг вручную)."
fi

# --- Данные ------------------------------------------------------------------
if [ "$PURGE_DATA" = "1" ]; then
  log "Удаляю данные приложения"
  rm -rf "$APP_DIR" "$DATA_DIR"
  rm -f "$ENV_FILE"
else
  warn "Данные сохранены: $APP_DIR, $DATA_DIR, $ENV_FILE (удалите вручную при необходимости)."
fi

# --- PostgreSQL --------------------------------------------------------------
if [ "$DROP_DB" = "1" ]; then
  if command -v psql >/dev/null 2>&1 && id -u postgres >/dev/null 2>&1; then
    log "Удаляю базу и роль PostgreSQL '$PG_DB'/'$PG_USER'"
    sudo -u postgres psql -c "DROP DATABASE IF EXISTS ${PG_DB};" 2>/dev/null || warn "Не удалось удалить базу (возможно, есть активные подключения)."
    sudo -u postgres psql -c "DROP ROLE IF EXISTS ${PG_USER};" 2>/dev/null || warn "Не удалось удалить роль."
  else
    warn "PostgreSQL не найден — пропуск удаления базы."
  fi
else
  warn "База PostgreSQL сохранена."
fi

# --- Пользователь ------------------------------------------------------------
if [ "$REMOVE_USER" = "1" ]; then
  if id -u "$APP_USER" >/dev/null 2>&1; then
    log "Удаляю пользователя $APP_USER"
    userdel "$APP_USER" 2>/dev/null || warn "Не удалось удалить пользователя $APP_USER."
    [ -d "/home/$APP_USER" ] && rm -rf "/home/$APP_USER"
  fi
fi

# --- Пакеты (опционально) ----------------------------------------------------
if [ "$REMOVE_PKGS" = "1" ]; then
  warn "Удаляю пакеты nginx/postgresql/redis. Это затронет ВСЮ систему!"
  export DEBIAN_FRONTEND=noninteractive
  apt-get purge -y nginx nginx-common postgresql postgresql-client redis-server 2>/dev/null || true
  apt-get autoremove -y 2>/dev/null || true
fi

echo
log "Готово. warehouse-queue удалён (варианты: $VARIANT)."
[ "$PURGE_DATA" != "1" ] && echo "  Данные оставлены. Полная очистка: sudo PURGE_DATA=1 DROP_DB=1 REMOVE_USER=1 bash uninstall.sh"
