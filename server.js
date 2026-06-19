const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const { initDatabase, getDb, setDb, ensureSlotsExist, isWeekday, upsertCounterparty, upsertNomenclature, upsertOrder1c, saveOrderItems1c, upsertManager1c, upsertEngineer1c } = require('./database');
const redis = require('redis');
const os = require('os');
const { execFile } = require('child_process');

// Safety net: a DB/psql error inside an async route becomes a rejected promise
// that Express 4 does not catch. Log it instead of letting it crash the server.
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', (err && err.message) ? err.message : err);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', (err && err.message) ? err.message : err);
});

const app = express();
const PORT = process.env.PORT || 3000;
// Behind a reverse proxy (nginx) trust X-Forwarded-* so req.ip is the real
// client address (used by the allowed-IP checks). Configurable via TRUST_PROXY.
if (process.env.TRUST_PROXY) {
  const tp = process.env.TRUST_PROXY;
  app.set('trust proxy', tp === 'true' ? true : (isNaN(Number(tp)) ? tp : Number(tp)));
}

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Cookie');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
app.use(express.json({ limit: '64mb' }));
app.use('/manager.html', requireAllowedIP);
app.use('/api/manager', requireAllowedIP);
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'warehouse-queue-secret-key-2025',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000, sameSite: 'lax', httpOnly: true }
}));
// Admin-only areas (Settings tab, manager management, backups, DB migration,
// IP networks, app updates). Must be AFTER the session middleware so req.session
// is available. Главный администратор (admin) — администратор по умолчанию.
['/api/manager/settings', '/api/manager/list', '/api/manager/create', '/api/manager/backup', '/api/manager/backups',
 '/api/manager/restore', '/api/manager/migrate', '/api/manager/switch', '/api/manager/update',
 '/api/manager/check-update', '/api/manager/networks', '/api/manager/migration'].forEach(function(p) {
  app.use(p, requireManager, requireAdmin);
});

const sqliteDb = initDatabase();
const dbAdapter = require('./db-adapter');
dbAdapter.setSqlite(sqliteDb);
var db = dbAdapter;
setDb(dbAdapter);
// Optional: seed connector settings from environment on first boot (Docker).
// Only fills keys that are not already present, so UI changes always win.
// db_type is intentionally NOT set here — the admin still migrates + switches.
if (process.env.SEED_CONNECTORS === '1') {
  var seedSetting = function(key, val) {
    if (val === undefined || val === null || val === '') return;
    var existing = sqliteDb.prepare('SELECT 1 FROM settings WHERE key = ?').get(key);
    if (!existing) sqliteDb.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(key, String(val));
  };
  seedSetting('pgsql_host', process.env.PGSQL_HOST);
  seedSetting('pgsql_port', process.env.PGSQL_PORT);
  seedSetting('pgsql_database', process.env.PGSQL_DATABASE);
  seedSetting('pgsql_user', process.env.PGSQL_USER);
  seedSetting('pgsql_password', process.env.PGSQL_PASSWORD);
  seedSetting('redis_host', process.env.REDIS_HOST);
  seedSetting('redis_port', process.env.REDIS_PORT);
  seedSetting('redis_enabled', process.env.REDIS_ENABLED);
}
// On startup, try switching to PostgreSQL if previously configured
var dbTypeRow = sqliteDb.prepare("SELECT value FROM settings WHERE key = 'db_type'").get();
if (dbTypeRow && dbTypeRow.value === 'postgresql') {
  var pgConf = {
    host: (sqliteDb.prepare("SELECT value FROM settings WHERE key = 'pgsql_host'").get() || {}).value || '127.0.0.1',
    port: parseInt((sqliteDb.prepare("SELECT value FROM settings WHERE key = 'pgsql_port'").get() || {}).value || '5432'),
    database: (sqliteDb.prepare("SELECT value FROM settings WHERE key = 'pgsql_database'").get() || {}).value || 'warehouse',
    user: (sqliteDb.prepare("SELECT value FROM settings WHERE key = 'pgsql_user'").get() || {}).value || 'postgres',
    password: (sqliteDb.prepare("SELECT value FROM settings WHERE key = 'pgsql_password'").get() || {}).value || ''
  };
  try {
    // Test PG connection before switching
    var testChild = require('child_process').execFileSync('psql', ['-h', pgConf.host, '-p', String(pgConf.port), '-U', pgConf.user, '-d', pgConf.database, '-A', '-t', '-q', '-c', 'SELECT 1'], { env: (function(e){e.PGPASSWORD=pgConf.password||'';return e;})(Object.assign({},process.env)), timeout: 5000, encoding: 'utf8' });
    dbAdapter.setPg(pgConf);
    console.log('Switched to PostgreSQL backend');
  } catch (e) {
    console.error('Failed to switch to PostgreSQL, using SQLite:', (e.stderr || e.message || '').trim().split('\n')[0]);
    dbAdapter.setSqlite(sqliteDb);
  }
}

let redisClient = null;
let redisEnabled = false;

function getRedisConfig() {
  const host = db.prepare("SELECT value FROM settings WHERE key = 'redis_host'").get();
  const port = db.prepare("SELECT value FROM settings WHERE key = 'redis_port'").get();
  const password = db.prepare("SELECT value FROM settings WHERE key = 'redis_password'").get();
  const dbNum = db.prepare("SELECT value FROM settings WHERE key = 'redis_db'").get();
  const enabled = db.prepare("SELECT value FROM settings WHERE key = 'redis_enabled'").get();
  return {
    host: host ? host.value : '127.0.0.1',
    port: port ? parseInt(port.value) : 6379,
    password: password ? password.value : '',
    db: dbNum ? parseInt(dbNum.value) : 0,
    enabled: enabled ? enabled.value === '1' : false
  };
}

function initRedis() {
  const config = getRedisConfig();
  redisEnabled = config.enabled;
  if (!config.enabled) {
    if (redisClient) { try { redisClient.quit(); } catch(e) {} redisClient = null; }
    return;
  }
  try {
    if (redisClient) { try { redisClient.quit(); } catch(e) {} }
    var opts = { host: config.host };
    if (config.port !== 6379) opts.port = config.port;
    if (config.password) opts.password = config.password;
    if (config.db) opts.db = config.db;
    redisClient = redis.createClient(opts);
    redisClient.on('error', function() {});
    redisClient.on('connect', function() {});
    redisClient.on('ready', function() {});
  } catch (err) {
    redisClient = null;
    redisEnabled = false;
  }
}

// Rolling per-minute counter of Redis operations (last hour).
var redisHits = new Array(60).fill(0);
var redisStamp = new Array(60).fill(-1);
function countRedisCall() {
  var minute = Math.floor(Date.now() / 60000);
  var idx = minute % 60;
  if (redisStamp[idx] !== minute) { redisStamp[idx] = minute; redisHits[idx] = 0; }
  redisHits[idx]++;
}
function redisRequestsLastHour() {
  var minute = Math.floor(Date.now() / 60000);
  var sum = 0;
  for (var i = 0; i < 60; i++) {
    if (redisStamp[i] >= 0 && (minute - redisStamp[i]) < 60) sum += redisHits[i];
  }
  return sum;
}

function redisGet(key) {
  return new Promise(function(resolve) {
    if (!redisClient || !redisEnabled) return resolve(null);
    countRedisCall();
    redisClient.get(key, function(err, val) {
      resolve(err ? null : val);
    });
  });
}

// Configurable cache TTLs (seconds), grouped by cache-key category. Defaults
// match the values used in code; overrides are stored in settings as ttl_<cat>.
var TTL_CATEGORIES = [
  { key: 'slots_public',    label: 'Свободные слоты (страница записи)',        def: 30  },
  { key: 'slots_cabinet',   label: 'Слоты в кабинете менеджера',               def: 10  },
  { key: 'directories',     label: 'Справочники (склады, номенклатура, контрагенты, кладовщики, менеджеры, классы машин, виды загрузки, подсети, баны)', def: 300 },
  { key: 'c1_data',         label: 'Данные 1С (заказы, менеджеры, инженеры, логи)', def: 60 },
  { key: 'messages',        label: 'Сообщения',                                def: 30  },
  { key: 'stats',           label: 'Статистика',                               def: 30  },
  { key: 'drivers',         label: 'Водители',                                 def: 30  },
  { key: 'manager_profile', label: 'Профиль менеджера',                        def: 300 }
];
var ttlOverrides = {};

function loadTtlOverrides() {
  ttlOverrides = {};
  try {
    for (var i = 0; i < TTL_CATEGORIES.length; i++) {
      var cat = TTL_CATEGORIES[i].key;
      var row = db.prepare("SELECT value FROM settings WHERE key = ?").get('ttl_' + cat);
      if (row && row.value !== '' && row.value !== null) {
        var n = parseInt(row.value, 10);
        if (!isNaN(n) && n >= 0) ttlOverrides[cat] = n;
      }
    }
  } catch (e) {}
}

function cacheCategory(key) {
  if (key.indexOf('slots:public:') === 0) return 'slots_public';
  if (key.indexOf('slots:') === 0 || key.indexOf('slots-id:') === 0) return 'slots_cabinet';
  if (key.indexOf('manager-me') === 0) return 'manager_profile';
  if (key.indexOf('stats') === 0) return 'stats';
  if (key.indexOf('drivers') === 0) return 'drivers';
  if (key.indexOf('messages') === 0) return 'messages';
  if (key.indexOf('check-logs') === 0 || key.indexOf('orders-1c') === 0 || key.indexOf('c1-orders') === 0
      || key.indexOf('managers-1c') === 0 || key.indexOf('engineers-1c') === 0) return 'c1_data';
  return 'directories';
}

function effectiveTtl(key, fallback) {
  var cat = cacheCategory(key);
  return Object.prototype.hasOwnProperty.call(ttlOverrides, cat) ? ttlOverrides[cat] : fallback;
}

function redisSet(key, value, ttlSeconds) {
  return new Promise(function(resolve) {
    if (!redisClient || !redisEnabled) return resolve();
    countRedisCall();
    var ttl = effectiveTtl(key, ttlSeconds);
    if (ttl) redisClient.setex(key, ttl, value, function() { resolve(); });
    else redisClient.set(key, value, function() { resolve(); });
  });
}

function redisDel(key) {
  return new Promise(function(resolve) {
    if (!redisClient || !redisEnabled) return resolve();
    countRedisCall();
    redisClient.del(key, function() { resolve(); });
  });
}

function redisFlushSlotsCache() {
  return new Promise(function(resolve) {
    if (!redisClient || !redisEnabled) return resolve();
    countRedisCall();
    redisClient.keys('slots:*', function(err, keys) {
      if (err || !keys || !keys.length) return resolve();
      redisClient.del.apply(redisClient, keys.concat([function() { resolve(); }]));
    });
  });
}

function redisFlushByPrefix(prefix) {
  return new Promise(function(resolve) {
    if (!redisClient || !redisEnabled) return resolve();
    countRedisCall();
    redisClient.keys(prefix + ':*', function(err, keys) {
      if (err || !keys || !keys.length) return resolve();
      redisClient.del.apply(redisClient, keys.concat([function() { resolve(); }]));
    });
  });
}

function redisFlushAll() {
  return new Promise(function(resolve) {
    if (!redisClient || !redisEnabled) return resolve();
    countRedisCall();
    redisClient.keys('*', function(err, keys) {
      if (err || !keys || !keys.length) return resolve();
      redisClient.del.apply(redisClient, keys.concat([function() { resolve(); }]));
    });
  });
}

function cacheKey() {
  var args = Array.prototype.slice.call(arguments);
  return args.join(':');
}

function withCache(key, ttl, handler, req, res) {
  redisGet(key).then(function(cached) {
    if (cached) return res.json(JSON.parse(cached));
    handler(function(data) {
      redisSet(key, JSON.stringify(data), ttl);
      res.json(data);
    });
  });
}

function getRedisStatus() {
  if (!redisEnabled) return 'disabled';
  if (!redisClient) return 'error';
  try { return redisClient.connected ? 'connected' : 'connecting'; } catch { return 'error'; }
}

// Backup config — declared before scheduleAutobackup() runs below.
var BACKUP_DIR = process.env.BACKUP_DIR || path.join(process.env.DB_PATH ? path.dirname(process.env.DB_PATH) : __dirname, 'backups');
var AUTOBACKUP_INTERVALS = [3600, 7200, 14400, 86400, 604800]; // 1h, 2h, 4h, 1d, 1w
var autobackupTimer = null;

// Ensure the page_visits table exists in the active backend (covers PG DBs that
// were migrated before this table was added to the schema).
function ensurePageVisitsTable() {
  try {
    if (dbAdapter.getType() === 'postgresql') {
      db.exec("CREATE TABLE IF NOT EXISTS page_visits (id SERIAL PRIMARY KEY, visited_at TEXT NOT NULL, ip TEXT DEFAULT '', device TEXT DEFAULT '', os TEXT DEFAULT '', browser TEXT DEFAULT '')");
      ['device', 'os', 'browser'].forEach(function(c) { try { db.exec("ALTER TABLE page_visits ADD COLUMN IF NOT EXISTS " + c + " TEXT DEFAULT ''"); } catch (e) {} });
    } else {
      db.exec("CREATE TABLE IF NOT EXISTS page_visits (id INTEGER PRIMARY KEY AUTOINCREMENT, visited_at TEXT NOT NULL, ip TEXT DEFAULT '', device TEXT DEFAULT '', os TEXT DEFAULT '', browser TEXT DEFAULT '')");
      try {
        const cols = sqliteDb.prepare("PRAGMA table_info('page_visits')").all().map(c => c.name);
        ['device', 'os', 'browser'].forEach(function(c) { if (cols.indexOf(c) === -1) sqliteDb.exec("ALTER TABLE page_visits ADD COLUMN " + c + " TEXT DEFAULT ''"); });
      } catch (e) {}
    }
  } catch (e) { console.error('ensurePageVisitsTable:', e.message); }
}

// Ensure managers.is_admin exists in the active backend (covers PG DBs migrated
// before this column was added).
function ensureManagerAdminColumn() {
  try {
    if (dbAdapter.getType() === 'postgresql') {
      db.exec("ALTER TABLE managers ADD COLUMN IF NOT EXISTS is_admin INTEGER NOT NULL DEFAULT 0");
    } else {
      const cols = sqliteDb.prepare("PRAGMA table_info('managers')").all().map(c => c.name);
      if (cols.indexOf('is_admin') === -1) sqliteDb.exec("ALTER TABLE managers ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0");
    }
  } catch (e) { console.error('ensureManagerAdminColumn:', e.message); }
}

loadTtlOverrides();
initRedis();
scheduleAutobackup();
ensurePageVisitsTable();
ensureManagerAdminColumn();
// Главный администратор (admin) всегда имеет признак администратора.
try { db.prepare("UPDATE managers SET is_admin = 1 WHERE username = 'admin'").run(); } catch (e) {}

function getIp(req) {
  return req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'].split(',')[0].trim() : req.connection.remoteAddress || '';
}

function getUserAgent(req) {
  return req.headers['user-agent'] || '';
}

// Simple in-memory sliding-window rate limiter for the public booking endpoint.
// Caps attempts per IP, which also makes brute-forcing the captcha impractical.
const bookAttempts = new Map();
const BOOK_WINDOW_MS = 60 * 1000;
const BOOK_MAX_ATTEMPTS = 10;
function bookRateLimit(req, res, next) {
  const ip = getIp(req) || 'unknown';
  const now = Date.now();
  const recent = (bookAttempts.get(ip) || []).filter(t => now - t < BOOK_WINDOW_MS);
  if (recent.length >= BOOK_MAX_ATTEMPTS) {
    return res.status(429).json({ error: 'Слишком много попыток. Попробуйте через минуту.' });
  }
  recent.push(now);
  bookAttempts.set(ip, recent);
  next();
}
// Periodically prune stale entries so the map does not grow unbounded.
setInterval(() => {
  const now = Date.now();
  for (const [ip, arr] of bookAttempts) {
    const fresh = arr.filter(t => now - t < BOOK_WINDOW_MS);
    if (fresh.length) bookAttempts.set(ip, fresh); else bookAttempts.delete(ip);
  }
}, 5 * 60 * 1000).unref();

function logAction(userType, userName, action, details, slotId, ip, userAgent) {
  try {
    const enabled = db.prepare("SELECT value FROM settings WHERE key = 'logging_enabled'").get();
    if (!enabled || enabled.value !== '1') return;
    db.prepare('INSERT INTO user_logs (user_type, user_name, action, details, slot_id, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)').run(userType || '', userName || '', action || '', details || '', slotId || 0, ip || '', userAgent || '');
  } catch (e) {}
}

