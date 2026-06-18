# Warehouse Queue System

Система онлайн-записи на склад с кабинетом менеджера, интеграцией с 1С, SMS-уведомлениями, Redis-кэшированием и поддержкой двух СУБД (SQLite / PostgreSQL).

## Архитектура

```
warehouse-queue/
├── server.js                 # Express-сервер, API, Redis, миграции БД
├── database.js               # Инициализация SQLite, миграции схемы, хелперы
├── db-adapter.js             # Прокси-адаптер SQLite ↔ PostgreSQL
├── package.json
├── warehouse.db              # SQLite-файл БД (создаётся автоматически)
├── public/
│   ├── manager.html          # SPA кабинет менеджера
│   └── logos/                # Логотипы для тем оформления
└── node_modules/
```

### Компоненты

| Компонент | Технология | Назначение |
|-----------|-----------|------------|
| **Сервер** | Node.js 12 + Express 4 | REST API, сессии, статика |
| **Основная БД** | SQLite (better-sqlite3) | Хранение всех данных |
| **Альтернативная БД** | PostgreSQL 14 (через psql) | Опциональный бэкенд |
| **Кэш** | Redis 3 (опционально) | Кэширование GET-запросов |
| **Фронтенд** | HTML+CSS+JS (одна страница) | Кабинет менеджера |

## Быстрый старт

```bash
cd warehouse-queue
npm install
node server.js
```

Сервер запускается на `http://0.0.0.0:3000`.

### Учётные данные по умолчанию

- **Логин:** `admin`
- **Пароль:** `admin123`

## Режимы работы с БД

Система поддерживает два бэкенда с переключением на лету:

| Режим | Как работает |
|-------|-------------|
| **SQLite** (по умолчанию) | Прямые синхронные запросы через better-sqlite3 |
| **PostgreSQL** | SQL-запросы транслируются и выполняются через psql (stdin) |

### Переключение БД

В кабинете менеджера: **Настройки → PostgreSQL → Переключиться на PostgreSQL / SQLite**.

Перед переключением необходимо выполнить миграцию данных (кнопка **Мигрировать в PostgreSQL**), чтобы создать схему и перенести все записи. Миграция не затрагивает работу системы — данные копируются в фоне.

При переключении:
1. Проверяется доступность целевой БД (psql, таймаут 10 с)
2. Адаптер `db-adapter.js` меняет active backend
3. Все последующие запросы идут через новую БД
4. Настройка `db_type` сохраняется в `settings` таблицы SQLite

После перезапуска сервер читает `db_type` и автоматически подключается к нужной БД.

### Миграция данных

- **SQLite → PostgreSQL:** DDL (CREATE TABLE + индексы) формируется динамически через `PRAGMA table_info`, данные вставляются батчами по 200 строк. После миграции можно переключиться.
- **PostgreSQL → SQLite:** Данные выгружаются через `row_to_json`, парсятся и вставляются в SQLite.

### Трансляция SQL (PostgreSQL-режим)

Адаптер автоматически преобразует SQLite-специфичный синтаксис:

| SQLite | PostgreSQL |
|--------|-----------|
| `INSERT OR REPLACE INTO settings ...` | `INSERT INTO settings ... ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value` |
| `datetime('now')` | `CURRENT_TIMESTAMP` |
| `GROUP_CONCAT(DISTINCT x)` | `string_agg(DISTINCT x, ',')` |
| `?` (placeholder) | Значение подставляется напрямую с экранированием |
| `PRAGMA table_info` | Не поддерживается (используется только при миграции) |

## API endpoints

### Аутентификация

| Метод | Путь | Описание |
|-------|------|----------|
| POST | `/api/manager/login` | Вход |
| POST | `/api/manager/logout` | Выход |
| GET | `/api/manager/me` | Текущий менеджер |

### Слоты

| Метод | Путь | Описание |
|-------|------|----------|
| GET | `/api/manager/slots` | Список слотов (с фильтрацией) |
| POST | `/api/manager/slots/:id/take` | Взять запись |
| POST | `/api/manager/slots/:id/confirm` | Подтвердить |
| POST | `/api/manager/slots/:id/assemble` | На сборку |
| POST | `/api/manager/slots/:id/complete` | Завершить |
| POST | `/api/manager/slots/:id/cancel` | Отменить |
| POST | `/api/manager/slots/:id/return-from-assembly` | Вернуть со сборки |
| POST | `/api/manager/slots/:id/send-message` | Отправить SMS |

### Настройки

