// Категории товаров на складе.
const http = require('http');
const { execFileSync } = require('child_process');
const DB = process.env.DB_PATH || '/tmp/sec_test.db';

function req(method, path, { body, cookie } = {}) {
  return new Promise((resolve) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const h = {};
    if (data !== null) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    if (cookie) h['Cookie'] = cookie;
    const r = http.request({ host: '127.0.0.1', port: 4998, method, path, headers: h, timeout: 15000 }, (res) => {
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
const sqlOne = (q) => execFileSync('python3', ['-c',
  `import sqlite3,sys;r=sqlite3.connect(sys.argv[1]).execute(sys.argv[2]).fetchone();print('' if r is None else r[0])`, DB, q], { encoding: 'utf8' }).trim();

const checks = [];
const check = (l, ok, d = '') => checks.push({ l, ok, d });

(async () => {
  const admin = await req('POST', '/api/manager/login', { body: { username: 'admin', password: 'Sklad-Test-2026' } });
  const A = admin.cookie;
  check('вход администратора', admin.status === 200, `HTTP ${admin.status}`);

  // --- справочник категорий ---
  for (const name of ['Насосы', 'Трубы', 'Фитинги']) {
    await req('POST', '/api/manager/categories', { cookie: A, body: { name } });
  }
  const cats = await req('GET', '/api/manager/categories', { cookie: A });
  const byName = {};
  (cats.json.categories || []).forEach(c => { byName[c.name] = c.id; });
  check('категории созданы', !!(byName['Насосы'] && byName['Трубы'] && byName['Фитинги']), JSON.stringify(Object.keys(byName)));

  // --- создание склада сразу с категориями ---
  const created = await req('POST', '/api/manager/warehouses', { cookie: A, body: {
    name: 'Склад с категориями', address: 'г. Видное', categoryIds: [byName['Насосы'], byName['Трубы']] } });
  check('склад создан', created.status === 200 && created.json.success, `HTTP ${created.status}: ${created.body.slice(0,120)}`);

  let list = await req('GET', '/api/manager/warehouses', { cookie: A });
  let wh = (list.json.warehouses || []).find(w => w.name === 'Склад с категориями');
  check('в списке складов есть категории',
        wh && Array.isArray(wh.categories) && wh.categories.length === 2, JSON.stringify(wh && wh.categories));
  check('категории отсортированы по алфавиту',
        wh && wh.categories.map(c => c.name).join(',') === 'Насосы,Трубы', JSON.stringify(wh && wh.categories.map(c => c.name)));

  // --- отдельный маршрут категорий склада ---
  const one = await req('GET', `/api/manager/warehouses/${wh.id}/categories`, { cookie: A });
  check('маршрут категорий склада работает',
        one.status === 200 && one.json.categories.length === 2, `HTTP ${one.status}`);
  const missing = await req('GET', '/api/manager/warehouses/999999/categories', { cookie: A });
  check('несуществующий склад → 404', missing.status === 404, `HTTP ${missing.status}`);

  // --- изменение набора категорий ---
  const upd = await req('PUT', `/api/manager/warehouses/${wh.id}`, { cookie: A, body: {
    name: 'Склад с категориями', address: 'г. Видное', categoryIds: [byName['Фитинги']] } });
  list = await req('GET', '/api/manager/warehouses', { cookie: A });
  wh = (list.json.warehouses || []).find(w => w.id === wh.id);
  check('набор категорий заменяется',
        upd.status === 200 && wh.categories.length === 1 && wh.categories[0].name === 'Фитинги',
        JSON.stringify(wh.categories));
  check('старые связи не остались',
        Number(sqlOne(`SELECT COUNT(*) FROM warehouse_categories WHERE warehouse_id=${wh.id}`)) === 1,
        sqlOne(`SELECT COUNT(*) FROM warehouse_categories WHERE warehouse_id=${wh.id}`));

  // --- дубли и мусор в списке id ---
  await req('PUT', `/api/manager/warehouses/${wh.id}`, { cookie: A, body: {
    name: 'Склад с категориями', categoryIds: [byName['Насосы'], byName['Насосы'], 999999, 'abc', null, -5] } });
  list = await req('GET', '/api/manager/warehouses', { cookie: A });
  wh = (list.json.warehouses || []).find(w => w.id === wh.id);
  check('дубли и несуществующие id отброшены',
        wh.categories.length === 1 && wh.categories[0].name === 'Насосы', JSON.stringify(wh.categories));

  // --- поле не передано: набор не трогаем (старые формы кабинета) ---
  await req('PUT', `/api/manager/warehouses/${wh.id}`, { cookie: A, body: { name: 'Склад с категориями', address: 'Новый адрес' } });
  list = await req('GET', '/api/manager/warehouses', { cookie: A });
  wh = (list.json.warehouses || []).find(w => w.id === wh.id);
  check('без поля categoryIds набор сохраняется',
        wh.categories.length === 1 && wh.address === 'Новый адрес', JSON.stringify(wh.categories) + ' / ' + wh.address);

  // --- пустой список снимает все категории ---
  await req('PUT', `/api/manager/warehouses/${wh.id}`, { cookie: A, body: { name: 'Склад с категориями', categoryIds: [] } });
  list = await req('GET', '/api/manager/warehouses', { cookie: A });
  wh = (list.json.warehouses || []).find(w => w.id === wh.id);
  check('пустой список снимает категории', wh.categories.length === 0, JSON.stringify(wh.categories));

  // --- переименование категории видно на складе ---
  await req('PUT', `/api/manager/warehouses/${wh.id}`, { cookie: A, body: { name: 'Склад с категориями', categoryIds: [byName['Трубы']] } });
  await req('PUT', `/api/manager/categories/${byName['Трубы']}`, { cookie: A, body: { name: 'Трубы ПНД' } });
  list = await req('GET', '/api/manager/warehouses', { cookie: A });
  wh = (list.json.warehouses || []).find(w => w.id === wh.id);
  check('переименование категории отражается на складе',
        wh.categories.length === 1 && wh.categories[0].name === 'Трубы ПНД', JSON.stringify(wh.categories));

  // --- удаление категории снимает её со складов ---
  await req('DELETE', `/api/manager/categories/${byName['Трубы']}`, { cookie: A });
  list = await req('GET', '/api/manager/warehouses', { cookie: A });
  wh = (list.json.warehouses || []).find(w => w.id === wh.id);
  check('удалённая категория исчезает со склада', wh.categories.length === 0, JSON.stringify(wh.categories));
  check('связь удалена из базы',
        Number(sqlOne(`SELECT COUNT(*) FROM warehouse_categories WHERE category_id=${byName['Трубы']}`)) === 0, '');

  // --- удаление склада убирает его связи ---
  await req('PUT', `/api/manager/warehouses/${wh.id}`, { cookie: A, body: { name: 'Склад с категориями', categoryIds: [byName['Насосы']] } });
  const whId = wh.id;
  await req('DELETE', `/api/manager/warehouses/${whId}`, { cookie: A });
  check('связи удалённого склада убраны',
        Number(sqlOne(`SELECT COUNT(*) FROM warehouse_categories WHERE warehouse_id=${whId}`)) === 0, '');

  // --- публичная страница записи видит категории склада ---
  await req('PUT', `/api/manager/warehouses/${whId}`, { cookie: A, body: { name: 'Склад с категориями', categoryIds: [] } });
  const pubWh = await req('POST', '/api/manager/warehouses', { cookie: A, body: {
    name: 'Публичный склад', address: 'г. Подольск', categoryIds: [byName['Насосы'], byName['Фитинги']] } });
  const pub = await req('GET', '/api/warehouses');
  const pw = (pub.json.warehouses || []).find(w => w.name === 'Публичный склад');
  check('публичный список складов отдаёт категории',
        pw && Array.isArray(pw.categories) && pw.categories.length === 2, JSON.stringify(pw && pw.categories));
  check('в публичном списке категории — названиями',
        pw && typeof pw.categories[0] === 'string', JSON.stringify(pw && pw.categories));
  check('склад без категорий отдаёт пустой список',
        (pub.json.warehouses || []).every(w => Array.isArray(w.categories)), '');
  if (pw) await req('DELETE', `/api/manager/warehouses/${pw.id}`, { cookie: A });

  // --- права доступа: раздел «Склады» только на чтение ---
  const crypto = require('crypto');
  const hash = crypto.createHash('sha256').update('Manager-Parol-26').digest('hex');
  execFileSync('python3', ['-c',
    `import sqlite3,sys;db=sqlite3.connect(sys.argv[1]);db.execute(sys.argv[2]);db.commit()`, DB,
    `INSERT OR IGNORE INTO managers (username,password_hash,first_name,last_name,is_admin) VALUES ('mgr_cat','${hash}','Иван','Менеджер',0)`]);
  const m = await req('POST', '/api/manager/login', { body: { username: 'mgr_cat', password: 'Manager-Parol-26' } });
  await req('POST', '/api/manager/settings/permissions', { cookie: A, body: { permissions: { manager: { warehouses: 'read' } } } });
  const readOnly = await req('POST', '/api/manager/warehouses', { cookie: m.cookie, body: { name: 'Левый склад', categoryIds: [] } });
  check('при праве «только чтение» склад не создать', readOnly.status === 403, `HTTP ${readOnly.status}`);
  await req('POST', '/api/manager/settings/permissions', { cookie: A, body: { permissions: { manager: { warehouses: 'write' } } } });

  let bad = 0;
  for (const c of checks) { if (!c.ok) bad++; console.log((c.ok ? 'OK  ' : 'FAIL') + '  ' + c.l + (c.d ? '  [' + c.d + ']' : '')); }
  console.log('\n' + (checks.length - bad) + '/' + checks.length + ' проверок пройдено');
  process.exit(bad ? 1 : 0);
})();