function requireManager(req, res, next) {
  if (!req.session || !req.session.managerId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

function isAdminManager(req) {
  if (!req.session || !req.session.managerId) return false;
  try {
    const m = db.prepare('SELECT is_admin FROM managers WHERE id = ?').get(req.session.managerId);
    return !!(m && (m.is_admin === 1 || m.is_admin === '1' || m.is_admin === true));
  } catch (e) { return false; }
}

function requireAdmin(req, res, next) {
  if (!req.session || !req.session.managerId) return res.status(401).json({ error: 'Unauthorized' });
  if (!isAdminManager(req)) return res.status(403).json({ error: 'Доступ только для администраторов' });
  next();
}

function sendSms(phone, message) {
  const setting = db.prepare("SELECT value FROM settings WHERE key = 'smsru_api_key'").get();
  const apiKey = setting ? setting.value : (process.env.SMSRU_API_KEY || '');
  if (!apiKey || !phone) return;
  const postData = `api_id=${apiKey}&to=${phone}&msg=${Buffer.from(message).toString('utf-8')}&json=1`;
  const req = https.request({
    hostname: 'sms.ru',
    path: '/sms/send',
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  }, (res) => {
    let body = '';
    res.on('data', (chunk) => body += chunk);
    res.on('end', () => {});
  });
  req.on('error', () => {});
  req.write(postData);
  req.end();
}

function validateAccountsWith1C(accounts, validationUrl, username, password) {
  return new Promise((resolve) => {
    if (!validationUrl || !accounts.length) { logCheck(accounts, validationUrl, true, 0, '', 'No URL or accounts', ''); resolve({ valid: true, invalidAccounts: [] }); return; }
    try {
      const urlObj = new URL(validationUrl);
      const client = urlObj.protocol === 'https:' ? https : http;
      const reqBodyStr = JSON.stringify({ invoce_number: accounts });
      const options = {
        hostname: urlObj.hostname,
        port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(reqBodyStr) },
        rejectUnauthorized: process.env.INSECURE_1C_TLS !== '1',
        timeout: 10000
      };
      if (username || password) options.auth = `${username}:${password}`;
      const req = client.request(options, (res) => {
        let resp = '';
        res.on('data', chunk => resp += chunk);
        res.on('end', () => {
          try {
            const json = JSON.parse(resp);
            if (json.results && typeof json.results === 'object') {
              const resultKeys = Object.keys(json.results);
              const foundStatuses = resultKeys.map(k => json.results[k].status || '');
              const parsedStatus = foundStatuses.join('; ');
              const invalidAccounts = resultKeys.filter(k => {
                const s = (json.results[k].status || '').toLowerCase().trim();
                return !s.startsWith('found') && !s.startsWith('найден');
              });
              const ok = invalidAccounts.length === 0;
              let customerName = '';
              if (ok) {
                for (const k of resultKeys) {
                  const r = json.results[k];
                  if (r && r.customerGUID) {
                    upsertCounterparty({ guid: r.customerGUID, name: r.customerName, inn: r.customerINN, kpp: r.customerKPP });
                    if (!customerName && r.customerName) customerName = r.customerName;
                  }
                  if (r && r.managerName) {
                    upsertManager1c(r.managerName);
                  }
                  if (r && r.engineerName) {
                    upsertEngineer1c(r.engineerName);
                  }
                  if (r && r.orderNumber) {
                    upsertOrder1c({ orderNumber: r.orderNumber, orderDate: r.orderDate, customerName: r.customerName, customerINN: r.customerINN, customerKPP: r.customerKPP, accountNumber: k, engineerName: r.engineerName || '', managerName: r.managerName || '', comment: r.comment || '' });
                    if (Array.isArray(r.products)) {
                      saveOrderItems1c(r.orderNumber, r.products);
                    }
                  }
                  if (r && Array.isArray(r.products)) {
                    for (const p of r.products) {
                      upsertNomenclature({ guid: p.guid, article: p.article, name: p.name });
                    }
                  }
                }
              }
              logCheck(accounts, validationUrl, ok, res.statusCode, resp, parsedStatus ? 'Parsed: ' + parsedStatus : '', reqBodyStr);
              resolve({ valid: ok, invalidAccounts, customerName });
            } else {
              logCheck(accounts, validationUrl, false, res.statusCode, resp, 'No results field', reqBodyStr);
              resolve({ valid: true, invalidAccounts: [] });
            }
          } catch {
            logCheck(accounts, validationUrl, false, res.statusCode, resp, 'Parse error', reqBodyStr);
            resolve({ valid: true, invalidAccounts: [] });
          }
        });
      });
      req.on('timeout', () => { req.destroy(); logCheck(accounts, validationUrl, false, 0, '', 'Timeout', reqBodyStr); resolve({ valid: true, invalidAccounts: [] }); });
      req.on('error', (err) => { logCheck(accounts, validationUrl, false, 0, '', err.message, reqBodyStr); resolve({ valid: true, invalidAccounts: [] }); });
      req.write(reqBodyStr);
      req.end();
    } catch (err) { logCheck(accounts, validationUrl, false, 0, '', err.message, reqBodyStr); resolve({ valid: true, invalidAccounts: [] }); }
  });
}

function checkPaymentWith1C(accounts, paymentCheckUrl, username, password) {
  return new Promise((resolve) => {
    if (!paymentCheckUrl || !accounts.length) { resolve({ paid: true, unpaidAccounts: [] }); return; }
    try {
      const urlObj = new URL(paymentCheckUrl);
      const client = urlObj.protocol === 'https:' ? https : http;
      const reqBodyStr = JSON.stringify({ invoce_number: accounts });
      const options = {
        hostname: urlObj.hostname,
        port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(reqBodyStr) },
        rejectUnauthorized: process.env.INSECURE_1C_TLS !== '1',
        timeout: 10000
      };
      if (username || password) options.auth = `${username}:${password}`;
      const req = client.request(options, (res) => {
        let resp = '';
        res.on('data', chunk => resp += chunk);
        res.on('end', () => {
          try {
            const json = JSON.parse(resp);
            if (json.results && typeof json.results === 'object') {
              const resultKeys = Object.keys(json.results);
              const unpaidAccounts = resultKeys.filter(k => {
                const s = (json.results[k].status || '').toLowerCase().trim();
                return s.startsWith('not paid') || s.startsWith('не оплачен') || s.startsWith('not ready') || s.startsWith('не готов');
              });
              const paid = unpaidAccounts.length === 0;
              logCheck(accounts, paymentCheckUrl, paid, res.statusCode, resp, '', reqBodyStr);
              resolve({ paid, unpaidAccounts });
            } else {
              logCheck(accounts, paymentCheckUrl, true, res.statusCode, resp, 'No results field', reqBodyStr);
              resolve({ paid: true, unpaidAccounts: [] });
            }
          } catch {
            logCheck(accounts, paymentCheckUrl, true, res.statusCode, resp, 'Parse error', reqBodyStr);
            resolve({ paid: true, unpaidAccounts: [] });
          }
        });
      });
      req.on('timeout', () => { req.destroy(); logCheck(accounts, paymentCheckUrl, false, 0, '', 'Timeout', reqBodyStr); resolve({ paid: true, unpaidAccounts: [] }); });
      req.on('error', (err) => { logCheck(accounts, paymentCheckUrl, false, 0, '', err.message, reqBodyStr); resolve({ paid: true, unpaidAccounts: [] }); });
      req.write(reqBodyStr);
      req.end();
    } catch (err) { logCheck(accounts, paymentCheckUrl, false, 0, '', err.message, ''); resolve({ paid: true, unpaidAccounts: [] }); }
  });
}

function checkReadyWith1C(accounts, readyCheckUrl, username, password) {
  return new Promise((resolve) => {
    if (!readyCheckUrl || !accounts.length) { resolve({ allReady: false, readyAccounts: [], goodsByAccount: {}, notReadyReasons: {} }); return; }
    try {
      const urlObj = new URL(readyCheckUrl);
      const client = urlObj.protocol === 'https:' ? https : http;
      const reqBodyStr = JSON.stringify({ invoce_number: accounts });
      const options = {
        hostname: urlObj.hostname,
        port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(reqBodyStr) },
        rejectUnauthorized: process.env.INSECURE_1C_TLS !== '1',
        timeout: 10000
      };
      if (username || password) options.auth = `${username}:${password}`;
      const req = client.request(options, (res) => {
        let resp = '';
        res.on('data', chunk => resp += chunk);
        res.on('end', () => {
          try {
            const json = JSON.parse(resp);
            const goodsByAccount = {};
            const readyAccounts = [];
            const notReadyReasons = {};
            if (Array.isArray(json.orders)) {
              for (const r of json.orders) {
                const inv = r.invoiceNumber;
                if (!inv) continue;
                if (Number(r.readyStatus) === 1) {
                  readyAccounts.push(inv);
                  if (Array.isArray(r.goods)) {
                    goodsByAccount[inv] = r.goods.filter(g => g.canShip);
                  }
                }
                if (r.notReadyReason) {
                  notReadyReasons[inv] = r.notReadyReason;
                }
              }
            }
            const allReady = readyAccounts.length === accounts.length;
            logCheck(accounts, readyCheckUrl, allReady, res.statusCode, resp, allReady ? 'All ready' : 'Not all ready', reqBodyStr);
            resolve({ allReady, readyAccounts, goodsByAccount, notReadyReasons });
          } catch {
            logCheck(accounts, readyCheckUrl, false, res.statusCode, resp, 'Parse error', reqBodyStr);
            resolve({ allReady: false, readyAccounts: [], goodsByAccount: {}, notReadyReasons: {} });
          }
        });
      });
      req.on('timeout', () => { req.destroy(); logCheck(accounts, readyCheckUrl, false, 0, '', 'Timeout', reqBodyStr); resolve({ allReady: false, readyAccounts: [], goodsByAccount: {}, notReadyReasons: {} }); });
      req.on('error', (err) => { logCheck(accounts, readyCheckUrl, false, 0, '', err.message, reqBodyStr); resolve({ allReady: false, readyAccounts: [], goodsByAccount: {}, notReadyReasons: {} }); });
      req.write(reqBodyStr);
      req.end();
    } catch (err) { logCheck(accounts, readyCheckUrl, false, 0, '', err.message, ''); resolve({ allReady: false, readyAccounts: [], goodsByAccount: {}, notReadyReasons: {} }); }
  });
}

function logCheck(accounts, url, success, status, body, error, reqBody) {
  try {
    const db = getDb();
    db.prepare("INSERT INTO check_logs (accounts, success, response_status, response_body, error, url, request_body) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      Array.isArray(accounts) ? accounts.join(', ') : String(accounts),
      success ? 1 : 0,
      status || null,
      body ? body.substring(0, 5000) : null,
      error || null,
      url || '',
      reqBody || ''
    );
  } catch {}
}

app.get('/api/warehouses', (req, res) => {
  const list = db.prepare('SELECT id, name, is_default FROM warehouses ORDER BY is_default DESC, name').all();
  res.json({ warehouses: list });
});

function worksOnWeekends() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'work_on_weekends'").get();
  return row ? row.value === '1' : false;
}

app.get('/api/slots', async (req, res) => {
  const { date, type, warehouse_id } = req.query;
  if (!date || !type) {
    return res.status(400).json({ error: 'date and type are required' });
  }
  if (!['small', 'bulk'].includes(type)) {
    return res.status(400).json({ error: 'type must be small or bulk' });
  }
  // Weekends are closed unless the "work on weekends" setting is enabled.
  if (!isWeekday(date) && !worksOnWeekends()) {
    return res.json({ slots: [], weekday: false });
  }
  const whId = warehouse_id || null;
  // Cache the slot rows (booked/free status) under a slots:* key so the
  // existing redisFlushSlotsCache() invalidation on any write also clears it.
  const cacheKey = 'slots:public:' + date + ':' + type + ':' + (warehouse_id || 'all');
  let slots = null;
  const cached = await redisGet(cacheKey);
  if (cached) {
    try { slots = JSON.parse(cached); } catch (e) { slots = null; }
  }
  if (!slots) {
    ensureSlotsExist(date, type);
    slots = db.prepare(
      'SELECT id, date, type, time_start, time_end, is_booked, confirmed, in_progress, completed, assembling, warehouse_id FROM slots WHERE date = ? AND type = ? AND (warehouse_id = ? OR (warehouse_id IS NULL AND ? IS NULL)) ORDER BY time_start'
    ).all(date, type, whId, whId);
    redisSet(cacheKey, JSON.stringify(slots), 30);
  }
  // "past" depends on the current time, so it is always computed fresh,
  // never served from cache.
  const minTime = new Date(Date.now() + 3600000);
  const maxTime = new Date(Date.now() + 1209600000);
  const enriched = slots.map(s => {
    const slotDate = new Date(`${s.date}T${s.time_start}`);
    return {
      ...s,
      past: slotDate <= minTime || slotDate > maxTime
    };
  });
  res.json({ slots: enriched, weekday: true });
});

app.get('/api/captcha', (req, res) => {
  const a = Math.floor(Math.random() * 20) + 1;
  const b = Math.floor(Math.random() * 20) + 1;
  req.session.captcha = a + b;
  res.json({ expression: `${a} + ${b}` });
});

app.get('/api/public/settings/allow-booking-without-account', (req, res) => {
  const setting = db.prepare("SELECT value FROM settings WHERE key = 'allow_booking_without_account'").get();
  res.json({ allow: setting ? setting.value !== '0' : true });
});

app.get('/api/public/vehicle-classes', (req, res) => {
  const classes = db.prepare('SELECT id, name, description FROM vehicle_classes ORDER BY name').all();
  res.json({ classes });
});

app.get('/api/public/load-types', (req, res) => {
  const types = db.prepare('SELECT id, name, description FROM load_types ORDER BY name').all();
  res.json({ types });
});

app.post('/api/slots/:id/book', bookRateLimit, async (req, res) => {
  try {
  const { id } = req.params;
  const { name: nameRaw, phone: phoneRaw, account, comment, organization: org, captchaAnswer, force, vehicleClassId, loadTypeId } = req.body;
  let organization = org;
  if (!nameRaw || !phoneRaw) {
    return res.status(400).json({ error: 'name and phone are required' });
  }
  // Normalize once so blacklist checks and storage use the same value.
  const name = String(nameRaw).trim();
  const phone = String(phoneRaw).trim();
  if (!vehicleClassId) {
    return res.status(400).json({ error: 'Выберите класс машины' });
  }
  if (!loadTypeId) {
    return res.status(400).json({ error: 'Выберите вид загрузки' });
  }
  const bannedPhone = db.prepare('SELECT id FROM banned_phones WHERE phone = ?').get(phone.trim());
  if (bannedPhone) {
    return res.status(403).json({ error: 'Ваш номер телефона находится в чёрном списке' });
  }
  const clientIp = getIp(req);
  const bannedIp = db.prepare('SELECT id FROM banned_ips WHERE ip = ?').get(clientIp);
  if (bannedIp) {
    return res.status(403).json({ error: 'Ваш IP-адрес находится в чёрном списке' });
  }

  const allowNoAccountSetting = db.prepare("SELECT value FROM settings WHERE key = 'allow_booking_without_account'").get();
  const allowNoAccount = allowNoAccountSetting ? allowNoAccountSetting.value !== '0' : true;
  if (!allowNoAccount && !account) {
    return res.status(400).json({ error: 'Необходимо указать номер счета' });
  }

  const warnMissingSetting = db.prepare("SELECT value FROM settings WHERE key = 'warn_missing_account_at_booking'").get();
  const warnMissing = warnMissingSetting ? warnMissingSetting.value === '1' : false;

  let bookingWarning = '';
  let autoConfirmSlot = false;

  if (!account && warnMissing) {
    bookingWarning = 'Не указан ни один номер счета';
  }

  if (account) {
    const accounts = account.split('\n').map(a => a.trim()).filter(a => a);
    if (accounts.length > 10) {
      return res.status(400).json({ error: 'No more than 10 account numbers' });
    }
  }
  if (req.session.captcha === undefined || Number(captchaAnswer) !== req.session.captcha) {
    return res.status(400).json({ error: 'Invalid captcha answer' });
  }
  delete req.session.captcha;

  if (account) {
    const accounts = account.split('\n').map(a => a.trim()).filter(a => a);
    const valUrlSetting = db.prepare("SELECT value FROM settings WHERE key = '1c_order_validation_url'").get();
    const validationUrl = valUrlSetting ? valUrlSetting.value : '';
    if (validationUrl && accounts.length) {
      const userSetting = db.prepare("SELECT value FROM settings WHERE key = '1c_username'").get();
      const passSetting = db.prepare("SELECT value FROM settings WHERE key = '1c_password'").get();
      const username = userSetting ? userSetting.value : '';
      const password = passSetting ? passSetting.value : '';
      const result = await validateAccountsWith1C(accounts, validationUrl, username, password);
      if (!organization && result.customerName) {
        organization = result.customerName;
      }
      if (!result.valid) {
        const allowInvalidSetting = db.prepare("SELECT value FROM settings WHERE key = 'allow_booking_with_invalid_account'").get();
        const allowInvalid = allowInvalidSetting ? allowInvalidSetting.value === '1' : false;
        if (!allowInvalid && !force) {
          const msg = result.invalidAccounts.length
            ? 'Счёт не найден в 1С: ' + result.invalidAccounts.join(', ')
            : 'Один или несколько счетов не найдены в 1С';
          return res.status(400).json({ error: msg, validationFailed: true, invalidAccounts: result.invalidAccounts });
        }
        const msg = result.invalidAccounts.length
          ? 'Счёт не найден в 1С: ' + result.invalidAccounts.join(', ')
          : 'Один или несколько счетов не найдены в 1С';
        bookingWarning = msg;
      }
      if (result.valid) {
        const payUrlSetting = db.prepare("SELECT value FROM settings WHERE key = '1c_payment_check_url'").get();
        const paymentCheckUrl = payUrlSetting ? payUrlSetting.value : '';
        if (paymentCheckUrl) {
          const payResult = await checkPaymentWith1C(accounts, paymentCheckUrl, username, password);
          if (!payResult.paid && payResult.unpaidAccounts.length) {
            const payMsg = 'Не оплачены счета: ' + payResult.unpaidAccounts.join(', ');
            bookingWarning = bookingWarning ? bookingWarning + '; ' + payMsg : payMsg;
          }
          const readyResult = await checkReadyWith1C(accounts, paymentCheckUrl, username, password);
          if (readyResult.allReady) {
            autoConfirmSlot = true;
            for (const acc of accounts) {
              const order = db.prepare("SELECT orderNumber FROM orders_1c WHERE accountNumber = ?").get(acc);
              if (order) {
                db.prepare("UPDATE orders_1c SET readyStatus = 1 WHERE orderNumber = ?").run(order.orderNumber);
              }
            }
            for (const goods of Object.values(readyResult.goodsByAccount)) {
              for (const g of goods) {
                const guid = g.guid || g.productGuid || g.productGUID || g.nomenclatureGuid || g.id || '';
                const article = g.article || '';
                if (guid) {
                  db.prepare("UPDATE order_items_1c SET status = 'К отгрузке' WHERE guid = ?").run(guid);
                } else if (article) {
                  db.prepare("UPDATE order_items_1c SET status = 'К отгрузке' WHERE article = ?").run(article);
                }
              }
            }
          }
          for (const [acc, reason] of Object.entries(readyResult.notReadyReasons)) {
            if (reason) {
              const order = db.prepare("SELECT orderNumber FROM orders_1c WHERE accountNumber = ?").get(acc);
              if (order) {
                db.prepare("UPDATE orders_1c SET notReadyReason = ? WHERE orderNumber = ?").run(reason, order.orderNumber);
              }
            }
          }
        }
      }
    }
  }

  const slot = db.prepare(`
    SELECT s.*, w.name AS warehouse_name, w.address AS warehouse_address
    FROM slots s LEFT JOIN warehouses w ON w.id = s.warehouse_id WHERE s.id = ?
  `).get(id);
  if (!slot) {
    return res.status(404).json({ error: 'Slot not found' });
  }
  if (slot.is_booked) {
    return res.status(409).json({ error: 'Slot already booked' });
  }
  if (account && slot.type === 'small') {
    const accountsArr = account.split('\n').map(a => a.trim()).filter(a => a);
    if (accountsArr.length > 3) {
      return res.status(400).json({ error: 'Вы указали более трех счетов в раздел До трех товаров в накладной, для отгрузки более трех товаров выберите раздел Сборный заказ' });
    }
  }
  const slotDate = new Date(`${slot.date}T${slot.time_start}`);
  if (slotDate <= new Date(Date.now() + 3600000)) {
    return res.status(400).json({ error: 'Слот можно забронировать минимум за 1 час' });
  }
  if (slotDate > new Date(Date.now() + 1209600000)) {
    return res.status(400).json({ error: 'Нельзя записаться на дату более 2 недель от текущей' });
  }
  // Conditional update guards against the double-booking race: only one
  // concurrent request can flip is_booked 0 -> 1.
  const bookInfo = db.prepare(
    "UPDATE slots SET is_booked = 1, customer_name = ?, customer_phone = ?, customer_account = ?, customer_comment = ?, customer_organization = ?, booked_at = datetime('now'), customer_ip = ?, customer_user_agent = ?, vehicle_class_id = ?, load_type_id = ? WHERE id = ? AND is_booked = 0"
  ).run(name, phone, account || null, comment || null, organization || null, getIp(req), getUserAgent(req), vehicleClassId, loadTypeId, id);
  if (!bookInfo || bookInfo.changes === 0) {
    return res.status(409).json({ error: 'Slot already booked' });
  }
  if (autoConfirmSlot) {
    db.prepare("UPDATE slots SET confirmed = 1, confirmed_at = datetime('now') WHERE id = ?").run(id);
  }
  logAction('client', name + ' (' + phone + ')', 'Бронирование', 'Слот ' + slot.time_start + '-' + slot.time_end + ' ' + slot.date + (account ? ', счета: ' + account.replace(/\n/g, ', ') : ''), Number(id), getIp(req), getUserAgent(req));
  const whName = slot.warehouse_name || '';
  const whAddr = slot.warehouse_address ? ` (${slot.warehouse_address})` : '';
  const typeLabel = slot.type === 'small' ? 'До 3-х товаров' : 'Сборный заказ';
  const dayNames = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
  const dayName = dayNames[new Date(slot.date + 'T00:00:00').getDay()];
  sendSms(phone, `Вы записаны на ${slot.date} (${dayName}) ${slot.time_start}–${slot.time_end}, ${typeLabel}, склад ${whName}${whAddr}`);
  redisFlushSlotsCache();
  res.json({ success: true, warning: bookingWarning || undefined });
  } catch (err) {
    console.error('Booking error:', err);
    res.status(500).json({ error: 'Внутренняя ошибка сервера. Попробуйте позже.' });
  }
});

app.post('/api/manager/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'username and password are required' });
  }
  const hash = crypto.createHash('sha256').update(password).digest('hex');
  const manager = db.prepare('SELECT * FROM managers WHERE username = ? AND password_hash = ?').get(username, hash);
  if (!manager) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  req.session.managerId = manager.id;
  req.session.username = manager.username;
  req.session.firstName = manager.first_name;
  req.session.lastName = manager.last_name;
  res.json({ success: true, id: manager.id, username: manager.username, firstName: manager.first_name, lastName: manager.last_name, isAdmin: !!(manager.is_admin === 1 || manager.is_admin === '1' || manager.is_admin === true) });
});

