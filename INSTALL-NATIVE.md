# Установка без Docker (native)

Ставит warehouse-queue прямо на сервер (Ubuntu/Debian) без контейнеров: **Node.js + PostgreSQL + Redis + nginx + Let's Encrypt + systemd**, с тем же git-автодеплоем.

## Быстрый старт (чистый сервер, под root)

```bash
curl -fsSL https://raw.githubusercontent.com/mnazarow/warehouse-queue/main/deploy/install-native.sh -o install-native.sh
sudo bash install-native.sh
```

Скрипт спросит домен, e-mail и пароль PostgreSQL. Предусловия: DNS домена уже указывает на сервер, открыты порты 80/443.

## Что делает `deploy/install-native.sh`

1. Ставит системные пакеты: Node.js 20, build-essential/python3 (для сборки `better-sqlite3`), PostgreSQL, Redis, nginx, certbot.
2. Создаёт системного пользователя `warehouse`, клонирует репозиторий в `/opt/warehouse-queue`, ставит зависимости (`npm ci`).
3. Создаёт роль и базу `warehouse` в PostgreSQL.
4. Пишет `/etc/warehouse-queue.env` (порт, `DB_PATH`, `SESSION_SECRET`, реквизиты PG/Redis, `TRUST_PROXY`).
5. Регистрирует systemd-сервис `warehouse-queue` (автозапуск, рестарт при падении).
6. Настраивает nginx как reverse-proxy на `127.0.0.1:3000` и выпускает TLS через `certbot --nginx` (+ редирект на HTTPS).
7. Ставит systemd-таймер автодеплоя.

## Автодеплой

`deploy/auto-deploy-native.sh` + systemd-таймер каждые ~3 минуты проверяют GitHub; при новом коммите: `git pull`, при изменении зависимостей — `npm ci`, и `systemctl restart warehouse-queue`.

```bash
systemctl status warehouse-queue                 # состояние приложения
journalctl -u warehouse-queue -f                 # логи приложения
systemctl list-timers warehouse-queue-deploy.timer
journalctl -u warehouse-queue-deploy.service -f  # логи автодеплоя
systemctl start warehouse-queue-deploy.service   # выкатить сейчас
```

## База данных

По умолчанию приложение работает на **SQLite** (файл в `/var/lib/warehouse-queue/`). Реквизиты PostgreSQL уже прописаны; чтобы перейти на PG — в кабинете: **Настройки → PostgreSQL → Мигрировать → Переключиться**. Redis-кэш включён сразу.

## Полезное

- Сменить настройки окружения: отредактируйте `/etc/warehouse-queue.env` и `systemctl restart warehouse-queue`.
- Сменить пароль `admin/admin123` после первого входа — обязательно (репозиторий публичный).
- Бэкап SQLite: файл `/var/lib/warehouse-queue/warehouse.db`. Бэкап PG: `sudo -u postgres pg_dump warehouse > backup.sql`.
