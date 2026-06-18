# Деплой через Docker

Полный стек: **app** (Node) + **PostgreSQL** + **Redis** + **nginx** (reverse-proxy с HTTPS) + **certbot** (авто-TLS Let's Encrypt).

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

# Автодеплой из GitHub (CI/CD)

Workflow `.github/workflows/deploy.yml`: при push в ветку `main` GitHub Actions собирает Docker-образ, публикует его в **GHCR** (`ghcr.io`) и по **SSH** обновляет контейнер на сервере (`git pull` конфигов → `docker compose pull app` → `up -d`). Образы БД/Redis/nginx при этом не трогаются — обновляется только `app`.

## Что нужно один раз настроить

### 1. Сервер (разовая ручная инициализация)

Сервер должен быть готов как при обычном деплое (см. выше), но клонированный из GitHub, и `app` должен запускаться из образа GHCR:

```bash
git clone https://github.com/ВАШ_ЛОГИН/warehouse-queue.git
cd warehouse-queue
cp .env.example .env && nano .env       # заполнить + добавить строку:
#   APP_IMAGE=ghcr.io/ваш_логин/warehouse-queue:latest   (всё в нижнем регистре)
docker compose build                    # или сразу pull, если образ уже в GHCR
./deploy/init-letsencrypt.sh            # выпуск TLS (разово)
docker compose up -d
```

### 2. Секреты репозитория GitHub

**Settings → Secrets and variables → Actions → New repository secret:**

| Секрет | Значение |
|--------|----------|
| `SSH_HOST` | IP/домен сервера |
| `SSH_USER` | пользователь SSH |
| `SSH_KEY` | приватный SSH-ключ (весь, с заголовками `-----BEGIN ...`) |
| `SSH_PORT` | порт SSH, если не 22 (иначе можно не задавать) |
| `DEPLOY_PATH` | путь к папке проекта на сервере (где `docker-compose.yml`) |
| `GHCR_PAT` | GitHub Personal Access Token с правом `read:packages` — чтобы сервер скачивал приватный образ |

`GITHUB_TOKEN` для публикации образа создаётся автоматически — отдельно настраивать не нужно.

### 3. Доступ к образу

По умолчанию пакет в GHCR **приватный** — поэтому на сервере нужен `GHCR_PAT` для `docker login` (workflow делает это сам). Если сделать пакет публичным (GitHub → Packages → пакет → Package settings → Change visibility → Public), `GHCR_PAT` можно не задавать, но тогда уберите строку `docker login` из workflow.

## Как это работает после настройки

```
git push origin main
   └─► GitHub Actions:
        1) build образа из Dockerfile
        2) push в ghcr.io/ваш_логин/warehouse-queue:latest и :<sha>
        3) SSH на сервер: git reset --hard origin/main → docker compose pull app → up -d
```

Запустить деплой вручную можно кнопкой **Run workflow** на вкладке Actions (триггер `workflow_dispatch`).

## Заметки

- Деплой обновляет и конфиги (`docker-compose.yml`, nginx-шаблон) через `git reset --hard origin/main`; ваш `.env` не затрагивается (он в `.gitignore`).
- Образ собирается под `linux/amd64`. Если сервер ARM — добавьте в шаг сборки `platforms: linux/arm64`.
- Откат: на сервере `APP_IMAGE=ghcr.io/...:<нужный_sha>` и `docker compose up -d app` (образы тегируются и по SHA коммита).