app.post('/api/manager/logout', requireManager, (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.get('/api/manager/me', requireManager, async (req, res) => {
  const cacheKey = 'manager-me:' + req.session.managerId;
  const cached = await redisGet(cacheKey);
  if (cached) return res.json(JSON.parse(cached));
  const mgr = db.prepare('SELECT * FROM managers WHERE id = ?').get(req.session.managerId);
  const response = { id: mgr.id, username: mgr.username, firstName: mgr.first_name, lastName: mgr.last_name, warehouseId: mgr.warehouse_id, isAdmin: !!(mgr.is_admin === 1 || mgr.is_admin === '1' || mgr.is_admin === true) };
  redisSet(cacheKey, JSON.stringify(response), 300);
  res.json(response);
});

app.get('/api/manager/slots', requireManager, async (req, res) => {
  const { date, type, warehouse_id } = req.query;
  const cacheKey = 'slots:' + (date || 'all') + ':' + (type || 'all') + ':' + (warehouse_id || 'all');
  const cached = await redisGet(cacheKey);
  if (cached) return res.json(JSON.parse(cached));
  let query = 'SELECT s.*, w.name AS warehouse_name, vc.name AS vehicle_class_name, lt.name AS load_type_name FROM slots s LEFT JOIN warehouses w ON w.id = s.warehouse_id LEFT JOIN vehicle_classes vc ON vc.id = s.vehicle_class_id LEFT JOIN load_types lt ON lt.id = s.load_type_id WHERE 1=1';
  const params = [];
  if (date) {
    query += ' AND s.date = ?';
    params.push(date);
  }
  if (type) {
    query += ' AND s.type = ?';
    params.push(type);
  }
  if (warehouse_id) {
    query += ' AND s.warehouse_id = ?';
    params.push(warehouse_id);
  }
  query += ' ORDER BY s.date DESC, s.time_start';
  const slots = db.prepare(query).all(...params);
  const allAccounts = [];
  for (const s of slots) {
    if (s.customer_account) {
      const accs = s.customer_account.split('\n').map(function(a) { return a.trim(); }).filter(function(a) { return a; });
      for (const a of accs) {
        if (allAccounts.indexOf(a) === -1) allAccounts.push(a);
      }
    }
  }
  const ordersMap = {};
  if (allAccounts.length) {
    const placeholders = allAccounts.map(function() { return '?'; }).join(',');
    const orders = db.prepare('SELECT accountNumber, engineerName, managerName, comment, readyStatus, notReadyReason FROM orders_1c WHERE accountNumber IN (' + placeholders + ')').all(...allAccounts);
    for (const o of orders) {
      ordersMap[o.accountNumber] = { engineerName: o.engineerName || '', managerName: o.managerName || '', comment: o.comment || '', readyStatus: o.readyStatus || 0, notReadyReason: o.notReadyReason || '' };
    }
  }
  const result = slots.map(function(row) {
    const accounts = row.customer_account ? row.customer_account.split('\n').map(function(a) { return a.trim(); }).filter(function(a) { return a; }) : [];
    const accountsInfo = accounts.map(function(a) {
      const info = ordersMap[a] || {};
      return { accountNumber: a, engineerName: info.engineerName || '', managerName: info.managerName || '', comment: info.comment || '', readyStatus: info.readyStatus || 0, notReadyReason: info.notReadyReason || '' };
    });
    return {
      id: row.id, date: row.date, type: row.type, time_start: row.time_start,
      time_end: row.time_end, is_booked: row.is_booked, confirmed: row.confirmed,
      customer_name: row.customer_name, customer_phone: row.customer_phone,
      customer_account: row.customer_account, customer_organization: row.customer_organization,
      customer_comment: row.customer_comment, booked_at: row.booked_at,
      confirmed_at: row.confirmed_at, in_progress: row.in_progress,
      in_progress_at: row.in_progress_at, assembling: row.assembling,
      assembling_at: row.assembling_at, completed: row.completed,
      completed_at: row.completed_at, warehouse_id: row.warehouse_id,
      storekeeper_id: row.storekeeper_id, storekeeper_name: row.storekeeper_name,
      warehouse_name: row.warehouse_name,
      vehicle_class_name: row.vehicle_class_name || null,
      load_type_name: row.load_type_name || null,
      accounts: accountsInfo
    };
  });
  const response = { slots: result };
  redisSet(cacheKey, JSON.stringify(response), 10);
  res.json(response);
});

app.get('/api/manager/slots/:id', requireManager, async (req, res) => {
  const { id } = req.params;
  const cacheKey = 'slots-id:' + id;
  const cached = await redisGet(cacheKey);
  if (cached) return res.json(JSON.parse(cached));
  const slot = db.prepare('SELECT * FROM slots WHERE id = ?').get(id);
  if (!slot) {
    return res.status(404).json({ error: 'Slot not found' });
  }
  const response = { slots: [slot] };
  redisSet(cacheKey, JSON.stringify(response), 10);
  res.json(response);
});

app.delete('/api/manager/slots/:id', requireManager, (req, res) => {
  const { id } = req.params;
  const slot = db.prepare('SELECT * FROM slots WHERE id = ?').get(id);
  if (!slot) {
    return res.status(404).json({ error: 'Slot not found' });
  }
  db.prepare('DELETE FROM slots WHERE id = ?').run(id);
  redisFlushSlotsCache();
  res.json({ success: true });
});

app.post('/api/manager/slots/:id/confirm', requireManager, (req, res) => {
  const { id } = req.params;
  const slot = db.prepare('SELECT * FROM slots WHERE id = ?').get(id);
  if (!slot) {
    return res.status(404).json({ error: 'Slot not found' });
  }
  if (!slot.is_booked) {
    return res.status(400).json({ error: 'Cannot confirm an unbooked slot' });
  }
  db.prepare("UPDATE slots SET confirmed = 1, confirmed_at = datetime('now') WHERE id = ?").run(id);
  logAction('manager', req.session.firstName + ' ' + req.session.lastName, 'Подтверждение', 'Слот ' + slot.time_start + '-' + slot.time_end + ' ' + slot.date, Number(id), getIp(req), getUserAgent(req));
  redisFlushSlotsCache();
  res.json({ success: true });
});

app.post('/api/manager/slots/:id/take', requireManager, (req, res) => {
  const { id } = req.params;
  const { storekeeperId } = req.body;
  const slot = db.prepare('SELECT * FROM slots WHERE id = ?').get(id);
  if (!slot) {
    return res.status(404).json({ error: 'Slot not found' });
  }
  if (!slot.confirmed) {
    return res.status(400).json({ error: 'Slot must be confirmed first' });
  }
  let skName = '';
  if (storekeeperId) {
    const sk = db.prepare('SELECT * FROM storekeepers WHERE id = ?').get(storekeeperId);
    if (sk) skName = sk.name;
  }
  db.prepare("UPDATE slots SET in_progress = 1, in_progress_at = datetime('now'), storekeeper_id = ?, storekeeper_name = ? WHERE id = ?").run(storekeeperId || null, skName, id);
  logAction('manager', req.session.firstName + ' ' + req.session.lastName, 'Взял в работу', 'Слот ' + slot.time_start + '-' + slot.time_end + ' ' + slot.date + (skName ? ', кладовщик: ' + skName : ''), Number(id), getIp(req), getUserAgent(req));
  redisFlushSlotsCache();
  res.json({ success: true });
});

app.post('/api/manager/slots/:id/return-from-assembly', requireManager, (req, res) => {
  const { id } = req.params;
  const slot = db.prepare('SELECT * FROM slots WHERE id = ?').get(id);
  if (!slot) {
    return res.status(404).json({ error: 'Slot not found' });
  }
  if (!slot.assembling) {
    return res.status(400).json({ error: 'Slot is not in assembly' });
  }
  db.prepare("UPDATE slots SET assembling = 0, assembling_at = NULL WHERE id = ?").run(id);
  logAction('manager', req.session.firstName + ' ' + req.session.lastName, 'Возврат со сборки', 'Слот ' + slot.time_start + '-' + slot.time_end + ' ' + slot.date, Number(id), getIp(req), getUserAgent(req));
  redisFlushSlotsCache();
  res.json({ success: true });
});
app.post('/api/manager/slots/:id/assemble', requireManager, (req, res) => {
  const { id } = req.params;
  const slot = db.prepare('SELECT * FROM slots WHERE id = ?').get(id);
  if (!slot) {
    return res.status(404).json({ error: 'Slot not found' });
  }
  if (!slot.in_progress) {
    return res.status(400).json({ error: 'Slot must be assigned to storekeeper first' });
  }
  if (slot.assembling) {
    return res.status(400).json({ error: 'Slot is already in assembly' });
  }
  db.prepare("UPDATE slots SET assembling = 1, assembling_at = datetime('now') WHERE id = ?").run(id);
  logAction('manager', req.session.firstName + ' ' + req.session.lastName, 'На сборке', 'Слот ' + slot.time_start + '-' + slot.time_end + ' ' + slot.date, Number(id), getIp(req), getUserAgent(req));
  redisFlushSlotsCache();
  res.json({ success: true });
});
app.post('/api/manager/slots/:id/complete', requireManager, (req, res) => {
  const { id } = req.params;
  const slot = db.prepare('SELECT * FROM slots WHERE id = ?').get(id);
  if (!slot) {
    return res.status(404).json({ error: 'Slot not found' });
  }
  if (!slot.assembling) {
    return res.status(400).json({ error: 'Slot must be in assembly first' });
  }
  db.prepare("UPDATE slots SET completed = 1, completed_at = datetime('now') WHERE id = ?").run(id);
  logAction('manager', req.session.firstName + ' ' + req.session.lastName, 'Завершён', 'Слот ' + slot.time_start + '-' + slot.time_end + ' ' + slot.date, Number(id), getIp(req), getUserAgent(req));
  sendSms(slot.customer_phone, 'Ваш заказ собран, обратитесь к сотруднику склада за его получением.');
  redisFlushSlotsCache();
  res.json({ success: true });
});

/* ---------- 1C Integration ---------- */

function require1cToken(req, res, next) {
  const token = req.query.token || req.headers['x-api-token'];
  if (!token) {
    return res.status(401).json({ error: 'Token required' });
  }
  const stored = db.prepare("SELECT value FROM settings WHERE key = '1c_api_token'").get();
  if (!stored || stored.value !== token) {
    return res.status(403).json({ error: 'Invalid token' });
  }
  next();
}

app.get('/api/manager/settings/1c', requireManager, (req, res) => {
  const token = db.prepare("SELECT value FROM settings WHERE key = '1c_api_token'").get();
  const url = db.prepare("SELECT value FROM settings WHERE key = '1c_server_url'").get();
  const user = db.prepare("SELECT value FROM settings WHERE key = '1c_username'").get();
  const pass = db.prepare("SELECT value FROM settings WHERE key = '1c_password'").get();
  const orderUrl = db.prepare("SELECT value FROM settings WHERE key = '1c_order_validation_url'").get();
  const payUrl = db.prepare("SELECT value FROM settings WHERE key = '1c_payment_check_url'").get();
  const notesVal = db.prepare("SELECT value FROM settings WHERE key = '1c_notes'").get();
  const allowNoAccount = db.prepare("SELECT value FROM settings WHERE key = 'allow_booking_without_account'").get();
  const allowInvalid = db.prepare("SELECT value FROM settings WHERE key = 'allow_booking_with_invalid_account'").get();
  const warnMissing = db.prepare("SELECT value FROM settings WHERE key = 'warn_missing_account_at_booking'").get();
  res.json({ token: token ? token.value : '', serverUrl: url ? url.value : '', username: user ? user.value : '', password: pass ? pass.value : '', orderValidationUrl: orderUrl ? orderUrl.value : '', paymentCheckUrl: payUrl ? payUrl.value : '', notes: notesVal ? notesVal.value : '', allowBookingWithoutAccount: allowNoAccount ? allowNoAccount.value : '1', allowBookingWithInvalidAccount: allowInvalid ? allowInvalid.value : '0', warnMissingAccountAtBooking: warnMissing ? warnMissing.value : '0' });
});

app.post('/api/manager/settings/1c/regenerate', requireManager, (req, res) => {
  const token = crypto.randomBytes(24).toString('hex');
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('1c_api_token', ?)").run(token);
  redisFlushByPrefix('orders-1c');
  redisFlushByPrefix('managers-1c');
  redisFlushByPrefix('engineers-1c');
  redisFlushByPrefix('c1-orders');
  res.json({ success: true, token });
});

app.post('/api/manager/settings/1c/server-url', requireManager, (req, res) => {
  const { serverUrl } = req.body;
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('1c_server_url', ?)").run(serverUrl || '');
  redisFlushByPrefix('orders-1c');
  redisFlushByPrefix('managers-1c');
  redisFlushByPrefix('engineers-1c');
  redisFlushByPrefix('c1-orders');
  res.json({ success: true });
});

app.post('/api/manager/settings/1c/credentials', requireManager, (req, res) => {
  const { username, password } = req.body;
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('1c_username', ?)").run(username || '');
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('1c_password', ?)").run(password || '');
  redisFlushByPrefix('orders-1c');
  redisFlushByPrefix('managers-1c');
  redisFlushByPrefix('engineers-1c');
  redisFlushByPrefix('c1-orders');
  res.json({ success: true });
});

app.post('/api/manager/settings/1c/password', requireManager, (req, res) => {
  const { password } = req.body;
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('1c_password', ?)").run(password || '');
  res.json({ success: true });
});

app.post('/api/manager/settings/1c/order-validation-url', requireManager, (req, res) => {
  const { orderValidationUrl } = req.body;
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('1c_order_validation_url', ?)").run(orderValidationUrl || '');
  redisFlushByPrefix('orders-1c');
  redisFlushByPrefix('managers-1c');
  redisFlushByPrefix('engineers-1c');
  redisFlushByPrefix('c1-orders');
  res.json({ success: true });
});

app.post('/api/manager/settings/1c/payment-check-url', requireManager, (req, res) => {
  const { paymentCheckUrl } = req.body;
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('1c_payment_check_url', ?)").run(paymentCheckUrl || '');
  redisFlushByPrefix('orders-1c');
  redisFlushByPrefix('managers-1c');
  redisFlushByPrefix('engineers-1c');
  redisFlushByPrefix('c1-orders');
  res.json({ success: true });
});

app.post('/api/manager/settings/1c/notes', requireManager, (req, res) => {
  const { notes } = req.body;
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('1c_notes', ?)").run(notes || '');
  redisFlushByPrefix('orders-1c');
  redisFlushByPrefix('managers-1c');
  redisFlushByPrefix('engineers-1c');
  redisFlushByPrefix('c1-orders');
  res.json({ success: true });
});

app.post('/api/manager/settings/1c/allow-booking-without-account', requireManager, (req, res) => {
  const { allow } = req.body;
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('allow_booking_without_account', ?)").run(allow ? '1' : '0');
  redisFlushByPrefix('orders-1c');
  redisFlushByPrefix('managers-1c');
  redisFlushByPrefix('engineers-1c');
  redisFlushByPrefix('c1-orders');
  res.json({ success: true });
});

app.post('/api/manager/settings/1c/allow-booking-with-invalid-account', requireManager, (req, res) => {
  const { allow } = req.body;
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('allow_booking_with_invalid_account', ?)").run(allow ? '1' : '0');
  redisFlushByPrefix('orders-1c');
  redisFlushByPrefix('managers-1c');
  redisFlushByPrefix('engineers-1c');
  redisFlushByPrefix('c1-orders');
  res.json({ success: true });
});

app.post('/api/manager/settings/1c/warn-missing-account-at-booking', requireManager, (req, res) => {
  const { warn } = req.body;
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('warn_missing_account_at_booking', ?)").run(warn ? '1' : '0');
  redisFlushByPrefix('orders-1c');
  redisFlushByPrefix('managers-1c');
  redisFlushByPrefix('engineers-1c');
  redisFlushByPrefix('c1-orders');
  res.json({ success: true });
});

app.post('/api/manager/settings/1c/test-order-validation', requireManager, async (req, res) => {
  const { accounts } = req.body;
  if (!accounts || !Array.isArray(accounts) || !accounts.length) {
    return res.status(400).json({ error: 'Accounts array required' });
  }
  const valUrlSetting = db.prepare("SELECT value FROM settings WHERE key = '1c_order_validation_url'").get();
  const validationUrl = valUrlSetting ? valUrlSetting.value : '';
  if (!validationUrl) {
    return res.status(400).json({ error: 'Validation URL not configured' });
  }
  const userSetting = db.prepare("SELECT value FROM settings WHERE key = '1c_username'").get();
  const passSetting = db.prepare("SELECT value FROM settings WHERE key = '1c_password'").get();
  const username = userSetting ? userSetting.value : '';
  const password = passSetting ? passSetting.value : '';
  const body = JSON.stringify({ invoce_number: accounts });
  const maskedAuth = 'Basic ' + Buffer.from(username + ':' + password).toString('base64') + '  (логин: ' + username + ', пароль: ' + password + ')';
  const prettyBody = JSON.stringify({ invoce_number: accounts }, null, 2);
  const requestDescription = `POST ${validationUrl}\nAuthorization: ${maskedAuth}\nContent-Type: application/json\n\n${prettyBody}`;
  try {
    const urlObj = new URL(validationUrl);
    const client = urlObj.protocol === 'https:' ? https : http;
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      rejectUnauthorized: process.env.INSECURE_1C_TLS !== '1',
      timeout: 10000
    };
    if (username || password) options.auth = `${username}:${password}`;
    const req = client.request(options, (response) => {
      let resp = '';
      response.on('data', chunk => resp += chunk);
      response.on('end', () => {
        let ok = false;
        let invalidAccounts = [];
        let parsedStatus = '';
        try {
          const json = JSON.parse(resp);
          if (json.results && typeof json.results === 'object') {
            const resultKeys = Object.keys(json.results);
            const foundStatuses = resultKeys.map(k => json.results[k].status || '');
            parsedStatus = foundStatuses.join('; ');
            invalidAccounts = resultKeys.filter(k => {
              const s = (json.results[k].status || '').toLowerCase().trim();
              return !s.startsWith('found') && !s.startsWith('найден');
            });
            ok = invalidAccounts.length === 0;
          } else {
            parsedStatus = '(no results field — проверка пропущена)';
            ok = true;
          }
        } catch {
          parsedStatus = '(parse error — проверка пропущена)';
          ok = true;
        }
        logCheck(accounts, validationUrl, ok, response.statusCode, resp, parsedStatus, body);
        let jsonKeys = null;
        try { jsonKeys = Object.keys(JSON.parse(resp)); } catch {}
        res.json({ httpStatus: response.statusCode, body: resp, parsedStatus: parsedStatus || null, jsonKeys, success: ok, invalidAccounts, request: requestDescription });
      });
    });
    req.on('timeout', () => { req.destroy(); logCheck(accounts, validationUrl, false, 0, '', 'Timeout', body); res.json({ httpStatus: 0, body: 'Timeout', success: false, request: requestDescription }); });
    req.on('error', (err) => { logCheck(accounts, validationUrl, false, 0, '', err.message, body); res.json({ httpStatus: 0, body: err.message, success: false, request: requestDescription }); });
    req.write(body);
    req.end();
  } catch (err) {
    logCheck(accounts, validationUrl, false, 0, '', err.message, '');
    res.json({ httpStatus: 0, body: err.message, success: false, request: requestDescription });
  }
});

app.post('/api/manager/settings/1c/test-payment-check', requireManager, async (req, res) => {
  const { accounts } = req.body;
  if (!accounts || !Array.isArray(accounts) || !accounts.length) {
    return res.status(400).json({ error: 'Accounts array required' });
  }
  const payUrlSetting = db.prepare("SELECT value FROM settings WHERE key = '1c_payment_check_url'").get();
  const paymentCheckUrl = payUrlSetting ? payUrlSetting.value : '';
  if (!paymentCheckUrl) {
    return res.status(400).json({ error: 'Payment check URL not configured' });
  }
  const userSetting = db.prepare("SELECT value FROM settings WHERE key = '1c_username'").get();
  const passSetting = db.prepare("SELECT value FROM settings WHERE key = '1c_password'").get();
  const username = userSetting ? userSetting.value : '';
  const password = passSetting ? passSetting.value : '';
  const body = JSON.stringify({ invoce_number: accounts });
  const maskedAuth = 'Basic ' + Buffer.from(username + ':' + password).toString('base64') + '  (логин: ' + username + ', пароль: ' + password + ')';
  const prettyBody = JSON.stringify({ invoce_number: accounts }, null, 2);
  const requestDescription = `POST ${paymentCheckUrl}\nAuthorization: ${maskedAuth}\nContent-Type: application/json\n\n${prettyBody}`;
  try {
    const urlObj = new URL(paymentCheckUrl);
    const client = urlObj.protocol === 'https:' ? https : http;
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      rejectUnauthorized: process.env.INSECURE_1C_TLS !== '1',
      timeout: 10000
    };
    if (username || password) options.auth = `${username}:${password}`;
    const req = client.request(options, (response) => {
      let resp = '';
      response.on('data', chunk => resp += chunk);
      response.on('end', () => {
        let ok = false;
        let parsedStatus = '';
        let jsonKeys = null;
        try { jsonKeys = Object.keys(JSON.parse(resp)); } catch {}
        try {
          const json = JSON.parse(resp);
          if (json.results && typeof json.results === 'object') {
            const resultKeys = Object.keys(json.results);
            const foundStatuses = resultKeys.map(k => json.results[k].status || '');
            parsedStatus = foundStatuses.join('; ');
          } else {
            parsedStatus = '(no results field)';
          }
        } catch {
          parsedStatus = '(parse error)';
        }
        ok = response.statusCode >= 200 && response.statusCode < 300;
        logCheck(accounts, paymentCheckUrl, ok, response.statusCode, resp, parsedStatus, body);
        res.json({ httpStatus: response.statusCode, body: resp, parsedStatus: parsedStatus || null, jsonKeys, success: ok, request: requestDescription });
      });
    });
    req.on('timeout', () => { req.destroy(); logCheck(accounts, paymentCheckUrl, false, 0, '', 'Timeout', body); res.json({ httpStatus: 0, body: 'Timeout', parsedStatus: null, jsonKeys: null, success: false, request: requestDescription }); });
    req.on('error', (err) => { logCheck(accounts, paymentCheckUrl, false, 0, '', err.message, body); res.json({ httpStatus: 0, body: err.message, parsedStatus: null, jsonKeys: null, success: false, request: requestDescription }); });
    req.write(body);
    req.end();
  } catch (err) {
    logCheck(accounts, paymentCheckUrl, false, 0, '', err.message, '');
    res.json({ httpStatus: 0, body: err.message, parsedStatus: null, jsonKeys: null, success: false, request: requestDescription });
  }
});

