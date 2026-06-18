# Отчёт по проверке кода — warehouse-queue

Дата: 2026-06-18. Проверены `server.js`, `database.js`, `db-adapter.js`, `public/index.html`, `public/manager.html`, `private/storekeeper.html`. Синтаксис всех JS-файлов корректен. Ниже — конкретные ошибки, сгруппированные по критичности. Помечены ✅ — проверено вручную на коде.

---

## CRITICAL

**C1. `string_agg` транслируется с несбалансированной скобкой → страница «Водители» падает в PG** ✅
`db-adapter.js:57`. Замена даёт `string_agg(DISTINCT $1, ','` — нет закрывающей `)`. Запрос на `server.js:2192-2193` (`/api/manager/drivers`) превращается в синтаксически неверный SQL и всегда возвращает 500 в режиме PostgreSQL. Также не обрабатывается `GROUP_CONCAT` без `DISTINCT`.
Фикс: `"string_agg(DISTINCT $1::text, ',')"` + правило для формы без DISTINCT.

**C2. `INSERT OR REPLACE INTO settings` теряет upsert → пересохранение настроек падает в PG** ✅
`db-adapter.js:44` переписывает в обычный `INSERT INTO settings` без `ON CONFLICT`. `settings.key` — PRIMARY KEY, поэтому повторное сохранение существующего ключа (1С-токен, конфиг Redis/PG, SMS и др. — ~25 мест в server.js, напр. строки 892/902/912) даёт ошибку дубликата ключа. Первое сохранение нового ключа проходит, повторное — нет.
Фикс: `INSERT INTO settings (key,value) VALUES (...) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`.

**C3. Сквозной XSS во всех трёх HTML — данные клиента/1С вставляются в `innerHTML` без экранирования**
Хелпера экранирования нет нигде. Запись слота с именем/комментарием вида `<img src=x onerror=...>` выполнит скрипт в сессии менеджера/кладовщика. Представительные места (паттерн повторяется): `storekeeper.html:144-147`; `manager.html:1624-1628`, `1626`, `3370-3380`, `3446-3452`, `3557-3559` (журнал), `3284-3291` (вкл. атрибуты `title="${...}"`), `3610-3612`, `3238`, `2483/2300` (имя склада). Усугубляется тем, что на странице менеджера в инпутах лежат 1С-токен, пароли Redis/PG, ключ SMS — XSS их выгрузит.
Фикс: добавить `escapeHtml()` и обернуть все интерполируемые строки; для контекста атрибутов экранировать отдельно; либо строить DOM через `textContent`/`createElement`.

**C4. Утечка секретов в браузер**
PIN-коды кладовщиков отдаются в открытом виде в таблицу и форму (`manager.html:2817, 2904`) — а они авторизуют действия «завершить/собрать». Пароль менеджера сохраняется в localStorage в открытом виде и автоподставляется (`manager.html:1467-1468, 4716-4721`). Любой XSS (C3) их читает.
Фикс: не отправлять `pin_code` на клиент (проверка только на сервере); убрать хранение пароля, опираться на сессионную cookie.

---

## HIGH

**H1. `lastInsertRowid` не возвращается в PG → создание контрагента отдаёт `id: undefined`** ✅
`db-adapter.js:pgQueryRun` всегда возвращает `{changes:1}` без `lastInsertRowid`. `server.js:1760` отдаёт `id: info.lastInsertRowid`. Любая логика, завязанная на новый id, ломается. Также `changes:1` неверен для UPDATE/DELETE без совпадений.
Фикс: `INSERT ... RETURNING id` через `.get()` в PG; для `changes` парсить ответ psql.

**H2. `transaction()` в PG — пустой проброс, нет атомарности**
`db-adapter.js` для PG возвращает функцию без `BEGIN/COMMIT`, каждый стейтмент — отдельный процесс `psql`. `fillMissingSlots` и любые многошаговые операции не атомарны: сбой в середине оставляет БД наполовину записанной. Это же — корень бага «не все слоты» (частичная запись не откатывается). Плюс 30+ слотов = 30+ запусков psql (медленно).
Фикс: собирать пакет в один вызов psql, обёрнутый в `BEGIN; ... COMMIT;`.

