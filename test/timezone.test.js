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
console.log(bad ? bad + ' ПРОВЕРОК ПРОВАЛЕНО' : 'ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ');
process.exit(bad ? 1 : 0);
