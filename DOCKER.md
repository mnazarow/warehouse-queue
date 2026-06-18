# Деплой через Docker

Полный стек: **app** (Node) + **PostgreSQL** + **Redis** + **nginx** (reverse-proxy с HTTPS) + **certbot** (авто-TLS Let's Encrypt).

---

## ⭐ Быстрый старт на чистом сервере (рекомендуется)

Один скрипт ставит Docker, клонирует публичный репозиторий, поднимает весь стек с HTTPS и настраивает **автодеплой** (сервер сам тянет изменения из GitHub и пересобирается). На свежем Ubuntu/Debian-сервере под root:

```bash
curl -fsSL https://raw.githubusercontent.com/mnazarow/warehouse-queue/main/deploy/server-setup.sh -o server-setup.sh
sudo bash server-setup.sh
```

Скрипт спросит домен, e-mail и пароль PostgreSQL — остальное (`SESSION_SECRET`, TLS, systemd-таймер) настроит сам. Предусловия: DNS домена уже указывает на сервер, открыты порты 80/443.

После установки **каждый `git push` в `main`** автоматически выкатывается: systemd-таймер каждые ~3 минуты проверяет GitHub и при новом коммите делает `git pull` + `docker compose up -d --build`.

```bash
systemctl list-timers warehouse-queue-deploy.timer    # расписание
journalctl -u warehouse-queue-deploy.service -f       # логи автодеплоя
systemctl start warehouse-queue-deploy.service        # выкатить прямо сейчас
```

Эта модель не требует ни токенов, ни GHCR, ни секретов — образ собирается на сервере из публичного репозитория. Ниже — ручной вариант и альтернатива через GHCR + Watchtower.

---

```
warehouse-queue/
├── Dockerfile                     # образ приложения (Node 20 + psql + сборка better-sqlite3)
├── docker-compose.yml             # app + postgres + redis + nginx + certbot
├── .dockerignore
├── .env.example                   # шаблон переменных окружения
└── deploy/
    ├── nginx/app.conf.template    # конфиг nginx (HTTP→HTTPS, проксирование на app:3000)
    └── init-letsencrypt.sh        # разовый выпуск TLS-сертификата
```

## Требования

- Docker и Docker Compose v2 на сервере.
- Доменное имя с DNS-записью **A/AAAA на IP этого сервера** (нужно ещё до выпуска сертификата).
- Открытые порты **80** и **443**.

## Шаги

```bash
cd warehouse-queue

# 1. Переменные окружения
cp .env.example .env
nano .env          # DOMAIN, CERTBOT_EMAIL, SESSION_SECRET, пароль POSTGRES_PASSWORD
#   SESSION_SECRET сгенерировать: openssl rand -hex 32

# 2. Собрать образ
docker compose build

# 3. Выпустить TLS-сертификат (разово). Для теста сначала со staging:
STAGING=1 ./deploy/init-letsencrypt.sh
#   убедились, что выпуск проходит — повторить уже без STAGING:
./deploy/init-letsencrypt.sh

# 4. Поднять весь стек
docker compose up -d

# 5. Логи / статус
docker compose ps
docker compose logs -f app
```

Кабинет менеджера: `https://ВАШ_ДОМЕН/manager.html` — логин `admin`, пароль `admin123` (смените!).

## Что происходит автоматически

- **SQLite по умолчанию.** База лежит в томе `app_data` (`/app/data/warehouse.db`) и переживает пересоздание контейнера.
- **Подключения к Postgres/Redis засеяны из env** (`SEED_CONNECTORS=1`): в настройках приложения уже прописаны `host=postgres` и `host=redis`. Redis-кэш включён сразу.
- **nginx** терминирует HTTPS и проксирует на `app:3000`, передавая реальный IP клиента (`X-Forwarded-For`); приложение доверяет прокси (`TRUST_PROXY=1`), поэтому работают IP-ограничения кабинета.
- **certbot** автоматически продлевает сертификат (проверка каждые 12 ч).

## Переключение на PostgreSQL

По умолчанию приложение работает на SQLite. Чтобы перейти на PostgreSQL (контейнер уже поднят, реквизиты засеяны):

1. Войдите в кабинет → **Настройки → PostgreSQL**.
2. Нажмите **Мигрировать в PostgreSQL** (создаст схему и перенесёт данные).
3. Нажмите **Переключиться на PostgreSQL**.

Хост/порт/база/пользователь/пароль уже заполнены значениями из `.env`. После переключения настройка `db_type` сохранится, и при перезапуске контейнера приложение само подключится к Postgres.

## Доступ к кабинету по IP

Кабинет менеджера и кладовщика ограничены списком разрешённых подсетей (`allowed_networks`). За nginx приложение видит реальный IP клиента. Если после деплоя кабинет отдаёт «Access denied» — добавьте свою сеть: временно зайдите с сервера (loopback разрешён) либо отредактируйте список в БД.

## Обслуживание

```bash
# Обновить приложение после изменений кода
docker compose build app && docker compose up -d app

# Бэкап PostgreSQL
docker compose exec postgres pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" > backup.sql

# Бэкап SQLite-тома
docker compose cp app:/app/data/warehouse.db ./warehouse.db.bak

# Остановить / удалить (тома с данными сохраняются)
docker compose down

# Полностью удалить вместе с данными (ОСТОРОЖНО)
docker compose down -v
```

## Переменные окружения (.env)

| Переменная | Назначение |
|-----------|-----------|
| `DOMAIN` | Домен для nginx/сертификата |
| `CERTBOT_EMAIL` | Почта для уведомлений Let's Encrypt |
| `SESSION_SECRET` | Секрет сессий Express |
| `POSTGRES_DB` / `POSTGRES_USER` / `POSTGRES_PASSWORD` | Реквизиты PostgreSQL (используются и сервисом БД, и сидингом настроек приложения) |

Дополнительно (необязательно): `INSECURE_1C_TLS=1` — отключить проверку TLS-сертификата при интеграции с 1С (если у 1С самоподписанный сертификат).

---

# Альтернатива: деплой через GHCR + Watchtower (CI/CD)

> Это **необязательный** вариант вместо git-pull-сборки выше. Здесь образ собирает GitHub Actions и кладёт в GHCR, а на сервере его подхватывает Watchtower (контейнер запускается профилем: `docker compose --profile ghcr up -d`). Подходит, если не хотите собирать образ на самом сервере. Для чистого сервера проще использовать `server-setup.sh` (раздел в начале).

Схема без SSH из CI:

```
git push origin main
   └─► GitHub Actions (.github/workflows/deploy.yml):
         build образа → push в ghcr.io/ваш_логин/warehouse-queue:latest и :<sha>

на сервере:
   Watchtower каждые 5 мин проверяет GHCR → при новом образе сам
   пере-создаёт контейнер app (БД/Redis/nginx не трогаются)
```

CI только **публикует образ** в GHCR (использует автоматический `GITHUB_TOKEN`, отдельные секреты не нужны). Развёртывание на сервере делает **Watchtower** — контейнер из `docker-compose.yml`, который следит за образом `app` и обновляет только его.

## Развёртывание на чистом сервере — одной командой

На сервере должны быть установлены Docker + `docker compose`, открыты порты 80/443, и DNS домена уже указывать на сервер.

Скопируйте на сервер один файл и запустите — он склонирует остальное с GitHub, создаст `.env`, выпустит TLS и поднимет весь стек:

```bash
scp deploy/bootstrap.sh user@server:/tmp/
ssh user@server 'bash /tmp/bootstrap.sh'
```

Скрипт спросит: репозиторий (`owner/name`), GitHub-токен (`repo` + `read:packages` — для клона приватного репозитория и скачивания образа), путь установки, домен, e-mail, пароль PostgreSQL. Остальное (`SESSION_SECRET`, `APP_IMAGE`, логин в GHCR) настроит сам.

После этого деплой полностью автоматический: `git push` → CI собирает образ → Watchtower подхватывает его на сервере.

## Доступ к образу (GHCR)

По умолчанию пакет в GHCR **приватный**, поэтому сервер логинится в `ghcr.io` (это делает `bootstrap.sh`), а Watchtower читает креды из `~/.docker/config.json` (примонтирован в контейнер). Токену достаточно прав `read:packages`. Если сделать пакет публичным (GitHub → Packages → Package settings → Change visibility → Public) — логин и токен не нужны.

## Откат к предыдущей версии

Образы тегируются и по SHA коммита. На сервере:

```bash
cd /opt/warehouse-queue
# зафиксировать конкретную версию (иначе Watchtower вернёт :latest)
sed -i 's#^APP_IMAGE=.*#APP_IMAGE=ghcr.io/ваш_логин/warehouse-queue:<sha>#' .env
docker compose up -d app
```

## Заметки

- Образ собирается под `linux/amd64`. Если сервер ARM — добавьте в шаг сборки workflow `platforms: linux/arm64` (через `docker/build-push-action`).
- Watchtower обновляет **только** `app` (по метке `com.centurylinklabs.watchtower.enable=true`); образы БД/Redis/nginx закреплены и не трогаются.
- Изменения в `docker-compose.yml`/nginx-шаблоне Watchtower НЕ применяет (он работает на уровне образа `app`). Для них на сервере: `git pull && docker compose up -d`.
- Интервал проверки Watchtower меняется через `WATCHTOWER_POLL_INTERVAL` (секунды) в `docker-compose.yml`.
