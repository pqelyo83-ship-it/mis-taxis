// Mis Taxis — app de una sola página (JavaScript sin compilación).
// Habla solo con estas rutas de la API: /api/auth, /api/taxis, /api/drivers,
// /api/trips, /api/expenses, /api/day-close, /api/change-pin.

(function () {
  'use strict';

  var token = localStorage.getItem('mt_token') || '';
  var user = null;
  try { user = JSON.parse(localStorage.getItem('mt_user') || 'null'); } catch (e) { user = null; }

  var loginView = document.getElementById('login-view');
  var appView = document.getElementById('app-view');
  var tabsEl = document.getElementById('tabs');
  var contentEl = document.getElementById('content');
  var messageEl = document.getElementById('message');
  var userNameEl = document.getElementById('user-name');
  var userBar = document.getElementById('user-bar');
  var loginError = document.getElementById('login-error');
  var currentTab = null;

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function money(n) {
    return '$' + Number(n || 0).toFixed(2);
  }

  function todayLocal() {
    var d = new Date();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return d.getFullYear() + '-' + m + '-' + day;
  }

  function showMessage(text, kind) {
    messageEl.textContent = text || '';
    messageEl.className = kind || '';
    if (text) {
      setTimeout(function () { messageEl.textContent = ''; messageEl.className = ''; }, 5000);
    }
  }

  async function api(path, method, body) {
    var headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    var options = { method: method || 'GET', headers: headers };
    if (body !== undefined) options.body = JSON.stringify(body);
    var res = await fetch(path, options);
    var data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!res.ok) {
      var msg = (data && data.error) ? data.error : 'Error ' + res.status;
      if (res.status === 401) { logout(); }
      throw new Error(msg);
    }
    return data;
  }

  function showLogin() {
    loginView.classList.remove('hidden');
    appView.classList.add('hidden');
    userBar.classList.add('hidden');
  }

  function showApp() {
    loginView.classList.add('hidden');
    appView.classList.remove('hidden');
    userBar.classList.remove('hidden');
    userNameEl.textContent = user.name + (user.role === 'admin' ? ' (admin)' : '');
    buildTabs();
  }

  function logout() {
    token = '';
    user = null;
    localStorage.removeItem('mt_token');
    localStorage.removeItem('mt_user');
    showLogin();
  }

  function driverTabs() {
    return [
      { id: 'trips', label: 'Mis viajes' },
      { id: 'new-trip', label: 'Nuevo viaje' },
      { id: 'expenses', label: 'Gastos' },
      { id: 'close', label: 'Cierre del día' },
      { id: 'pin', label: 'Mi PIN' },
    ];
  }

  function adminTabs() {
    return [
      { id: 'closes', label: 'Cierres' },
      { id: 'taxis', label: 'Taxis' },
      { id: 'drivers', label: 'Choferes' },
      { id: 'trips', label: 'Viajes' },
      { id: 'expenses', label: 'Gastos' },
      { id: 'pin', label: 'Mi PIN' },
    ];
  }

  function buildTabs() {
    var tabs = user.role === 'admin' ? adminTabs() : driverTabs();
    if (!currentTab) currentTab = tabs[0].id;
    tabsEl.innerHTML = tabs.map(function (t) {
      return '<button type="button" data-tab="' + t.id + '"' + (t.id === currentTab ? ' class="active"' : '') + '>' + esc(t.label) + '</button>';
    }).join('');
    tabsEl.querySelectorAll('button').forEach(function (btn) {
      btn.addEventListener('click', function () {
        currentTab = btn.getAttribute('data-tab');
        buildTabs();
      });
    });
    renderTab();
  }

  function renderTab() {
    contentEl.innerHTML = '<p class="muted">Cargando…</p>';
    var renderers = {
      'trips': renderTrips,
      'new-trip': renderNewTrip,
      'expenses': renderExpenses,
      'close': renderMyClose,
      'closes': renderAllCloses,
      'taxis': renderTaxis,
      'drivers': renderDrivers,
      'pin': renderPin,
    };
    var fn = renderers[currentTab];
    if (fn) fn().catch(function (err) { contentEl.innerHTML = '<p class="error">' + esc(err.message) + '</p>'; });
  }

  // ---------- Viajes ----------

  async function renderTrips() {
    var trips = await api('/api/trips');
    var title = user.role === 'admin' ? 'Todos los viajes' : 'Mis viajes';
    var rows = trips.map(function (t) {
      return '<div class="card"><p><strong>' + esc(t.trip_date) + '</strong> · ' + esc(t.driver_name || user.name) +
        (t.taxi_identifier ? ' · ' + esc(t.taxi_identifier) : '') + '</p>' +
        '<p>Entrada: ' + esc(t.entry_time) + ' · ' + esc(t.entry_km) + ' km — Salida: ' + esc(t.exit_time) + ' · ' + esc(t.exit_km) + ' km</p>' +
        '<p>Monto: ' + money(t.amount) + ' · %: ' + esc(t.pct_snapshot) + '% · Te quedás: ' + money(t.driver_keeps) + ' · Dueño: ' + money(t.owner_share) + '</p>' +
        '<button type="button" class="danger small" data-del-trip="' + t.id + '">Borrar</button></div>';
    }).join('');
    contentEl.innerHTML = '<h2>' + title + '</h2>' + (rows || '<p class="muted">Todavía no hay viajes.</p>');
    contentEl.querySelectorAll('[data-del-trip]').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        if (!confirm('¿Borrar este viaje?')) return;
        try {
          await api('/api/trips?id=' + btn.getAttribute('data-del-trip'), 'DELETE');
          showMessage('Viaje borrado.', 'ok');
          renderTab();
        } catch (e) { showMessage(e.message, 'error'); }
      });
    });
  }

  function tripFormHtml() {
    return '<h2>Nuevo viaje</h2><form id="trip-form">' +
      '<label>Fecha <input name="trip_date" type="date" value="' + todayLocal() + '" required></label>' +
      '<label>Hora de entrada <input name="entry_time" type="time" required></label>' +
      '<label>Kilometraje de entrada <input name="entry_km" type="number" step="0.01" min="0" required></label>' +
      '<label>Hora de salida <input name="exit_time" type="time" required></label>' +
      '<label>Kilometraje de salida <input name="exit_km" type="number" step="0.01" min="0" required></label>' +
      '<label>Monto del viaje (USD) <input name="amount" type="number" step="0.01" min="0" required></label>' +
      '<button type="submit">Guardar viaje</button></form>' +
      '<p class="muted">El % que se aplica es el que te puso el administrador. Si cambia después, tus viajes viejos no cambian.</p>';
  }

  async function renderNewTrip() {
    contentEl.innerHTML = tripFormHtml();
    document.getElementById('trip-form').addEventListener('submit', async function (ev) {
      ev.preventDefault();
      var f = ev.target;
      var body = {
        trip_date: f.trip_date.value,
        entry_time: f.entry_time.value,
        entry_km: f.entry_km.value,
        exit_time: f.exit_time.value,
        exit_km: f.exit_km.value,
        amount: f.amount.value,
      };
      try {
        var created = await api('/api/trips', 'POST', body);
        showMessage('Viaje guardado. Te quedás ' + money(created.driver_keeps) + ' y al dueño le van ' + money(created.owner_share) + '.', 'ok');
        currentTab = 'trips';
        buildTabs();
      } catch (e) { showMessage(e.message, 'error'); }
    });
  }

  // ---------- Gastos ----------

  async function renderExpenses() {
    var expenses = await api('/api/expenses');
    var title = user.role === 'admin' ? 'Todos los gastos' : 'Mis gastos';
    var formHtml = '';
    if (user.role === 'driver') {
      formHtml = '<h3>Nuevo gasto</h3><form id="expense-form">' +
        '<label>Fecha <input name="expense_date" type="date" value="' + todayLocal() + '" required></label>' +
        '<label>Tipo <select name="type"><option value="gasolina">Gasolina</option><option value="arreglos">Arreglos</option><option value="otros">Otros</option></select></label>' +
        '<label>Monto (USD) <input name="amount" type="number" step="0.01" min="0" required></label>' +
        '<label>Nota <input name="note" type="text" placeholder="Ej: nafta de la mañana"></label>' +
        '<button type="submit">Guardar gasto</button></form>';
    }
    var rows = expenses.map(function (g) {
      return '<div class="card"><p><strong>' + esc(g.expense_date) + '</strong> · ' + esc(g.type) + ' · ' + money(g.amount) +
        (g.driver_name ? ' · ' + esc(g.driver_name) : '') + '</p>' +
        (g.note ? '<p>' + esc(g.note) + '</p>' : '') +
        '<button type="button" class="danger small" data-del-expense="' + g.id + '">Borrar</button></div>';
    }).join('');
    contentEl.innerHTML = '<h2>' + title + '</h2>' + formHtml + '<h3>Lista</h3>' + (rows || '<p class="muted">Todavía no hay gastos.</p>');
    var form = document.getElementById('expense-form');
    if (form) {
      form.addEventListener('submit', async function (ev) {
        ev.preventDefault();
        try {
          await api('/api/expenses', 'POST', {
            expense_date: form.expense_date.value,
            type: form.type.value,
            amount: form.amount.value,
            note: form.note.value,
          });
          showMessage('Gasto guardado.', 'ok');
          renderTab();
        } catch (e) { showMessage(e.message, 'error'); }
      });
    }
    contentEl.querySelectorAll('[data-del-expense]').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        if (!confirm('¿Borrar este gasto?')) return;
        try {
          await api('/api/expenses?id=' + btn.getAttribute('data-del-expense'), 'DELETE');
          showMessage('Gasto borrado.', 'ok');
          renderTab();
        } catch (e) { showMessage(e.message, 'error'); }
      });
    });
  }

  // ---------- Cierre del día ----------

  function closeCardsHtml(closes) {
    return closes.map(function (c) {
      return '<div class="card"><h3>' + esc(c.driver_name) + ' · ' + esc(c.date) + '</h3>' +
        '<p>Viajes: ' + esc(c.trips_count) + '</p>' +
        '<p>Total recaudado</p><p class="big-number">' + money(c.total_collected) + '</p>' +
        '<p>Te quedás / Se queda el chofer: <strong>' + money(c.driver_keeps) + '</strong></p>' +
        '<p>Gastos del día: ' + money(c.expenses) + '</p>' +
        '<p>Debe entregar al dueño: <strong>' + money(c.handover_to_owner) + '</strong></p>' +
        '<p class="muted">Los gastos se descuentan de la parte del dueño.</p></div>';
    }).join('');
  }

  async function renderMyClose() {
    contentEl.innerHTML = '<h2>Cierre del día</h2><form id="close-form" class="row">' +
      '<label>Fecha <input name="date" type="date" value="' + todayLocal() + '" required></label>' +
      '<button type="submit">Ver cierre</button></form><div id="close-result"></div>';
    var form = document.getElementById('close-form');
    var result = document.getElementById('close-result');
    async function load() {
      try {
        var closes = await api('/api/day-close?date=' + encodeURIComponent(form.date.value));
        result.innerHTML = closes.length ? closeCardsHtml(closes) : '<p class="muted">Sin datos para esa fecha.</p>';
      } catch (e) { result.innerHTML = '<p class="error">' + esc(e.message) + '</p>'; }
    }
    form.addEventListener('submit', function (ev) { ev.preventDefault(); load(); });
    load();
  }

  async function renderAllCloses() {
    contentEl.innerHTML = '<h2>Cierres del día (todos los choferes)</h2><form id="close-form" class="row">' +
      '<label>Fecha <input name="date" type="date" value="' + todayLocal() + '" required></label>' +
      '<button type="submit">Ver cierres</button></form><div id="close-result"></div>';
    var form = document.getElementById('close-form');
    var result = document.getElementById('close-result');
    async function load() {
      try {
        var closes = await api('/api/day-close?date=' + encodeURIComponent(form.date.value));
        result.innerHTML = closes.length ? closeCardsHtml(closes) : '<p class="muted">Sin datos para esa fecha.</p>';
      } catch (e) { result.innerHTML = '<p class="error">' + esc(e.message) + '</p>'; }
    }
    form.addEventListener('submit', function (ev) { ev.preventDefault(); load(); });
    load();
  }

  // ---------- Taxis (admin) ----------

  async function renderTaxis() {
    var taxis = await api('/api/taxis');
    var rows = taxis.map(function (t) {
      return '<div class="card"><p><strong>' + esc(t.identifier) + '</strong> · ' + esc(t.plate) + ' · ' + esc(t.model) + ' · ' + esc(t.year || '') + ' · ' + (t.active ? 'Activo' : 'Inactivo') + '</p>' +
        '<div class="row"><button type="button" class="secondary small" data-edit-taxi="' + t.id + '">Editar</button>' +
        '<button type="button" class="danger small" data-del-taxi="' + t.id + '">Borrar</button></div></div>';
    }).join('');
    contentEl.innerHTML = '<h2>Taxis</h2><form id="taxi-form">' +
      '<input type="hidden" name="id">' +
      '<label>Identificador <input name="identifier" type="text" placeholder="Ej: TAXI-01" required></label>' +
      '<label>Patente <input name="plate" type="text" required></label>' +
      '<label>Modelo <input name="model" type="text"></label>' +
      '<label>Año <input name="year" type="number" min="1980" max="2100"></label>' +
      '<label><input name="active" type="checkbox" checked> Activo</label>' +
      '<button type="submit">Guardar taxi</button></form><h3>Lista</h3>' +
      (rows || '<p class="muted">Todavía no hay taxis.</p>');
    var form = document.getElementById('taxi-form');
    form.addEventListener('submit', async function (ev) {
      ev.preventDefault();
      var body = {
        identifier: form.identifier.value,
        plate: form.plate.value,
        model: form.model.value,
        year: form.year.value,
        active: form.active.checked,
      };
      try {
        if (form.id.value) { await api('/api/taxis?id=' + form.id.value, 'PUT', body); }
        else { await api('/api/taxis', 'POST', body); }
        showMessage('Taxi guardado.', 'ok');
        renderTab();
      } catch (e) { showMessage(e.message, 'error'); }
    });
    contentEl.querySelectorAll('[data-edit-taxi]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var t = taxis.find(function (x) { return String(x.id) === btn.getAttribute('data-edit-taxi'); });
        form.id.value = t.id;
        form.identifier.value = t.identifier;
        form.plate.value = t.plate;
        form.model.value = t.model || '';
        form.year.value = t.year || '';
        form.active.checked = !!t.active;
        window.scrollTo(0, 0);
      });
    });
    contentEl.querySelectorAll('[data-del-taxi]').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        if (!confirm('¿Borrar este taxi?')) return;
        try {
          await api('/api/taxis?id=' + btn.getAttribute('data-del-taxi'), 'DELETE');
          showMessage('Taxi borrado.', 'ok');
          renderTab();
        } catch (e) { showMessage(e.message, 'error'); }
      });
    });
  }

  // ---------- Choferes (admin) ----------

  async function renderDrivers() {
    var drivers = await api('/api/drivers');
    var taxis = await api('/api/taxis');
    var taxiOptions = '<option value="">Sin taxi</option>' + taxis.map(function (t) {
      return '<option value="' + t.id + '">' + esc(t.identifier) + ' · ' + esc(t.plate) + '</option>';
    }).join('');
    var rows = drivers.map(function (d) {
      return '<div class="card"><p><strong>' + esc(d.name) + '</strong> · ' + esc(d.phone) + ' · Taxi: ' + esc(d.taxi_identifier || '—') + ' · %: ' + esc(d.commission_pct) + ' · ' + (d.active ? 'Activo' : 'Inactivo') + '</p>' +
        '<div class="row"><button type="button" class="secondary small" data-edit-driver="' + d.id + '">Editar</button>' +
        (d.active ? '<button type="button" class="danger small" data-del-driver="' + d.id + '">Desactivar</button>' : '') + '</div></div>';
    }).join('');
    contentEl.innerHTML = '<h2>Choferes</h2><form id="driver-form">' +
      '<input type="hidden" name="id">' +
      '<label>Nombre <input name="name" type="text" required></label>' +
      '<label>Teléfono <input name="phone" type="text"></label>' +
      '<label>Taxi asignado <select name="taxi_id">' + taxiOptions + '</select></label>' +
      '<label>% del chofer <input name="commission_pct" type="number" step="0.01" min="0" max="100" required></label>' +
      '<label>PIN <input name="pin" type="password" inputmode="numeric" placeholder="Al editar, dejar vacío para no cambiarlo"></label>' +
      '<button type="submit">Guardar chofer</button></form><h3>Lista</h3>' +
      (rows || '<p class="muted">Todavía no hay choferes.</p>');
    var form = document.getElementById('driver-form');
    form.addEventListener('submit', async function (ev) {
      ev.preventDefault();
      var body = {
        name: form.name.value,
        phone: form.phone.value,
        taxi_id: form.taxi_id.value,
        commission_pct: form.commission_pct.value,
      };
      if (form.pin.value) body.pin = form.pin.value;
      try {
        if (form.id.value) {
          if (!form.pin.value) { /* sin cambio de PIN */ }
          await api('/api/drivers?id=' + form.id.value, 'PUT', body);
        } else {
          if (!form.pin.value) { showMessage('El PIN es obligatorio para un chofer nuevo.', 'error'); return; }
          await api('/api/drivers', 'POST', body);
        }
        showMessage('Chofer guardado.', 'ok');
        renderTab();
      } catch (e) { showMessage(e.message, 'error'); }
    });
    contentEl.querySelectorAll('[data-edit-driver]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var d = drivers.find(function (x) { return String(x.id) === btn.getAttribute('data-edit-driver'); });
        form.id.value = d.id;
        form.name.value = d.name;
        form.phone.value = d.phone || '';
        form.taxi_id.value = d.taxi_id || '';
        form.commission_pct.value = d.commission_pct;
        form.pin.value = '';
        window.scrollTo(0, 0);
      });
    });
    contentEl.querySelectorAll('[data-del-driver]').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        if (!confirm('¿Desactivar este chofer? Su historial se conserva.')) return;
        try {
          await api('/api/drivers?id=' + btn.getAttribute('data-del-driver'), 'DELETE');
          showMessage('Chofer desactivado.', 'ok');
          renderTab();
        } catch (e) { showMessage(e.message, 'error'); }
      });
    });
  }

  // ---------- Mi PIN ----------

  async function renderPin() {
    contentEl.innerHTML = '<h2>Cambiar mi PIN</h2><form id="pin-form">' +
      '<label>PIN nuevo <input name="new_pin" type="password" inputmode="numeric" required></label>' +
      '<label>Repetir PIN nuevo <input name="new_pin2" type="password" inputmode="numeric" required></label>' +
      '<button type="submit">Cambiar PIN</button></form>' +
      '<p class="muted">Después del cambio, entrá con el PIN nuevo.</p>';
    document.getElementById('pin-form').addEventListener('submit', async function (ev) {
      ev.preventDefault();
      var f = ev.target;
      if (f.new_pin.value !== f.new_pin2.value) { showMessage('Los PIN no coinciden.', 'error'); return; }
      try {
        await api('/api/change-pin', 'POST', { new_pin: f.new_pin.value });
        showMessage('PIN cambiado.', 'ok');
        f.reset();
      } catch (e) { showMessage(e.message, 'error'); }
    });
  }

  // ---------- Login ----------

  document.getElementById('login-form').addEventListener('submit', async function (ev) {
    ev.preventDefault();
    var pin = document.getElementById('pin-input').value;
    loginError.classList.add('hidden');
    try {
      var data = await api('/api/auth', 'POST', { pin: pin });
      token = data.token;
      user = data.user;
      localStorage.setItem('mt_token', token);
      localStorage.setItem('mt_user', JSON.stringify(user));
      document.getElementById('pin-input').value = '';
      currentTab = null;
      showApp();
    } catch (e) {
      loginError.textContent = e.message;
      loginError.classList.remove('hidden');
    }
  });

  document.getElementById('logout-btn').addEventListener('click', logout);

  if (token && user) { showApp(); } else { showLogin(); }
})();
