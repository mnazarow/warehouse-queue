// Сквозные проверки безопасности по реальным HTTP-запросам к server.js.
const http = require('http');
const BASE = { host: '127.0.0.1', port: 4998 };

function req(method, path, { body, headers = {}, cookie } = {}) {
  return new Promise((resolve) => {
    const data = body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const h = Object.assign({}, headers);
    if (data !== null && !h['Content-Type']) h['Content-Type'] = 'application/json';
    if (data !== null) h['Content-Length'] = Buffer.byteLength(data);
    if (cookie) h['Cookie'] = cookie;
    const r = http.request({ ...BASE, method, path, headers: h, timeout: 8000 }, (res) => {
      let b = '';
      res.on('data', c => b += c);
      res.on('end', () => {
        let json = null; try { json = JSON.parse(b); } catch (e) {}
        resolve({ status: res.statusCode, headers: res.headers, body: b, json,
                  cookie: (res.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ') });
      });
    });
    r.on('error', e => resolve({ status: 0, body: String(e.message), json: null, headers: {} }));
    r.on('timeout', () => { r.destroy(); resolve({ status: 0, body: 'timeout', json: null, headers: {} }); });
    if (data !== null) r.write(data);
    r.end();
  });
}

const checks = [];
const check = (label, ok, detail = '') => { checks.push({ label, ok, detail }); };

(async () => {
  // 1. Вход: верный пароль
  let r = await req('POST', '/api/manager/login', { body: { username: 'admin', password: 'Sklad-Test-2026' } });
  check('вход с верным паролем', r.status === 200 && r.json && r.json.success, `HTTP ${r.status}`);
  const goodCookie = r.cookie;

  // 2. Сессия: смена идентификатора при входе (session fixation)
  const anon = await req('GET', '/api/captcha');
  const anonCookie = anon.cookie;
  const r2 = await req('POST', '/api/manager/login', { body: { username: 'admin', password: 'Sklad-Test-2026' }, cookie: anonCookie });
  check('идентификатор сессии меняется при входе', !!r2.cookie && r2.cookie !== anonCookie,
        `было ${anonCookie || '-'} стало ${r2.cookie || '-'}`);
  const me = await req('GET', '/api/manager/me', { cookie: anonCookie });
  check('старый (донатный) cookie не даёт доступ', me.status === 401, `HTTP ${me.status}`);

  // 3. Перебор пароля блокируется (подбираем отдельную учётку, чтобы не
  // блокировать admin для остальных проверок)
  let blocked = false, attempts = 0;
  for (let i = 0; i < 9; i++) {
    const rr = await req('POST', '/api/manager/login', { body: { username: 'perebor', password: 'wrong' + i } });
    attempts++;
    if (rr.status === 429) { blocked = true; break; }
  }
  check('перебор пароля блокируется', blocked, `блокировка после ${attempts} попыток`);

  // 3a. Блокировка одной учётки не мешает работать другим (нет отказа в обслуживании)
  const other = await req('POST', '/api/manager/login', { body: { username: 'admin', password: 'Sklad-Test-2026' } });
  check('блокировка точечная — вход другой учётки работает', other.status === 200, `HTTP ${other.status}`);

  // 4. Доступ к кабинету без сессии
  for (const p of ['/api/manager/me', '/api/manager/drivers', '/api/manager/logs', '/api/manager/list']) {
    const rr = await req('GET', p);
    check('без входа закрыт ' + p, rr.status === 401 || rr.status === 403, `HTTP ${rr.status}`);
  }

  // 5. Заголовки безопасности
  const pub = await req('GET', '/api/warehouses');
  check('X-Frame-Options', pub.headers['x-frame-options'] === 'SAMEORIGIN', pub.headers['x-frame-options'] || 'нет');
  check('X-Content-Type-Options', pub.headers['x-content-type-options'] === 'nosniff', pub.headers['x-content-type-options'] || 'нет');
  check('X-Powered-By скрыт', !pub.headers['x-powered-by'], pub.headers['x-powered-by'] || 'скрыт');

  // 6. CORS: кабинет не открыт чужому origin, публичная часть открыта
  const corsMgr = await req('GET', '/api/manager/me', { headers: { Origin: 'https://evil.example' } });
  check('CORS: кабинет не отдаёт Allow-Origin чужому сайту', !corsMgr.headers['access-control-allow-origin'],
        corsMgr.headers['access-control-allow-origin'] || 'нет заголовка');
  check('CORS: публичная часть доступна', pub.headers['access-control-allow-origin'] === '*',
        pub.headers['access-control-allow-origin'] || 'нет');

  // 7. Дата слотов: мусор и далёкие даты отклоняются
  for (const d of ['2026-13-45', 'не-дата', '9999-01-01', '1999-01-01', "2026-01-01' OR 1=1--"]) {
    const rr = await req('GET', '/api/slots?date=' + encodeURIComponent(d) + '&type=small');
    check('дата отклонена: ' + d, rr.status === 400, `HTTP ${rr.status}`);
  }
  const okDate = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
  const rok = await req('GET', '/api/slots?date=' + okDate + '&type=small');
  check('корректная дата принимается', rok.status === 200, `HTTP ${rok.status}`);

  // 8. Размер тела запроса
  const big = 'x'.repeat(300 * 1024);
  const rbig = await req('POST', '/api/visit', { body: { junk: big } });
  check('крупное тело на публичном маршруте отклонено', rbig.status === 413 || rbig.status === 400 || rbig.status === 0,
        `HTTP ${rbig.status}`);

  // 9. Ключ внешнего API
  const ext = await req('GET', '/api/ext/v1/ping', { headers: { 'X-Api-Key': 'guessed-key-123' } });
  check('внешнее API без верного ключа закрыто', ext.status === 401 || ext.status === 503, `HTTP ${ext.status}`);

  // 10. Токен 1С
  const c1 = await req('GET', '/api/integration/1c/orders?token=' + encodeURIComponent('неверный'));
  check('интеграция 1С без верного токена закрыта', c1.status === 401 || c1.status === 403, `HTTP ${c1.status}`);

  // 11. Неизвестный /api маршрут отдаёт JSON, а не HTML со стеком
  const nf = await req('GET', '/api/' + encodeURIComponent('такого-нет'));
  check('404 по /api отдаёт JSON без стека', nf.status === 404 && nf.json && !/at .*server\.js/.test(nf.body), `HTTP ${nf.status}`);

  // 12. Битый JSON не роняет и не светит стек
  const badJson = await req('POST', '/api/manager/login', { body: '{"username": ' , headers: { 'Content-Type': 'application/json' } });
  check('битый JSON → 400 без стека', badJson.status === 400 && !/server\.js/.test(badJson.body), `HTTP ${badJson.status}: ${badJson.body.slice(0,60)}`);

  // 13. Выход завершает сессию
  const logout = await req('POST', '/api/manager/logout', { cookie: goodCookie });
  const afterLogout = await req('GET', '/api/manager/me', { cookie: goodCookie });
  check('после выхода сессия недействительна', logout.status === 200 && afterLogout.status === 401,
        `logout ${logout.status}, me ${afterLogout.status}`);

  // 14. Сервер жив после всех проверок
  const alive = await req('GET', '/api/warehouses');
  check('сервер работает после всех проверок', alive.status === 200, `HTTP ${alive.status}`);

  let bad = 0;
  for (const c of checks) { if (!c.ok) bad++; console.log((c.ok ? 'OK  ' : 'FAIL') + '  ' + c.label + (c.detail ? '  [' + c.detail + ']' : '')); }
  console.log('\n' + (checks.length - bad) + '/' + checks.length + ' проверок пройдено');
  process.exit(bad ? 1 : 0);
})();
