// Время отметок в кабинете и организации из 1С.
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
const sqlRun = (q) => execFileSync('python3', ['-c',
  `import sqlite3,sys;db=sqlite3.connect(sys.argv[1]);db.executescript(sys.argv[2]);db.commit()`, DB, q], { encoding: 'utf8' });
const sqlOne = (q) => execFileSync('python3', ['-c',
  `import sqlite3,sys;r=sqlite3.connect(sys.argv[1]).execute(sys.argv[2]).fetchone();print('' if r is None else r[0])`, DB, q], { encoding: 'utf8' }).trim();

const checks = [];
const check = (l, ok, d = '') => checks.push({ l, ok, d });

// Мини-сервер, изображающий 1С: два счёта у разных юрлиц
function start1C(port, mapping) {
  return new Promise((resolve) => {
    const srv = http.createServer((rq, rs) => {
      let b = ''; rq.on('data', c => b += c);
      rq.on('end', () => {
        let accounts = [];
        try { accounts = (JSON.parse(b).invoce_number) || []; } catch (e) {}
        const results = {};
        accounts.forEach(a => {
          const m = mapping[a];
          results[a] = m
            ? { status: 'found', customerName: m.org, customerGUID: m.guid || ('guid-' + a), orderNumber: 'ORD-' + a, orderDate: '2026-09-01', managerName: m.manager || '', engineerName: '' }
            : { status: 'not found' };
        });
        rs.writeHead(200, { 'Content-Type': 'application/json' });
        rs.end(JSON.stringify({ results }));
      });
    });
    srv.listen(port, () => resolve(srv));
  });
}

