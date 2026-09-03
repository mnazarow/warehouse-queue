// Проверка серверной логики часового пояса склада без запуска Express:
// вытаскиваем функции из server.js и подставляем фиктивную БД.
const fs = require('fs');
const src = fs.readFileSync('server.js', 'utf8');

function extract(name) {
  const i = src.indexOf('function ' + name + '(');
  if (i === -1) throw new Error('not found: ' + name);
  let depth = 0, started = false, j = i;
  for (; j < src.length; j++) {
    if (src[j] === '{') { depth++; started = true; }
    else if (src[j] === '}') { depth--; if (started && depth === 0) { j++; break; } }
  }
  return src.slice(i, j);
}

const code = [extract('appTzOffsetHours'), extract('warehouseTzOffsetHours'), extract('slotInstantMs')].join('\n');

const warehouses = {
  5: { id: 5, tz_offset: '' },      // пусто -> общий пояс
  6: { id: 6, tz_offset: '5' },     // Екатеринбург
  7: { id: 7, tz_offset: 'мусор' }, // некорректно -> общий
  8: { id: 8, tz_offset: '99' }     // вне диапазона -> общий
};
const db = {
  prepare(sql) {
    return {
      get(arg) {
        if (/FROM settings/.test(sql)) return { value: '3' };  // общий пояс = Москва
        if (/FROM warehouses/.test(sql)) return warehouses[arg] || null;
        return null;
      }
    };
  }
};
const process_ = { env: {} };
const f = new Function('db', 'process', code + '; return { appTzOffsetHours, warehouseTzOffsetHours, slotInstantMs };');
const api = f(db, process_);

const checks = [];
const eq = (label, got, want) => checks.push({ label, ok: got === want, got, want });

eq('глобальный пояс', api.appTzOffsetHours(), 3);
eq('склад без пояса -> общий', api.warehouseTzOffsetHours(5), 3);
eq('склад UTC+5', api.warehouseTzOffsetHours(6), 5);
eq('мусор в поясе -> общий', api.warehouseTzOffsetHours(7), 3);
eq('пояс вне диапазона -> общий', api.warehouseTzOffsetHours(8), 3);
eq('склад не указан -> общий', api.warehouseTzOffsetHours(null), 3);

// 09:00 15.09.2026 в Москве = 06:00 UTC; в Екатеринбурге (UTC+5) = 04:00 UTC
eq('слот московского склада', api.slotInstantMs('2026-09-15', '09:00', 5), Date.parse('2026-09-15T06:00:00Z'));
eq('слот склада UTC+5', api.slotInstantMs('2026-09-15', '09:00', 6), Date.parse('2026-09-15T04:00:00Z'));
eq('без склада — как раньше', api.slotInstantMs('2026-09-15', '09:00'), Date.parse('2026-09-15T06:00:00Z'));

// «Просрочено»: для склада UTC+5 окно наступает на 2 часа раньше по UTC
const diffHours = (api.slotInstantMs('2026-09-15', '09:00', 5) - api.slotInstantMs('2026-09-15', '09:00', 6)) / 3600000;
eq('разница Москва/Екатеринбург = 2 ч', diffHours, 2);

let bad = 0;
for (const c of checks) {
  if (!c.ok) bad++;
  console.log((c.ok ? 'OK  ' : 'FAIL') + '  ' + c.label + (c.ok ? '' : `  (получено ${c.got}, ожидалось ${c.want})`));
}
console.log(bad ? bad + ' ПРОВЕРОК ПРОВАЛЕНО' : 'ВСЕ ПРОВЕРКИ ПОЯСОВ ПРОЙДЕНЫ');
// итог по этому блоку подводится в конце файла

