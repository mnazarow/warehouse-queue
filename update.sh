#!/bin/bash
set -euo pipefail

# ============================================================
# Warehouse Queue System — Update Script
# ============================================================
# Обновляет приложение с резервной копией, перезапуском и
# проверкой работоспособности. Понимает три способа запуска:
# systemd-сервис, docker compose и обычный «node server.js».
#
# Использование:
#   ./update.sh                          # git pull + перезапуск
#   ./update.sh --branch main            # обновиться с другой ветки
#   ./update.sh --source /path/to/new    # обновление из папки (без git)
#   ./update.sh --mode systemd|docker|manual   # способ перезапуска вручную
#   ./update.sh --port 3000              # порт для проверки после запуска
#   ./update.sh --no-backup              # без резервной копии (не советуем)
#   ./update.sh --no-restart             # только обновить файлы
#   ./update.sh --rollback               # откат кода на последнюю копию
#   ./update.sh --help
#
# Резервные копии: backups/updates/UPDATE-<дата>/ (код + файлы SQLite).
# База данных при откате НЕ трогается — откатывается только код.
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log()  { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
err()  { echo -e "${RED}[✗]${NC} $1"; }
info() { echo -e "${CYAN}[i]${NC} $1"; }
die()  { err "$1"; exit 1; }

SERVICE_NAME="warehouse-queue"
BACKUP_ROOT="$SCRIPT_DIR/backups/updates"
KEEP_BACKUPS=5

DO_BACKUP=true
DO_RESTART=true
DO_ROLLBACK=false
BRANCH=""
SOURCE_DIR=""
MODE=""            # systemd | docker | manual (пусто = определить самим)
PORT="${PORT:-}"

usage() { sed -n '5,24p' "$0" | sed 's/^# \{0,1\}//'; exit 0; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --help|-h)     usage ;;
    --no-backup)   DO_BACKUP=false; shift ;;
    --no-restart)  DO_RESTART=false; shift ;;
    --rollback)    DO_ROLLBACK=true; shift ;;
    --branch)      BRANCH="${2:-}"; shift 2 ;;
    --source)      SOURCE_DIR="${2:-}"; shift 2 ;;
    --mode)        MODE="${2:-}"; shift 2 ;;
    --port)        PORT="${2:-}"; shift 2 ;;
    *) die "Неизвестный параметр: $1 (см. ./update.sh --help)" ;;
  esac
done

# ------------------------------------------------------------
# Порт приложения: параметр → .env → окружение → 3000
# ------------------------------------------------------------
if [ -z "$PORT" ] && [ -f .env ]; then
  PORT="$(grep -E '^PORT=' .env | tail -1 | cut -d= -f2 | tr -d '[:space:]' || true)"
fi
PORT="${PORT:-3000}"

# ------------------------------------------------------------
# Как запущено приложение (для перезапуска)
# ------------------------------------------------------------
detect_mode() {
  if [ -n "$MODE" ]; then echo "$MODE"; return; fi
  if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files 2>/dev/null | grep -q "^${SERVICE_NAME}\.service"; then
    echo systemd; return
  fi
  if [ -f docker-compose.yml ] && command -v docker >/dev/null 2>&1 \
     && docker compose ps --status=running 2>/dev/null | grep -q .; then
    echo docker; return
  fi
  echo manual
}

# ------------------------------------------------------------
# Проверка работоспособности: публичный список складов
# ------------------------------------------------------------
health_check() {
  local tries=${1:-20}
  info "Проверяю доступность приложения на порту ${PORT}..."
  for i in $(seq 1 "$tries"); do
    if curl -fsS -m 3 "http://127.0.0.1:${PORT}/api/warehouses" >/dev/null 2>&1; then
      log "Приложение отвечает (попытка $i)"
      return 0
    fi
    sleep 1
  done
  return 1
}

