const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'warehouse.db');

let db;

function initDatabase() {
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS slots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('small', 'bulk')),
      time_start TEXT NOT NULL,
      time_end TEXT NOT NULL,
      is_booked INTEGER NOT NULL DEFAULT 0,
      confirmed INTEGER NOT NULL DEFAULT 0,
      customer_name TEXT,
      customer_phone TEXT,
      customer_account TEXT,
      customer_comment TEXT,
      booked_at TEXT,
      confirmed_at TEXT,
      in_progress INTEGER NOT NULL DEFAULT 0,
      in_progress_at TEXT,
      completed INTEGER NOT NULL DEFAULT 0,
      completed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS managers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      first_name TEXT DEFAULT '',
      last_name TEXT DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS storekeepers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      phone TEXT DEFAULT '',
      pin_code TEXT DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS allowed_networks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      network TEXT NOT NULL UNIQUE,
      description TEXT DEFAULT '',
      protected INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS warehouses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      address TEXT DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const colCheck = db.prepare("PRAGMA table_info('slots')").all();
  if (!colCheck.some(c => c.name === 'customer_account')) {
    db.exec("ALTER TABLE slots ADD COLUMN customer_account TEXT");
  }
  if (!colCheck.some(c => c.name === 'confirmed')) {
    db.exec("ALTER TABLE slots ADD COLUMN confirmed INTEGER NOT NULL DEFAULT 0");
  }
  if (!colCheck.some(c => c.name === 'customer_comment')) {
    db.exec("ALTER TABLE slots ADD COLUMN customer_comment TEXT");
  }
  if (!colCheck.some(c => c.name === 'booked_at')) {
    db.exec("ALTER TABLE slots ADD COLUMN booked_at TEXT");
  }
  if (!colCheck.some(c => c.name === 'confirmed_at')) {
    db.exec("ALTER TABLE slots ADD COLUMN confirmed_at TEXT");
  }
  if (!colCheck.some(c => c.name === 'in_progress')) {
    db.exec("ALTER TABLE slots ADD COLUMN in_progress INTEGER NOT NULL DEFAULT 0");
  }
  if (!colCheck.some(c => c.name === 'in_progress_at')) {
    db.exec("ALTER TABLE slots ADD COLUMN in_progress_at TEXT");
  }
  if (!colCheck.some(c => c.name === 'completed')) {
    db.exec("ALTER TABLE slots ADD COLUMN completed INTEGER NOT NULL DEFAULT 0");
  }
  if (!colCheck.some(c => c.name === 'completed_at')) {
    db.exec("ALTER TABLE slots ADD COLUMN completed_at TEXT");
  }
  if (!colCheck.some(c => c.name === 'storekeeper_id')) {
    db.exec("ALTER TABLE slots ADD COLUMN storekeeper_id INTEGER DEFAULT NULL");
  }
  if (!colCheck.some(c => c.name === 'storekeeper_name')) {
    db.exec("ALTER TABLE slots ADD COLUMN storekeeper_name TEXT DEFAULT ''");
  }
  if (!colCheck.some(c => c.name === 'assembling')) {
    db.exec("ALTER TABLE slots ADD COLUMN assembling INTEGER NOT NULL DEFAULT 0");
  }
  if (!colCheck.some(c => c.name === 'assembling_at')) {
    db.exec("ALTER TABLE slots ADD COLUMN assembling_at TEXT");
  }
  if (!colCheck.some(c => c.name === 'warehouse_id')) {
    db.exec("ALTER TABLE slots ADD COLUMN warehouse_id INTEGER DEFAULT NULL");
  }
  if (!colCheck.some(c => c.name === 'customer_organization')) {
    db.exec("ALTER TABLE slots ADD COLUMN customer_organization TEXT");
  }

  const skColCheck = db.prepare("PRAGMA table_info('storekeepers')").all();
  if (!skColCheck.some(c => c.name === 'pin_code')) {
    db.exec("ALTER TABLE storekeepers ADD COLUMN pin_code TEXT DEFAULT ''");
  }

  const netColCheck = db.prepare("PRAGMA table_info('allowed_networks')").all();
  if (!netColCheck.some(c => c.name === 'protected')) {
    db.exec("ALTER TABLE allowed_networks ADD COLUMN protected INTEGER NOT NULL DEFAULT 0");
  }

  const whColCheck = db.prepare("PRAGMA table_info('warehouses')").all();
  if (!whColCheck.some(c => c.name === 'is_default')) {
    db.exec("ALTER TABLE warehouses ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0");
  }

  const defaultNet = db.prepare("SELECT id FROM allowed_networks WHERE network = '80.76.228.0/24'").get();
  if (!defaultNet) {
    db.prepare("INSERT INTO allowed_networks (network, description, protected) VALUES (?, ?, 1)").run('80.76.228.0/24', 'Основная подсеть');
    console.log('Default network added: 80.76.228.0/24');
  } else {
    db.prepare("UPDATE allowed_networks SET protected = 1 WHERE network = '80.76.228.0/24'").run();
  }

  const extraNet = db.prepare("SELECT id FROM allowed_networks WHERE network = '89.23.39.75'").get();
  if (!extraNet) {
    db.prepare("INSERT INTO allowed_networks (network, description, protected) VALUES (?, ?, 1)").run('89.23.39.75', 'Дополнительный адрес');
    console.log('Default network added: 89.23.39.75');
  } else {
    db.prepare("UPDATE allowed_networks SET protected = 1 WHERE network = '89.23.39.75'").run();
  }

  const mgrColCheck = db.prepare("PRAGMA table_info('managers')").all();
  if (!mgrColCheck.some(c => c.name === 'first_name')) {
    db.exec("ALTER TABLE managers ADD COLUMN first_name TEXT DEFAULT ''");
  }
  if (!mgrColCheck.some(c => c.name === 'last_name')) {
    db.exec("ALTER TABLE managers ADD COLUMN last_name TEXT DEFAULT ''");
  }
  if (!mgrColCheck.some(c => c.name === 'warehouse_id')) {
    db.exec("ALTER TABLE managers ADD COLUMN warehouse_id INTEGER DEFAULT NULL");
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS page_visits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      visited_at TEXT NOT NULL,
      ip TEXT DEFAULT '',
      device TEXT DEFAULT '',
      os TEXT DEFAULT '',
      browser TEXT DEFAULT ''
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slot_id INTEGER NOT NULL,
      phone TEXT NOT NULL,
      message TEXT NOT NULL,
      sent_at TEXT NOT NULL DEFAULT (datetime('now')),
      manager_id INTEGER DEFAULT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS nomenclature (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      article TEXT DEFAULT '',
      unit TEXT DEFAULT 'шт',
      price REAL DEFAULT 0,
      category TEXT DEFAULT '',
      description TEXT DEFAULT '',
      guid1c TEXT DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS check_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      accounts TEXT NOT NULL,
      success INTEGER NOT NULL DEFAULT 0,
      response_status INTEGER,
      response_body TEXT,
      error TEXT,
      url TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `  );

  const checkLogCols = db.prepare("PRAGMA table_info('check_logs')").all();
  if (!checkLogCols.some(c => c.name === 'request_body')) {
    db.exec("ALTER TABLE check_logs ADD COLUMN request_body TEXT DEFAULT ''");
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS counterparties (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      phone TEXT DEFAULT '',
      inn TEXT DEFAULT '',
      kpp TEXT DEFAULT '',
      comment TEXT DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS orders_1c (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      orderNumber TEXT NOT NULL UNIQUE,
      orderDate TEXT DEFAULT '',
      customerName TEXT DEFAULT '',
      customerINN TEXT DEFAULT '',
      customerKPP TEXT DEFAULT '',
      accountNumber TEXT DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS order_items_1c (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      orderNumber TEXT NOT NULL,
      guid TEXT NOT NULL DEFAULT '',
      article TEXT DEFAULT '',
      name TEXT DEFAULT '',
      quantity REAL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS managers_1c (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      orderCount INTEGER NOT NULL DEFAULT 0,
      lastSeen TEXT DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS engineers_1c (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      orderCount INTEGER NOT NULL DEFAULT 0,
      lastSeen TEXT DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS banned_phones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL,
      reason TEXT DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS banned_ips (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ip TEXT NOT NULL,
      reason TEXT DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS vehicle_classes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS load_types (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS user_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_type TEXT NOT NULL DEFAULT '',
      user_name TEXT DEFAULT '',
      action TEXT NOT NULL,
      details TEXT DEFAULT '',
      ip TEXT DEFAULT '',
      user_agent TEXT DEFAULT '',
      slot_id INTEGER DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    )
  `);

  const logsColCheck = db.prepare("PRAGMA table_info('user_logs')").all();
  if (!logsColCheck.some(c => c.name === 'ip')) {
    db.exec("ALTER TABLE user_logs ADD COLUMN ip TEXT DEFAULT ''");
  }
  if (!logsColCheck.some(c => c.name === 'user_agent')) {
    db.exec("ALTER TABLE user_logs ADD COLUMN user_agent TEXT DEFAULT ''");
  }

  const counterpartyColCheck = db.prepare("PRAGMA table_info('counterparties')").all();
  if (!counterpartyColCheck.some(c => c.name === 'guid1c')) {
    db.exec("ALTER TABLE counterparties ADD COLUMN guid1c TEXT DEFAULT ''");
  }

  const ordersColCheck = db.prepare("PRAGMA table_info('orders_1c')").all();
  if (!ordersColCheck.some(c => c.name === 'accountNumber')) {
    db.exec("ALTER TABLE orders_1c ADD COLUMN accountNumber TEXT DEFAULT ''");
  }
  if (!ordersColCheck.some(c => c.name === 'engineerName')) {
    db.exec("ALTER TABLE orders_1c ADD COLUMN engineerName TEXT DEFAULT ''");
  }
  if (!ordersColCheck.some(c => c.name === 'managerName')) {
    db.exec("ALTER TABLE orders_1c ADD COLUMN managerName TEXT DEFAULT ''");
  }
  if (!ordersColCheck.some(c => c.name === 'comment')) {
    db.exec("ALTER TABLE orders_1c ADD COLUMN comment TEXT DEFAULT ''");
  }
  if (!ordersColCheck.some(c => c.name === 'readyStatus')) {
    db.exec("ALTER TABLE orders_1c ADD COLUMN readyStatus INTEGER DEFAULT 0");
  }
  if (!ordersColCheck.some(c => c.name === 'notReadyReason')) {
    db.exec("ALTER TABLE orders_1c ADD COLUMN notReadyReason TEXT DEFAULT ''");
  }

  const itemsColCheck = db.prepare("PRAGMA table_info('order_items_1c')").all();
  if (!itemsColCheck.some(c => c.name === 'status')) {
    db.exec("ALTER TABLE order_items_1c ADD COLUMN status TEXT DEFAULT ''");
  }

  const nomColCheck = db.prepare("PRAGMA table_info('nomenclature')").all();
  if (!nomColCheck.some(c => c.name === 'guid1c')) {
    db.exec("ALTER TABLE nomenclature ADD COLUMN guid1c TEXT DEFAULT ''");
  }
  if (!nomColCheck.some(c => c.name === 'code_1c')) {
    db.exec("ALTER TABLE nomenclature ADD COLUMN code_1c TEXT DEFAULT ''");
  }
  if (!nomColCheck.some(c => c.name === 'comment')) {
    db.exec("ALTER TABLE nomenclature ADD COLUMN comment TEXT DEFAULT ''");
  }
  if (!nomColCheck.some(c => c.name === 'weight')) {
    db.exec("ALTER TABLE nomenclature ADD COLUMN weight REAL DEFAULT 0");
  }
  if (!nomColCheck.some(c => c.name === 'volume')) {
    db.exec("ALTER TABLE nomenclature ADD COLUMN volume REAL DEFAULT 0");
  }
  if (!nomColCheck.some(c => c.name === 'internal_code')) {
    db.exec("ALTER TABLE nomenclature ADD COLUMN internal_code TEXT DEFAULT ''");
  }

  const slotsColCheck = db.prepare("PRAGMA table_info('slots')").all();
  if (!slotsColCheck.some(c => c.name === 'customer_ip')) {
    db.exec("ALTER TABLE slots ADD COLUMN customer_ip TEXT DEFAULT ''");
  }
  if (!slotsColCheck.some(c => c.name === 'customer_user_agent')) {
    db.exec("ALTER TABLE slots ADD COLUMN customer_user_agent TEXT DEFAULT ''");
  }
  if (!slotsColCheck.some(c => c.name === 'vehicle_class_id')) {
    db.exec("ALTER TABLE slots ADD COLUMN vehicle_class_id INTEGER DEFAULT NULL");
  }
  if (!slotsColCheck.some(c => c.name === 'load_type_id')) {
    db.exec("ALTER TABLE slots ADD COLUMN load_type_id INTEGER DEFAULT NULL");
  }

  const existing = db.prepare('SELECT COUNT(*) as cnt FROM managers').get();
  if (existing.cnt === 0) {
    const hash = crypto.createHash('sha256').update('admin123').digest('hex');
    db.prepare('INSERT INTO managers (username, password_hash, first_name, last_name) VALUES (?, ?, ?, ?)').run('admin', hash, 'Главный', 'Администратор');
    console.log('Default manager created: admin / admin123');
  }

  return db;
}