(async () => {
  const admin = await req('POST', '/api/manager/login', { body: { username: 'admin', password: 'Sklad-Test-2026' } });
  const A = admin.cookie;

  // Настраиваем «1С»
  const ORG1 = 'ООО «Ромашка»', ORG2 = 'ООО «Василёк»';
  const srv = await start1C(4477, {
    '40817810000000000001': { org: ORG1 },
    '40817810000000000002': { org: ORG1 },
    '40817810000000000003': { org: ORG2 }
  });
  sqlRun("INSERT OR REPLACE INTO settings (key,value) VALUES ('1c_order_validation_url','http://127.0.0.1:4477/check');");
  // класс машины и вид загрузки по умолчанию обязательны — отключаем на время теста
  sqlRun("INSERT OR REPLACE INTO settings (key,value) VALUES ('require_vehicle_class','0');" +
         "INSERT OR REPLACE INTO settings (key,value) VALUES ('require_load_type','0');");

  // Дата ближайшего буднего дня
  const d = new Date(Date.now() + 2 * 86400000);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  const date = d.toISOString().slice(0, 10);

  const slots = await req('GET', `/api/slots?date=${date}&type=bulk`);
  const free = (slots.json.slots || []).filter(s => !s.is_booked && !s.past);
  check('есть свободные окна для теста', free.length >= 2, 'свободно: ' + free.length);

  async function book(slotId, org, accounts) {
    const cap = await req('GET', '/api/captcha');
    const m = String(cap.json.expression).match(/(\d+)\s*\+\s*(\d+)/);
    return req('POST', `/api/slots/${slotId}/book`, { cookie: cap.cookie, body: {
      name: 'Иван Иванов', phone: '79001110001', organization: org,
      account: accounts.join('\n'), captchaAnswer: Number(m[1]) + Number(m[2]) } });
  }

  // 1. Клиент указал НЕ ту организацию — заменяем на данные 1С
  const r1 = await book(free[0].id, 'ООО Неправильное Название', ['40817810000000000001']);
  check('запись прошла', r1.status === 200 && r1.json.success, `HTTP ${r1.status}: ${r1.body.slice(0,120)}`);
  check('организация заменена на данные 1С', r1.json && r1.json.organization === ORG1, JSON.stringify(r1.json && r1.json.organization));
  check('сервер сообщил о замене', r1.json && r1.json.organizationReplaced === true, String(r1.json && r1.json.organizationReplaced));
  check('в базе записана организация из 1С',
        sqlOne(`SELECT customer_organization FROM slots WHERE id=${free[0].id}`) === ORG1,
        sqlOne(`SELECT customer_organization FROM slots WHERE id=${free[0].id}`));

  // 2. Счета по нескольким организациям — перечисляем все
  const r2 = await book(free[1].id, '', ['40817810000000000001', '40817810000000000003']);
  check('запись с двумя юрлицами прошла', r2.status === 200 && r2.json.success, `HTTP ${r2.status}`);
  check('перечислены обе организации',
        r2.json && r2.json.organization === ORG1 + ', ' + ORG2, JSON.stringify(r2.json && r2.json.organization));
  const savedMap = sqlOne(`SELECT customer_account_orgs FROM slots WHERE id=${free[1].id}`);
  check('сохранено соответствие «счёт → организация»',
        savedMap.indexOf('40817810000000000001') !== -1 && savedMap.indexOf('Василёк') !== -1, savedMap.slice(0, 120));

  // 3. Кабинет: счета сгруппированы, организации перечислены
  const cab = await req('GET', `/api/manager/slots?date=${date}`, { cookie: A });
  const row = (cab.json.slots || []).find(s => s.id === free[1].id);
  check('кабинет отдаёт организацию у каждого счёта',
        row && row.accounts && row.accounts.length === 2 &&
        row.accounts[0].organization === ORG1 && row.accounts[1].organization === ORG2,
        JSON.stringify(row && row.accounts && row.accounts.map(a => a.organization)));

  // 4. Время отметки «Заявка»: должно совпадать с текущим временем склада (МСК)
  const stored = sqlOne(`SELECT booked_at FROM slots WHERE id=${free[1].id}`);
  check('в базе отметка хранится в UTC (без сдвига)',
        Math.abs(Date.parse(stored.replace(' ', 'T') + 'Z') - Date.now()) < 120000,
        'в базе: ' + stored + ', сейчас UTC: ' + new Date().toISOString().slice(0, 19));

  const shown = row && row.booked_at;
  const expectMsk = new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 16).replace('T', ' ');
  check('кабинет показывает время склада (МСК), а не UTC',
        shown && Math.abs(Date.parse(shown.replace(' ', 'T') + 'Z') - Date.parse(expectMsk.replace(' ', 'T') + 'Z')) < 120000,
        'показано: ' + shown + ', ожидалось около: ' + expectMsk);
  check('показанное время отличается от хранимого на 3 часа',
        shown && Math.round((Date.parse(shown.replace(' ','T')+'Z') - Date.parse(stored.replace(' ','T')+'Z')) / 3600000) === 3,
        'разница: ' + (shown ? Math.round((Date.parse(shown.replace(' ','T')+'Z') - Date.parse(stored.replace(' ','T')+'Z')) / 3600000) : '?') + ' ч');

  // 5. Подтверждение заявки — время тоже верное
  const conf = await req('POST', `/api/manager/slots/${free[1].id}/confirm`, { cookie: A });
  const cab2 = await req('GET', `/api/manager/slots?date=${date}`, { cookie: A });
  const row2 = (cab2.json.slots || []).find(s => s.id === free[1].id);
  check('колонка «Подтв.» показывает время склада',
        conf.status === 200 && row2 && row2.confirmed_at &&
        Math.abs(Date.parse(row2.confirmed_at.replace(' ', 'T') + 'Z') - Date.parse(expectMsk.replace(' ', 'T') + 'Z')) < 180000,
        'показано: ' + (row2 && row2.confirmed_at));

  // 6. Склад в другом поясе — отметка сдвигается вместе с ним
  sqlRun("INSERT OR IGNORE INTO warehouses (id, name, address, tz_offset) VALUES (77,'Склад UTC+7','Красноярск','7');" +
         "UPDATE warehouses SET tz_offset='7' WHERE id=77;" +
         "UPDATE slots SET warehouse_id=77 WHERE id=" + free[1].id + ";");
  const cab3 = await req('GET', `/api/manager/slots?date=${date}`, { cookie: A });
  const row3 = (cab3.json.slots || []).find(s => s.id === free[1].id);
  const diff = row3 && row3.booked_at
    ? Math.round((Date.parse(row3.booked_at.replace(' ','T')+'Z') - Date.parse(stored.replace(' ','T')+'Z')) / 3600000) : null;
  check('для склада UTC+7 отметка сдвинута на 7 часов', diff === 7, 'сдвиг: ' + diff + ' ч');
  sqlRun("UPDATE slots SET warehouse_id=NULL WHERE id=" + free[1].id + "; DELETE FROM warehouses WHERE id=77;");

  srv.close();
  let bad = 0;
  for (const c of checks) { if (!c.ok) bad++; console.log((c.ok ? 'OK  ' : 'FAIL') + '  ' + c.l + (c.d ? '  [' + c.d + ']' : '')); }
  console.log('\n' + (checks.length - bad) + '/' + checks.length + ' проверок пройдено');
  process.exit(bad ? 1 : 0);
})();
