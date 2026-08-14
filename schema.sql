-- ============================================================================
--  warehouse-queue — КАНОНИЧЕСКАЯ СХЕМА БД (единый источник истины)
-- ----------------------------------------------------------------------------
--  Все три реализации (Node database.js, Go db.go, Rust db.rs) обязаны
--  соответствовать этой схеме. При изменении структуры правьте СНАЧАЛА этот
--  файл, затем — три реализации (и добавляйте ALTER-миграцию для существующих
--  БД, т.к. новые столбцы не появляются в старых таблицах автоматически).
--
--  Диалект: показан для SQLite. Для PostgreSQL:
--    * INTEGER PRIMARY KEY AUTOINCREMENT  ->  SERIAL PRIMARY KEY
--    * datetime('now')                     ->  CURRENT_TIMESTAMP
--    * INSERT OR IGNORE / OR REPLACE       ->  ON CONFLICT ...
--  (эти различия инкапсулированы в слое доступа каждого варианта).
-- ============================================================================

CREATE TABLE IF NOT EXISTS warehouses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  address TEXT DEFAULT '',
  is_default INTEGER NOT NULL DEFAULT 0,
  directions TEXT DEFAULT '',              -- описание, как доехать
  map_scheme TEXT DEFAULT '',              -- схема проезда (картинка, data-URL)
  route_moscow TEXT DEFAULT '',            -- маршрут из Москвы (шаги, по строке)
  tz_offset TEXT DEFAULT ''                -- часовой пояс склада (UTC±ч); пусто = общий из настроек
);

CREATE TABLE IF NOT EXISTS slots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  type TEXT NOT NULL,                    -- 'small' | 'bulk'
  time_start TEXT NOT NULL,
  time_end TEXT NOT NULL,
  is_booked INTEGER NOT NULL DEFAULT 0,
  confirmed INTEGER NOT NULL DEFAULT 0,
  in_progress INTEGER NOT NULL DEFAULT 0,
  assembling INTEGER NOT NULL DEFAULT 0,
  completed INTEGER NOT NULL DEFAULT 0,
  warehouse_id INTEGER,
  customer_name TEXT, customer_phone TEXT, customer_account TEXT,
  customer_comment TEXT, customer_organization TEXT,
  storekeeper_name TEXT, storekeeper_id INTEGER,
  booked_at TEXT, confirmed_at TEXT, in_progress_at TEXT,
  assembling_at TEXT, completed_at TEXT,
  customer_ip TEXT, customer_user_agent TEXT,
  vehicle_class_id INTEGER, load_type_id INTEGER,
  created_at TEXT
);

-- Учётные записи кабинета. warehouse_ids — CSV назначенных складов (мультивыбор);
-- пусто = все склады. warehouse_id хранит «основной» (первый) для совместимости.
CREATE TABLE IF NOT EXISTS managers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,           -- SHA-256, клиенту НЕ отдаётся
  first_name TEXT DEFAULT '',
  last_name TEXT DEFAULT '',
  warehouse_id INTEGER,
  warehouse_ids TEXT DEFAULT '',
  is_admin INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS storekeepers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL, phone TEXT DEFAULT '',
  pin_code TEXT DEFAULT '',               -- 4 цифры, клиенту НЕ отдаётся
  created_at TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS vehicle_classes (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS load_types      (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS categories      (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
-- Справочник логистов: ФИО и телефон (хранится цифрами, 11 знаков, с 7 в начале).
CREATE TABLE IF NOT EXISTS logisticians    (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, phone TEXT DEFAULT '', created_at TEXT DEFAULT '');
-- Журнал бронирований для статистики: не пропадает при отмене брони.
CREATE TABLE IF NOT EXISTS booking_events  (id INTEGER PRIMARY KEY AUTOINCREMENT, slot_id INTEGER DEFAULT 0, created_at TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS counterparties  (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, phone TEXT DEFAULT '', inn TEXT DEFAULT '', kpp TEXT DEFAULT '', comment TEXT DEFAULT '');

-- IP-allowlist для кабинета/кладовщика (пустой список = доступ открыт).
CREATE TABLE IF NOT EXISTS allowed_networks (id INTEGER PRIMARY KEY AUTOINCREMENT, network TEXT NOT NULL, description TEXT DEFAULT '');

-- Чёрные списки. Авто-баны имеют reason, начинающийся с 'Автоблокировка', и
-- истекают через 24 часа (по created_at); ручные — бессрочные.
CREATE TABLE IF NOT EXISTS banned_phones (id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT NOT NULL, reason TEXT DEFAULT '', created_at TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS banned_ips    (id INTEGER PRIMARY KEY AUTOINCREMENT, ip TEXT NOT NULL, reason TEXT DEFAULT '', created_at TEXT DEFAULT '');

CREATE TABLE IF NOT EXISTS user_logs   (id INTEGER PRIMARY KEY AUTOINCREMENT, user_type TEXT, user_name TEXT, action TEXT, details TEXT, slot_id INTEGER, ip TEXT, user_agent TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS messages    (id INTEGER PRIMARY KEY AUTOINCREMENT, slot_id INTEGER, phone TEXT, message TEXT, status TEXT DEFAULT '', created_at TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS check_logs  (id INTEGER PRIMARY KEY AUTOINCREMENT, accounts TEXT, success INTEGER, response_status INTEGER, response_body TEXT, error TEXT, url TEXT, request_body TEXT, created_at TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS nomenclature(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, article TEXT DEFAULT '', guid TEXT DEFAULT '', category TEXT DEFAULT '');

-- Данные, подтягиваемые из 1С.
CREATE TABLE IF NOT EXISTS orders_1c      (id INTEGER PRIMARY KEY AUTOINCREMENT, orderNumber TEXT, orderDate TEXT DEFAULT '', customerName TEXT DEFAULT '', customerINN TEXT DEFAULT '', customerKPP TEXT DEFAULT '', accountNumber TEXT DEFAULT '', engineerName TEXT DEFAULT '', managerName TEXT DEFAULT '', comment TEXT DEFAULT '', readyStatus INTEGER DEFAULT 0, notReadyReason TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS order_items_1c (id INTEGER PRIMARY KEY AUTOINCREMENT, orderNumber TEXT, guid TEXT, article TEXT, name TEXT, quantity REAL DEFAULT 0, status TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS managers_1c    (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, orderCount INTEGER DEFAULT 0, lastSeen TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS engineers_1c   (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, orderCount INTEGER DEFAULT 0, lastSeen TEXT DEFAULT '');

-- Ключ-значение: все настройки кабинета (токен 1С, TTL кэша, tz_offset_hours,
-- booking_max_days, booking_page_message, redis_*, pgsql_*, db_type, и т.д.).
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS page_visits (id INTEGER PRIMARY KEY AUTOINCREMENT, visited_at TEXT NOT NULL, ip TEXT DEFAULT '', device TEXT DEFAULT '', os TEXT DEFAULT '', browser TEXT DEFAULT '');
