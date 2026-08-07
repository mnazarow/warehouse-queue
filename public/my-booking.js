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
})(window);
