process.env.DB_PATH = process.env.DB_PATH || '/tmp/sec_test.db';
process.env.PORT = process.env.PORT || '4998';
process.env.NODE_ENV = 'production';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Sklad-Test-2026';
module.paths.unshift(__dirname + '/node_modules');
require('module').Module._initPaths();

// E2E_REDIS=1 — поднять сервер с включённым кэшем (заглушка Redis хранит данные
// по-настоящему). Так проверяется инвалидация: без неё справочники отдавались
// из кэша ещё 5 минут после изменения.
if (process.env.E2E_REDIS === '1') {
  const Database = require(__dirname + '/node_modules/better-sqlite3.js');
  const tmp = new Database(process.env.DB_PATH);
  try {
    tmp.prepare('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)').run();
    tmp.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('redis_enabled', '1')").run();
  } catch (e) { console.error('E2E_REDIS:', e.message); }
  try { tmp.close(); } catch (e) {}
}

require(require('path').resolve(__dirname, '../../server.js'));
