// Проверка новой парольной схемы: вырезаем функции из server.js и гоняем их напрямую.
const fs = require('fs');
const crypto = require('crypto');
const src = fs.readFileSync('server.js', 'utf8');

function extract(name) {
  const i = src.indexOf('function ' + name + '(');
  if (i === -1) throw new Error('нет функции ' + name);
  let d = 0, started = false, j = i;
  for (; j < src.length; j++) {
    if (src[j] === '{') { d++; started = true; }
    else if (src[j] === '}') { d--; if (started && d === 0) { j++; break; } }
  }
  return src.slice(i, j);
}
const code = ['safeEqual', 'hashPassword', 'verifyPassword', 'validatePassword'].map(extract).join('\n');
const api = new Function('crypto', code + '; return {safeEqual,hashPassword,verifyPassword,validatePassword};')(crypto);

const checks = [];
const t = (label, got, want) => checks.push({ label, ok: JSON.stringify(got) === JSON.stringify(want), got, want });

// scrypt round-trip
const h = api.hashPassword('Sklad-2026-Xyz');
t('формат scrypt-хеша', /^scrypt\$16384\$8\$1\$[0-9a-f]{32}\$[0-9a-f]{128}$/.test(h), true);
t('верный пароль принят', api.verifyPassword('Sklad-2026-Xyz', h), true);
t('неверный пароль отклонён', api.verifyPassword('Sklad-2026-Xyy', h), false);
t('пустой пароль отклонён', api.verifyPassword('', h), false);
t('соль разная у одинаковых паролей', api.hashPassword('одинаковый') !== api.hashPassword('одинаковый'), true);

// обратная совместимость со старыми хешами
const legacy = crypto.createHash('sha256').update('admin123').digest('hex');
t('старый sha256 принят и помечен на перехеширование', api.verifyPassword('admin123', legacy), 'rehash');
t('старый sha256 с неверным паролем отклонён', api.verifyPassword('admin124', legacy), false);
t('пустой хеш в базе отклонён', api.verifyPassword('что угодно', ''), false);
t('битый scrypt-хеш отклонён', api.verifyPassword('x', 'scrypt$16384$8$1$zz$zz'), false);

// сравнение за постоянное время
t('safeEqual равные', api.safeEqual('abc', 'abc'), true);
t('safeEqual разные', api.safeEqual('abc', 'abd'), false);
t('safeEqual разной длины', api.safeEqual('abc', 'abcd'), false);
t('safeEqual null', api.safeEqual(null, ''), true);
t('safeEqual юникод', api.safeEqual('ключ-я', 'ключ-я'), true);

// требования к паролю
t('короткий пароль отклонён', typeof api.validatePassword('1234', 'admin'), 'string');
t('пароль с логином отклонён', typeof api.validatePassword('admin-parol-1', 'admin'), 'string');
t('слабый пароль отклонён', typeof api.validatePassword('admin123', 'petrov'), 'string');
t('нормальный пароль принят', api.validatePassword('Sklad-2026-Xyz', 'petrov'), null);

let bad = 0;
for (const c of checks) { if (!c.ok) bad++; console.log((c.ok ? 'OK  ' : 'FAIL') + '  ' + c.label + (c.ok ? '' : ` (получено ${JSON.stringify(c.got)}, ожидалось ${JSON.stringify(c.want)})`)); }

// скорость: scrypt не должен стопорить вход
const t0 = Date.now(); api.hashPassword('bench'); const ms = Date.now() - t0;
console.log(`\nвремя хеширования: ${ms} мс` + (ms < 500 ? ' — приемлемо для входа' : ' — СЛИШКОМ ДОЛГО'));
console.log(bad ? bad + ' ПРОВЕРОК ПРОВАЛЕНО' : 'ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ');
process.exit(bad ? 1 : 0);