**H3. Гонка двойного бронирования**
`server.js:619` проверяет `is_booked`, затем отдельный `UPDATE ... WHERE id=?` (стр. 636). Между проверкой и записью есть `await` (валидация 1С), поэтому два параллельных запроса могут оба пройти проверку и записаться — второй перетирает первого. Под PG транзакционной защиты нет вовсе.
Фикс: `UPDATE slots SET is_booked=1, ... WHERE id=? AND is_booked=0 RETURNING id` и проверять, что строка реально обновилась; иначе 409.

**H4. Миграция не переносит UNIQUE-ограничения в PG**
`generatePgCreateSQL` (`server.js:2473-2490`) берёт только `PRAGMA table_info` (даёт column-level PRIMARY KEY, но не inline UNIQUE), а `generatePgIndexes` отфильтровывает `sqlite_autoindex_*`. В итоге `categories.name`, `managers.username`, `orders_1c.orderNumber`, `managers_1c/engineers_1c.name` в PG создаются БЕЗ уникальности → возможны дубликаты, а `ON CONFLICT` по этим ключам не сработает.
Фикс: эмитить inline UNIQUE/PK в DDL миграции либо пересоздавать индексы явно.

**H5. `cancelSlot` не обновляет таблицу и глотает ошибки** — `manager.html:1858-1861`
В отличие от соседних действий, не проверяет `res.ok`/`data.success` и не вызывает `loadSlots()`. Слот висит «занятым» до автообновления (30 с).
Фикс: `const data = await res.json(); if (data.success) loadSlots();` + обработка ошибки.

**H6. Обработчики `res.json()` без проверки `res.ok` → необработанные исключения**
Многие функции (`confirmSlot`/`completeSlot`/`assembleSlot` без try/catch, `manager.html:1700-1701, 1765-1766, 1782-1783, 1814-1815, 3054-3055`; `storekeeper.html:102-103`) делают `await res.json()` и сразу читают вложенный массив. Ответ 500/HTML/`{error}` → throw, часто как unhandled rejection.
Фикс: проверять `res.ok` и наличие полей; оборачивать в try/catch.

**H7. Инъекционная поверхность адаптера: значения инлайнятся в SQL для psql**
`db-adapter.js:pgLiteral` экранирует только одинарные кавычки. При `standard_conforming_strings=off` обратный слэш перед кавычкой может разорвать литерал. Date-объекты → `String(date)` (неверное значение в timestamp), `NaN/Infinity` → невалидный SQL, boolean → `'1'/'0'`.
Фикс: перейти на реальный параметризованный клиент `pg` ($1) либо: экранировать `\`, форматировать Date в ISO, проверять `Number.isFinite`, форсить `standard_conforming_strings=on`.

---

## MEDIUM

**M1. `pgQueryAll`/`pgQueryGet` молча теряют строки на переносах** — `db-adapter.js`
Вывод psql режется по `\n` и каждая строка `JSON.parse` в `try{}catch{}` без логирования. Значение с переносом строки (напр. `customer_comment`) ломает JSON фрагмента → строка тихо выпадает. Затрагивает таблицы броней/заказов с многострочными комментариями.
Фикс: получать один JSON-документ через `json_agg(...)`/`COPY ... TO STDOUT` и парсить один раз.

**M2. CTE не попадают в JSON-обёртку** — `db-adapter.js`
Тест `/^\s*SELECT/i` не ловит `WITH ... SELECT`, такие запросы уходят в ветку «не-SELECT» и возвращают `null/[]`. `;`-strip срезает только один хвостовой `;`.
Фикс: проверять `^\s*(SELECT|WITH)`.

**M3. Нет защиты от двойного сабмита брони** — `index.html:116, 371-447`
`confirmBooking/forceBooking` не блокируют `#bookBtn`. Двойной клик/медленная сеть → два POST на `/book`.
Фикс: отключать кнопку на входе, включать в `finally`.