function getDb() {
  if (!db) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }
  return db;
}

function generateSlotsForDate(dateStr, type, warehouseId) {
  const duration = type === 'small' ? 15 : 30;
  const slots = [];
  const [h, m] = [10, 0];
  const startMinutes = h * 60 + m;
  const endMinutes = 17 * 60 + 30;

  for (let mins = startMinutes; mins < endMinutes; mins += duration) {
    const startHour = String(Math.floor(mins / 60)).padStart(2, '0');
    const startMin = String(mins % 60).padStart(2, '0');
    const endMins = mins + duration;
    const endHour = String(Math.floor(endMins / 60)).padStart(2, '0');
    const endMin = String(endMins % 60).padStart(2, '0');
    slots.push({
      date: dateStr,
      type,
      time_start: `${startHour}:${startMin}`,
      time_end: `${endHour}:${endMin}`,
      warehouse_id: warehouseId || null
    });
  }
  return slots;
}

// Ensure the full canonical set of slots exists for one warehouse (or the
// legacy null warehouse). Idempotent and self-healing: it removes obsolete
// 09:* slots and then inserts ONLY the time-slots that are still missing, so a
// partially-populated date always gets completed to the full set.
function fillMissingSlots(dateStr, type, warehouseId) {
  const isNull = warehouseId === null || warehouseId === undefined;
  const whClause = isNull ? 'warehouse_id IS NULL' : 'warehouse_id = ?';
  const whArgs = isNull ? [] : [warehouseId];

  // Drop legacy unbooked 09:* slots so they regenerate at the current start time.
  const legacy = db.prepare(
    "SELECT COUNT(*) as cnt FROM slots WHERE date = ? AND type = ? AND " + whClause + " AND time_start LIKE '09:%'"
  ).get(dateStr, type, ...whArgs);
  if (legacy && legacy.cnt > 0) {
    db.prepare(
      "DELETE FROM slots WHERE date = ? AND type = ? AND " + whClause + " AND time_start LIKE '09:%' AND is_booked = 0"
    ).run(dateStr, type, ...whArgs);
  }

  const desired = generateSlotsForDate(dateStr, type, isNull ? null : warehouseId);
  const existingTimes = new Set(
    db.prepare("SELECT time_start FROM slots WHERE date = ? AND type = ? AND " + whClause)
      .all(dateStr, type, ...whArgs)
      .map(r => r.time_start)
  );
  const missing = desired.filter(s => !existingTimes.has(s.time_start));
  if (missing.length === 0) return;

  const insert = db.prepare(
    'INSERT OR IGNORE INTO slots (date, type, time_start, time_end, warehouse_id) VALUES (@date, @type, @time_start, @time_end, @warehouse_id)'
  );
  const insertMany = db.transaction((items) => { for (const item of items) insert.run(item); });
  insertMany(missing);
}

