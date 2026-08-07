/*
 * Просмотр и отмена собственной записи клиентом.
 * Общий модуль для index.html и steps.html.
 *
 * Доступ подтверждается номером телефона, указанным при записи (проверка на
 * сервере, с лимитом попыток по IP). Записи, сделанные в этом браузере,
 * помечаются в сетке как «Ваша запись» и открываются без ввода телефона.
 */
(function (global) {
  const KEY = 'my_bookings';
  const KEEP_DAYS = 60;

  function todayStr() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function readAll() {
    let list = [];
    try {
      const raw = JSON.parse(localStorage.getItem(KEY) || '[]');
      if (Array.isArray(raw)) list = raw;
    } catch (e) { list = []; }
    // Чистим старые записи, чтобы хранилище не росло бесконечно.
    const limit = Date.now() - KEEP_DAYS * 86400000;
    return list.filter(function (b) {
      if (!b || typeof b.id === 'undefined') return false;
      const ms = Date.parse((b.date || todayStr()) + 'T00:00:00');
      return !Number.isFinite(ms) || ms >= limit;
    });
  }

  function writeAll(list) {
    try { localStorage.setItem(KEY, JSON.stringify(list.slice(-30))); } catch (e) {}
  }

  function remember(slotId, phone, date) {
    const id = Number(slotId);
    const list = readAll().filter(function (b) { return Number(b.id) !== id; });
    list.push({ id: id, phone: String(phone || '').replace(/\D/g, ''), date: date || todayStr() });
    writeAll(list);
  }

  function forget(slotId) {
    const id = Number(slotId);
    writeAll(readAll().filter(function (b) { return Number(b.id) !== id; }));
  }

  function phoneFor(slotId) {
    const id = Number(slotId);
    const found = readAll().find(function (b) { return Number(b.id) === id; });
    return found ? found.phone : '';
  }

  function mineIds() {
    const set = new Set();
    readAll().forEach(function (b) { set.add(Number(b.id)); });
    return set;
  }

  // Разметка окна вставляется скриптом — страницам достаточно подключить файл.
  const MARKUP = ''
    + '<div class="modal-overlay" id="myBookingModal">'
    + '  <div class="modal" style="max-width:480px">'
    + '    <h2 id="myBookingTitle">Ваша запись</h2>'
    + '    <div id="myBookingAuth">'
    + '      <p style="color:#4a5568;font-size:0.92rem;line-height:1.45;margin:0 0 14px">Это окно занято. Если запись ваша — введите номер телефона, который указывали при записи, и мы покажем её детали.</p>'
    + '      <div class="form-group">'
    + '        <label for="myBookingPhone">Телефон</label>'
    + '        <input type="tel" id="myBookingPhone" placeholder="+7 (9XX) XXX-XX-XX" autocomplete="tel">'
    + '      </div>'
    + '    </div>'
    + '    <div id="myBookingDetails" style="display:none">'
    + '      <ul class="mb-list" id="myBookingList"></ul>'
    + '      <div id="myBookingNote" style="display:none;margin-bottom:14px;padding:10px 12px;background:#fffaf0;border:1px solid #f6ad55;border-radius:8px;font-size:0.86rem;color:#7b341e;line-height:1.4"></div>'
    + '    </div>'
    + '    <div id="myBookingError" style="display:none;margin-bottom:14px;padding:10px 12px;background:#fff5f5;border:1px solid #fc8181;border-radius:8px;font-size:0.88rem;color:#c53030;line-height:1.4"></div>'
    + '    <div class="modal-actions">'
    + '      <button class="btn btn-secondary" type="button" id="myBookingClose">Закрыть</button>'
    + '      <button class="btn btn-primary" type="button" id="myBookingSubmit">Показать запись</button>'
    + '      <button class="btn btn-primary" type="button" id="myBookingCancel" style="display:none;background:#e53e3e">Отменить запись</button>'
    + '    </div>'
    + '  </div>'
    + '</div>';

  let currentSlotId = null;
  let busy = false;
  let onChange = function () {};

  const $ = function (id) { return document.getElementById(id); };

  function showError(msg) {
    const el = $('myBookingError');
    el.textContent = msg;
    el.style.display = 'block';
  }
  function hideError() { $('myBookingError').style.display = 'none'; }

  function setMode(mode) {
    const auth = mode === 'auth';
    $('myBookingAuth').style.display = auth ? 'block' : 'none';
    $('myBookingDetails').style.display = auth ? 'none' : 'block';
    $('myBookingSubmit').style.display = auth ? 'inline-block' : 'none';
    $('myBookingCancel').style.display = 'none';
  }

  function open(slotId) {
    currentSlotId = Number(slotId);
    hideError();
    setMode('auth');
    $('myBookingTitle').textContent = 'Ваша запись';
    $('myBookingPhone').value = '';
    $('myBookingModal').classList.add('open');
    const saved = phoneFor(currentSlotId);
    if (saved) {
      $('myBookingPhone').value = formatPhone(saved);
      load();
    } else {
      setTimeout(function () { $('myBookingPhone').focus(); }, 60);
    }
  }

  function close() {
    $('myBookingModal').classList.remove('open');
    currentSlotId = null;
  }

  function formatPhone(digits) {
    let v = String(digits || '').replace(/\D/g, '');
    if (!v) return '';
    if (!v.startsWith('7')) v = '7' + v;
    v = v.slice(0, 11);
    let m = '+7';
    if (v.length > 1) m += ' (' + v.slice(1, 4);
    if (v.length >= 5) m += ') ' + v.slice(4, 7);
    if (v.length >= 8) m += '-' + v.slice(7, 9);
    if (v.length >= 10) m += '-' + v.slice(9, 11);
    return m;
  }

  function row(k, v) {
    if (!v) return;
    const li = document.createElement('li');
    const ke = document.createElement('span');
    ke.className = 'k';
    ke.textContent = k;
    const ve = document.createElement('span');
    ve.className = 'v';
    ve.textContent = v;
    li.appendChild(ke);
    li.appendChild(ve);
    $('myBookingList').appendChild(li);
  }

  function renderBooking(b) {
    $('myBookingTitle').textContent = 'Ваша запись';
    const list = $('myBookingList');
    list.innerHTML = '';
    row('Дата', b.date);
    row('Время', b.time_start + ' – ' + b.time_end);
    row('Тип записи', b.typeLabel);
    row('Склад', b.warehouse_name + (b.warehouse_address ? ', ' + b.warehouse_address : ''));
    row('Статус', b.status);
    row('Имя', b.customer_name);
    row('Телефон', formatPhone(b.customer_phone) || b.customer_phone);
    row('Организация', b.customer_organization);
    row('Счета', (b.customer_account || '').split('\n').filter(function (x) { return x.trim(); }).join(', '));
    row('Комментарий', b.customer_comment);
    row('Класс машины', b.vehicle_class_name);
    row('Вид загрузки', b.load_type_name);
    row('Записан', b.booked_at);
    setMode('details');
    const note = $('myBookingNote');
    if (b.canCancel) {
      note.style.display = 'none';
    } else {
      note.textContent = b.cancelBlockReason || 'Отмена этой записи уже недоступна.';
      note.style.display = 'block';
    }
    $('myBookingCancel').style.display = b.canCancel ? 'inline-block' : 'none';
  }

  async function load() {
    if (busy || !currentSlotId) return;
    const digits = $('myBookingPhone').value.replace(/\D/g, '');
    if (digits.length !== 11) {
      showError('Введите номер телефона полностью');
      return;
    }
    hideError();
    busy = true;
    $('myBookingSubmit').disabled = true;
    try {
      const res = await fetch('/api/slots/' + currentSlotId + '/my-booking', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: digits })
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        // Телефон не подошёл — сохранённую привязку убираем, чтобы не
        // показывать «Ваша запись» на чужом слоте.
        if (res.status === 403 || res.status === 404) forget(currentSlotId);
        showError((data && data.error) || 'Не удалось открыть запись');
        setMode('auth');
        onChange();
        return;
      }
      remember(currentSlotId, digits, data.booking.date);
      renderBooking(data.booking);
      onChange();
    } catch (e) {
      showError('Ошибка соединения. Попробуйте ещё раз.');
    } finally {
      busy = false;
      $('myBookingSubmit').disabled = false;
    }
  }

  async function cancel() {
    if (busy || !currentSlotId) return;
    if (!confirm('Отменить запись? Освободившееся окно смогут занять другие клиенты.')) return;
    const digits = $('myBookingPhone').value.replace(/\D/g, '') || phoneFor(currentSlotId);
    busy = true;
    $('myBookingCancel').disabled = true;
    try {
      const res = await fetch('/api/slots/' + currentSlotId + '/my-booking/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: digits })
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        showError((data && data.error) || 'Не удалось отменить запись');
        return;
      }
      forget(currentSlotId);
      close();
      onChange();
      alert('Запись отменена. Окно снова свободно.');
    } catch (e) {
      showError('Ошибка соединения. Попробуйте ещё раз.');
    } finally {
      busy = false;
      $('myBookingCancel').disabled = false;
    }
  }

  // init({ onChange }) — onChange вызывается после изменений, чтобы страница
  // перерисовала сетку слотов.
  function init(options) {
    onChange = (options && options.onChange) || function () {};
    const holder = document.createElement('div');
    holder.innerHTML = MARKUP;
    document.body.appendChild(holder.firstChild);
    $('myBookingClose').addEventListener('click', close);
    $('myBookingSubmit').addEventListener('click', load);
    $('myBookingCancel').addEventListener('click', cancel);
    $('myBookingModal').addEventListener('click', function (e) {
      if (e.target === e.currentTarget) close();
    });
    const input = $('myBookingPhone');
    input.addEventListener('input', function () {
      hideError();
      this.value = formatPhone(this.value);
    });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); load(); }
    });
  }

  global.MyBooking = {
    init: init,
    open: open,
    close: close,
    remember: remember,
    forget: forget,
    mineIds: mineIds
  };

  /* ------------------------------------------------------------------
   * Блок «Как доехать»: адрес, описание и схема проезда склада.
   * Используется в окне «Вы записаны!» на обеих страницах записи.
   * ------------------------------------------------------------------ */
  global.WhDirections = {
    async render(warehouseId, container) {
      if (!container) return;
      container.innerHTML = '';
      container.style.display = 'none';
      if (!warehouseId) return;
      let d = null;
      try {
        const res = await fetch('/api/warehouses/' + Number(warehouseId) + '/directions');
        if (!res.ok) return;
        d = await res.json();
      } catch (e) { return; }
      if (!d || (!d.address && !d.directions && !d.mapScheme)) return;

      const wrap = document.createElement('div');
      wrap.style.cssText = 'margin:16px 0 4px;text-align:left;background:#f7fafc;border:1px solid #e2e8f0;border-radius:10px;padding:14px';

      const title = document.createElement('div');
      title.style.cssText = 'font-weight:700;color:#2d3748;margin-bottom:8px';
      title.textContent = 'Как доехать' + (d.name ? ' — ' + d.name : '');
      wrap.appendChild(title);

      if (d.address) {
        const addr = document.createElement('div');
        addr.style.cssText = 'font-size:0.9rem;color:#2d3748;margin-bottom:8px';
        addr.textContent = 'Адрес: ' + d.address;
        wrap.appendChild(addr);
      }

      if (d.directions) {
        const txt = document.createElement('div');
        txt.style.cssText = 'font-size:0.88rem;color:#4a5568;line-height:1.5;white-space:pre-wrap;margin-bottom:10px';
        txt.textContent = d.directions;
        wrap.appendChild(txt);
      }

      // --- Маршрут из Москвы: пошаговое описание + рисованная схема ---
      // Схема генерируется прямо здесь (SVG): Москва (МКАД) слева, шаги
      // маршрута по трассе, склад справа отмечен логотипом компании.
      const routeSteps = String(d.routeMoscow || '').split('\n').map(function (s) { return s.trim(); }).filter(function (s) { return s; });
      if (routeSteps.length || d.address) {
        const rm = document.createElement('div');
        rm.style.cssText = 'margin:2px 0 12px;padding:10px 12px;background:#fff;border:1px solid #e2e8f0;border-radius:8px';
        const rmTitle = document.createElement('div');
        rmTitle.style.cssText = 'font-weight:600;color:#2d3748;margin-bottom:6px';
        rmTitle.textContent = 'Как доехать из Москвы';
        rm.appendChild(rmTitle);
        if (routeSteps.length) {
          const ol = document.createElement('ol');
          ol.style.cssText = 'margin:0 0 8px 18px;padding:0;font-size:0.88rem;color:#4a5568;line-height:1.5';
          routeSteps.forEach(function (s) {
            const li = document.createElement('li');
            li.textContent = s;
            ol.appendChild(li);
          });
          rm.appendChild(ol);
        }
        rm.appendChild(buildMoscowScheme(routeSteps, d.name));
        if (d.address) {
          const link = document.createElement('a');
          link.href = 'https://yandex.ru/maps/?rtext=' + encodeURIComponent('Москва') + '~' + encodeURIComponent(d.address);
          link.target = '_blank';
          link.rel = 'noopener';
          link.style.cssText = 'font-size:0.88rem';
          link.textContent = 'Построить маршрут из Москвы в Яндекс.Картах';
          rm.appendChild(link);
        }
        wrap.appendChild(rm);
      }

      if (d.mapScheme && /^data:image\//.test(d.mapScheme)) {
        const fig = document.createElement('div');
        fig.style.cssText = 'margin-bottom:10px';
        const cap = document.createElement('div');
        cap.style.cssText = 'font-size:0.8rem;color:#718096;margin-bottom:4px';
        cap.textContent = 'Схема проезда (нажмите, чтобы увеличить):';
        const img = document.createElement('img');
        img.src = d.mapScheme;
        img.alt = 'Схема проезда';
        img.style.cssText = 'max-width:100%;border:1px solid #e2e8f0;border-radius:8px;display:block;cursor:zoom-in';
        img.addEventListener('click', function () {
          // Полноэкранный просмотр схемы
          const ov = document.createElement('div');
          ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.85);z-index:10005;display:flex;align-items:center;justify-content:center;cursor:zoom-out;padding:16px';
          const big = document.createElement('img');
          big.src = d.mapScheme;
          big.style.cssText = 'max-width:100%;max-height:100%;border-radius:8px';
          ov.appendChild(big);
          ov.addEventListener('click', function () { ov.remove(); });
          document.body.appendChild(ov);
        });
        fig.appendChild(cap);
        fig.appendChild(img);
        wrap.appendChild(fig);
      }

      if (d.address) {
        const links = document.createElement('div');
        links.style.cssText = 'display:flex;gap:14px;flex-wrap:wrap;font-size:0.88rem';
        const ya = document.createElement('a');
        ya.href = 'https://yandex.ru/maps/?rtext=~' + encodeURIComponent(d.address);
        ya.target = '_blank';
        ya.rel = 'noopener';
        ya.textContent = 'Маршрут в Яндекс.Картах';
        const gis = document.createElement('a');
        gis.href = 'https://2gis.ru/search/' + encodeURIComponent(d.address);
        gis.target = '_blank';
        gis.rel = 'noopener';
        gis.textContent = 'Найти в 2ГИС';
        links.appendChild(ya);
        links.appendChild(gis);
        wrap.appendChild(links);
      }

      container.appendChild(wrap);
      container.style.display = 'block';
    }
  };

  /* ------------------------------------------------------------------
   * Схема «Москва → склад» (SVG). Склад отмечен логотипом компании
   * (/logo.png). Шаги маршрута подписываются вдоль трассы (до 4 штук).
   * ------------------------------------------------------------------ */
  function buildMoscowScheme(steps, warehouseName) {
    const NS = 'http://www.w3.org/2000/svg';
    const W = 640, H = 190;
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'Схема проезда из Москвы до склада');
    svg.style.cssText = 'width:100%;height:auto;display:block;margin:2px 0 8px;background:#f0f7ee;border:1px solid #dbe7d5;border-radius:8px';
    const el = function (tag, attrs, text) {
      const n = document.createElementNS(NS, tag);
      for (const k in attrs) n.setAttribute(k, attrs[k]);
      if (text !== undefined) n.textContent = text;
      return n;
    };

    // Москва: двойное кольцо (МКАД) + подпись
    const mx = 70, my = 88;
    svg.appendChild(el('circle', { cx: mx, cy: my, r: 34, fill: '#fde9e7', stroke: '#e05252', 'stroke-width': 3 }));
    svg.appendChild(el('circle', { cx: mx, cy: my, r: 20, fill: '#fff', stroke: '#e05252', 'stroke-width': 2, 'stroke-dasharray': '4 3' }));
    svg.appendChild(el('text', { x: mx, y: my + 4, 'text-anchor': 'middle', 'font-size': 11, 'font-weight': 700, fill: '#9b2c2c', 'font-family': 'sans-serif' }, 'МОСКВА'));
    svg.appendChild(el('text', { x: mx, y: my + 48, 'text-anchor': 'middle', 'font-size': 9, fill: '#718096', 'font-family': 'sans-serif' }, 'МКАД'));

    // Склад: рамка + логотип + подпись
    const wx = W - 86, wy = 78;
    svg.appendChild(el('rect', { x: wx - 34, y: wy - 34, width: 68, height: 68, rx: 10, fill: '#fff', stroke: '#3182ce', 'stroke-width': 2.5 }));
    const logo = el('image', { x: wx - 26, y: wy - 26, width: 52, height: 52, href: '/logo.png', preserveAspectRatio: 'xMidYMid meet' });
    logo.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', '/logo.png');
    svg.appendChild(logo);
    // Флажок-указатель над складом
    svg.appendChild(el('path', { d: 'M ' + wx + ' ' + (wy - 52) + ' l 0 16 M ' + wx + ' ' + (wy - 52) + ' l 14 5 l -14 5', fill: 'none', stroke: '#e05252', 'stroke-width': 2, 'stroke-linejoin': 'round' }));
    const wName = String(warehouseName || 'Склад');
    svg.appendChild(el('text', { x: wx, y: wy + 48, 'text-anchor': 'middle', 'font-size': 10, 'font-weight': 700, fill: '#2c5282', 'font-family': 'sans-serif' },
      wName.length > 18 ? wName.slice(0, 17) + '…' : wName));

    // Трасса: полотно + осевая разметка
    const x1 = mx + 40, x2 = wx - 44;
    svg.appendChild(el('path', { d: 'M ' + x1 + ' ' + my + ' C ' + (x1 + 90) + ' ' + (my - 34) + ', ' + (x2 - 90) + ' ' + (my + 26) + ', ' + x2 + ' ' + (wy + 4), fill: 'none', stroke: '#8f9aa8', 'stroke-width': 12, 'stroke-linecap': 'round' }));
    svg.appendChild(el('path', { d: 'M ' + x1 + ' ' + my + ' C ' + (x1 + 90) + ' ' + (my - 34) + ', ' + (x2 - 90) + ' ' + (my + 26) + ', ' + x2 + ' ' + (wy + 4), fill: 'none', stroke: '#fff', 'stroke-width': 2, 'stroke-dasharray': '10 8' }));
    // Стрелка направления у склада
    svg.appendChild(el('path', { d: 'M ' + (x2 - 4) + ' ' + (wy - 6) + ' l 10 9 l -13 5 z', fill: '#8f9aa8' }));

    // Отметки шагов вдоль трассы (до 4)
    const marks = steps.slice(0, 4);
    marks.forEach(function (s, i) {
      const t = (i + 1) / (marks.length + 1);
      // Точка на кривой Безье (приближение по той же кривой)
      const bez = function (p0, p1, p2, p3, tt) {
        const u = 1 - tt;
        return u * u * u * p0 + 3 * u * u * tt * p1 + 3 * u * tt * tt * p2 + tt * tt * tt * p3;
      };
      const px = bez(x1, x1 + 90, x2 - 90, x2, t);
      const py = bez(my, my - 34, my + 26, wy + 4, t);
      svg.appendChild(el('circle', { cx: px, cy: py, r: 9, fill: '#3182ce', stroke: '#fff', 'stroke-width': 2 }));
      svg.appendChild(el('text', { x: px, y: py + 3.5, 'text-anchor': 'middle', 'font-size': 10, 'font-weight': 700, fill: '#fff', 'font-family': 'sans-serif' }, String(i + 1)));
      // Короткая подпись шага (сверху/снизу попеременно)
      const short = s.length > 30 ? s.slice(0, 29) + '…' : s;
      const above = i % 2 === 0;
      svg.appendChild(el('text', { x: px, y: py + (above ? -16 : 24), 'text-anchor': 'middle', 'font-size': 8.5, fill: '#4a5568', 'font-family': 'sans-serif' }, short));
    });
    return svg;
  }

  /* ------------------------------------------------------------------
   * Тема Hi-Tech: переключатель в углу страницы, выбор запоминается
   * в браузере и применяется до отрисовки (скрипт подключён в <body>).
   * ------------------------------------------------------------------ */
  (function () {
    var KEY = 'ui_theme';
    var saved = '';
    try { saved = localStorage.getItem(KEY) || ''; } catch (e) {}
    if (saved === 'hitech') document.body.classList.add('theme-hitech');

    function makeBtn() {
      var btn = document.createElement('button');
      btn.id = 'themeToggle';
      btn.type = 'button';
      btn.title = 'Переключить тему оформления';
      function label() {
        btn.textContent = document.body.classList.contains('theme-hitech') ? '☀ Классическая' : '⚡ Hi-Tech';
      }
      btn.addEventListener('click', function () {
        document.body.classList.toggle('theme-hitech');
        try { localStorage.setItem(KEY, document.body.classList.contains('theme-hitech') ? 'hitech' : 'classic'); } catch (e) {}
        label();
      });
      label();
      document.body.appendChild(btn);
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', makeBtn);
    else makeBtn();
  })();
})(window);