**M4. Экранирование кавычек в inline-`onclick` неполное**
Часть обработчиков экранирует только `'`, не `"`/`\` (`manager.html:3384, 1586, 1593, 3610, 3620`), часть — ничего (`index.html:253`). Значение с `\` ломает сгенерированный JS.
Фикс: строить кнопки через `addEventListener` + data-атрибуты.

**M5. `rejectUnauthorized: false` на всех HTTPS-вызовах к 1С** — `server.js:234, 313, 363, 1008, 1081, 1147`
Отключена проверка TLS-сертификата → MITM при удалённом 1С.
Фикс: включить проверку или использовать доверенный CA.

**M6. Поле `phone` для бан-чека тримится, а в слот пишется нетримленым** — `server.js:505 vs 637`
Бан можно обойти, добавив пробел.
Фикс: нормализовать `phone = phone.trim()` один раз и использовать везде.

**M7. Хост/порт/БД PostgreSQL берутся из settings без валидации** — `server.js` (настройки PG)
`execFile` защищает от shell-инъекции, но менеджер может задать произвольный `pgsql_host`/`database` → подключение к чужой БД (SSRF-подобный вектор).
Фикс: валидировать host/port/db/user по allowlist/regex перед сохранением.

---

## LOW

- **L1. Порядок в `confirmBooking`** — `index.html:433-441`: `closeModal()` обнуляет `selectedSlotId` до `querySelector('.slot[data-id="..."]')`, поэтому только что забронированный слот не помечается «занят», а в окне успеха пустое время. Захватить id в локальную переменную до `closeModal()`.
- **L2. Мёртвый код** `parseRows`/`parseSingleRow` всегда возвращают `[]` — удалить (`db-adapter.js`).
- **L3. Секрет сессии захардкожен** — `server.js:28` `'warehouse-queue-secret-key-2025'`. Вынести в переменную окружения.
- **L4. Капча без rate-limit** — `server.js` `/book`: перебор 1–40 тривиален. Добавить лимит попыток.
- **L5. Нет CSRF-токена** на мутациях менеджера (cookie + `credentials:'include'`). Проверить `SameSite`/добавить CSRF.
- **L6. `session.destroy()` без колбэка** (`server.js:674`) — безвредно.
- **L7. `ipToInt` не поддерживает IPv6** — `server.js:~1323`: IPv6-клиент против IPv4-подсети парсится как `NaN`.
- **L8. `isWeekday`/`getDay()`** зависят от таймзоны процесса; если TZ сервера ≠ бизнес-TZ, у дат у полуночи возможны расхождения.

---

## Проверено и НЕ является ошибкой
- Все колонки, используемые в запросах (`assembling`, `warehouse_id`, `customer_organization`, `vehicle_class_id`, `load_type_id`, `storekeeper_id`, `readyStatus`, `notReadyReason`, `customer_ip`, `customer_user_agent`), создаются в CREATE TABLE или ALTER TABLE-миграциях.
- `generateSlotsForDate`/`fillMissingSlots` — тайм-математика и идемпотентность корректны (для SQLite проверено тестом); чистка legacy 09:* удаляет только незабронированные.
- Upsert-хелперы (`upsertCounterparty` и др.) используют read-then-write, а не `INSERT OR REPLACE` → в PG транслируются чисто.
- `INSERT OR IGNORE` → `ON CONFLICT DO NOTHING` без таргета — валидный PG (но перестаёт дедуплицировать без UNIQUE, см. H4).
- На сервере нет server-side XSS (API только JSON); `RANDOM/strftime/PRAGMA/AUTOINCREMENT` в рантайм-запросах не используются (PRAGMA/AUTOINCREMENT — только в DDL для SQLite).

---

## Рекомендуемый порядок исправления
1. C1, C2 (ломают «Водителей» и сохранение настроек прямо сейчас в PG).
2. C3, C4 (безопасность: XSS + утечка PIN/паролей).
3. H1, H4, H2/H3 (целостность данных и гонки).
4. Остальное по убыванию.