| Метод | Путь | Описание |
|-------|------|----------|
| GET | `/api/manager/settings/logging` | Настройки логирования |
| POST | `/api/manager/settings/logging` | Сохранить логирование |
| GET | `/api/manager/settings/redis` | Настройки Redis |
| POST | `/api/manager/settings/redis` | Сохранить Redis |
| POST | `/api/manager/settings/redis/test` | Проверить соединение с Redis |
| GET | `/api/manager/settings/pgsql` | Настройки PostgreSQL |
| POST | `/api/manager/settings/pgsql` | Сохранить PostgreSQL |
| GET | `/api/manager/settings/smsru` | Настройки SMS |
| POST | `/api/manager/settings/smsru` | Сохранить SMS |
| GET | `/api/manager/migration/status` | Статус обеих БД |

### Миграция и переключение

| Метод | Путь | Описание |
|-------|------|----------|
| POST | `/api/manager/migrate/to-pgsql` | Перенести данные из SQLite в PostgreSQL |
| POST | `/api/manager/migrate/to-sqlite` | Перенести данные из PostgreSQL в SQLite |
| POST | `/api/manager/switch/to-pgsql` | Переключить активную БД на PostgreSQL |
| POST | `/api/manager/switch/to-sqlite` | Переключить активную БД на SQLite |

### Справочники

| Метод | Путь | Описание |
|-------|------|----------|
| GET/POST | `/api/manager/storekeepers` | Кладовщики |
| GET/POST | `/api/manager/managers` | Менеджеры |
| GET/POST | `/api/manager/nomenclature` | Номенклатура |
| GET/POST | `/api/manager/categories` | Категории |
| GET/POST | `/api/manager/counterparties` | Контрагенты |
| GET/POST | `/api/manager/warehouses` | Склады |
| GET/POST | `/api/manager/drivers` | Водители |
| GET/POST | `/api/manager/vehicle-classes` | Классы машин |
| GET/POST | `/api/manager/load-types` | Виды загрузки |
| GET/POST | `/api/manager/banned-phones` | Забаненные телефоны |
| GET/POST | `/api/manager/banned-ips` | Забаненные IP |
| GET/POST | `/api/manager/networks` | Разрешённые подсети |
| GET/POST | `/api/manager/managers-1c` | Менеджеры из 1С |
| GET/POST | `/api/manager/engineers-1c` | Инженеры из 1С |
| GET/POST | `/api/manager/orders-1c` | Заказы 1С |
| GET/POST | `/api/manager/check-logs` | Логи проверки 1С |

## Redis-кэширование

Опционально. Включается в **Настройки → Redis**. Кэшируются GET-эндпоинты со следующими TTL:

| Данные | Эндпоинт | TTL |
|--------|----------|-----|
| Свободные слоты (страница записи) | `GET /api/slots` | 30 с |
| Слоты в кабинете менеджера | `GET /api/manager/slots` | 10 с |
| Брони / выполненные / архив | `GET /api/manager/bookings`, `/completed`, … | 30 с |
| Справочники (склады, номенклатура, контрагенты, классы машин и т.п.) | соответствующие GET | 300 с |
| Данные 1С (заказы, менеджеры, инженеры) | соответствующие GET | 30–300 с |

Ключи слотов имеют префикс `slots:` (публичные — `slots:public:<дата>:<тип>:<склад>`).

Флаг «просрочен/недоступен» (`past`) для свободных слотов **всегда вычисляется на лету** и не берётся из кэша — кэшируется только статус брони слота.

### Инвалидация

Кэш сбрасывается при любом write-запросе (POST/PUT/DELETE):
- любое изменение слота (бронирование, подтверждение, сборка, завершение, отмена) вызывает `redisFlushSlotsCache()` — удаляются все ключи `slots:*`, включая публичные;
- изменение справочника сбрасывает кэш по своему префиксу (`redisFlushByPrefix`).

## Темы оформления

Циклический переключатель: ☀️ → 💀 → 🌙 → 🐉 → 🌻 → 🍂 → ❄️ → 🌷 → ☀️

- **Светлая** — класс `.light-theme` (по умолчанию)
- **Cyberpunk 2077** — класс `.cyberpunk-theme`
- **Тёмная** — класс `.dark-theme`
- **Фэнтези** — класс `.fantasy-theme` (пурпур/изумруд/золото, серифные заголовки)
- **Сезонные** (`.summer/.autumn/.winter/.spring-theme` + общий `.season-theme`) — фоновые SVG-сцены: летнее поле, осенние листья, зимний лес, весна с голландской мельницей и гладиолусами; панели полупрозрачные для читабельности. Фоны встроены (data URI), внешних картинок не требуют.

Тема сохраняется в `localStorage('manager_theme')`. Для каждой темы можно загрузить отдельный логотип (`public/logos/{theme}.png`).

## Требования

- Node.js 12+
- npm 6+
- PostgreSQL 14+ (для PostgreSQL-режима, необязательно)
- Redis 5+ (для кэширования, необязательно)

## Переменные окружения

| Переменная | По умолчанию | Описание |
|-----------|-------------|----------|
| `PORT` | `3000` | Порт сервера |