app.post('/api/manager/settings/1c/test-ready-check', requireManager, async (req, res) => {
  const { accounts } = req.body;
  if (!accounts || !Array.isArray(accounts) || !accounts.length) {
    return res.status(400).json({ error: 'Accounts array required' });
  }
  const payUrlSetting = db.prepare("SELECT value FROM settings WHERE key = '1c_payment_check_url'").get();
  const readyCheckUrl = payUrlSetting ? payUrlSetting.value : '';
  if (!readyCheckUrl) {
    return res.status(400).json({ error: 'Payment check URL not configured' });
  }
  const userSetting = db.prepare("SELECT value FROM settings WHERE key = '1c_username'").get();
  const passSetting = db.prepare("SELECT value FROM settings WHERE key = '1c_password'").get();
  const username = userSetting ? userSetting.value : '';
  const password = passSetting ? passSetting.value : '';
  const body = JSON.stringify({ invoce_number: accounts });
  const maskedAuth = 'Basic ' + Buffer.from(username + ':' + password).toString('base64') + '  (логин: ' + username + ', пароль: ' + password + ')';
  const prettyBody = JSON.stringify({ invoce_number: accounts }, null, 2);
  const requestDescription = `POST ${readyCheckUrl}\nAuthorization: ${maskedAuth}\nContent-Type: application/json\n\n${prettyBody}`;
  try {
    const urlObj = new URL(readyCheckUrl);
    const client = urlObj.protocol === 'https:' ? https : http;
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      rejectUnauthorized: process.env.INSECURE_1C_TLS !== '1',
      timeout: 10000
    };
    if (username || password) options.auth = `${username}:${password}`;
    const req = client.request(options, (response) => {
      let resp = '';
      response.on('data', chunk => resp += chunk);
      response.on('end', () => {
        let allReady = false;
        let readyCount = 0;
        let goodsCount = 0;
        let jsonKeys = null;
        let notReadyReasons = [];
        try { jsonKeys = Object.keys(JSON.parse(resp)); } catch {}
        try {
          const json = JSON.parse(resp);
          if (Array.isArray(json.orders)) {
            for (const r of json.orders) {
              if (Number(r.readyStatus) === 1) {
                readyCount++;
                if (Array.isArray(r.goods)) {
                  goodsCount += r.goods.filter(g => g.canShip).length;
                }
              }
              if (r.notReadyReason) {
                notReadyReasons.push((r.invoiceNumber || '?') + ': ' + r.notReadyReason);
              }
            }
            allReady = readyCount === accounts.length;
          }
        } catch {}
        const parsedStatus = allReady ? 'All ready' : (readyCount > 0 ? readyCount + '/' + accounts.length + ' ready' : 'Not ready');
        logCheck(accounts, readyCheckUrl, allReady, response.statusCode, resp, parsedStatus, body);
        res.json({ httpStatus: response.statusCode, body: resp, parsedStatus, jsonKeys, success: allReady, readyCount, goodsCount, notReadyReasons, request: requestDescription });
      });
    });
    req.on('timeout', () => { req.destroy(); logCheck(accounts, readyCheckUrl, false, 0, '', 'Timeout', body); res.json({ httpStatus: 0, body: 'Timeout', success: false, request: requestDescription }); });
    req.on('error', (err) => { logCheck(accounts, readyCheckUrl, false, 0, '', err.message, body); res.json({ httpStatus: 0, body: err.message, success: false, request: requestDescription }); });
    req.write(body);
    req.end();
  } catch (err) {
    logCheck(accounts, readyCheckUrl, false, 0, '', err.message, '');
    res.json({ httpStatus: 0, body: err.message, success: false, request: requestDescription });
  }
});

app.get('/api/manager/check-logs', requireManager, async (req, res) => {
  const cacheKey = 'check-logs';
  const cached = await redisGet(cacheKey);
  if (cached) return res.json(JSON.parse(cached));
  const logs = db.prepare('SELECT * FROM check_logs ORDER BY id DESC LIMIT 200').all();
  const response = { logs };
  redisSet(cacheKey, JSON.stringify(response), 30);
  res.json(response);
});

app.get('/api/integration/1c/orders', require1cToken, async (req, res) => {
  const { date, date_from, date_to, status } = req.query;
  const cacheKey = 'orders-1c:' + (date || 'all') + ':' + (date_from || 'all') + ':' + (date_to || 'all') + ':' + (status || 'all');
  const cached = await redisGet(cacheKey);
  if (cached) return res.json(JSON.parse(cached));
  let query = `SELECT s.id, s.date, s.time_start, s.time_end, s.type, s.is_booked, s.confirmed, s.in_progress, s.assembling, s.completed, s.customer_name, s.customer_phone, s.customer_account, s.customer_comment, s.customer_organization, s.storekeeper_name, w.name AS warehouse_name, w.address AS warehouse_address FROM slots s LEFT JOIN warehouses w ON w.id = s.warehouse_id WHERE s.is_booked = 1`;
  const params = [];
  if (date) {
    query += ' AND s.date = ?';
    params.push(date);
  } else {
    if (date_from) { query += ' AND s.date >= ?'; params.push(date_from); }
    if (date_to) { query += ' AND s.date <= ?'; params.push(date_to); }
  }
  if (status === 'pending') query += ' AND s.confirmed = 0';
  else if (status === 'confirmed') query += ' AND s.confirmed = 1 AND s.in_progress = 0';
  else if (status === 'in_progress') query += ' AND s.in_progress = 1 AND s.completed = 0';
  else if (status === 'completed') query += ' AND s.completed = 1';
  query += ' ORDER BY s.date, s.time_start';
  const orders = db.prepare(query).all(...params);
  const response = { orders };
  redisSet(cacheKey, JSON.stringify(response), 300);
  res.json(response);
});

app.get('/api/manager/c1-orders', requireManager, async (req, res) => {
  const { date_from, date_to, status, q } = req.query;
  const cacheKey = 'c1-orders:' + (date_from || 'all') + ':' + (date_to || 'all') + ':' + (status || 'all') + ':' + (q || 'all');
  const cached = await redisGet(cacheKey);
  if (cached) return res.json(JSON.parse(cached));
  let query = `SELECT s.*, w.name AS warehouse_name, w.address AS warehouse_address FROM slots s LEFT JOIN warehouses w ON w.id = s.warehouse_id WHERE s.is_booked = 1`;
  const params = [];
  if (date_from) { query += ' AND s.date >= ?'; params.push(date_from); }
  if (date_to) { query += ' AND s.date <= ?'; params.push(date_to); }
  if (status === 'pending') query += ' AND s.confirmed = 0';
  else if (status === 'confirmed') query += ' AND s.confirmed = 1 AND s.in_progress = 0';
  else if (status === 'in_progress') query += ' AND s.in_progress = 1 AND s.completed = 0';
  else if (status === 'completed') query += ' AND s.completed = 1';
  if (q) {
    query += ' AND (s.customer_name LIKE ? OR s.customer_phone LIKE ? OR s.customer_account LIKE ?)';
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  query += ' ORDER BY s.date DESC, s.time_start';
  const orders = db.prepare(query).all(...params);
  const response = { orders };
  redisSet(cacheKey, JSON.stringify(response), 30);
  res.json(response);
});

app.post('/api/integration/1c/orders/:id/status', require1cToken, (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  const slot = db.prepare('SELECT * FROM slots WHERE id = ? AND is_booked = 1').get(id);
  if (!slot) {
    return res.status(404).json({ error: 'Order not found' });
  }
  if (status === 'complete') {
    db.prepare("UPDATE slots SET completed = 1, completed_at = datetime('now') WHERE id = ?").run(id);
  } else if (status === 'cancel') {
    db.prepare("UPDATE slots SET is_booked = 0, confirmed = 0, in_progress = 0, completed = 0, assembling = 0, customer_name = NULL, customer_phone = NULL, customer_account = NULL, customer_comment = NULL, customer_organization = NULL, booked_at = NULL, confirmed_at = NULL, in_progress_at = NULL, completed_at = NULL, assembling_at = NULL, storekeeper_id = NULL, storekeeper_name = NULL WHERE id = ?").run(id);
  } else {
    return res.status(400).json({ error: 'Invalid status. Use: complete, cancel' });
  }
  redisFlushByPrefix('orders-1c');
  redisFlushByPrefix('c1-orders');
  redisFlushByPrefix('orders-1c-items');
  redisFlushByPrefix('orders-1c-by-account');
  redisFlushSlotsCache();
  res.json({ success: true });
});

/* ---------- Send message to customer ---------- */

app.post('/api/manager/slots/:id/send-message', requireManager, (req, res) => {
  const { id } = req.params;
  const { message } = req.body;
  if (!message || !message.trim()) {
    return res.status(400).json({ error: 'Сообщение не может быть пустым' });
  }
  const slot = db.prepare('SELECT * FROM slots WHERE id = ?').get(id);
  if (!slot) {
    return res.status(404).json({ error: 'Slot not found' });
  }
  if (!slot.customer_phone) {
    return res.status(400).json({ error: 'У заявки нет номера телефона' });
  }
  sendSms(slot.customer_phone, message.trim());
  db.prepare('INSERT INTO messages (slot_id, phone, message, manager_id) VALUES (?, ?, ?, ?)').run(id, slot.customer_phone, message.trim(), req.session.managerId);
  redisFlushByPrefix('messages');
  res.json({ success: true, phone: slot.customer_phone });
});

app.get('/api/manager/messages', requireManager, async (req, res) => {
  const cacheKey = 'messages';
  const cached = await redisGet(cacheKey);
  if (cached) return res.json(JSON.parse(cached));
  const messages = db.prepare(`
    SELECT m.*, s.date AS slot_date, s.time_start AS slot_time, s.customer_name,
           mgr.first_name AS manager_first_name, mgr.last_name AS manager_last_name
    FROM messages m
    LEFT JOIN slots s ON s.id = m.slot_id
    LEFT JOIN managers mgr ON mgr.id = m.manager_id
    ORDER BY m.sent_at DESC
    LIMIT 500
  `).all();
  const response = { messages };
  redisSet(cacheKey, JSON.stringify(response), 30);
  res.json(response);
});

app.use(function(err, req, res, next) {
  console.error('Unhandled error:', err);
  if (res.headersSent) return;
  res.status(500).json({ error: 'Внутренняя ошибка сервера' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Warehouse Queue System running on http://0.0.0.0:${PORT}`);
});

function ipToInt(ip) {
  return ip.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0) >>> 0;
}

function isIPv4(s) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(s);
}

function ipInNetwork(clientIP, network) {
  if (network.includes('/')) {
    const [netIP, prefixStr] = network.split('/');
    // IPv4 CIDR math only applies to IPv4 on both sides; for IPv6 (or mixed
    // families) fall back to exact address match.
    if (!isIPv4(clientIP) || !isIPv4(netIP)) return clientIP === netIP;
    const prefix = parseInt(prefixStr, 10);
    if (isNaN(prefix) || prefix < 0 || prefix > 32) return false;
    const mask = prefix === 0 ? 0 : (~(2 ** (32 - prefix) - 1)) >>> 0;
    return ((ipToInt(clientIP) & mask) >>> 0) === ((ipToInt(netIP) & mask) >>> 0);
  }
  return clientIP === network;
}

function requireAllowedIP(req, res, next) {
  const rawIP = req.ip || req.connection.remoteAddress || '';
  const clientIP = rawIP.replace(/^::ffff:/, '');
  if (clientIP === '127.0.0.1' || clientIP === '::1') return next();
  const nets = db.prepare('SELECT network FROM allowed_networks').all();
  const allowed = nets.some(n => ipInNetwork(clientIP, n.network));
  if (!allowed) {
    return res.status(403).json({ error: 'Access denied from this IP' });
  }
  next();
}

app.get('/storekeeper', requireAllowedIP, (req, res) => {
  res.sendFile(path.join(__dirname, 'private', 'storekeeper.html'));
});

app.get('/api/storekeeper/slots', requireAllowedIP, (req, res) => {
  const slots = db.prepare(
    "SELECT s.id, s.date, s.time_start, s.time_end, s.type, s.customer_name, s.customer_phone, s.customer_account, s.customer_organization, s.in_progress, s.assembling, s.completed, s.customer_comment, s.storekeeper_id, s.storekeeper_name, s.in_progress_at, s.assembling_at, s.completed_at, w.name AS warehouse_name FROM slots s LEFT JOIN warehouses w ON w.id = s.warehouse_id WHERE (s.in_progress = 1 OR s.assembling = 1 OR s.completed = 1) ORDER BY s.date DESC, s.time_start"
  ).all();
  const active = slots.filter(s => !s.completed);
  const done = slots.filter(s => s.completed);
  res.json({ active, completed: done });
});

app.post('/api/storekeeper/slots/:id/assemble', requireAllowedIP, (req, res) => {
  const { id } = req.params;
  const { pinCode } = req.body;
  if (!pinCode || !/^\d{4}$/.test(pinCode)) {
    return res.status(400).json({ error: 'PIN must be 4 digits' });
  }
  const sk = db.prepare('SELECT id, name FROM storekeepers WHERE pin_code = ?').get(pinCode);
  if (!sk) {
    return res.status(403).json({ error: 'Invalid PIN' });
  }
  const slot = db.prepare('SELECT * FROM slots WHERE id = ? AND (storekeeper_id = ? OR storekeeper_id IS NULL)').get(id, sk.id);
  if (!slot) {
    return res.status(404).json({ error: 'Slot not found or not assigned to you' });
  }
  if (!slot.in_progress) {
    return res.status(400).json({ error: 'Slot must be assigned to you first' });
  }
  if (slot.assembling) {
    return res.status(400).json({ error: 'Slot is already in assembly' });
  }
  // If unassigned, claim it
  if (!slot.storekeeper_id) {
    db.prepare("UPDATE slots SET storekeeper_id = ?, storekeeper_name = ? WHERE id = ?").run(sk.id, sk.name, id);
  }
  db.prepare("UPDATE slots SET assembling = 1, assembling_at = datetime('now') WHERE id = ?").run(id);
  redisFlushSlotsCache();
  res.json({ success: true });
});

app.post('/api/storekeeper/slots/:id/return-from-assembly', requireAllowedIP, (req, res) => {
  const { id } = req.params;
  const { pinCode } = req.body;
  if (!pinCode || !/^\d{4}$/.test(pinCode)) {
    return res.status(400).json({ error: 'PIN must be 4 digits' });
  }
  const sk = db.prepare('SELECT id FROM storekeepers WHERE pin_code = ?').get(pinCode);
  if (!sk) {
    return res.status(403).json({ error: 'Invalid PIN' });
  }
  const slot = db.prepare('SELECT * FROM slots WHERE id = ? AND (storekeeper_id = ? OR storekeeper_id IS NULL)').get(id, sk.id);
  if (!slot) {
    return res.status(404).json({ error: 'Slot not found or not assigned to you' });
  }
  if (!slot.assembling) {
    return res.status(400).json({ error: 'Slot is not in assembly' });
  }
  // If unassigned, claim it
  if (!slot.storekeeper_id) {
    db.prepare("UPDATE slots SET storekeeper_id = ?, storekeeper_name = ? WHERE id = ?").run(sk.id, sk.name, id);
  }
  db.prepare("UPDATE slots SET assembling = 0, assembling_at = NULL WHERE id = ?").run(id);
  redisFlushSlotsCache();
  res.json({ success: true });
});

app.post('/api/storekeeper/slots/:id/complete', requireAllowedIP, (req, res) => {
  const { id } = req.params;
  const { pinCode } = req.body;
  if (!pinCode || !/^\d{4}$/.test(pinCode)) {
    return res.status(400).json({ error: 'PIN must be 4 digits' });
  }
  const sk = db.prepare('SELECT id, name FROM storekeepers WHERE pin_code = ?').get(pinCode);
  if (!sk) {
    return res.status(403).json({ error: 'Invalid PIN' });
  }
  const slot = db.prepare('SELECT * FROM slots WHERE id = ? AND (storekeeper_id = ? OR storekeeper_id IS NULL)').get(id, sk.id);
  if (!slot) {
    return res.status(404).json({ error: 'Slot not found or not assigned to you' });
  }
  if (!slot.assembling) {
    return res.status(400).json({ error: 'Slot must be in assembly first' });
  }
  // If unassigned, claim it
  if (!slot.storekeeper_id) {
    db.prepare("UPDATE slots SET storekeeper_id = ?, storekeeper_name = ? WHERE id = ?").run(sk.id, sk.name, id);
  }
  db.prepare("UPDATE slots SET completed = 1, completed_at = datetime('now') WHERE id = ?").run(id);
  sendSms(slot.customer_phone, 'Ваш заказ собран, обратитесь к сотруднику склада за его получением.');
  redisFlushSlotsCache();
  res.json({ success: true });
});

/* ---------- Manager CRUD ---------- */

app.get('/api/manager/list', requireManager, async (req, res) => {
  const cacheKey = 'list';
  const cached = await redisGet(cacheKey);
  if (cached) return res.json(JSON.parse(cached));
  const managers = db.prepare(`
    SELECT m.*, w.name AS warehouse_name
    FROM managers m
    LEFT JOIN warehouses w ON w.id = m.warehouse_id
    ORDER BY m.id
  `).all();
  const response = { managers };
  redisSet(cacheKey, JSON.stringify(response), 300);
  res.json(response);
});

app.post('/api/manager/create', requireManager, (req, res) => {
  const { username, password, firstName, lastName, warehouseId, isAdmin } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }
  const existing = db.prepare('SELECT id FROM managers WHERE username = ?').get(username);
  if (existing) {
    return res.status(409).json({ error: 'Username already exists' });
  }
  const hash = crypto.createHash('sha256').update(password).digest('hex');
  db.prepare('INSERT INTO managers (username, password_hash, first_name, last_name, warehouse_id, is_admin) VALUES (?, ?, ?, ?, ?, ?)').run(username, hash, firstName || '', lastName || '', warehouseId || null, isAdmin ? 1 : 0);
  redisFlushByPrefix('list');
  res.json({ success: true });
});

