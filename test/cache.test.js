// Инвалидация кэша справочников. Регрессия: redisFlushByPrefix удалял только
// ключи вида 'prefix:*', а справочники кэшируются под ключом без двоеточия
// ('categories', 'warehouses', 'storekeepers', ...). Из-за этого добавленная
// категория не появлялась в списке ещё 5 минут — «+ Категория ничего не делает».
const http = require('http');
const PORT = parseInt(process.env.E2E_PORT || '4998', 10);

function req(method, path, { body, cookie } = {}) {
  return new Promise((resolve) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const h = {};
    if (data !== null) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    if (cookie) h['Cookie'] = cookie;
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path, headers: h, timeout: 15000 }, (res) => {
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

const checks = [];
const check = (l, ok, d = '') => checks.push({ l, ok, d });
const uniq = () => 'Кэш-' + Date.now() + '-' + Math.floor(Math.random() * 1000);

(async () => {
  const admin = await req('POST', '/api/manager/login', { body: { username: 'admin', password: 'Sklad-Test-2026' } });
  const A = admin.cookie;
  check('вход администратора', admin.status === 200, `HTTP ${admin.status}`);

  // --- категория: POST → сразу видна в GET ---
  await req('GET', '/api/manager/categories', { cookie: A });        // прогреваем кэш
  const name = uniq();
  const add = await req('POST', '/api/manager/categories', { cookie: A, body: { name } });
  check('категория создана', add.status === 200 && add.json && add.json.success, `HTTP ${add.status}: ${add.body.slice(0, 120)}`);
  check('ответ содержит id новой категории',
        !!(add.json && add.json.category && add.json.category.id), JSON.stringify(add.json));

  const after = await req('GET', '/api/manager/categories', { cookie: A });
  const found = (after.json.categories || []).find(c => c.name === name);
  check('новая категория сразу видна в справочнике (кэш сброшен)', !!found, `в списке ${(after.json.categories || []).length} шт.`);

  // --- повторное добавление того же имени не ошибка, а тот же id ---
  const again = await req('POST', '/api/manager/categories', { cookie: A, body: { name } });
  check('повтор имени → success + existed', again.status === 200 && again.json && again.json.success && again.json.existed, `HTTP ${again.status}: ${again.body.slice(0, 120)}`);
  check('повтор возвращает тот же id',
        again.json && again.json.category && found && Number(again.json.category.id) === Number(found.id),
        JSON.stringify(again.json && again.json.category));
  check('пустое имя → 400', (await req('POST', '/api/manager/categories', { cookie: A, body: { name: '  ' } })).status === 400);

  // --- склад: список складов обновляется сразу после изменения ---
  await req('GET', '/api/manager/warehouses', { cookie: A });        // прогреваем кэш
  const whName = uniq() + ' склад';
  const createdWh = await req('POST', '/api/manager/warehouses', { cookie: A, body: {
    name: whName, address: 'г. Тест', categoryIds: [Number(found && found.id)] } });
  check('склад создан', createdWh.status === 200 && createdWh.json.success, `HTTP ${createdWh.status}`);

  const whList = await req('GET', '/api/manager/warehouses', { cookie: A });
  const wh = (whList.json.warehouses || []).find(w => w.name === whName);
  check('новый склад сразу в списке (кэш сброшен)', !!wh, `в списке ${(whList.json.warehouses || []).length} шт.`);
  check('категория склада сразу видна',
        !!(wh && (wh.categories || []).some(c => c.name === name)), JSON.stringify(wh && wh.categories));

  // --- изменение категорий склада видно сразу ---
  if (wh) {
    const upd = await req('PUT', `/api/manager/warehouses/${wh.id}`, { cookie: A, body: {
      name: whName, address: 'г. Тест', categoryIds: [] } });
    check('склад обновлён', upd.status === 200 && upd.json.success, `HTTP ${upd.status}`);
    const whList2 = await req('GET', '/api/manager/warehouses', { cookie: A });
    const wh2 = (whList2.json.warehouses || []).find(w => w.id === wh.id);
    check('снятые категории сразу исчезли', !!wh2 && (wh2.categories || []).length === 0, JSON.stringify(wh2 && wh2.categories));
  } else {
    check('склад обновлён', false, 'склад не найден в списке — кэш не сброшен');
    check('снятые категории сразу исчезли', false, 'склад не найден в списке — кэш не сброшен');
  }

  // --- публичный список складов не кэшируется и отдаёт категории ---
  const pub = await req('GET', '/api/warehouses');
  check('публичный список складов работает', pub.status === 200 && Array.isArray(pub.json.warehouses), `HTTP ${pub.status}`);

  // --- кладовщики: тот же класс ключа без двоеточия ---
  await req('GET', '/api/manager/storekeepers', { cookie: A });
  const skName = uniq() + ' кладовщик';
  const sk = await req('POST', '/api/manager/storekeepers', { cookie: A, body: { name: skName, phone: '79990000000', pin_code: '1234' } });
  check('кладовщик создан', sk.status === 200, `HTTP ${sk.status}: ${sk.body.slice(0, 120)}`);
  const skList = await req('GET', '/api/manager/storekeepers', { cookie: A });
  check('новый кладовщик сразу в списке (кэш сброшен)',
        (skList.json.storekeepers || []).some(s => s.name === skName), `в списке ${(skList.json.storekeepers || []).length} шт.`);

  const bad = checks.filter(c => !c.ok);
  checks.forEach(c => console.log((c.ok ? '  OK  ' : ' FAIL ') + c.l + (c.d && !c.ok ? '  — ' + c.d : '')));
  console.log(`\nКэш: ${checks.length - bad.length}/${checks.length} проверок пройдено`);
  process.exit(bad.length ? 1 : 0);
})();
