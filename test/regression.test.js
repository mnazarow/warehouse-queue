// Проверяем, что рабочие сценарии не сломались новыми правками.
const http = require('http');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

function req(method, path, { body, cookie } = {}) {
  return new Promise((resolve) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const h = {};
    if (data !== null) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    if (cookie) h['Cookie'] = cookie;
    const r = http.request({ host: '127.0.0.1', port: 4998, method, path, headers: h, timeout: 8000 }, (res) => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (e) {}
        resolve({ status: res.statusCode, json: j, body: b, cookie: (res.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ') }); });
    });
    r.on('error', e => resolve({ status: 0, body: e.message, json: null }));
    r.on('timeout', () => { r.destroy(); resolve({ status: 0, body: 'timeout', json: null }); });
    if (data !== null) r.write(data); r.end();
  });
}
const PY = (sql) => execFileSync('python3', ['-c',
  `import sqlite3,sys;db=sqlite3.connect('/tmp/sec_test.db');db.execute(sys.argv[1]);db.commit()`, sql], { encoding: 'utf8' });

const checks = [];
const check = (l, ok, d = '') => checks.push({ l, ok, d });

(async () => {
  // --- вход по СТАРОМУ хешу sha256 должен работать и молча обновиться ---
  const legacy = crypto.createHash('sha256').update('staryi-parol-2025').digest('hex');
  PY(`INSERT INTO managers (username, password_hash, first_name, last_name, is_admin) VALUES ('legacy_user','${legacy}','Пётр','Старый',0)`);
  const lg = await req('POST', '/api/manager/login', { body: { username: 'legacy_user', password: 'staryi-parol-2025' } });
  check('вход по старому sha256-хешу работает', lg.status === 200 && lg.json && lg.json.success, `HTTP ${lg.status}`);
  const stored = execFileSync('python3', ['-c',
    `import sqlite3;print(sqlite3.connect('/tmp/sec_test.db').execute("SELECT password_hash FROM managers WHERE username='legacy_user'").fetchone()[0][:7])`],
    { encoding: 'utf8' }).trim();
  check('старый хеш переписан на scrypt при входе', stored === 'scrypt$', 'в базе: ' + stored);
  const lg2 = await req('POST', '/api/manager/login', { body: { username: 'legacy_user', password: 'staryi-parol-2025' } });
  check('повторный вход после перехеширования работает', lg2.status === 200, `HTTP ${lg2.status}`);
  const lgBad = await req('POST', '/api/manager/login', { body: { username: 'legacy_user', password: 'не-тот' } });
  check('неверный пароль после миграции отклонён', lgBad.status === 401, `HTTP ${lgBad.status}`);

  // --- публичная запись: полный цикл ---
  const date = (() => { const d = new Date(Date.now() + 3 * 86400000);
    while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
    return d.toISOString().slice(0, 10); })();
  const wh = await req('GET', '/api/warehouses');
  check('список складов отдаётся', wh.status === 200 && wh.json && Array.isArray(wh.json.warehouses), `HTTP ${wh.status}`);
  check('в складах есть часовой пояс', wh.json && wh.json.warehouses.every(w => w.tz_offset !== undefined), '');

  const slots = await req('GET', `/api/slots?date=${date}&type=small`);
  check('окна на будний день создаются', slots.status === 200 && slots.json && slots.json.slots && slots.json.slots.length > 0,
        `HTTP ${slots.status}, окон: ${slots.json && slots.json.slots ? slots.json.slots.length : 0}`);
  check('ответ слотов содержит часовой пояс', slots.json && slots.json.tz_offset !== undefined, String(slots.json && slots.json.tz_offset));

  const free = (slots.json.slots || []).find(s => !s.is_booked && !s.past);
  if (free) {
    const cap = await req('GET', '/api/captcha');
    const m = String(cap.json && cap.json.expression || '').match(/(\d+)\s*\+\s*(\d+)/);
    const answer = m ? Number(m[1]) + Number(m[2]) : 0;
    const bk = await req('POST', `/api/slots/${free.id}/book`, {
      cookie: cap.cookie,
      body: { name: 'Иван Иванов', phone: '79001112233', captchaAnswer: answer, vehicleClassId: 1, loadTypeId: 1 }
    });
    check('бронирование проходит', bk.status === 200 && bk.json && bk.json.success, `HTTP ${bk.status}: ${bk.body.slice(0, 80)}`);
    const after = await req('GET', `/api/slots?date=${date}&type=small`);
    const now = (after.json.slots || []).find(s => s.id === free.id);
    check('слот помечен занятым', !!(now && now.is_booked), '');
    const mine = await req('POST', `/api/slots/${free.id}/my-booking`, { body: { phone: '79001112233' } });
    check('клиент открывает свою запись по телефону', mine.status === 200 && mine.json && mine.json.booking, `HTTP ${mine.status}`);
    const foreign = await req('POST', `/api/slots/${free.id}/my-booking`, { body: { phone: '79009998877' } });
    check('чужой телефон запись не открывает', foreign.status === 403 || foreign.status === 404, `HTTP ${foreign.status}`);
  } else {
    check('нашёлся свободный слот для теста', false, 'свободных окон нет');
  }

  // --- кабинет: базовые данные ---
  const login = await req('POST', '/api/manager/login', { body: { username: 'admin', password: 'Sklad-Test-2026' } });
  const ck = login.cookie;
  for (const p of ['/api/manager/me', '/api/manager/warehouses', '/api/manager/storekeepers', '/api/manager/logisticians',
                   '/api/manager/settings/required-fields', '/api/manager/settings/booking-min-minutes']) {
    const rr = await req('GET', p, { cookie: ck });
    check('кабинет отвечает: ' + p, rr.status === 200, `HTTP ${rr.status}`);
  }
  // сохранение настройки обязательных полей
  const save = await req('POST', '/api/manager/settings/required-fields', { cookie: ck, body: { vehicleClass: false, loadType: true } });
  check('настройка обязательных полей сохраняется', save.status === 200 && save.json && save.json.success, `HTTP ${save.status}`);
  const pub = await req('GET', '/api/public/settings/required-fields');
  check('настройка видна публично', pub.status === 200 && pub.json && pub.json.vehicleClass === false, JSON.stringify(pub.json));

  // смена пароля: слабый отклоняется, нормальный принимается
  const weak = await req('POST', '/api/manager/password', { cookie: ck, body: { currentPassword: 'Sklad-Test-2026', newPassword: '1234' } });
  check('слабый новый пароль отклонён', weak.status === 400, `HTTP ${weak.status}: ${weak.body.slice(0,60)}`);
  const strong = await req('POST', '/api/manager/password', { cookie: ck, body: { currentPassword: 'Sklad-Test-2026', newPassword: 'Novyi-Parol-2026' } });
  check('смена пароля работает', strong.status === 200, `HTTP ${strong.status}`);
  const relog = await req('POST', '/api/manager/login', { body: { username: 'admin', password: 'Novyi-Parol-2026' } });
  check('вход с новым паролем работает', relog.status === 200, `HTTP ${relog.status}`);

  let bad = 0;
  for (const c of checks) { if (!c.ok) bad++; console.log((c.ok ? 'OK  ' : 'FAIL') + '  ' + c.l + (c.d ? '  [' + c.d + ']' : '')); }
  console.log('\n' + (checks.length - bad) + '/' + checks.length + ' проверок пройдено');
  process.exit(bad ? 1 : 0);
})();