app.put('/api/manager/:id', requireManager, requireAdmin, (req, res) => {
  const { id } = req.params;
  const { username, password, firstName, lastName, warehouseId, isAdmin } = req.body;
  if (!username) {
    return res.status(400).json({ error: 'Username is required' });
  }
  const mgr = db.prepare('SELECT * FROM managers WHERE id = ?').get(id);
  if (!mgr) {
    return res.status(404).json({ error: 'Manager not found' });
  }
  if (username !== mgr.username) {
    const existing = db.prepare('SELECT id FROM managers WHERE username = ? AND id != ?').get(username, id);
    if (existing) {
      return res.status(409).json({ error: 'Username already exists' });
    }
  }
  // Главного администратора (admin) нельзя лишить прав администратора.
  let adminFlag = isAdmin ? 1 : 0;
  if (mgr.username === 'admin') adminFlag = 1;
  if (password) {
    const hash = crypto.createHash('sha256').update(password).digest('hex');
    db.prepare('UPDATE managers SET username = ?, password_hash = ?, first_name = ?, last_name = ?, warehouse_id = ?, is_admin = ? WHERE id = ?').run(username, hash, firstName || '', lastName || '', warehouseId || null, adminFlag, id);
  } else {
    db.prepare('UPDATE managers SET username = ?, first_name = ?, last_name = ?, warehouse_id = ?, is_admin = ? WHERE id = ?').run(username, firstName || '', lastName || '', warehouseId || null, adminFlag, id);
  }
  redisFlushByPrefix('list');
  redisFlushByPrefix('manager-me');
  res.json({ success: true });
});

app.delete('/api/manager/:id', requireManager, requireAdmin, (req, res) => {
  const { id } = req.params;
  if (Number(id) === req.session.managerId) {
    return res.status(400).json({ error: 'Cannot delete yourself' });
  }
  const mgr = db.prepare('SELECT * FROM managers WHERE id = ?').get(id);
  if (!mgr) {
    return res.status(404).json({ error: 'Manager not found' });
  }
  if (mgr.username === 'admin') {
    return res.status(400).json({ error: 'Нельзя удалить главного администратора' });
  }
  db.prepare('DELETE FROM managers WHERE id = ?').run(id);
  redisFlushByPrefix('list');
  redisFlushByPrefix('manager-me');
  res.json({ success: true });
});

/* ---------- Statistics ---------- */

app.get('/api/manager/stats', requireManager, async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) {
    return res.status(400).json({ error: 'from and to are required' });
  }
  const cacheKey = 'stats:' + from + ':' + to;
  const cached = await redisGet(cacheKey);
  if (cached) return res.json(JSON.parse(cached));
  const total = db.prepare('SELECT COUNT(*) AS c FROM slots WHERE date >= ? AND date <= ?').get(from, to).c;
  const byType = db.prepare('SELECT type, COUNT(*) AS c FROM slots WHERE date >= ? AND date <= ? GROUP BY type').all(from, to);
  const byStatus = {
    booked: db.prepare('SELECT COUNT(*) AS c FROM slots WHERE is_booked = 1 AND date >= ? AND date <= ?').get(from, to).c,
    confirmed: db.prepare('SELECT COUNT(*) AS c FROM slots WHERE confirmed = 1 AND date >= ? AND date <= ?').get(from, to).c,
    inProgress: db.prepare('SELECT COUNT(*) AS c FROM slots WHERE in_progress = 1 AND date >= ? AND date <= ?').get(from, to).c,
    assembling: db.prepare('SELECT COUNT(*) AS c FROM slots WHERE assembling = 1 AND date >= ? AND date <= ?').get(from, to).c || 0,
    completed: db.prepare('SELECT COUNT(*) AS c FROM slots WHERE completed = 1 AND date >= ? AND date <= ?').get(from, to).c
  };
  const response = { total, byType, byStatus };
  redisSet(cacheKey, JSON.stringify(response), 30);
  res.json(response);
});

app.get('/api/manager/stats/storekeepers', requireManager, async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) {
    return res.status(400).json({ error: 'from and to are required' });
  }
  const cacheKey = 'stats-storekeepers:' + from + ':' + to;
  const cached = await redisGet(cacheKey);
  if (cached) return res.json(JSON.parse(cached));
  const storekeepers = db.prepare("SELECT id, name FROM storekeepers ORDER BY name").all();
  const unassigned = db.prepare("SELECT COUNT(*) AS c FROM slots WHERE in_progress = 1 AND storekeeper_id IS NULL AND date(in_progress_at) >= ? AND date(in_progress_at) <= ?").get(from, to).c;
  const stats = storekeepers.map(sk => {
    const orders = db.prepare(`
      SELECT s.date, s.time_start, s.time_end, s.customer_name, s.in_progress_at, s.assembling_at, s.completed_at
      FROM slots s
      WHERE s.storekeeper_id = ? AND (s.in_progress = 1 OR s.assembling = 1 OR s.completed = 1)
        AND date(s.in_progress_at) >= ? AND date(s.in_progress_at) <= ?
      ORDER BY s.date, s.time_start
    `).all(sk.id, from, to).map(o => ({
      ...o,
      duration: o.in_progress_at && o.completed_at ? Math.round((new Date(o.completed_at) - new Date(o.in_progress_at)) / 60000) : null
    }));
    const total = orders.length;
    const completed = orders.filter(o => o.completed_at).length;
    return { id: sk.id, name: sk.name, total, completed, orders };
  });
  const response = { stats, unassigned, byWarehouse: [] };
  redisSet(cacheKey, JSON.stringify(response), 30);
  res.json(response);
});

/* ---------- Storekeeper CRUD ---------- */

app.get('/api/manager/storekeepers', requireManager, async (req, res) => {
  const cacheKey = 'storekeepers';
  const cached = await redisGet(cacheKey);
  if (cached) return res.json(JSON.parse(cached));
  // Never expose pin_code to the client; only whether a PIN is set.
  const list = db.prepare('SELECT id, name, phone, created_at FROM storekeepers ORDER BY id').all();
  const pins = db.prepare("SELECT id, CASE WHEN pin_code IS NOT NULL AND pin_code <> '' THEN 1 ELSE 0 END AS has_pin FROM storekeepers").all();
  const pinMap = {};
  for (const p of pins) pinMap[p.id] = p.has_pin;
  for (const s of list) s.has_pin = pinMap[s.id] || 0;
  const response = { storekeepers: list };
  redisSet(cacheKey, JSON.stringify(response), 300);
  res.json(response);
});

app.post('/api/manager/storekeepers', requireManager, (req, res) => {
  const { name, phone, pinCode } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Name is required' });
  }
  db.prepare('INSERT INTO storekeepers (name, phone, pin_code) VALUES (?, ?, ?)').run(name.trim(), phone || '', pinCode || '');
  redisFlushByPrefix('storekeepers');
  res.json({ success: true });
});

app.put('/api/manager/storekeepers/:id', requireManager, (req, res) => {
  const { id } = req.params;
  const { name, phone, pinCode } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Name is required' });
  }
  const sk = db.prepare('SELECT * FROM storekeepers WHERE id = ?').get(id);
  if (!sk) {
    return res.status(404).json({ error: 'Storekeeper not found' });
  }
  // Only overwrite the PIN when a new one is provided, so an empty field in
  // the edit form (which no longer receives the existing PIN) keeps it intact.
  if (pinCode && String(pinCode).trim()) {
    db.prepare('UPDATE storekeepers SET name = ?, phone = ?, pin_code = ? WHERE id = ?').run(name.trim(), phone || '', String(pinCode).trim(), id);
  } else {
    db.prepare('UPDATE storekeepers SET name = ?, phone = ? WHERE id = ?').run(name.trim(), phone || '', id);
  }
  redisFlushByPrefix('storekeepers');
  res.json({ success: true });
});

app.delete('/api/manager/storekeepers/:id', requireManager, (req, res) => {
  const { id } = req.params;
  const sk = db.prepare('SELECT * FROM storekeepers WHERE id = ?').get(id);
  if (!sk) {
    return res.status(404).json({ error: 'Storekeeper not found' });
  }
  db.prepare('DELETE FROM storekeepers WHERE id = ?').run(id);
  redisFlushByPrefix('storekeepers');
  res.json({ success: true });
});

/* ---------- Nomenclature CRUD ---------- */

app.get('/api/manager/nomenclature', requireManager, async (req, res) => {
  const { category, q } = req.query;
  const cacheKey = 'nomenclature:' + (category || 'all') + ':' + (q || 'all');
  const cached = await redisGet(cacheKey);
  if (cached) return res.json(JSON.parse(cached));
  let query = 'SELECT * FROM nomenclature WHERE 1=1';
  const params = [];
  if (category) {
    query += ' AND category = ?';
    params.push(category);
  }
  if (q) {
    query += ' AND (name LIKE ? OR article LIKE ?)';
    params.push(`%${q}%`, `%${q}%`);
  }
  query += ' ORDER BY name';
  const items = db.prepare(query).all(...params);
  const catNames = db.prepare('SELECT DISTINCT category FROM nomenclature WHERE category != \'\' ORDER BY category').all().map(r => r.category);
  const catTable = db.prepare('SELECT name FROM categories ORDER BY name').all().map(r => r.name);
  const categories = [...new Set([...catTable, ...catNames])];
  const response = { items, categories };
  redisSet(cacheKey, JSON.stringify(response), 300);
  res.json(response);
});

app.post('/api/manager/nomenclature', requireManager, (req, res) => {
  const { name, article, unit, price, category, description, guid1c, code1c, comment, weight, volume, internalCode } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Наименование обязательно' });
  }
  db.prepare('INSERT INTO nomenclature (name, article, unit, price, category, description, guid1c, code_1c, comment, weight, volume, internal_code) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(name.trim(), article || '', unit || 'шт', Number(price) || 0, category || '', description || '', guid1c || '', code1c || '', comment || '', Number(weight) || 0, Number(volume) || 0, internalCode || '');
  if (category) {
    try { db.prepare('INSERT OR IGNORE INTO categories (name) VALUES (?)').run(category); } catch {}
  }
  redisFlushByPrefix('nomenclature');
  res.json({ success: true });
});

app.put('/api/manager/nomenclature/:id', requireManager, (req, res) => {
  const { id } = req.params;
  const { name, article, unit, price, category, description, guid1c, code1c, comment, weight, volume, internalCode } = req.body;
  const item = db.prepare('SELECT * FROM nomenclature WHERE id = ?').get(id);
  if (!item) {
    return res.status(404).json({ error: 'Not found' });
  }
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Наименование обязательно' });
  }
  db.prepare('UPDATE nomenclature SET name = ?, article = ?, unit = ?, price = ?, category = ?, description = ?, guid1c = ?, code_1c = ?, comment = ?, weight = ?, volume = ?, internal_code = ? WHERE id = ?').run(name.trim(), article || '', unit || 'шт', Number(price) || 0, category || '', description || '', guid1c || '', code1c || '', comment || '', Number(weight) || 0, Number(volume) || 0, internalCode || '', id);
  if (category) {
    try { db.prepare('INSERT OR IGNORE INTO categories (name) VALUES (?)').run(category); } catch {}
  }
  redisFlushByPrefix('nomenclature');
  res.json({ success: true });
});

app.delete('/api/manager/nomenclature/:id', requireManager, (req, res) => {
  const { id } = req.params;
  const item = db.prepare('SELECT * FROM nomenclature WHERE id = ?').get(id);
  if (!item) {
    return res.status(404).json({ error: 'Not found' });
  }
  db.prepare('DELETE FROM nomenclature WHERE id = ?').run(id);
  redisFlushByPrefix('nomenclature');
  res.json({ success: true });
});

/* ---------- Categories CRUD ---------- */

app.get('/api/manager/categories', requireManager, async (req, res) => {
  const cacheKey = 'categories';
  const cached = await redisGet(cacheKey);
  if (cached) return res.json(JSON.parse(cached));
  const categories = db.prepare('SELECT * FROM categories ORDER BY name').all();
  const response = { categories };
  redisSet(cacheKey, JSON.stringify(response), 300);
  res.json(response);
});

app.post('/api/manager/categories', requireManager, (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Название обязательно' });
  }
  try {
    db.prepare('INSERT INTO categories (name) VALUES (?)').run(name.trim());
    redisFlushByPrefix('categories');
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: 'Категория уже существует' });
  }
});

app.put('/api/manager/categories/:id', requireManager, (req, res) => {
  const { id } = req.params;
  const { name } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Название обязательно' });
  }
  const old = db.prepare('SELECT * FROM categories WHERE id = ?').get(id);
  if (!old) return res.status(404).json({ error: 'Not found' });
  try {
    db.prepare('UPDATE categories SET name = ? WHERE id = ?').run(name.trim(), id);
    db.prepare("UPDATE nomenclature SET category = ? WHERE category = ?").run(name.trim(), old.name);
    redisFlushByPrefix('categories');
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: 'Категория уже существует' });
  }
});

app.delete('/api/manager/categories/:id', requireManager, (req, res) => {
  const { id } = req.params;
  const cat = db.prepare('SELECT * FROM categories WHERE id = ?').get(id);
  if (!cat) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM categories WHERE id = ?').run(id);
  redisFlushByPrefix('categories');
  res.json({ success: true });
});

app.get('/api/manager/counterparties', requireManager, async (req, res) => {
  const cacheKey = 'counterparties';
  const cached = await redisGet(cacheKey);
  if (cached) return res.json(JSON.parse(cached));
  const items = db.prepare('SELECT * FROM counterparties ORDER BY name').all();
  const response = { counterparties: items };
  redisSet(cacheKey, JSON.stringify(response), 300);
  res.json(response);
});

app.post('/api/manager/counterparties', requireManager, (req, res) => {
  const { name, phone, inn, kpp, comment } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Название обязательно' });
  }
  const newId = db.runReturningId("INSERT INTO counterparties (name, phone, inn, kpp, comment) VALUES (?, ?, ?, ?, ?)",
    [name.trim(), phone || '', inn || '', kpp || '', comment || '']
  );
  redisFlushByPrefix('counterparties');
  res.json({ success: true, id: newId });
});

app.put('/api/manager/counterparties/:id', requireManager, (req, res) => {
  const { id } = req.params;
  const { name, phone, inn, kpp, comment } = req.body;
  const existing = db.prepare('SELECT * FROM counterparties WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  db.prepare("UPDATE counterparties SET name = ?, phone = ?, inn = ?, kpp = ?, comment = ? WHERE id = ?").run(
    name || existing.name, phone || existing.phone, inn || existing.inn, kpp || existing.kpp, comment || existing.comment, id
  );
  redisFlushByPrefix('counterparties');
  res.json({ success: true });
});

app.delete('/api/manager/counterparties/:id', requireManager, (req, res) => {
  const { id } = req.params;
  const existing = db.prepare('SELECT * FROM counterparties WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM counterparties WHERE id = ?').run(id);
  redisFlushByPrefix('counterparties');
  res.json({ success: true });
});

app.get('/api/manager/orders-1c', requireManager, async (req, res) => {
  const { date_from, date_to, search } = req.query;
  const cacheKey = 'orders-1c:' + (date_from || 'all') + ':' + (date_to || 'all') + ':' + (search || 'all');
  const cached = await redisGet(cacheKey);
  if (cached) return res.json(JSON.parse(cached));
  let query = 'SELECT * FROM orders_1c';
  const params = [];
  const conditions = [];
  if (date_from) {
    conditions.push("substr(orderDate, 7, 4) || substr(orderDate, 4, 2) || substr(orderDate, 1, 2) >= ?");
    params.push(date_from.replace(/-/g, ''));
  }
  if (date_to) {
    conditions.push("substr(orderDate, 7, 4) || substr(orderDate, 4, 2) || substr(orderDate, 1, 2) <= ?");
    params.push(date_to.replace(/-/g, ''));
  }
  if (search) {
    conditions.push("(orderNumber LIKE ? OR accountNumber LIKE ? OR customerName LIKE ?)");
    const like = '%' + search + '%';
    params.push(like, like, like);
  }
  if (conditions.length) query += ' WHERE ' + conditions.join(' AND ');
  query += ' ORDER BY orderDate DESC';
  const items = db.prepare(query).all(...params);
  try {
    const userSetting = db.prepare("SELECT value FROM settings WHERE key = '1c_username'").get();
    const passSetting = db.prepare("SELECT value FROM settings WHERE key = '1c_password'").get();
    const payUrlSetting = db.prepare("SELECT value FROM settings WHERE key = '1c_payment_check_url'").get();
    const username = userSetting ? userSetting.value : '';
    const password = passSetting ? passSetting.value : '';
    const readyCheckUrl = payUrlSetting ? payUrlSetting.value : '';
    const accounts = items.map(i => i.accountNumber).filter(Boolean);
    if (accounts.length && readyCheckUrl) {
      const readyResult = await checkReadyWith1C(accounts, readyCheckUrl, username, password);
      const updateReady = db.prepare("UPDATE orders_1c SET readyStatus = 1, notReadyReason = '' WHERE accountNumber = ?");
      const updateNotReady = db.prepare("UPDATE orders_1c SET readyStatus = 0, notReadyReason = ? WHERE accountNumber = ?");
      for (const acc of readyResult.readyAccounts) {
        updateReady.run(acc);
        const item = items.find(i => i.accountNumber === acc);
        if (item) { item.readyStatus = 1; item.notReadyReason = ''; }
      }
      for (const [acc, reason] of Object.entries(readyResult.notReadyReasons)) {
        if (reason) {
          updateNotReady.run(reason, acc);
          const item = items.find(i => i.accountNumber === acc);
          if (item) { item.readyStatus = 0; item.notReadyReason = reason; }
        }
      }
    }
  } catch (err) {
    console.error('Error refreshing ready status from 1C:', err.message);
  }
  const response = { orders: items };
  redisSet(cacheKey, JSON.stringify(response), 30);
  res.json(response);
});

app.get('/api/manager/orders-1c/:orderNumber/items', requireManager, async (req, res) => {
  const { orderNumber } = req.params;
  const cacheKey = 'orders-1c-items:' + orderNumber;
  const cached = await redisGet(cacheKey);
  if (cached) return res.json(JSON.parse(cached));
  const items = db.prepare('SELECT * FROM order_items_1c WHERE orderNumber = ? ORDER BY guid').all(orderNumber);
  const response = { items };
  redisSet(cacheKey, JSON.stringify(response), 300);
  res.json(response);
});

app.get('/api/manager/orders-1c/by-account/:accountNumber/items', requireManager, async (req, res) => {
  const { accountNumber } = req.params;
  const cacheKey = 'orders-1c-by-account:' + accountNumber;
  const cached = await redisGet(cacheKey);
  if (cached) return res.json(JSON.parse(cached));
  const order = db.prepare("SELECT orderNumber FROM orders_1c WHERE accountNumber = ?").get(accountNumber);
  if (!order) return res.json({ items: [] });
  const items = db.prepare('SELECT * FROM order_items_1c WHERE orderNumber = ? ORDER BY guid').all(order.orderNumber);
  const response = { items };
  redisSet(cacheKey, JSON.stringify(response), 300);
  res.json(response);
});

app.get('/api/manager/managers-1c', requireManager, async (req, res) => {
  const cacheKey = 'managers-1c';
  const cached = await redisGet(cacheKey);
  if (cached) return res.json(JSON.parse(cached));
  const managers = db.prepare('SELECT * FROM managers_1c ORDER BY lastSeen DESC, orderCount DESC').all();
  const response = { managers };
  redisSet(cacheKey, JSON.stringify(response), 300);
  res.json(response);
});

app.get('/api/manager/engineers-1c', requireManager, async (req, res) => {
  const cacheKey = 'engineers-1c';
  const cached = await redisGet(cacheKey);
  if (cached) return res.json(JSON.parse(cached));
  const engineers = db.prepare('SELECT * FROM engineers_1c ORDER BY lastSeen DESC, orderCount DESC').all();
  const response = { engineers };
  redisSet(cacheKey, JSON.stringify(response), 300);
  res.json(response);
});

/* ---------- Verify PIN ---------- */

app.post('/api/manager/verify-pin', requireManager, (req, res) => {
  const { pinCode, storekeeperId } = req.body;
  if (!pinCode || !/^\d{4}$/.test(pinCode)) {
    return res.status(400).json({ error: 'PIN must be 4 digits' });
  }
  if (storekeeperId) {
    const sk = db.prepare('SELECT id, name FROM storekeepers WHERE id = ? AND pin_code = ?').get(storekeeperId, pinCode);
    if (!sk) {
      return res.status(403).json({ error: 'Invalid PIN' });
    }
    return res.json({ success: true, storekeeper: sk });
  }
  const sk = db.prepare('SELECT id, name FROM storekeepers WHERE pin_code = ?').get(pinCode);
  if (!sk) {
    return res.status(403).json({ error: 'Invalid PIN' });
  }
  res.json({ success: true, storekeeper: sk });
});