function ensureSlotsExist(dateStr, type) {
  const allWarehouses = db.prepare('SELECT id FROM warehouses').all();
  if (allWarehouses.length === 0) {
    fillMissingSlots(dateStr, type, null);
    return;
  }
  for (const wh of allWarehouses) {
    fillMissingSlots(dateStr, type, wh.id);
  }
  // Keep legacy null-warehouse slots (from before warehouse support) in sync too.
  fillMissingSlots(dateStr, type, null);
}

function isWeekday(dateStr) {
  // Compute the weekday of the calendar date deterministically (UTC), so the
  // result does not depend on the server's local timezone.
  const parts = String(dateStr).split('-');
  const y = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  const d = parseInt(parts[2], 10);
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return day >= 1 && day <= 5;
}

function upsertCounterparty({ guid, name, inn, kpp }) {
  if (!guid) return;
  const existing = db.prepare("SELECT id, name, inn, kpp FROM counterparties WHERE guid1c = ?").get(guid);
  if (existing) {
    if (existing.name !== name || existing.inn !== inn || existing.kpp !== kpp) {
      db.prepare("UPDATE counterparties SET name = ?, inn = ?, kpp = ? WHERE guid1c = ?").run(name || '', inn || '', kpp || '', guid);
    }
  } else {
    db.prepare("INSERT INTO counterparties (name, inn, kpp, guid1c) VALUES (?, ?, ?, ?)").run(name || '', inn || '', kpp || '', guid);
  }
}