restart_app() {
  local mode="$1"
  case "$mode" in
    systemd)
      info "Перезапускаю systemd-сервис ${SERVICE_NAME}..."
      sudo systemctl restart "$SERVICE_NAME"
      ;;
    docker)
      info "Пересобираю и перезапускаю docker compose..."
      docker compose up -d --build
      ;;
    manual)
      info "Перезапускаю node server.js..."
      # Убиваем ВСЕ процессы node server.js: если их два (старый держит порт),
      # новый не сможет подняться, а старый продолжит отдавать старый код.
      local pids pid
      pids="$(pgrep -f 'node .*server\.js' || true)"
      if [ -n "$pids" ]; then
        info "Найдены процессы: $(echo $pids | tr '\n' ' ')"
        for pid in $pids; do kill "$pid" 2>/dev/null || true; done
        for _ in $(seq 1 10); do pgrep -f 'node .*server\.js' >/dev/null 2>&1 || break; sleep 0.5; done
        for pid in $pids; do kill -9 "$pid" 2>/dev/null || true; done
        sleep 1
      else
        warn "Работающий процесс не найден — просто запускаю новый"
      fi
      nohup node server.js >> server.log 2>&1 &
      log "Запущен node server.js (PID $!), лог: server.log"
      ;;
    *) die "Неизвестный режим перезапуска: $mode" ;;
  esac
}

# ------------------------------------------------------------
# Резервная копия: код (без node_modules/.git/backups) + SQLite
# ------------------------------------------------------------
make_backup() {
  local stamp dir
  stamp="$(date +%Y%m%d-%H%M%S)"
  dir="$BACKUP_ROOT/UPDATE-$stamp"
  mkdir -p "$dir"
  info "Резервная копия: $dir"
  tar --exclude='./node_modules' --exclude='./.git' --exclude='./backups' \
      --exclude='./server.log' --exclude='./warehouse.db*' \
      -czf "$dir/code.tar.gz" .
  # Файлы SQLite (если есть; при PostgreSQL их просто нет)
  local f
  for f in warehouse.db warehouse.db-wal warehouse.db-shm; do
    [ -f "$f" ] && cp -p "$f" "$dir/" || true
  done
  # Отметка версии для журнала
  {
    echo "date: $(date '+%Y-%m-%d %H:%M:%S')"
    if [ -d .git ]; then echo "git: $(git rev-parse HEAD 2>/dev/null || echo '-')"; fi
  } > "$dir/INFO.txt"
  log "Копия создана"
  # Держим только последние $KEEP_BACKUPS копий
  ls -1dt "$BACKUP_ROOT"/UPDATE-* 2>/dev/null | tail -n +$((KEEP_BACKUPS + 1)) | while read -r old; do
    rm -rf "$old"
    info "Удалена старая копия: $(basename "$old")"
  done
}

latest_backup() {
  ls -1dt "$BACKUP_ROOT"/UPDATE-* 2>/dev/null | head -1
}

# ------------------------------------------------------------
# Откат кода на последнюю копию (база не трогается)
# ------------------------------------------------------------
do_rollback() {
  local dir
  dir="$(latest_backup)"
  [ -n "$dir" ] || die "Копий для отката нет (ищу в $BACKUP_ROOT)"
  warn "Откатываю код на копию: $(basename "$dir")"
  tar -xzf "$dir/code.tar.gz" -C "$SCRIPT_DIR"
  log "Код восстановлен"
  if $DO_RESTART; then
    local mode; mode="$(detect_mode)"
    restart_app "$mode"
    health_check 30 || die "Приложение не поднялось после отката — смотрите логи"
  fi
  log "Откат завершён"
  exit 0
}

$DO_ROLLBACK && do_rollback

# ------------------------------------------------------------
# Обновление кода: git pull либо копирование из --source
# ------------------------------------------------------------
PKG_HASH_BEFORE=""
[ -f package-lock.json ] && PKG_HASH_BEFORE="$(cksum package-lock.json package.json 2>/dev/null || true)"