/* ---------- Networks CRUD ---------- */

app.get('/api/manager/networks', requireManager, async (req, res) => {
  const cacheKey = 'networks';
  const cached = await redisGet(cacheKey);
  if (cached) return res.json(JSON.parse(cached));
  const networks = db.prepare('SELECT * FROM allowed_networks ORDER BY id').all();
  const response = { networks };
  redisSet(cacheKey, JSON.stringify(response), 300);
  res.json(response);
});

app.post('/api/manager/networks', requireManager, (req, res) => {
  const { network, description } = req.body;
  if (!network || !network.trim()) {
    return res.status(400).json({ error: 'Network is required' });
  }
  const existing = db.prepare('SELECT id FROM allowed_networks WHERE network = ?').get(network.trim());
  if (existing) {
    return res.status(409).json({ error: 'Network already exists' });
  }
  db.prepare('INSERT INTO allowed_networks (network, description) VALUES (?, ?)').run(network.trim(), description || '');
  redisFlushByPrefix('networks');
  res.json({ success: true });
});

app.delete('/api/manager/networks/:id', requireManager, (req, res) => {
  const { id } = req.params;
  const net = db.prepare('SELECT * FROM allowed_networks WHERE id = ?').get(id);
  if (!net) {
    return res.status(404).json({ error: 'Network not found' });
  }
  if (net.protected) {
    return res.status(403).json({ error: 'Cannot delete protected network' });
  }
  db.prepare('DELETE FROM allowed_networks WHERE id = ?').run(id);
  redisFlushByPrefix('networks');
  res.json({ success: true });
});

/* ---------- Warehouse CRUD ---------- */

app.get('/api/manager/warehouses', requireManager, async (req, res) => {
  const cacheKey = 'warehouses';
  const cached = await redisGet(cacheKey);
  if (cached) return res.json(JSON.parse(cached));
  const list = db.prepare('SELECT * FROM warehouses ORDER BY is_default DESC, name').all();
  const response = { warehouses: list };
  redisSet(cacheKey, JSON.stringify(response), 300);
  res.json(response);
});

app.post('/api/manager/warehouses', requireManager, (req, res) => {
  const { name, address, isDefault } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Name is required' });
  }
  if (isDefault) {
    db.prepare('UPDATE warehouses SET is_default = 0').run();
  }
  db.prepare('INSERT INTO warehouses (name, address, is_default) VALUES (?, ?, ?)').run(name.trim(), address || '', isDefault ? 1 : 0);
  redisFlushByPrefix('warehouses');
  res.json({ success: true });
});

app.put('/api/manager/warehouses/:id', requireManager, (req, res) => {
  const { id } = req.params;
  const { name, address, isDefault } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Name is required' });
  }
  const wh = db.prepare('SELECT * FROM warehouses WHERE id = ?').get(id);
  if (!wh) {
    return res.status(404).json({ error: 'Warehouse not found' });
  }
  if (isDefault) {
    db.prepare('UPDATE warehouses SET is_default = 0').run();
  }
  db.prepare('UPDATE warehouses SET name = ?, address = ?, is_default = ? WHERE id = ?').run(name.trim(), address || '', isDefault ? 1 : 0, id);
  redisFlushByPrefix('warehouses');
  res.json({ success: true });
});

app.delete('/api/manager/warehouses/:id', requireManager, (req, res) => {
  const { id } = req.params;
  const wh = db.prepare('SELECT * FROM warehouses WHERE id = ?').get(id);
  if (!wh) {
    return res.status(404).json({ error: 'Warehouse not found' });
  }
  db.prepare('DELETE FROM warehouses WHERE id = ?').run(id);
  redisFlushByPrefix('warehouses');
  res.json({ success: true });
});

/* ---------- Cancel Slot ---------- */

app.post('/api/manager/slots/:id/cancel', requireManager, (req, res) => {
  const { id } = req.params;
  const slot = db.prepare('SELECT * FROM slots WHERE id = ?').get(id);
  if (!slot) {
    return res.status(404).json({ error: 'Slot not found' });
  }
  db.prepare("UPDATE slots SET is_booked = 0, confirmed = 0, in_progress = 0, completed = 0, assembling = 0, customer_name = NULL, customer_phone = NULL, customer_account = NULL, customer_comment = NULL, customer_organization = NULL, booked_at = NULL, confirmed_at = NULL, in_progress_at = NULL, completed_at = NULL, assembling_at = NULL, storekeeper_id = NULL, storekeeper_name = NULL WHERE id = ?").run(id);
  logAction('manager', req.session.firstName + ' ' + req.session.lastName, 'Отмена', 'Слот ' + slot.time_start + '-' + slot.time_end + ' ' + slot.date + (slot.customer_name ? ', клиент: ' + slot.customer_name : ''), Number(id), getIp(req), getUserAgent(req));
  redisFlushSlotsCache();
  res.json({ success: true });
});

/* ---------- Change Password ---------- */

app.post('/api/manager/password', requireManager, (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Current and new password are required' });
  }
  if (newPassword.length < 4) {
    return res.status(400).json({ error: 'New password must be at least 4 characters' });
  }
  const mgr = db.prepare('SELECT * FROM managers WHERE id = ?').get(req.session.managerId);
  const currentHash = crypto.createHash('sha256').update(currentPassword).digest('hex');
  if (currentHash !== mgr.password_hash) {
    return res.status(403).json({ error: 'Current password is incorrect' });
  }
  const newHash = crypto.createHash('sha256').update(newPassword).digest('hex');
  db.prepare('UPDATE managers SET password_hash = ? WHERE id = ?').run(newHash, req.session.managerId);
  redisFlushByPrefix('manager-me');
  res.json({ success: true });
});

/* ---------- SMS Settings ---------- */

app.get('/api/manager/settings/smsru', requireManager, (req, res) => {
  const setting = db.prepare("SELECT value FROM settings WHERE key = 'smsru_api_key'").get();
  res.json({ apiKey: setting ? setting.value : '' });
});

app.post('/api/manager/settings/smsru', requireManager, (req, res) => {
  const { apiKey } = req.body;
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('smsru_api_key', ?)").run(apiKey || '');
  res.json({ success: true });
});

/* ---------- Journal ---------- */

app.get('/api/manager/logs', requireManager, (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(200, Math.max(10, parseInt(req.query.limit) || 50));
  const offset = (page - 1) * limit;
  let where = '';
  const params = [];
  const { search, date_from, date_to } = req.query;
  if (search) {
    where += ' AND (user_name LIKE ? OR action LIKE ? OR details LIKE ?)';
    const like = '%' + search + '%';
    params.push(like, like, like);
  }
  if (date_from) {
    where += ' AND created_at >= ?';
    params.push(date_from + ' 00:00:00');
  }
  if (date_to) {
    where += ' AND created_at <= ?';
    params.push(date_to + ' 23:59:59');
  }
  const total = db.prepare('SELECT COUNT(*) as cnt FROM user_logs WHERE 1=1' + where).get(...params).cnt;
  const logs = db.prepare('SELECT * FROM user_logs WHERE 1=1' + where + ' ORDER BY id DESC LIMIT ? OFFSET ?').all(...params, limit, offset);
  res.json({ logs, total, page, limit });
});

app.get('/api/manager/settings/logging', requireManager, (req, res) => {
  const setting = db.prepare("SELECT value FROM settings WHERE key = 'logging_enabled'").get();
  res.json({ enabled: setting ? setting.value === '1' : false });
});

app.post('/api/manager/settings/logging', requireManager, (req, res) => {
  const { enabled } = req.body;
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('logging_enabled', ?)").run(enabled ? '1' : '0');
  logAction('manager', req.session.firstName + ' ' + req.session.lastName, 'Настройка', (enabled ? 'Включил' : 'Выключил') + ' ведение журнала', 0, getIp(req), getUserAgent(req));
  res.json({ success: true });
});

var APP_VERSION = (function() { try { return require('./package.json').version || '?'; } catch (e) { return '?'; } })();
var APP_STARTED = new Date().toISOString();

app.get('/api/manager/about', requireManager, (req, res) => {
  var lastModified = null;
  try {
    var files = ['server.js', 'database.js', 'db-adapter.js', 'package.json', 'public/manager.html', 'public/index.html', 'private/storekeeper.html'];
    var max = 0;
    for (var i = 0; i < files.length; i++) {
      try { var m = fs.statSync(path.join(__dirname, files[i])).mtimeMs; if (m > max) max = m; } catch (e) {}
    }
    if (max) lastModified = new Date(max).toISOString();
  } catch (e) {}
  var load = (typeof os.loadavg === 'function') ? os.loadavg() : [0, 0, 0];
  var cpus = (os.cpus() || []).length || 1;
  res.json({
    version: APP_VERSION,
    lastModified: lastModified,
    serverTime: new Date().toISOString(),
    startedAt: APP_STARTED,
    uptimeSeconds: Math.floor(process.uptime()),
    load: { avg1: load[0], avg5: load[1], avg15: load[2], cpus: cpus, percent: Math.round((load[0] / cpus) * 100) },
    memory: {
      rssMb: Math.round(process.memoryUsage().rss / 1048576),
      usedMb: Math.round((os.totalmem() - os.freemem()) / 1048576),
      totalMb: Math.round(os.totalmem() / 1048576)
    },
    redisRequestsLastHour: redisRequestsLastHour(),
    dbRequestsLastHour: (typeof dbAdapter.dbRequestsLastHour === 'function') ? dbAdapter.dbRequestsLastHour() : 0
  });
});

// Compare the local checkout with the configured git remote (origin). Works for
// any host (GitHub, GitLab, …) since it uses the repo's own remote.
function gitCmd(args) {
  return new Promise(function(resolve, reject) {
    execFile('git', ['-C', __dirname].concat(args), { timeout: 15000 }, function(err, stdout, stderr) {
      if (err) return reject(new Error(((stderr || err.message) || '').trim()));
      resolve((stdout || '').trim());
    });
  });
}

app.get('/api/manager/check-update', requireManager, async (req, res) => {
  try {
    const current = await gitCmd(['rev-parse', 'HEAD']);
    let branch = 'main';
    try { branch = await gitCmd(['rev-parse', '--abbrev-ref', 'HEAD']) || 'main'; } catch (e) {}
    let remoteUrl = '';
    try { remoteUrl = await gitCmd(['config', '--get', 'remote.origin.url']); } catch (e) {}
    const ls = await gitCmd(['ls-remote', 'origin', branch]);
    const latest = ls ? ls.split(/\s+/)[0] : '';
    res.json({
      ok: true,
      branch: branch,
      remoteUrl: remoteUrl,
      current: current,
      latest: latest,
      upToDate: !!latest && current === latest,
      updateAvailable: !!latest && current !== latest
    });
  } catch (e) {
    res.json({ ok: false, error: String(e.message || e) });
  }
});