// ---------------------------------------------------------------------------
// Разбор сохранённых отметок времени (parseStampMs / stampToLocal)
// ---------------------------------------------------------------------------
(function () {
  const fs2 = require('fs');
  const src2 = fs2.readFileSync(require('path').join(__dirname, '..', 'server.js'), 'utf8');
  function cut(name) {
    const i = src2.indexOf('function ' + name + '(');
    if (i === -1) throw new Error('нет функции ' + name);
    let d = 0, st = false, j = i;
    for (; j < src2.length; j++) {
      if (src2[j] === '{') { d++; st = true; }
      else if (src2[j] === '}') { d--; if (st && d === 0) { j++; break; } }
    }
    return src2.slice(i, j);
  }
  const code2 = ['appTzOffsetHours', 'parseStampMs', 'stampToLocal', 'nowStampUtc'].map(cut).join('\n');
  const fakeDb = { prepare: () => ({ get: () => ({ value: '3' }) }) };
  const mk = env => new Function('db', 'process', code2 +
    ';return{parseStampMs,stampToLocal,nowStampUtc}')(fakeDb, { env });
  const api = mk({});

  const t2 = [];
  const eq2 = (label, got, want) => t2.push({ label, ok: got === want, got, want });

  const iso = ms => Number.isFinite(ms) ? new Date(ms).toISOString() : String(ms);

  eq2('формат SQLite (UTC без пояса)', iso(api.parseStampMs('2026-09-03 09:15:00')), '2026-09-03T09:15:00.000Z');
  eq2('формат PostgreSQL со смещением +03', iso(api.parseStampMs('2026-09-03 09:15:00.123456+03')), '2026-09-03T06:15:00.123Z');
  eq2('смещение с минутами +03:00', iso(api.parseStampMs('2026-09-03 09:15:00+03:00')), '2026-09-03T06:15:00.000Z');
  eq2('явный UTC с Z', iso(api.parseStampMs('2026-09-03T09:15:00Z')), '2026-09-03T09:15:00.000Z');
  eq2('пустое значение', Number.isFinite(api.parseStampMs('')), false);
  eq2('null', Number.isFinite(api.parseStampMs(null)), false);

  eq2('перевод UTC → Москва', api.stampToLocal('2026-09-03 09:15:00', 3), '2026-09-03 12:15');
  eq2('перевод UTC → UTC+7', api.stampToLocal('2026-09-03 09:15:00', 7), '2026-09-03 16:15');
  eq2('перевод через полночь', api.stampToLocal('2026-09-03 22:30:00', 3), '2026-09-04 01:30');
  eq2('пустая отметка остаётся пустой', api.stampToLocal(null, 3), '');
  eq2('отметка PostgreSQL тоже переводится верно', api.stampToLocal('2026-09-03 09:15:00+03', 3), '2026-09-03 09:15');

  // Режим «в базе местное время» не должен зависеть от пояса процесса
  const apiLocal = mk({ DB_TIMESTAMPS_LOCAL: '1' });
  eq2('DB_TIMESTAMPS_LOCAL: местное 09:15 МСК = 06:15 UTC',
      iso(apiLocal.parseStampMs('2026-09-03 09:15:00')), '2026-09-03T06:15:00.000Z');
  eq2('DB_TIMESTAMPS_LOCAL: обратно показывает то же время',
      apiLocal.stampToLocal('2026-09-03 09:15:00', 3), '2026-09-03 09:15');

  eq2('формат новой отметки', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(api.nowStampUtc()), true);
  eq2('новая отметка в UTC', Math.abs(api.parseStampMs(api.nowStampUtc()) - Date.now()) < 2000, true);

  let bad2 = 0;
  console.log('\n--- отметки времени ---');
  for (const c of t2) {
    if (!c.ok) bad2++;
    console.log((c.ok ? 'OK  ' : 'FAIL') + '  ' + c.label + (c.ok ? '' : `  (получено ${JSON.stringify(c.got)}, ожидалось ${JSON.stringify(c.want)})`));
  }
  if (bad2 || bad) { console.log((bad2 + bad) + ' ПРОВЕРОК ПРОВАЛЕНО'); process.exit(1); }
  console.log('ВСЕ ПРОВЕРКИ ОТМЕТОК ПРОЙДЕНЫ');
})();