update_from_git() {
  command -v git >/dev/null 2>&1 || die "git не установлен"
  [ -d .git ] || die "Это не git-репозиторий. Обновляйтесь из папки: ./update.sh --source /путь/к/новой/версии"
  local branch="$BRANCH"
  [ -n "$branch" ] || branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)"
  if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
    warn "В рабочей папке есть локальные изменения — git может отказать в обновлении."
    warn "Они сохранены в резервной копии; при конфликте: git stash → ./update.sh → git stash pop"
  fi
  info "git pull --ff-only origin $branch"
  git fetch origin "$branch"
  local before after
  before="$(git rev-parse HEAD)"
  git pull --ff-only origin "$branch"
  after="$(git rev-parse HEAD)"
  if [ "$before" = "$after" ]; then
    log "Уже установлена последняя версия ($(git rev-parse --short HEAD))"
  else
    log "Обновлено: ${before:0:7} → ${after:0:7}"
  fi
}

update_from_source() {
  [ -d "$SOURCE_DIR" ] || die "Папка не найдена: $SOURCE_DIR"
  [ -f "$SOURCE_DIR/server.js" ] || die "В $SOURCE_DIR нет server.js — это точно папка с новой версией?"
  info "Копирую файлы из $SOURCE_DIR..."
  if command -v rsync >/dev/null 2>&1; then
    rsync -a \
      --exclude 'node_modules' --exclude '.git' --exclude 'backups' \
      --exclude 'warehouse.db' --exclude 'warehouse.db-wal' --exclude 'warehouse.db-shm' \
      --exclude '.env' --exclude 'server.log' \
      "$SOURCE_DIR"/ "$SCRIPT_DIR"/
  else
    ( cd "$SOURCE_DIR" && tar --exclude='./node_modules' --exclude='./.git' --exclude='./backups' \
        --exclude='./warehouse.db*' --exclude='./.env' --exclude='./server.log' -cf - . ) \
      | tar -xf - -C "$SCRIPT_DIR"
  fi
  log "Файлы обновлены (база данных и .env не тронуты)"
}

if $DO_BACKUP; then make_backup; else warn "Резервная копия пропущена (--no-backup)"; fi

if [ -n "$SOURCE_DIR" ]; then
  update_from_source
else
  update_from_git
fi

# ------------------------------------------------------------
# Зависимости: только если менялись package.json / package-lock.json
# ------------------------------------------------------------
PKG_HASH_AFTER=""
[ -f package-lock.json ] && PKG_HASH_AFTER="$(cksum package-lock.json package.json 2>/dev/null || true)"
if [ "$PKG_HASH_BEFORE" != "$PKG_HASH_AFTER" ]; then
  info "Зависимости изменились — npm ci..."
  if npm ci --omit=dev; then
    log "Зависимости установлены (npm ci)"
  else
    warn "npm ci не прошёл, пробую npm install..."
    npm install --omit=dev
    log "Зависимости установлены (npm install)"
  fi
else
  log "Зависимости не менялись — npm пропущен"
fi

# ------------------------------------------------------------
# Перезапуск и проверка. Новые таблицы/колонки БД приложение
# досоздаёт само при старте (ensureFeatureSchema) — миграции не нужны.
# ------------------------------------------------------------
if ! $DO_RESTART; then
  warn "Перезапуск пропущен (--no-restart). Не забудьте перезапустить приложение!"
  exit 0
fi

APP_MODE="$(detect_mode)"
info "Режим перезапуска: $APP_MODE"
restart_app "$APP_MODE"

if health_check 30; then
  log "Обновление завершено успешно"
  echo
  info "Если что-то пошло не так: ./update.sh --rollback"
else
  err "Приложение не отвечает после обновления!"
  case "$APP_MODE" in
    systemd) err "Логи: sudo journalctl -u $SERVICE_NAME -n 50" ;;
    docker)  err "Логи: docker compose logs --tail 50" ;;
    manual)  err "Логи: tail -50 server.log" ;;
  esac
  err "Откат кода на предыдущую версию: ./update.sh --rollback"
  exit 1
fi