// ---------------------------------------------------------------------------
// Analytics: page-visit logging + time-series aggregation (visits / bookings)
// ---------------------------------------------------------------------------
function detectDevice(ua) {
  if (!ua) return 'unknown';
  if (/bot|crawl|spider|slurp|bingpreview|facebookexternalhit/i.test(ua)) return 'bot';
  if (/iPad|Tablet|PlayBook|Silk|(Android(?!.*Mobile))/i.test(ua)) return 'tablet';
  if (/Mobi|iPhone|iPod|Android|Windows Phone|Opera Mini|IEMobile|BlackBerry/i.test(ua)) return 'mobile';
  return 'desktop';
}
function detectOS(ua) {
  if (!ua) return '';
  if (/Windows Phone/i.test(ua)) return 'Windows Phone';
  if (/Windows NT/i.test(ua)) return 'Windows';
  if (/iPhone|iPad|iPod/i.test(ua)) return 'iOS';
  if (/Android/i.test(ua)) return 'Android';
  if (/Mac OS X|Macintosh/i.test(ua)) return 'macOS';
  if (/Linux/i.test(ua)) return 'Linux';
  return 'Прочее';
}
function detectBrowser(ua) {
  if (!ua) return '';
  if (/Edg(e|A|iOS)?\//i.test(ua)) return 'Edge';
  if (/OPR\/|Opera/i.test(ua)) return 'Opera';
  if (/YaBrowser/i.test(ua)) return 'Yandex';
  if (/Firefox\/|FxiOS/i.test(ua)) return 'Firefox';
  if (/Chrome\/|CriOS/i.test(ua)) return 'Chrome';
  if (/Safari\//i.test(ua)) return 'Safari';
  return 'Прочее';
}

app.post('/api/visit', (req, res) => {
  try {
    const ua = getUserAgent(req);
    db.prepare('INSERT INTO page_visits (visited_at, ip, device, os, browser) VALUES (?, ?, ?, ?, ?)')
      .run(new Date().toISOString(), getIp(req), detectDevice(ua), detectOS(ua), detectBrowser(ua));
  } catch (e) {}
  res.json({ ok: true });
});

app.get('/api/manager/stats/devices', requireManager, (req, res) => {
  try {
    const cat = { desktop: 0, mobile: 0, tablet: 0, other: 0 };
    for (const r of db.prepare("SELECT device AS k, COUNT(*) AS cnt FROM page_visits GROUP BY device").all()) {
      const c = Number(r.cnt) || 0;
      if (r.k === 'desktop' || r.k === 'mobile' || r.k === 'tablet') cat[r.k] += c; else cat.other += c;
    }
    const groupList = (col) => {
      const m = {};
      for (const r of db.prepare("SELECT " + col + " AS k, COUNT(*) AS cnt FROM page_visits GROUP BY " + col).all()) {
        const name = (r.k && String(r.k).trim()) ? String(r.k) : 'Прочее';
        m[name] = (m[name] || 0) + (Number(r.cnt) || 0);
      }
      return Object.keys(m).map(k => ({ name: k, count: m[k] })).sort((a, b) => b.count - a.count);
    };
    const total = cat.desktop + cat.mobile + cat.tablet + cat.other;
    res.json({ total: total, categories: cat, os: groupList('os'), browser: groupList('browser') });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

function pad2(n) { return String(n).padStart(2, '0'); }
function parseTs(ts) {
  if (!ts) return NaN;
  const s = String(ts);
  // Normalize 'YYYY-MM-DD HH:MM:SS' (sqlite UTC) to ISO; ISO strings pass through.
  return Date.parse(s.indexOf('T') !== -1 ? s : (s.replace(' ', 'T') + 'Z'));
}
function makeBuckets(interval) {
  const now = new Date();
  const b = [];
  const push = (start, end, label) => b.push({ start: start.getTime(), end: end.getTime(), label: label, count: 0 });
  if (interval === 'minute') {
    const base = new Date(now); base.setSeconds(0, 0);
    for (let i = 59; i >= 0; i--) { const s = new Date(base.getTime() - i * 60000); push(s, new Date(s.getTime() + 60000), pad2(s.getHours()) + ':' + pad2(s.getMinutes())); }
  } else if (interval === 'hour') {
    const base = new Date(now); base.setMinutes(0, 0, 0);
    for (let i = 23; i >= 0; i--) { const s = new Date(base.getTime() - i * 3600000); push(s, new Date(s.getTime() + 3600000), pad2(s.getHours()) + ':00'); }
  } else if (interval === 'week') {
    const base = new Date(now); base.setHours(0, 0, 0, 0); base.setDate(base.getDate() - ((base.getDay() + 6) % 7));
    for (let i = 11; i >= 0; i--) { const s = new Date(base.getTime() - i * 7 * 86400000); push(s, new Date(s.getTime() + 7 * 86400000), pad2(s.getDate()) + '.' + pad2(s.getMonth() + 1)); }
  } else if (interval === 'year') {
    const y = now.getFullYear();
    for (let i = 5; i >= 0; i--) { const s = new Date(y - i, 0, 1); push(s, new Date(y - i + 1, 0, 1), String(y - i)); }
  } else { // day
    const base = new Date(now); base.setHours(0, 0, 0, 0);
    for (let i = 29; i >= 0; i--) { const s = new Date(base.getTime() - i * 86400000); push(s, new Date(s.getTime() + 86400000), pad2(s.getDate()) + '.' + pad2(s.getMonth() + 1)); }
  }
  return b;
}
function countInto(buckets, timestamps) {
  if (!buckets.length) return;
  const first = buckets[0].start, last = buckets[buckets.length - 1].end;
  for (const ts of timestamps) {
    const t = parseTs(ts);
    if (isNaN(t) || t < first || t >= last) continue;
    for (const bk of buckets) { if (t >= bk.start && t < bk.end) { bk.count++; break; } }
  }
}

app.get('/api/manager/stats/timeseries', requireManager, (req, res) => {
  const interval = ['minute', 'hour', 'day', 'week', 'year'].indexOf(req.query.interval) !== -1 ? req.query.interval : 'day';
  const metric = req.query.metric === 'bookings' ? 'bookings' : 'visits';
  try {
    const buckets = makeBuckets(interval);
    let timestamps = [];
    if (metric === 'visits') {
      const since = new Date(buckets[0].start).toISOString();
      timestamps = db.prepare('SELECT visited_at FROM page_visits WHERE visited_at >= ?').all(since).map(r => r.visited_at);
    } else {
      timestamps = db.prepare("SELECT booked_at FROM slots WHERE booked_at IS NOT NULL").all().map(r => r.booked_at);
    }
    countInto(buckets, timestamps);
    res.json({ interval: interval, metric: metric, labels: buckets.map(b => b.label), counts: buckets.map(b => b.count) });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

function npmInstall() {
  return new Promise(function(resolve, reject) {
    execFile(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci', '--omit=dev'], { cwd: __dirname, timeout: 300000 }, function(err, so, se) {
      if (err) return reject(new Error(((se || err.message) || '').trim()));
      resolve();
    });
  });
}

// Pull the latest code from the git remote and restart so it takes effect.
// Relies on a process supervisor (systemd / Docker restart policy) to bring the
// app back up. Suitable for the native / git-checkout deployments.
app.post('/api/manager/update', requireManager, async (req, res) => {
  try {
    const before = await gitCmd(['rev-parse', 'HEAD']);
    let branch = 'main';
    try { branch = await gitCmd(['rev-parse', '--abbrev-ref', 'HEAD']) || 'main'; } catch (e) {}
    await gitCmd(['pull', '--ff-only', 'origin', branch]);
    const after = await gitCmd(['rev-parse', 'HEAD']);
    if (before === after) {
      return res.json({ success: true, updated: false, message: 'Уже установлена последняя версия' });
    }
    let depsChanged = false;
    try {
      const diff = await gitCmd(['diff', '--name-only', before, after]);
      depsChanged = /(^|\n)package(-lock)?\.json/.test(diff);
    } catch (e) {}
    if (depsChanged) {
      try { await npmInstall(); } catch (e) {
        return res.json({ success: false, error: 'git обновлён, но npm ci не прошёл: ' + e.message });
      }
    }
    logAction('manager', req.session.firstName + ' ' + req.session.lastName, 'Обновление', 'Обновил приложение ' + before.slice(0, 7) + ' → ' + after.slice(0, 7), 0, getIp(req), getUserAgent(req));
    res.json({ success: true, updated: true, from: before, to: after, depsChanged: depsChanged, restarting: true });
    // Give the response time to flush, then exit so the supervisor restarts us.
    setTimeout(function() { process.exit(0); }, 800);
  } catch (e) {
    res.json({ success: false, error: String(e.message || e) });
  }
});

// ---------------------------------------------------------------------------
// Backup / restore (logical JSON dump, backend-agnostic via the active adapter)
// ---------------------------------------------------------------------------
function buildBackupObject() {
  const tables = getSqliteTables();
  const dump = { app: 'warehouse-queue', version: APP_VERSION, createdAt: new Date().toISOString(), dbType: dbAdapter.getType(), tables: {} };
  for (const t of tables) dump.tables[t] = db.prepare('SELECT * FROM "' + t + '"').all();
  return dump;
}

function restoreFromDump(dump) {
  if (!dump || typeof dump.tables !== 'object' || dump.tables === null) {
    throw new Error('Некорректный файл резервной копии');
  }
  const tables = getSqliteTables();
  let rowCount = 0;
  const doRestore = db.transaction(() => {
    for (const t of tables) {
      if (!Array.isArray(dump.tables[t])) continue;
      db.prepare('DELETE FROM "' + t + '"').run();
      for (const row of dump.tables[t]) {
        const cols = Object.keys(row);
        if (!cols.length) continue;
        const colList = cols.map(c => '"' + c + '"').join(', ');
        const placeholders = cols.map(() => '?').join(', ');
        db.prepare('INSERT INTO "' + t + '" (' + colList + ') VALUES (' + placeholders + ')').run.apply(null, cols.map(c => row[c]));
        rowCount++;
      }
    }
  });
  doRestore();
  if (dbAdapter.getType() === 'postgresql') {
    for (const t of tables) {
      let hasId = false;
      try { hasId = sqliteDb.prepare("PRAGMA table_info('" + t + "')").all().some(c => c.name === 'id'); } catch (e) {}
      if (hasId) {
        try { db.prepare("SELECT setval(pg_get_serial_sequence('\"" + t + "\"','id'), COALESCE((SELECT MAX(id) FROM \"" + t + "\"),1), EXISTS(SELECT 1 FROM \"" + t + "\"))").get(); } catch (e) {}
      }
    }
  }
  loadTtlOverrides();
  redisFlushAll();
  return rowCount;
}

function safeBackupName(name) {
  return (typeof name === 'string' && /^[A-Za-z0-9_.\-]+\.json$/.test(name) && name.indexOf('..') === -1) ? name : null;
}

function getAutobackupInterval() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'autobackup_interval'").get();
  const n = row ? parseInt(row.value, 10) : 0;
  return AUTOBACKUP_INTERVALS.indexOf(n) !== -1 ? n : 0;
}
function getAutobackupKeep() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'autobackup_keep'").get();
  const n = row ? parseInt(row.value, 10) : 0;
  return (n && n > 0) ? Math.min(n, 1000) : 24;
}

function pruneBackups() {
  try {
    const keep = getAutobackupKeep();
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => /^autobackup-.*\.json$/.test(f))
      .map(f => ({ f: f, t: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (let i = keep; i < files.length; i++) {
      try { fs.unlinkSync(path.join(BACKUP_DIR, files[i].f)); } catch (e) {}
    }
  } catch (e) {}
}

function writeAutoBackup() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const dump = buildBackupObject();
  const name = 'autobackup-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.json';
  fs.writeFileSync(path.join(BACKUP_DIR, name), JSON.stringify(dump));
  pruneBackups();
  return name;
}

function scheduleAutobackup() {
  if (autobackupTimer) { clearInterval(autobackupTimer); autobackupTimer = null; }
  const sec = getAutobackupInterval();
  if (sec > 0) {
    autobackupTimer = setInterval(function() {
      try { writeAutoBackup(); } catch (e) { console.error('Autobackup failed:', e.message); }
    }, sec * 1000);
  }
}

app.get('/api/manager/backup', requireManager, (req, res) => {
  try {
    const dump = buildBackupObject();
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="warehouse-backup-' + stamp + '.json"');
    res.send(JSON.stringify(dump));
    logAction('manager', req.session.firstName + ' ' + req.session.lastName, 'Резервная копия', 'Скачал резервную копию БД', 0, getIp(req), getUserAgent(req));
  } catch (e) {
    res.status(500).json({ error: 'Ошибка создания резервной копии: ' + (e.message || e) });
  }
});

app.post('/api/manager/restore', requireManager, (req, res) => {
  try {
    const rows = restoreFromDump(req.body);
    logAction('manager', req.session.firstName + ' ' + req.session.lastName, 'Резервная копия', 'Восстановил БД из файла (' + rows + ' записей)', 0, getIp(req), getUserAgent(req));
    res.json({ success: true, rows: rows });
  } catch (e) {
    res.status(e.message.indexOf('Некорректный') === 0 ? 400 : 500).json({ error: 'Ошибка восстановления: ' + (e.message || e) });
  }
});

app.get('/api/manager/settings/autobackup', requireManager, (req, res) => {
  res.json({ interval: getAutobackupInterval(), keep: getAutobackupKeep(), intervals: AUTOBACKUP_INTERVALS });
});

app.post('/api/manager/settings/autobackup', requireManager, (req, res) => {
  let interval = parseInt(req.body.interval, 10);
  if (isNaN(interval) || (interval !== 0 && AUTOBACKUP_INTERVALS.indexOf(interval) === -1)) {
    return res.status(400).json({ error: 'Недопустимый интервал' });
  }
  let keep = parseInt(req.body.keep, 10);
  if (isNaN(keep) || keep < 1 || keep > 1000) {
    return res.status(400).json({ error: 'Кол-во копий должно быть от 1 до 1000' });
  }
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('autobackup_interval', ?)").run(String(interval));
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('autobackup_keep', ?)").run(String(keep));
  scheduleAutobackup();
  pruneBackups();
  logAction('manager', req.session.firstName + ' ' + req.session.lastName, 'Настройка', 'Изменил автоматическое резервное копирование', 0, getIp(req), getUserAgent(req));
  res.json({ success: true });
});

app.get('/api/manager/backups', requireManager, (req, res) => {
  try {
    let list = [];
    try {
      list = fs.readdirSync(BACKUP_DIR)
        .filter(f => /^autobackup-.*\.json$/.test(f))
        .map(f => { const st = fs.statSync(path.join(BACKUP_DIR, f)); return { name: f, sizeKb: Math.round(st.size / 1024), createdAt: new Date(st.mtimeMs).toISOString() }; })
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    } catch (e) {}
    res.json({ backups: list });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.post('/api/manager/backups/run', requireManager, (req, res) => {
  try {
    const name = writeAutoBackup();
    logAction('manager', req.session.firstName + ' ' + req.session.lastName, 'Резервная копия', 'Создал резервную копию вручную', 0, getIp(req), getUserAgent(req));
    res.json({ success: true, name: name });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка создания копии: ' + (e.message || e) });
  }
});

app.get('/api/manager/backups/:name', requireManager, (req, res) => {
  const name = safeBackupName(req.params.name);
  if (!name) return res.status(400).json({ error: 'Недопустимое имя файла' });
  const full = path.join(BACKUP_DIR, name);
  if (!fs.existsSync(full)) return res.status(404).json({ error: 'Файл не найден' });
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="' + name + '"');
  fs.createReadStream(full).pipe(res);
});

app.post('/api/manager/backups/:name/restore', requireManager, (req, res) => {
  const name = safeBackupName(req.params.name);
  if (!name) return res.status(400).json({ error: 'Недопустимое имя файла' });
  const full = path.join(BACKUP_DIR, name);
  if (!fs.existsSync(full)) return res.status(404).json({ error: 'Файл не найден' });
  try {
    const dump = JSON.parse(fs.readFileSync(full, 'utf8'));
    const rows = restoreFromDump(dump);
    logAction('manager', req.session.firstName + ' ' + req.session.lastName, 'Резервная копия', 'Восстановил БД из копии ' + name + ' (' + rows + ' записей)', 0, getIp(req), getUserAgent(req));
    res.json({ success: true, rows: rows });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка восстановления: ' + (e.message || e) });
  }
});

app.get('/api/public/privacy-policy', (req, res) => {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'privacy_policy_text'").get();
  res.json({ text: row ? row.value : '' });
});

app.get('/api/public/cookie-policy', (req, res) => {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'cookie_policy_text'").get();
  res.json({ text: row ? row.value : '' });
});

app.get('/api/public/settings/mascot', (req, res) => {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'mascot_enabled'").get();
  res.json({ enabled: row ? row.value === '1' : true });
});

app.get('/api/manager/settings/mascot', requireManager, (req, res) => {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'mascot_enabled'").get();
  res.json({ enabled: row ? row.value === '1' : true });
});

app.post('/api/manager/settings/mascot', requireManager, (req, res) => {
  const { enabled } = req.body;
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('mascot_enabled', ?)").run(enabled ? '1' : '0');
  logAction('manager', req.session.firstName + ' ' + req.session.lastName, 'Настройка', (enabled ? 'Включил' : 'Выключил') + ' маскота', 0, getIp(req), getUserAgent(req));
  res.json({ success: true });
});

app.get('/api/manager/settings/cookie-policy', requireManager, (req, res) => {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'cookie_policy_text'").get();
  res.json({ text: row ? row.value : '' });
});

app.post('/api/manager/settings/cookie-policy', requireManager, (req, res) => {
  const text = (req.body && typeof req.body.text === 'string') ? req.body.text : '';
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('cookie_policy_text', ?)").run(text);
  logAction('manager', req.session.firstName + ' ' + req.session.lastName, 'Настройка', 'Изменил текст политики cookie', 0, getIp(req), getUserAgent(req));
  res.json({ success: true });
});

app.get('/api/manager/settings/privacy-policy', requireManager, (req, res) => {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'privacy_policy_text'").get();
  res.json({ text: row ? row.value : '' });
});

app.post('/api/manager/settings/privacy-policy', requireManager, (req, res) => {
  const text = (req.body && typeof req.body.text === 'string') ? req.body.text : '';
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('privacy_policy_text', ?)").run(text);
  logAction('manager', req.session.firstName + ' ' + req.session.lastName, 'Настройка', 'Изменил текст политики обработки ПДн', 0, getIp(req), getUserAgent(req));
  res.json({ success: true });
});

app.get('/api/manager/settings/work-on-weekends', requireManager, (req, res) => {
  const setting = db.prepare("SELECT value FROM settings WHERE key = 'work_on_weekends'").get();
  res.json({ enabled: setting ? setting.value === '1' : false });
});

app.post('/api/manager/settings/work-on-weekends', requireManager, (req, res) => {
  const { enabled } = req.body;
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('work_on_weekends', ?)").run(enabled ? '1' : '0');
  redisFlushSlotsCache();
  logAction('manager', req.session.firstName + ' ' + req.session.lastName, 'Настройка', (enabled ? 'Включил' : 'Выключил') + ' работу в выходные дни', 0, getIp(req), getUserAgent(req));
  res.json({ success: true });
});

app.get('/api/manager/settings/logos', requireManager, (req, res) => {
  const logosDir = path.join(__dirname, 'public', 'logos');
  const result = { light: null, dark: null, cyberpunk: null };
  try {
    if (fs.existsSync(logosDir)) {
      for (const theme of ['light', 'dark', 'cyberpunk']) {
        const filePath = path.join(logosDir, theme + '.png');
        if (fs.existsSync(filePath)) {
          result[theme] = '/logos/' + theme + '.png?' + fs.statSync(filePath).mtimeMs;
        }
      }
    }
  } catch {}
  res.json(result);
});

app.post('/api/manager/settings/logo', requireManager, (req, res) => {
  const { theme, data } = req.body;
  if (!['light', 'dark', 'cyberpunk'].includes(theme)) return res.status(400).json({ error: 'Invalid theme' });
  if (!data || !data.startsWith('data:image')) return res.status(400).json({ error: 'Invalid image data' });
  const logosDir = path.join(__dirname, 'public', 'logos');
  if (!fs.existsSync(logosDir)) fs.mkdirSync(logosDir, { recursive: true });
  const base64 = data.replace(/^data:image\/\w+;base64,/, '');
  const buf = Buffer.from(base64, 'base64');
  fs.writeFileSync(path.join(logosDir, theme + '.png'), buf);
  logAction('manager', req.session.firstName + ' ' + req.session.lastName, 'Настройка', 'Изменил логотип для темы ' + theme, 0, getIp(req), getUserAgent(req));
  res.json({ success: true, url: '/logos/' + theme + '.png?' + Date.now() });
});

app.post('/api/manager/settings/logo/reset', requireManager, (req, res) => {
  const { theme } = req.body;
  if (!['light', 'dark', 'cyberpunk'].includes(theme)) return res.status(400).json({ error: 'Invalid theme' });
  const filePath = path.join(__dirname, 'public', 'logos', theme + '.png');
  try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch {}
  logAction('manager', req.session.firstName + ' ' + req.session.lastName, 'Настройка', 'Сбросил логотип для темы ' + theme, 0, getIp(req), getUserAgent(req));
  res.json({ success: true });
});

app.get('/api/manager/settings/redis', requireManager, (req, res) => {
  const config = getRedisConfig();
  res.json({ ...config, status: getRedisStatus() });
});

app.post('/api/manager/settings/redis', requireManager, (req, res) => {
  const { host, port, password, db: redisDb, enabled } = req.body;
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('redis_host', ?)").run(host || '127.0.0.1');
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('redis_port', ?)").run(String(port || 6379));
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('redis_password', ?)").run(password || '');
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('redis_db', ?)").run(String(redisDb || 0));
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('redis_enabled', ?)").run(enabled ? '1' : '0');
  initRedis();
  logAction('manager', req.session.firstName + ' ' + req.session.lastName, 'Настройка', 'Изменил настройки Redis' + (enabled ? '' : ' (отключил)'), 0, getIp(req), getUserAgent(req));
  if (!enabled || !redisClient) return res.json({ success: true, status: 'disabled' });
  var responded = false;
  var timer = setTimeout(function() { if (!responded) { responded = true; res.json({ success: true, status: getRedisStatus() }); } }, 1500);
  redisClient.once('ready', function() { if (!responded) { responded = true; clearTimeout(timer); res.json({ success: true, status: 'connected' }); } });
  redisClient.once('error', function() { if (!responded) { responded = true; clearTimeout(timer); res.json({ success: true, status: getRedisStatus() }); } });
});

app.get('/api/manager/settings/cache-ttl', requireManager, (req, res) => {
  const items = TTL_CATEGORIES.map(function(c) {
    return {
      key: c.key,
      label: c.label,
      def: c.def,
      value: Object.prototype.hasOwnProperty.call(ttlOverrides, c.key) ? ttlOverrides[c.key] : c.def
    };
  });
  res.json({ ttl: items });
});

app.post('/api/manager/settings/cache-ttl', requireManager, (req, res) => {
  const incoming = (req.body && req.body.ttl) ? req.body.ttl : {};
  for (const c of TTL_CATEGORIES) {
    if (!Object.prototype.hasOwnProperty.call(incoming, c.key)) continue;
    const n = parseInt(incoming[c.key], 10);
    if (isNaN(n) || n < 0 || n > 86400) {
      return res.status(400).json({ error: 'Недопустимый TTL (0–86400 c) для «' + c.label + '»' });
    }
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run('ttl_' + c.key, String(n));
  }
  loadTtlOverrides();
  redisFlushAll();
  logAction('manager', req.session.firstName + ' ' + req.session.lastName, 'Настройка', 'Изменил TTL кэша Redis', 0, getIp(req), getUserAgent(req));
  res.json({ success: true });
});

app.post('/api/manager/settings/redis/test', requireManager, (req, res) => {
  try {
    const { host, port, password, db } = req.body;
    var opts = { host: host || '127.0.0.1' };
    if (port) opts.port = typeof port === 'number' ? port : parseInt(port);
    if (password) opts.password = password;
    if (db) opts.db = typeof db === 'number' ? db : parseInt(db);
    var testClient;
    opts.retry_strategy = function() { return undefined; };
    try { testClient = redis.createClient(opts); } catch (e) { return res.json({ success: false, error: 'Failed to create Redis client: ' + e.message }); }
    var done = false;
    var timer = setTimeout(function() { if (!done) { done = true; try { testClient.quit(); } catch(e) {} res.json({ success: false, error: 'Таймаут подключения к Redis' }); } }, 5000);
    testClient.on('error', function(err) {
      if (!done) { done = true; clearTimeout(timer); try { testClient.quit(); } catch(e) {} res.json({ success: false, error: err.message }); }
    });
    testClient.on('ready', function() {
      if (done) return;
      done = true;
      clearTimeout(timer);
      testClient.set('__healthcheck__', '1', function(err) {
        try { testClient.quit(); } catch(e) {}
        if (err) return res.json({ success: false, error: err.message });
        res.json({ success: true });
      });
    });
  } catch (e) {
    console.error('Redis test error:', e);
    res.json({ success: false, error: 'Internal error: ' + e.message });
  }
});

/* ---------- Drivers ---------- */

app.get('/api/manager/drivers', requireManager, async (req, res) => {
  const { search } = req.query;
  const cacheKey = 'drivers:' + (search || 'all');
  const cached = await redisGet(cacheKey);
  if (cached) return res.json(JSON.parse(cached));
  let where = 'customer_phone IS NOT NULL AND customer_phone != \'\'';
  const params = [];
  if (search) {
    where += ' AND customer_phone LIKE ?';
    params.push('%' + search + '%');
  }
  const drivers = db.prepare(`
    SELECT s.customer_phone,
           GROUP_CONCAT(DISTINCT s.customer_name) AS names,
           GROUP_CONCAT(DISTINCT s.customer_account) AS accounts,
           MAX(s.booked_at) AS last_booked_at,
           COUNT(*) AS booking_count,
           (SELECT customer_ip FROM slots WHERE customer_phone = s.customer_phone AND customer_ip != '' ORDER BY booked_at DESC LIMIT 1) AS last_ip,
           (SELECT customer_user_agent FROM slots WHERE customer_phone = s.customer_phone AND customer_user_agent != '' ORDER BY booked_at DESC LIMIT 1) AS last_user_agent
    FROM slots s
    WHERE ${where}
    GROUP BY s.customer_phone
    ORDER BY last_booked_at DESC
  `).all(...params);
  const bannedPhones = db.prepare("SELECT phone FROM banned_phones").all().map(r => r.phone);
  for (const d of drivers) {
    d.isBanned = bannedPhones.includes(d.customer_phone);
  }
  const response = { drivers };
  redisSet(cacheKey, JSON.stringify(response), 30);
  res.json(response);
});

/* ---------- Banned Phones CRUD ---------- */

app.get('/api/manager/banned-phones', requireManager, async (req, res) => {
  const cacheKey = 'banned-phones';
  const cached = await redisGet(cacheKey);
  if (cached) return res.json(JSON.parse(cached));
  const list = db.prepare('SELECT * FROM banned_phones ORDER BY created_at DESC').all();
  const response = { phones: list };
  redisSet(cacheKey, JSON.stringify(response), 300);
  res.json(response);
});

app.post('/api/manager/banned-phones', requireManager, (req, res) => {
  const { phone, reason } = req.body;
  if (!phone || !phone.trim()) {
    return res.status(400).json({ error: 'Phone is required' });
  }
  const existing = db.prepare('SELECT id FROM banned_phones WHERE phone = ?').get(phone.trim());
  if (existing) {
    return res.status(409).json({ error: 'Phone already banned' });
  }
  db.prepare('INSERT INTO banned_phones (phone, reason) VALUES (?, ?)').run(phone.trim(), reason || '');
  redisFlushByPrefix('banned-phones');
  res.json({ success: true });
});

app.put('/api/manager/banned-phones/:id', requireManager, (req, res) => {
  const { id } = req.params;
  const { phone, reason } = req.body;
  const existing = db.prepare('SELECT * FROM banned_phones WHERE id = ?').get(id);
  if (!existing) {
    return res.status(404).json({ error: 'Not found' });
  }
  if (phone && phone.trim() !== existing.phone) {
    const dup = db.prepare('SELECT id FROM banned_phones WHERE phone = ? AND id != ?').get(phone.trim(), id);
    if (dup) {
      return res.status(409).json({ error: 'Phone already banned' });
    }
  }
  db.prepare('UPDATE banned_phones SET phone = ?, reason = ? WHERE id = ?').run(phone ? phone.trim() : existing.phone, reason !== undefined ? reason : existing.reason, id);
  redisFlushByPrefix('banned-phones');
  res.json({ success: true });
});

app.delete('/api/manager/banned-phones/:id', requireManager, (req, res) => {
  const { id } = req.params;
  db.prepare('DELETE FROM banned_phones WHERE id = ?').run(id);
  res.json({ success: true });
});

/* ---------- Banned IPs CRUD ---------- */

app.get('/api/manager/banned-ips', requireManager, async (req, res) => {
  const cacheKey = 'banned-ips';
  const cached = await redisGet(cacheKey);
  if (cached) return res.json(JSON.parse(cached));
  const list = db.prepare('SELECT * FROM banned_ips ORDER BY created_at DESC').all();
  const response = { ips: list };
  redisSet(cacheKey, JSON.stringify(response), 300);
  res.json(response);
});

app.post('/api/manager/banned-ips', requireManager, (req, res) => {
  const { ip, reason } = req.body;
  if (!ip || !ip.trim()) {
    return res.status(400).json({ error: 'IP is required' });
  }
  const existing = db.prepare('SELECT id FROM banned_ips WHERE ip = ?').get(ip.trim());
  if (existing) {
    return res.status(409).json({ error: 'IP already banned' });
  }
  db.prepare('INSERT INTO banned_ips (ip, reason) VALUES (?, ?)').run(ip.trim(), reason || '');
  redisFlushByPrefix('banned-ips');
  res.json({ success: true });
});

app.put('/api/manager/banned-ips/:id', requireManager, (req, res) => {
  const { id } = req.params;
  const { ip, reason } = req.body;
  const existing = db.prepare('SELECT * FROM banned_ips WHERE id = ?').get(id);
  if (!existing) {
    return res.status(404).json({ error: 'Not found' });
  }
  if (ip && ip.trim() !== existing.ip) {
    const dup = db.prepare('SELECT id FROM banned_ips WHERE ip = ? AND id != ?').get(ip.trim(), id);
    if (dup) {
      return res.status(409).json({ error: 'IP already banned' });
    }
  }
  db.prepare('UPDATE banned_ips SET ip = ?, reason = ? WHERE id = ?').run(ip ? ip.trim() : existing.ip, reason !== undefined ? reason : existing.reason, id);
  redisFlushByPrefix('banned-ips');
  res.json({ success: true });
});

app.delete('/api/manager/banned-ips/:id', requireManager, (req, res) => {
  const { id } = req.params;
  db.prepare('DELETE FROM banned_ips WHERE id = ?').run(id);
  res.json({ success: true });
});

/* ---------- Vehicle Classes CRUD ---------- */

app.get('/api/manager/vehicle-classes', requireManager, async (req, res) => {
  const cacheKey = 'vehicle-classes';
  const cached = await redisGet(cacheKey);
  if (cached) return res.json(JSON.parse(cached));
  const list = db.prepare('SELECT * FROM vehicle_classes ORDER BY name').all();
  const response = { classes: list };
  redisSet(cacheKey, JSON.stringify(response), 300);
  res.json(response);
});

app.post('/api/manager/vehicle-classes', requireManager, (req, res) => {
  const { name, description } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Name is required' });
  }
  const existing = db.prepare('SELECT id FROM vehicle_classes WHERE name = ?').get(name.trim());
  if (existing) {
    return res.status(409).json({ error: 'Class already exists' });
  }
  db.prepare('INSERT INTO vehicle_classes (name, description) VALUES (?, ?)').run(name.trim(), description || '');
  logAction('manager', req.session.firstName + ' ' + req.session.lastName, 'Класс машин', 'Добавил: ' + name.trim(), 0, getIp(req), getUserAgent(req));
  redisFlushByPrefix('vehicle-classes');
  res.json({ success: true });
});

app.put('/api/manager/vehicle-classes/:id', requireManager, (req, res) => {
  const { id } = req.params;
  const { name, description } = req.body;
  const existing = db.prepare('SELECT * FROM vehicle_classes WHERE id = ?').get(id);
  if (!existing) {
    return res.status(404).json({ error: 'Not found' });
  }
  if (name && name.trim() !== existing.name) {
    const dup = db.prepare('SELECT id FROM vehicle_classes WHERE name = ? AND id != ?').get(name.trim(), id);
    if (dup) {
      return res.status(409).json({ error: 'Class already exists' });
    }
  }
  db.prepare('UPDATE vehicle_classes SET name = ?, description = ? WHERE id = ?').run(name ? name.trim() : existing.name, description !== undefined ? description : existing.description, id);
  logAction('manager', req.session.firstName + ' ' + req.session.lastName, 'Класс машин', 'Изменил: ' + (name ? name.trim() : existing.name), 0, getIp(req), getUserAgent(req));
  redisFlushByPrefix('vehicle-classes');
  res.json({ success: true });
});

app.delete('/api/manager/vehicle-classes/:id', requireManager, (req, res) => {
  const { id } = req.params;
  const cls = db.prepare('SELECT * FROM vehicle_classes WHERE id = ?').get(id);
  if (cls) {
    logAction('manager', req.session.firstName + ' ' + req.session.lastName, 'Класс машин', 'Удалил: ' + cls.name, 0, getIp(req), getUserAgent(req));
  }
  db.prepare('DELETE FROM vehicle_classes WHERE id = ?').run(id);
  redisFlushByPrefix('vehicle-classes');
  res.json({ success: true });
});

/* ---------- Load Types CRUD ---------- */

app.get('/api/manager/load-types', requireManager, async (req, res) => {
  const cacheKey = 'load-types';
  const cached = await redisGet(cacheKey);
  if (cached) return res.json(JSON.parse(cached));
  const list = db.prepare('SELECT * FROM load_types ORDER BY name').all();
  const response = { types: list };
  redisSet(cacheKey, JSON.stringify(response), 300);
  res.json(response);
});

app.post('/api/manager/load-types', requireManager, (req, res) => {
  const { name, description } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Name is required' });
  }
  const existing = db.prepare('SELECT id FROM load_types WHERE name = ?').get(name.trim());
  if (existing) {
    return res.status(409).json({ error: 'Load type already exists' });
  }
  db.prepare('INSERT INTO load_types (name, description) VALUES (?, ?)').run(name.trim(), description || '');
  logAction('manager', req.session.firstName + ' ' + req.session.lastName, 'Вид загрузки', 'Добавил: ' + name.trim(), 0, getIp(req), getUserAgent(req));
  redisFlushByPrefix('load-types');
  res.json({ success: true });
});

app.put('/api/manager/load-types/:id', requireManager, (req, res) => {
  const { id } = req.params;
  const { name, description } = req.body;
  const existing = db.prepare('SELECT * FROM load_types WHERE id = ?').get(id);
  if (!existing) {
    return res.status(404).json({ error: 'Not found' });
  }
  if (name && name.trim() !== existing.name) {
    const dup = db.prepare('SELECT id FROM load_types WHERE name = ? AND id != ?').get(name.trim(), id);
    if (dup) {
      return res.status(409).json({ error: 'Load type already exists' });
    }
  }
  db.prepare('UPDATE load_types SET name = ?, description = ? WHERE id = ?').run(name ? name.trim() : existing.name, description !== undefined ? description : existing.description, id);
  logAction('manager', req.session.firstName + ' ' + req.session.lastName, 'Вид загрузки', 'Изменил: ' + (name ? name.trim() : existing.name), 0, getIp(req), getUserAgent(req));
  redisFlushByPrefix('load-types');
  res.json({ success: true });
});

app.delete('/api/manager/load-types/:id', requireManager, (req, res) => {
  const { id } = req.params;
  const t = db.prepare('SELECT * FROM load_types WHERE id = ?').get(id);
  if (t) {
    logAction('manager', req.session.firstName + ' ' + req.session.lastName, 'Вид загрузки', 'Удалил: ' + t.name, 0, getIp(req), getUserAgent(req));
  }
  db.prepare('DELETE FROM load_types WHERE id = ?').run(id);
  redisFlushByPrefix('load-types');
  res.json({ success: true });
});

/* ---------- PostgreSQL Settings & Migration ---------- */

function getPgSqlConfig() {
  var host = db.prepare("SELECT value FROM settings WHERE key = 'pgsql_host'").get();
  var port = db.prepare("SELECT value FROM settings WHERE key = 'pgsql_port'").get();
  var database = db.prepare("SELECT value FROM settings WHERE key = 'pgsql_database'").get();
  var user = db.prepare("SELECT value FROM settings WHERE key = 'pgsql_user'").get();
  var password = db.prepare("SELECT value FROM settings WHERE key = 'pgsql_password'").get();
  return {
    host: host ? host.value : '127.0.0.1',
    port: port ? parseInt(port.value) : 5432,
    database: database ? database.value : 'warehouse',
    user: user ? user.value : 'postgres',
    password: password ? password.value : ''
  };
}

function pgEsc(val) {
  if (val === null || val === undefined) return 'NULL';
  if (typeof val === 'number') return String(val);
  var s = String(val);
  s = s.replace(/'/g, "''");
  return "'" + s + "'";
}

function pgsqlType(sqliteType) {
  var t = (sqliteType || 'TEXT').toUpperCase();
  if (t === 'INTEGER' || t === 'INT') return 'INTEGER';
  if (t === 'REAL' || t === 'FLOAT' || t === 'DOUBLE') return 'DOUBLE PRECISION';
  if (t.indexOf('VARCHAR') !== -1) return t;
  if (t === 'BLOB') return 'BYTEA';
  return 'TEXT';
}

function pgsqlDefault(def) {
  if (def === null || def === undefined) return null;
  def = def.trim();
  while (def.charAt(0) === '(' && def.charAt(def.length - 1) === ')') {
    def = def.slice(1, -1).trim();
  }
  if (def === "datetime('now')" || def === "datetime('now','localtime')" || def === "datetime('now', 'localtime')") return 'CURRENT_TIMESTAMP';
  if (def === "''") return "''";
  if (def === '0' || def === '1') return def;
  if (def.match(/^'[^']*'$/)) return def;
  return def;
}

function generatePgCreateSQL(tableName) {
  var cols = sqliteDb.prepare("PRAGMA table_info('" + tableName + "')").all();
  var lines = [];
  for (var i = 0; i < cols.length; i++) {
    var c = cols[i];
    var pgType = pgsqlType(c.type);
    var line = '  "' + c.name + '" ' + pgType;
    if (c.pk && pgType === 'INTEGER') {
      line = '  "' + c.name + '" SERIAL PRIMARY KEY';
    } else if (c.pk) {
      line += ' PRIMARY KEY';
    }
    if (c.notnull) line += ' NOT NULL';
    var dflt = pgsqlDefault(c.dflt_value);
    if (dflt !== null) line += ' DEFAULT ' + dflt;
    lines.push(line);
  }
  // Carry over inline UNIQUE constraints. SQLite stores these as auto-indexes
  // (sqlite_autoindex_*) that the separate index step skips, so without this
  // the PG tables would lose uniqueness and ON CONFLICT targets.
  var idxList = sqliteDb.prepare("PRAGMA index_list('" + tableName + "')").all();
  for (var j = 0; j < idxList.length; j++) {
    var idx = idxList[j];
    if (idx.unique && idx.origin === 'u') {
      var info = sqliteDb.prepare("PRAGMA index_info('" + idx.name + "')").all();
      var ucols = info.map(function(ic) { return '"' + ic.name + '"'; });
      if (ucols.length) lines.push('  UNIQUE (' + ucols.join(', ') + ')');
    }
  }
  return 'CREATE TABLE IF NOT EXISTS "' + tableName + '" (\n' + lines.join(',\n') + '\n)';
}

function generatePgInsertsBatched(tableName) {
  var cols = sqliteDb.prepare("PRAGMA table_info('" + tableName + "')").all();
  var colNames = cols.map(function(c) { return c.name; });
  var quoted = colNames.map(function(n) { return '"' + n + '"'; }).join(', ');
  var rows;
  try {
    rows = sqliteDb.prepare('SELECT * FROM "' + tableName + '"').all();
  } catch (e) {
    return [];
  }
  if (!rows.length) return [];
  var BATCH = 200;
  var batches = [];
  for (var start = 0; start < rows.length; start += BATCH) {
    var end = Math.min(start + BATCH, rows.length);
    var valsList = [];
    for (var i = start; i < end; i++) {
      valsList.push('(' + colNames.map(function(n) { return pgEsc(rows[i][n]); }).join(', ') + ')');
    }
    batches.push('INSERT INTO "' + tableName + '" (' + quoted + ') VALUES\n  ' + valsList.join(',\n  '));
  }
  return batches;
}

function getSqliteTables() {
  return sqliteDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(function(r) { return r.name; });
}

function generatePgIndexes(tableName) {
  var indexes = sqliteDb.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%'").all(tableName);
  var sql = '';
  for (var i = 0; i < indexes.length; i++) {
    sql += indexes[i].sql.replace(/^CREATE (UNIQUE )?INDEX/, 'CREATE $1INDEX IF NOT EXISTS') + ';\n';
  }
  return sql;
}

function psqlEnv(config) {
  var env = {};
  for (var k in process.env) env[k] = process.env[k];
  env.PGPASSWORD = config.password;
  return env;
}

function psqlArgs(config) {
  return ['-h', config.host, '-p', String(config.port), '-U', config.user, '-d', config.database, '-q'];
}

function psqlExec(config, sql, cb) {
  var child = execFile('psql', psqlArgs(config), { env: psqlEnv(config), maxBuffer: 100 * 1024 * 1024, timeout: 120000 }, function(err, stdout, stderr) {
    if (err) return cb(new Error(stderr.trim() || 'psql error'));
    cb(null, stdout);
  });
  child.stdin.write(sql);
  child.stdin.end();
}

app.get('/api/manager/migration/status', requireManager, function(req, res) {
  var info = {
    current: dbAdapter.getType(),
    sqlite: {
      path: path.resolve(__dirname, 'warehouse.db'),
      tables: sqliteDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().length
    },
    pgsql: getPgSqlConfig()
  };
  try {
    var stat = fs.statSync(info.sqlite.path);
    info.sqlite.size = stat.size;
  } catch (e) {
    info.sqlite.size = 0;
  }
  // test PG connectivity briefly
  info.pgsql.connected = false;
  var child = execFile('psql', psqlArgs(info.pgsql).concat(['-c', 'SELECT 1']), { env: psqlEnv(info.pgsql), timeout: 5000 }, function(err) {
    info.pgsql.connected = !err;
    res.json(info);
  });
  child.stdin.end();
});

app.post('/api/manager/settings/pgsql', requireManager, function(req, res) {
  var host = req.body.host;
  var port = req.body.port;
  var database = req.body.database;
  var user = req.body.user;
  var password = req.body.password;
  // Validate connection parameters before persisting (they are later passed to
  // the psql CLI). host/db/user are restricted to a safe character set.
  var idRe = /^[A-Za-z0-9_.\-]+$/;
  var hostRe = /^[A-Za-z0-9_.\-:]+$/; // allow ':' for IPv6 hosts
  if (host && !hostRe.test(host)) {
    return res.status(400).json({ error: 'Недопустимый хост PostgreSQL' });
  }
  if (database && !idRe.test(database)) {
    return res.status(400).json({ error: 'Недопустимое имя базы данных' });
  }
  if (user && !idRe.test(user)) {
    return res.status(400).json({ error: 'Недопустимое имя пользователя' });
  }
  if (port !== undefined && port !== null && port !== '') {
    var portNum = parseInt(port, 10);
    if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
      return res.status(400).json({ error: 'Недопустимый порт' });
    }
  }
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('pgsql_host', ?)").run(host || '127.0.0.1');
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('pgsql_port', ?)").run(String(port || 5432));
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('pgsql_database', ?)").run(database || 'warehouse');
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('pgsql_user', ?)").run(user || 'postgres');
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('pgsql_password', ?)").run(password || '');
  logAction('manager', req.session.firstName + ' ' + req.session.lastName, 'Настройка', 'Сохранил настройки PostgreSQL', 0, getIp(req), getUserAgent(req));
  res.json({ success: true });
});

app.post('/api/manager/migrate/to-pgsql', requireManager, function(req, res) {
  var config = getPgSqlConfig();
  var responded = false;
  function respond(err, totalRows) {
    if (responded) return;
    responded = true;
    if (err) return res.json({ success: false, error: 'psql: ' + (err.message.split('\n')[0] || String(err)) });
    res.json({ success: true, tables: getSqliteTables().length, rows: totalRows || 0 });
  }

  var tables = getSqliteTables();
  var totalRows = 0;
  var idx = 0;

  function migrateNext() {
    if (idx >= tables.length) return respond(null, totalRows);
    var t = tables[idx];
    idx++;

    var rowCount;
    try { rowCount = db.prepare('SELECT COUNT(*) as cnt FROM "' + t + '"').get().cnt; } catch(e) { rowCount = 0; }

    var sql = 'DROP TABLE IF EXISTS "' + t + '" CASCADE;\n';
    sql += generatePgCreateSQL(t) + ';\n';
    sql += generatePgIndexes(t);
    var batches = generatePgInsertsBatched(t);
    for (var b = 0; b < batches.length; b++) {
      sql += batches[b] + ';\n';
    }
    // Rows are copied with their original ids, so advance the SERIAL sequence
    // to MAX(id); otherwise the next INSERT reuses id=1 and violates the PK.
    var hasId = false;
    try { hasId = sqliteDb.prepare("PRAGMA table_info('" + t + "')").all().some(function(c){ return c.name === 'id'; }); } catch (e) {}
    if (hasId) {
      sql += "SELECT setval(pg_get_serial_sequence('\"" + t + "\"','id'), COALESCE((SELECT MAX(id) FROM \"" + t + "\"),1), EXISTS(SELECT 1 FROM \"" + t + "\"));\n";
    }

    psqlExec(config, sql, function(err) {
      if (err) return respond(err);
      totalRows += rowCount;
      migrateNext();
    });
  }
  migrateNext();
});

app.post('/api/manager/migrate/to-sqlite', requireManager, function(req, res) {
  var config = getPgSqlConfig();
  var responded = false;
  function respond(err, totalRows) {
    if (responded) return;
    responded = true;
    if (err) return res.json({ success: false, error: 'psql: ' + (err.message.split('\n')[0] || String(err)) });
    res.json({ success: true, tables: getSqliteTables().length, rows: totalRows || 0 });
  }

  var tables = getSqliteTables();
  var totalRows = 0;
  var idx = 0;

  function migrateNext() {
    if (idx >= tables.length) return respond(null, totalRows);
    var t = tables[idx];
    idx++;
    psqlExec(config, 'SELECT row_to_json(r) FROM (SELECT * FROM "' + t + '") r', function(err, stdout) {
      if (err) return respond(err);
      var lines = stdout.trim().split('\n').filter(function(l) { return l.trim(); });
      if (!lines.length) return migrateNext();
      var rows = [];
      for (var i = 0; i < lines.length; i++) {
        try { rows.push(JSON.parse(lines[i])); } catch (e) {}
      }
      if (!rows.length) return migrateNext();
      var cols = sqliteDb.prepare("PRAGMA table_info('" + t + "')").all();
      var colNames = cols.map(function(c) { return c.name; });
      var placeholders = colNames.map(function() { return '?'; }).join(', ');
      var quoted = colNames.map(function(n) { return '"' + n + '"'; }).join(', ');
      var sql = 'INSERT INTO "' + t + '" (' + quoted + ') VALUES (' + placeholders + ')';
      db.prepare('DELETE FROM "' + t + '"').run();
      var insertStmt = db.prepare(sql);
      var count = 0;
      for (var k = 0; k < rows.length; k++) {
        var vals = colNames.map(function(n) {
          var v = rows[k][n];
          return v === null || v === undefined ? null : v;
        });
        try {
          insertStmt.run.apply(insertStmt, vals);
          count++;
        } catch (e) {
          return respond(e);
        }
      }
      totalRows += count;
      migrateNext();
    });
  }
  migrateNext();
});

app.post('/api/manager/switch/to-pgsql', requireManager, function(req, res) {
  var config = getPgSqlConfig();
  var testChild;
  try {
    testChild = require('child_process').execFileSync('psql', ['-h', config.host, '-p', String(config.port), '-U', config.user, '-d', config.database, '-A', '-t', '-q', '-c', 'SELECT 1'], { env: (function(e){e.PGPASSWORD=config.password||'';return e;})(Object.assign({},process.env)), timeout: 10000, encoding: 'utf8' });
  } catch (e) {
    var msg = (e.stderr || e.message || '').trim().split('\n')[0] || 'Connection failed';
    return res.json({ success: false, error: 'PostgreSQL недоступен: ' + msg });
  }
  dbAdapter.setPg(config);
  setDb(dbAdapter);
  sqliteDb.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('db_type', 'postgresql')").run();
  logAction('manager', req.session.firstName + ' ' + req.session.lastName, 'Настройка', 'Переключил БД на PostgreSQL', 0, getIp(req), getUserAgent(req));
  res.json({ success: true });
});

app.post('/api/manager/switch/to-sqlite', requireManager, function(req, res) {
  dbAdapter.setSqlite(sqliteDb);
  setDb(dbAdapter);
  sqliteDb.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('db_type', 'sqlite')").run();
  logAction('manager', req.session.firstName + ' ' + req.session.lastName, 'Настройка', 'Переключил БД на SQLite', 0, getIp(req), getUserAgent(req));
  res.json({ success: true });
});
