// Права доступа по разделам и маскировка секретов в настройках.
const http = require('http');
const { execFileSync } = require('child_process');
const crypto = require('crypto');

function req(method, path, { body, cookie } = {}) {
  return new Promise((resolve) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const h = {};
    if (data !== null) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    if (cookie) h['Cookie'] = cookie;
    const r = http.request({ host: '127.0.0.1', port: 4998, method, path, headers: h, timeout: 8000 }, (res) => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (e) {}
        resolve({ status: res.statusCode, json: j, body: b,
                  cookie: (res.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ') }); });
    });
    r.on('error', e => resolve({ status: 0, body: e.message, json: null }));
    r.on('timeout', () => { r.destroy(); resolve({ status: 0, body: 'timeout', json: null }); });
    if (data !== null) r.write(data); r.end();
  });
}
const sql = (q) => execFileSync('python3', ['-c',
  `import sqlite3,sys;db=sqlite3.connect('/tmp/sec_test.db');db.execute(sys.argv[1]);db.commit()`, q], { encoding: 'utf8' });
const sqlGet = (q) => execFileSync('python3', ['-c',
  `import sqlite3,sys;print(sqlite3.connect('/tmp/sec_test.db').execute(sys.argv[1]).fetchone())`, q], { encoding: 'utf8' }).trim();

const checks = [];
const check = (l, ok, d = '') => checks.push({ l, ok, d });

(async () => {
  const admin = await req('POST', '/api/manager/login', { body: { username: 'admin', password: 'Sklad-Test-2026' } });
  const A = admin.cookie;
  check('вход администратора', admin.status === 200, `HTTP ${admin.status}`);

  // обычный менеджер (не админ)
  const hash = crypto.createHash('sha256').update('Manager-Parol-26').digest('hex');
  sql(`INSERT OR IGNORE INTO managers (username, password_hash, first_name, last_name, is_admin) VALUES ('mgr1','${hash}','Иван','Менеджер',0)`);
  const mLogin = await req('POST', '/api/manager/login', { body: { username: 'mgr1', password: 'Manager-Parol-26' } });
  const M = mLogin.cookie;
  check('вход обычного менеджера', mLogin.status === 200, `HTTP ${mLogin.status}`);

  // --- матрица прав ---
  const list = await req('GET', '/api/manager/settings/permissions', { cookie: A });
  check('матрица прав отдаётся', list.status === 200 && list.json && Array.isArray(list.json.sections), `HTTP ${list.status}`);
  check('в матрице есть роли менеджера и кладовщика',
        list.json && (list.json.roles || []).map(r => r.key).join(',') === 'manager,storekeeper',
        JSON.stringify(list.json && list.json.roles));
  check('по умолчанию всё разрешено',
        list.json && list.json.permissions.manager.drivers === 'write', JSON.stringify(list.json && list.json.permissions.manager.drivers));

  // до ограничений менеджер видит «Водителей»
  const before = await req('GET', '/api/manager/drivers', { cookie: M });
  check('до ограничения менеджер видит раздел «Водители»', before.status === 200, `HTTP ${before.status}`);

  // ставим: водители — нет доступа, журнал — только чтение, склады — только чтение
  const save = await req('POST', '/api/manager/settings/permissions', { cookie: A, body: {
    permissions: { manager: { drivers: 'none', journal: 'read', warehouses: 'read' }, storekeeper: { skcabinet: 'read' } }
  } });
  check('права сохраняются', save.status === 200 && save.json && save.json.success, `HTTP ${save.status}`);

  // --- проверка применения ---
  const d1 = await req('GET', '/api/manager/drivers', { cookie: M });
  check('«нет доступа»: чтение закрыто', d1.status === 403, `HTTP ${d1.status}: ${(d1.json||{}).error || ''}`);

  const j1 = await req('GET', '/api/manager/logs', { cookie: M });
  check('«только чтение»: просмотр журнала работает', j1.status === 200, `HTTP ${j1.status}`);

  const w1 = await req('GET', '/api/manager/warehouses', { cookie: M });
  check('«только чтение»: список складов открывается', w1.status === 200, `HTTP ${w1.status}`);
  const w2 = await req('POST', '/api/manager/warehouses', { cookie: M, body: { name: 'Левый склад' } });
  check('«только чтение»: создать склад нельзя', w2.status === 403, `HTTP ${w2.status}: ${(w2.json||{}).error || ''}`);
  const w3 = await req('PUT', '/api/manager/warehouses/1', { cookie: M, body: { name: 'Переименован' } });
  check('«только чтение»: изменить склад нельзя', w3.status === 403, `HTTP ${w3.status}`);

  // разделы без ограничений продолжают работать
  const ok1 = await req('GET', '/api/manager/slots?date=2026-08-20&type=small', { cookie: M });
  check('неограниченный раздел работает', ok1.status === 200, `HTTP ${ok1.status}`);
  const ok2 = await req('GET', '/api/manager/storekeepers', { cookie: M });
  check('неограниченный раздел (кладовщики) работает', ok2.status === 200, `HTTP ${ok2.status}`);

  // администратора ограничения не касаются
  const a1 = await req('GET', '/api/manager/drivers', { cookie: A });
  check('на администратора права не влияют', a1.status === 200, `HTTP ${a1.status}`);

  // /me отдаёт права для интерфейса
  const me = await req('GET', '/api/manager/me', { cookie: M });
  check('/me отдаёт права менеджера',
        me.json && me.json.permissions && me.json.permissions.drivers === 'none' && me.json.permissions.journal === 'read',
        JSON.stringify(me.json && me.json.permissions));
  const meA = await req('GET', '/api/manager/me', { cookie: A });
  check('/me администратора: везде полный доступ',
        meA.json && meA.json.permissions && meA.json.permissions.drivers === 'write',
        JSON.stringify(meA.json && meA.json.permissions && meA.json.permissions.drivers));

  // кабинет кладовщика: только чтение
  const sk1 = await req('GET', '/api/storekeeper/slots');
  check('кладовщик: просмотр работает', sk1.status === 200, `HTTP ${sk1.status}`);
  const sk2 = await req('POST', '/api/storekeeper/slots/1/assemble', { body: { pinCode: '1234' } });
  check('кладовщик «только чтение»: изменение закрыто', sk2.status === 403, `HTTP ${sk2.status}: ${(sk2.json||{}).error || ''}`);

  // менеджер не может менять права сам
  const hack = await req('POST', '/api/manager/settings/permissions', { cookie: M, body: { permissions: { manager: { drivers: 'write' } } } });
  check('менеджер не может расширить свои права', hack.status === 403, `HTTP ${hack.status}`);

  // возврат к полному доступу
  const reset = await req('POST', '/api/manager/settings/permissions', { cookie: A, body: {
    permissions: { manager: { drivers: 'write', journal: 'write', warehouses: 'write' }, storekeeper: { skcabinet: 'write' } } } });
  const d2 = await req('GET', '/api/manager/drivers', { cookie: M });
  check('сброс прав возвращает доступ', reset.status === 200 && d2.status === 200, `HTTP ${d2.status}`);

  // --- секреты в настройках ---
  sql("INSERT OR REPLACE INTO settings (key, value) VALUES ('1c_password','sekret-1c')");
  sql("INSERT OR REPLACE INTO settings (key, value) VALUES ('smsru_api_key','sms-kluch-123')");
  sql("INSERT OR REPLACE INTO settings (key, value) VALUES ('pgsql_password','pg-parol-456')");
  sql("INSERT OR REPLACE INTO settings (key, value) VALUES ('redis_password','redis-parol')");

  const c1 = await req('GET', '/api/manager/settings/1c', { cookie: A });
  check('пароль 1С не отдаётся', c1.json && c1.json.password === '' && c1.json.passwordSet === true && !/sekret-1c/.test(c1.body), c1.body.slice(0, 90));
  const sms = await req('GET', '/api/manager/settings/smsru', { cookie: A });
  check('ключ SMS не отдаётся', sms.json && sms.json.apiKey === '' && sms.json.apiKeySet === true && !/sms-kluch/.test(sms.body), sms.body);
  const rd = await req('GET', '/api/manager/settings/redis', { cookie: A });
  check('пароль Redis не отдаётся', rd.json && rd.json.password === '' && rd.json.passwordSet === true && !/redis-parol/.test(rd.body), rd.body.slice(0, 90));
  const ab = await req('GET', '/api/manager/migration/status', { cookie: A });
  check('пароль PostgreSQL не отдаётся', !/pg-parol-456/.test(ab.body) && ab.json && ab.json.pgsql && ab.json.pgsql.passwordSet === true,
        JSON.stringify(ab.json && ab.json.pgsql));

  // пустое значение не затирает сохранённый секрет
  await req('POST', '/api/manager/settings/1c/credentials', { cookie: A, body: { username: 'novyi-login', password: '' } });
  check('пустой пароль 1С не стирает сохранённый', sqlGet("SELECT value FROM settings WHERE key='1c_password'").indexOf('sekret-1c') !== -1,
        sqlGet("SELECT value FROM settings WHERE key='1c_password'"));
  check('логин 1С при этом сохранился', sqlGet("SELECT value FROM settings WHERE key='1c_username'").indexOf('novyi-login') !== -1, '');

  // новое значение сохраняется
  await req('POST', '/api/manager/settings/smsru', { cookie: A, body: { apiKey: 'novyi-kluch-999' } });
  check('новый ключ SMS сохраняется', sqlGet("SELECT value FROM settings WHERE key='smsru_api_key'").indexOf('novyi-kluch-999') !== -1,
        sqlGet("SELECT value FROM settings WHERE key='smsru_api_key'"));

  // прочерк очищает
  await req('POST', '/api/manager/settings/smsru', { cookie: A, body: { apiKey: '-' } });
  const cleared = sqlGet("SELECT value FROM settings WHERE key='smsru_api_key'");
  check('прочерк очищает значение', cleared.indexOf("''") !== -1 || cleared === "('',)", cleared);

  let bad = 0;
  for (const c of checks) { if (!c.ok) bad++; console.log((c.ok ? 'OK  ' : 'FAIL') + '  ' + c.l + (c.d ? '  [' + c.d + ']' : '')); }
  console.log('\n' + (checks.length - bad) + '/' + checks.length + ' проверок пройдено');
  process.exit(bad ? 1 : 0);
})();