function upsertNomenclature({ guid, article, name }) {
  if (!guid) return;
  const existing = db.prepare("SELECT id, article, name FROM nomenclature WHERE guid1c = ?").get(guid);
  if (existing) {
    if (existing.article !== article || existing.name !== name) {
      db.prepare("UPDATE nomenclature SET article = ?, name = ? WHERE guid1c = ?").run(article || '', name || '', guid);
    }
  } else {
    db.prepare("INSERT INTO nomenclature (guid1c, article, name) VALUES (?, ?, ?)").run(guid, article || '', name || '');
  }
}

function upsertOrder1c({ orderNumber, orderDate, customerName, customerINN, customerKPP, accountNumber, engineerName, managerName, comment }) {
  if (!orderNumber) return;
  const existing = db.prepare("SELECT id, orderDate, customerName, customerINN, customerKPP, accountNumber, engineerName, managerName, comment FROM orders_1c WHERE orderNumber = ?").get(orderNumber);
  if (existing) {
    if (existing.orderDate !== orderDate || existing.customerName !== customerName || existing.customerINN !== customerINN || existing.customerKPP !== customerKPP || existing.accountNumber !== accountNumber || existing.engineerName !== engineerName || existing.managerName !== managerName || existing.comment !== comment) {
      db.prepare("UPDATE orders_1c SET orderDate = ?, customerName = ?, customerINN = ?, customerKPP = ?, accountNumber = ?, engineerName = ?, managerName = ?, comment = ? WHERE orderNumber = ?").run(orderDate || '', customerName || '', customerINN || '', customerKPP || '', accountNumber || '', engineerName || '', managerName || '', comment || '', orderNumber);
    }
  } else {
    db.prepare("INSERT INTO orders_1c (orderNumber, orderDate, customerName, customerINN, customerKPP, accountNumber, engineerName, managerName, comment) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(orderNumber, orderDate || '', customerName || '', customerINN || '', customerKPP || '', accountNumber || '', engineerName || '', managerName || '', comment || '');
  }
}

function saveOrderItems1c(orderNumber, products) {
  if (!orderNumber || !Array.isArray(products)) return;
  db.prepare("DELETE FROM order_items_1c WHERE orderNumber = ?").run(orderNumber);
  const insert = db.prepare("INSERT INTO order_items_1c (orderNumber, guid, article, name, quantity, status) VALUES (?, ?, ?, ?, ?, ?)");
  for (const p of products) {
    insert.run(orderNumber, p.guid || '', p.article || '', p.name || '', Number(p.quantity) || 0, p.status || '');
  }
}

function upsertManager1c(name) {
  if (!name) return;
  const existing = db.prepare("SELECT id, orderCount FROM managers_1c WHERE name = ?").get(name);
  if (existing) {
    db.prepare("UPDATE managers_1c SET orderCount = orderCount + 1, lastSeen = datetime('now') WHERE name = ?").run(name);
  } else {
    db.prepare("INSERT INTO managers_1c (name, orderCount, lastSeen) VALUES (?, 1, datetime('now'))").run(name);
  }
}

function upsertEngineer1c(name) {
  if (!name) return;
  const existing = db.prepare("SELECT id, orderCount FROM engineers_1c WHERE name = ?").get(name);
  if (existing) {
    db.prepare("UPDATE engineers_1c SET orderCount = orderCount + 1, lastSeen = datetime('now') WHERE name = ?").run(name);
  } else {
    db.prepare("INSERT INTO engineers_1c (name, orderCount, lastSeen) VALUES (?, 1, datetime('now'))").run(name);
  }
}

function setDb(newDb) {
  db = newDb;
}

module.exports = { initDatabase, getDb, setDb, generateSlotsForDate, ensureSlotsExist, isWeekday, upsertCounterparty, upsertNomenclature, upsertOrder1c, saveOrderItems1c, upsertManager1c, upsertEngineer1c };
