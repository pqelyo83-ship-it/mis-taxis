// Mis Taxis — app de una sola página (JavaScript sin compilación).
// Habla solo con estas rutas de la API: /api/auth, /api/login-users,
// /api/company, /api/taxis, /api/drivers,
// /api/trips, /api/expenses, /api/day-close, /api/change-pin, /api/report,
// /api/shifts.

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

  function daysAgoLocal(n) {
    var d = new Date();
    d.setDate(d.getDate() - n);
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return d.getFullYear() + '-' + m + '-' + day;
  }

  function nowTimeLocal() {
    var d = new Date();
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  // ¿Es hora de noche según el horario de la empresa? Soporta rangos que
  // cruzan la medianoche (por ejemplo 22 a 6).
  function isNightHour(hour, start, end) {
    if (start === end) return false;
    if (start < end) return hour >= start && hour < end;
    return hour >= start || hour < end;
  }

  // Ubicación del teléfono (pide permiso al navegador). Si no hay permiso
  // o no hay GPS, llama con null: la ubicación es opcional, nunca bloquea.
  function captureLocation(cb) {
    if (!navigator.geolocation) { cb(null); return; }
    var done = false;
    function finish(v) { if (!done) { done = true; cb(v); } }
    try {
      navigator.geolocation.getCurrentPosition(
        function (pos) { finish({ lat: pos.coords.latitude, lng: pos.coords.longitude }); },
        function () { finish(null); },
        { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 }
      );
      setTimeout(function () { finish(null); }, 9000);
    } catch (e) { finish(null); }
  }

  function mapLink(lat, lng, label) {
    if (lat === null || lat === undefined || lng === null || lng === undefined) return '';
    return ' · <a href="https://maps.google.com/?q=' + encodeURIComponent(lat + ',' + lng) + '" target="_blank" rel="noopener">' + (label || 'Mapa') + '</a>';
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
    // El link de un dueño (?login=owner) muestra SOLO el ingreso con email
    // y PIN: no se carga ni se muestra la lista de empresas, así el dueño
    // no ve los nombres de las otras empresas.
    var params = new URLSearchParams(window.location.search);
    var ownerOnly = params.get('login') === 'owner';
    document.getElementById('pin-login-block').classList.toggle('hidden', ownerOnly);
    document.getElementById('owner-login-block').classList.toggle('hidden', !ownerOnly);
    if (!ownerOnly) loadCompanies();
  }

  // Empresas para la pantalla de ingreso. Si hay una sola, se elige sola;
  // ?company=CODIGO en la URL preselecciona esa empresa.
  async function loadCompanies() {
    var select = document.getElementById('company-select');
    if (!select) return;
    try {
      var companies = await api('/api/company?list=1');
      if (!companies || !companies.length) {
        select.innerHTML = '<option value="">Sin empresas</option>';
        return;
      }
      select.innerHTML = companies.map(function (c) {
        return '<option value="' + c.id + '">' + esc(c.name) + ' (' + esc(c.code) + ')</option>';
      }).join('');
      var params = new URLSearchParams(window.location.search);
      var code = params.get('company');
      if (code) {
        var found = companies.find(function (c) { return c.code === code; });
        if (found) select.value = found.id;
      }
      loadLoginUsers(select.value);
    } catch (e) {
      select.innerHTML = '<option value="">No se pudo cargar la lista</option>';
    }
  }

  // Carga los nombres para la pantalla de ingreso (sin PINes ni hashes),
  // solo de la empresa seleccionada.
  async function loadLoginUsers(companyId) {
    var select = document.getElementById('user-select');
    if (!select) return;
    if (!companyId) {
      select.innerHTML = '<option value="">Elegí una empresa</option>';
      return;
    }
    try {
      var users = await api('/api/login-users?company_id=' + encodeURIComponent(companyId));
      if (!users || !users.length) {
        select.innerHTML = '<option value="">Sin usuarios activos</option>';
        return;
      }
      select.innerHTML = users.map(function (u) {
        return '<option value="' + u.id + '">' + esc(u.name) + ((u.role === 'admin' || u.role === 'superadmin') ? ' (admin)' : '') + '</option>';
      }).join('');
    } catch (e) {
      select.innerHTML = '<option value="">No se pudo cargar la lista</option>';
    }
  }

  function showApp() {
    loginView.classList.add('hidden');
    appView.classList.remove('hidden');
    userBar.classList.remove('hidden');
    var params = new URLSearchParams(window.location.search);
    // Vista del encargado de la app (?panel=empresas): solo dueños y links,
    // sin pestañas operativas (reportes, viajes, choferes, etc.).
    if (user.is_superadmin && params.get('panel') === 'empresas') {
      userNameEl.textContent = user.name + ' · dueño de la app';
      tabsEl.innerHTML = '';
      currentTab = 'empresas';
      renderTab();
      return;
    }
    userNameEl.textContent = user.name + (user.role === 'admin' ? ' (admin)' : '') +
      (user.company_name ? ' · ' + user.company_name : '') +
      (user.is_superadmin ? ' · dueño de la app' : '');
    if (!currentTab) {
      if (params.get('panel') === 'empresas' && user.is_superadmin) currentTab = 'empresas';
    }
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
      { id: 'day', label: 'Mi día' },
      { id: 'trips', label: 'Mis viajes' },
      { id: 'new-trip', label: 'Nuevo viaje' },
      { id: 'expenses', label: 'Gastos' },
      { id: 'close', label: 'Cierre del día' },
      { id: 'pin', label: 'Mi PIN' },
    ];
  }

  function adminTabs() {
    var tabs = [
      { id: 'report', label: 'Reportes' },
      { id: 'closes', label: 'Cierres' },
      { id: 'taxis', label: 'Taxis' },
      { id: 'drivers', label: 'Choferes' },
      { id: 'trips', label: 'Viajes' },
      { id: 'expenses', label: 'Gastos' },
      { id: 'company', label: 'Mi empresa' },
      { id: 'methods', label: 'Métodos de pago' },
    ];
    if (user.is_superadmin) tabs.push({ id: 'empresas', label: 'Empresas' });
    tabs.push({ id: 'pin', label: 'Mi PIN' });
    return tabs;
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
      'day': renderDay,
      'trips': renderTrips,
      'new-trip': renderNewTrip,
      'expenses': renderExpenses,
      'close': renderMyClose,
      'closes': renderAllCloses,
      'report': renderReport,
      'taxis': renderTaxis,
      'drivers': renderDrivers,
      'company': renderCompany,
      'methods': renderPaymentMethods,
      'empresas': renderEmpresas,
      'pin': renderPin,
    };
    var fn = renderers[currentTab];
    if (fn) fn().catch(function (err) { contentEl.innerHTML = '<p class="error">' + esc(err.message) + '</p>'; });
  }

  // ---------- Mi día (jornada) ----------
  // Al entrar, el chofer carga hora y km de entrada (y el taxi del día).
  // Al terminar, pulsa "Cerrar el día" y carga hora y km de cierre.
  // Después del cierre se muestra el resumen del día.

  async function renderDay() {
    var taxis = [];
    try { taxis = await api('/api/taxis'); } catch (e) { taxis = []; }
    contentEl.innerHTML = '<h2>Mi día</h2>' +
      '<label>Fecha <input id="day-date" type="date" value="' + todayLocal() + '"></label>' +
      '<div id="day-state"></div>';
    var dateInput = document.getElementById('day-date');
    var stateEl = document.getElementById('day-state');

    function taxiSelect(selectedId) {
      return '<label>Taxi del día <select name="taxi_id">' + taxis.map(function (t) {
        return '<option value="' + t.id + '"' + (selectedId === t.id ? ' selected' : '') + '>' + esc(t.identifier) + '</option>';
      }).join('') + '</select></label>';
    }

    async function load() {
      var date = dateInput.value;
      try {
        var shifts = await api('/api/shifts?date=' + encodeURIComponent(date));
        var s = shifts && shifts[0] ? shifts[0] : null;
        if (!s) {
          // Sin jornada: entrada del día. La hora se precarga con la actual
          // y la ubicación se captura del teléfono (si da permiso).
          var entryGeo = null;
          stateEl.innerHTML = '<form id="day-start-form" class="row">' + taxiSelect(user.taxi_id) +
            '<label>Hora de entrada <input name="entry_time" type="time" value="' + nowTimeLocal() + '" required></label>' +
            '<label>Km del auto <input name="entry_km" type="number" step="0.01" min="0" required></label>' +
            '<button type="submit">Empezar día</button></form>' +
            '<p class="muted" id="day-geo-status">Detectando ubicación…</p>' +
            '<p class="muted">Al entrar, cargá la hora y el kilometraje con el que agarrás el auto.</p>';
          captureLocation(function (geo) {
            entryGeo = geo;
            var st = document.getElementById('day-geo-status');
            if (st) st.textContent = geo ? 'Ubicación de entrada detectada.' : 'Sin ubicación (revisá los permisos del navegador).';
          });
          document.getElementById('day-start-form').addEventListener('submit', async function (ev) {
            ev.preventDefault();
            var f = ev.target;
            var body = {
              shift_date: date,
              taxi_id: f.taxi_id.value,
              entry_time: f.entry_time.value,
              entry_km: f.entry_km.value,
              exit_time: null,
              exit_km: null,
            };
            if (entryGeo) { body.entry_lat = entryGeo.lat; body.entry_lng = entryGeo.lng; }
            try {
              await api('/api/shifts', 'POST', body);
              showMessage('Día empezado.', 'ok');
              load();
            } catch (e) { showMessage(e.message, 'error'); }
          });
        } else if (!s.exit_time && s.exit_km === null) {
          // Jornada abierta: botón para cerrar el día. Hora actual precargada
          // y ubicación de salida del teléfono (si da permiso).
          var exitGeo = null;
          stateEl.innerHTML = '<p>Taxi del día: <strong>' + esc(s.taxi_identifier || '—') + '</strong> · Entrada: ' + esc(s.entry_time) + ' · ' + esc(s.entry_km) + ' km' + mapLink(s.entry_lat, s.entry_lng, 'Ver entrada en mapa') + '</p>' +
            '<form id="day-close-form" class="row">' +
            '<label>Hora de cierre <input name="exit_time" type="time" value="' + nowTimeLocal() + '" required></label>' +
            '<label>Km con el que queda el auto <input name="exit_km" type="number" step="0.01" min="0" required></label>' +
            '<button type="submit">Cerrar el día</button></form>' +
            '<p class="muted" id="day-geo-status">Detectando ubicación…</p>';
          captureLocation(function (geo) {
            exitGeo = geo;
            var st = document.getElementById('day-geo-status');
            if (st) st.textContent = geo ? 'Ubicación de salida detectada.' : 'Sin ubicación (revisá los permisos del navegador).';
          });
          document.getElementById('day-close-form').addEventListener('submit', async function (ev) {
            ev.preventDefault();
            var f = ev.target;
            var body = {
              shift_date: date,
              taxi_id: s.taxi_id,
              entry_time: s.entry_time,
              entry_km: s.entry_km,
              exit_time: f.exit_time.value,
              exit_km: f.exit_km.value,
            };
            if (exitGeo) { body.exit_lat = exitGeo.lat; body.exit_lng = exitGeo.lng; }
            try {
              await api('/api/shifts', 'POST', body);
              showMessage('Día cerrado.', 'ok');
              load();
            } catch (e) { showMessage(e.message, 'error'); }
          });
        } else {
          // Día cerrado: resumen + cierre.
          var closes = await api('/api/day-close?date=' + encodeURIComponent(date));
          var kmLine = (s.km_driven !== null && s.km_driven !== undefined)
            ? ' · Km recorridos: <strong>' + esc(s.km_driven) + ' km</strong>' : '';
          var exitLine = (s.exit_time ? ' · Cierre: ' + esc(s.exit_time) : '') +
            (s.exit_km !== null ? ' · ' + esc(s.exit_km) + ' km' : '');
          stateEl.innerHTML = '<p><strong>Día cerrado.</strong> Taxi: ' + esc(s.taxi_identifier || '—') +
            ' · Entrada: ' + esc(s.entry_time) + ' · ' + esc(s.entry_km) + ' km' + mapLink(s.entry_lat, s.entry_lng, 'Entrada en mapa') + exitLine + mapLink(s.exit_lat, s.exit_lng, 'Salida en mapa') + kmLine + '</p>' +
            (closes.length ? closeCardsHtml(closes) : '') +
            '<button type="button" id="day-edit-btn">Editar día</button>';
          document.getElementById('day-edit-btn').addEventListener('click', function () {
            showEditForm(s);
          });
        }
      } catch (e) { stateEl.innerHTML = '<p class="error">' + esc(e.message) + '</p>'; }
    }

    function showEditForm(s) {
      stateEl.innerHTML = '<form id="day-edit-form" class="row">' + taxiSelect(s.taxi_id) +
        '<label>Hora de entrada <input name="entry_time" type="time" value="' + esc(s.entry_time || '') + '" required></label>' +
        '<label>Km de entrada <input name="entry_km" type="number" step="0.01" min="0" value="' + esc(s.entry_km) + '" required></label>' +
        '<label>Hora de cierre <input name="exit_time" type="time" value="' + esc(s.exit_time || '') + '"></label>' +
        '<label>Km de cierre <input name="exit_km" type="number" step="0.01" min="0" value="' + (s.exit_km !== null ? esc(s.exit_km) : '') + '"></label>' +
        '<button type="submit">Guardar día</button></form>';
      document.getElementById('day-edit-form').addEventListener('submit', async function (ev) {
        ev.preventDefault();
        var f = ev.target;
        try {
          await api('/api/shifts', 'POST', {
            shift_date: dateInput.value,
            taxi_id: f.taxi_id.value,
            entry_time: f.entry_time.value,
            entry_km: f.entry_km.value,
            exit_time: f.exit_time.value || null,
            exit_km: f.exit_km.value === '' ? null : f.exit_km.value,
          });
          showMessage('Día guardado.', 'ok');
          load();
        } catch (e) { showMessage(e.message, 'error'); }
      });
    }

    dateInput.addEventListener('change', load);
    load();
  }

  // ---------- Viajes ----------

  async function renderTrips() {
    var trips = await api('/api/trips');
    var methods = [];
    try { methods = await api('/api/trips?methods=1'); } catch (e) { methods = []; }
    var title = user.role === 'admin' ? 'Todos los viajes' : 'Mis viajes';
    var rows = trips.map(function (t) {
      var shiftLine = t.entry_time
        ? '<p>Entrada: ' + esc(t.entry_time) + ' · ' + esc(t.entry_km) + ' km — Salida: ' + esc(t.exit_time) + ' · ' + esc(t.exit_km) + ' km</p>'
        : '';
      return '<div class="card"><p><strong>' + esc(t.trip_date) + '</strong> · ' + esc(t.driver_name || user.name) +
        (t.taxi_identifier ? ' · ' + esc(t.taxi_identifier) : '') + ' · Turno: ' + (t.shift_type === 'night' ? 'Noche' : 'Día') + mapLink(t.trip_lat, t.trip_lng, 'Mapa') + '</p>' + shiftLine +
        '<p>Monto: ' + money(t.amount) + ' · %: ' + esc(t.pct_snapshot) + '% · Te quedás: ' + money(t.driver_keeps) + ' · Dueño: ' + money(t.owner_share) + (t.payment_method_name ? ' · Pago: ' + esc(t.payment_method_name) : '') + '</p>' +
        '<button type="button" class="secondary small" data-edit-trip="' + t.id + '">Editar</button> ' +
        '<button type="button" class="danger small" data-del-trip="' + t.id + '">Borrar</button></div>';
    }).join('');
    contentEl.innerHTML = '<h2>' + title + '</h2>' + (rows || '<p class="muted">Todavía no hay viajes.</p>');
    contentEl.querySelectorAll('[data-edit-trip]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var t = trips.find(function (x) { return String(x.id) === btn.getAttribute('data-edit-trip'); });
        var card = btn.closest('.card');
        // Si el método del viaje está inactivo (no viene en la lista del
        // chofer), igual se muestra para no cambiarlo sin querer.
        var editMethods = methods.slice();
        if (t.payment_method_id && !editMethods.find(function (m) { return String(m.id) === String(t.payment_method_id); })) {
          editMethods.unshift({ id: t.payment_method_id, name: (t.payment_method_name || 'Método') + ' (inactivo)' });
        }
        var methodOptions = editMethods.length
          ? editMethods.map(function (m) {
              return '<option value="' + m.id + '"' + (String(m.id) === String(t.payment_method_id) ? ' selected' : '') + '>' + esc(m.name) + '</option>';
            }).join('')
          : '<option value="">Sin métodos</option>';
        card.innerHTML = '<form class="row">' +
          '<label>Fecha <input name="trip_date" type="date" value="' + esc(t.trip_date) + '" required></label>' +
          '<label>Turno <select name="shift_type"><option value="day"' + (t.shift_type === 'night' ? '' : ' selected') + '>Día</option><option value="night"' + (t.shift_type === 'night' ? ' selected' : '') + '>Noche</option></select></label>' +
          '<label>Método de pago <select name="payment_method_id">' + methodOptions + '</select></label>' +
          '<label>Monto (USD) <input name="amount" type="number" step="0.01" min="0" value="' + esc(t.amount) + '" required></label>' +
          '<button type="submit">Guardar cambios</button> <button type="button" data-cancel-edit>Cancelar</button></form>';
        var f = card.querySelector('form');
        f.addEventListener('submit', async function (ev) {
          ev.preventDefault();
          try {
            await api('/api/trips?id=' + t.id, 'PUT', {
              trip_date: f.trip_date.value,
              shift_type: f.shift_type.value,
              payment_method_id: f.payment_method_id.value,
              amount: f.amount.value,
            });
            showMessage('Viaje actualizado.', 'ok');
            renderTab();
          } catch (e) { showMessage(e.message, 'error'); }
        });
        card.querySelector('[data-cancel-edit]').addEventListener('click', function () { renderTab(); });
      });
    });
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

  function tripFormHtml(methods) {
    var hour = new Date().getHours();
    var nightStart = (user.night_start !== undefined && user.night_start !== null) ? user.night_start : 22;
    var nightEnd = (user.night_end !== undefined && user.night_end !== null) ? user.night_end : 6;
    var nightDefault = isNightHour(hour, nightStart, nightEnd);
    var pctNote = '';
    if (user.commission_day_pct !== undefined && user.commission_night_pct !== undefined) {
      pctNote = ' Tu %: día ' + esc(user.commission_day_pct) + '% · noche ' + esc(user.commission_night_pct) + '%.';
    }
    var methodOptions = (methods && methods.length)
      ? methods.map(function (m) {
          return '<option value="' + m.id + '">' + esc(m.name) + '</option>';
        }).join('')
      : '<option value="">Sin métodos de pago</option>';
    return '<h2>Nuevo viaje</h2><form id="trip-form">' +
      '<label>Fecha <input name="trip_date" type="date" value="' + todayLocal() + '" required></label>' +
      '<label>Turno <select name="shift_type"><option value="day"' + (nightDefault ? '' : ' selected') + '>Día</option><option value="night"' + (nightDefault ? ' selected' : '') + '>Noche</option></select></label>' +
      '<label>Método de pago <select name="payment_method_id" required>' + methodOptions + '</select></label>' +
      '<label>Monto del viaje (USD) <input name="amount" type="number" step="0.01" min="0" required></label>' +
      '<button type="submit">Guardar viaje</button></form>' +
      '<p class="muted" id="trip-geo-status">Detectando ubicación…</p>' +
      '<p class="muted">Solo el monto: la hora y el kilometraje van en "Mi día". El % que se aplica es el de tu turno (día o noche), puesto por el administrador.' + pctNote + ' Si cambia después, tus viajes viejos no cambian.</p>';
  }

  async function renderNewTrip() {
    var tripGeo = null;
    var methods = [];
    try { methods = await api('/api/trips?methods=1'); } catch (e) { methods = []; }
    contentEl.innerHTML = tripFormHtml(methods);
    captureLocation(function (geo) {
      tripGeo = geo;
      var st = document.getElementById('trip-geo-status');
      if (st) st.textContent = geo ? 'Ubicación del viaje detectada.' : 'Sin ubicación (revisá los permisos del navegador).';
    });
    document.getElementById('trip-form').addEventListener('submit', async function (ev) {
      ev.preventDefault();
      var f = ev.target;
      var body = {
        trip_date: f.trip_date.value,
        shift_type: f.shift_type.value,
        payment_method_id: f.payment_method_id.value,
        amount: f.amount.value,
      };
      if (tripGeo) { body.trip_lat = tripGeo.lat; body.trip_lng = tripGeo.lng; }
      try {
        var created = await api('/api/trips', 'POST', body);
        showMessage('Viaje guardado. Te quedás ' + money(created.driver_keeps) + ' y al dueño le van ' + money(created.owner_share) + '.', 'ok');
        currentTab = 'trips';
        buildTabs();
      } catch (e) { showMessage(e.message, 'error'); }
    });
  }

  // Comprime la foto de la factura en el celular antes de subirla:
  // lado máximo 1200px, JPEG. Si igual queda pesada, reintenta más chica.
  function compressReceiptImage(file) {
    function attempt(maxSide, quality) {
      return new Promise(function (resolve, reject) {
        var img = new Image();
        var url = URL.createObjectURL(file);
        img.onload = function () {
          var scale = Math.min(1, maxSide / Math.max(img.width, img.height));
          var canvas = document.createElement('canvas');
          canvas.width = Math.round(img.width * scale);
          canvas.height = Math.round(img.height * scale);
          canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
          URL.revokeObjectURL(url);
          resolve(canvas.toDataURL('image/jpeg', quality));
        };
        img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('No se pudo leer la foto')); };
        img.src = url;
      });
    }
    return attempt(1200, 0.8).then(function (dataUrl) {
      if (dataUrl.length <= 650000) return dataUrl;
      return attempt(900, 0.6).then(function (smaller) {
        if (smaller.length <= 650000) return smaller;
        throw new Error('La foto quedó demasiado grande, probá con otra foto');
      });
    });
  }

  function showReceiptImage(dataUrl) {
    var overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.85);display:flex;flex-direction:column;align-items:center;justify-content:center;z-index:9999;padding:16px;box-sizing:border-box;';
    var img = document.createElement('img');
    img.src = dataUrl;
    img.style.cssText = 'max-width:100%;max-height:85vh;object-fit:contain;';
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Cerrar';
    btn.style.cssText = 'margin-top:12px;';
    btn.addEventListener('click', function () { overlay.remove(); });
    overlay.addEventListener('click', function (ev) { if (ev.target === overlay) overlay.remove(); });
    overlay.appendChild(img);
    overlay.appendChild(btn);
    document.body.appendChild(overlay);
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
        '<label>Foto de la factura <input name="receipt" type="file" accept="image/*"></label>' +
        '<button type="submit">Guardar gasto</button></form>';
    }
    var rows = expenses.map(function (g) {
      return '<div class="card"><p><strong>' + esc(g.expense_date) + '</strong> · ' + esc(g.type) + ' · ' + money(g.amount) +
        (g.driver_name ? ' · ' + esc(g.driver_name) : '') + '</p>' +
        (g.note ? '<p>' + esc(g.note) + '</p>' : '') +
        (g.has_receipt ? '<button type="button" class="small" data-receipt-expense="' + g.id + '">Ver factura</button> ' : '') +
        '<button type="button" class="danger small" data-del-expense="' + g.id + '">Borrar</button></div>';
    }).join('');
    contentEl.innerHTML = '<h2>' + title + '</h2>' + formHtml + '<h3>Lista</h3>' + (rows || '<p class="muted">Todavía no hay gastos.</p>');
    var form = document.getElementById('expense-form');
    if (form) {
      form.addEventListener('submit', async function (ev) {
        ev.preventDefault();
        try {
          var receiptImage = null;
          var file = form.receipt && form.receipt.files && form.receipt.files[0];
          if (file) receiptImage = await compressReceiptImage(file);
          await api('/api/expenses', 'POST', {
            expense_date: form.expense_date.value,
            type: form.type.value,
            amount: form.amount.value,
            note: form.note.value,
            receipt_image: receiptImage,
          });
          showMessage('Gasto guardado.', 'ok');
          renderTab();
        } catch (e) { showMessage(e.message, 'error'); }
      });
    }
    contentEl.querySelectorAll('[data-receipt-expense]').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        try {
          var data = await api('/api/expenses?receipt=' + btn.getAttribute('data-receipt-expense'));
          showReceiptImage(data.image);
        } catch (e) { showMessage(e.message, 'error'); }
      });
    });
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

  // ---------- Reportes (admin) ----------

  async function renderReport() {
    var drivers = [];
    var taxis = [];
    var methods = [];
    try { drivers = await api('/api/drivers'); } catch (e) { drivers = []; }
    try { taxis = await api('/api/taxis'); } catch (e) { taxis = []; }
    try { methods = await api('/api/trips?methods=1'); } catch (e) { methods = []; }
    var driverOptions = '<option value="">Todos los choferes</option>' + drivers.map(function (d) {
      return '<option value="' + d.id + '">' + esc(d.name) + '</option>';
    }).join('');
    var taxiOptions = '<option value="">Todos los autos</option>' + taxis.map(function (t) {
      return '<option value="' + t.id + '">' + esc(t.identifier) + '</option>';
    }).join('');
    var methodOptions = '<option value="">Todos los métodos</option>' + methods.map(function (m) {
      return '<option value="' + m.id + '">' + esc(m.name) + '</option>';
    }).join('');
    contentEl.innerHTML = '<h2>Reportes</h2><form id="report-form" class="row">' +
      '<label>Desde <input name="from" type="date" value="' + daysAgoLocal(30) + '" required></label>' +
      '<label>Hasta <input name="to" type="date" value="' + todayLocal() + '" required></label>' +
      '<label>Chofer <select name="driver_id">' + driverOptions + '</select></label>' +
      '<label>Auto <select name="taxi_id">' + taxiOptions + '</select></label>' +
      '<label>Método de pago <select name="payment_method_id">' + methodOptions + '</select></label>' +
      '<button type="submit">Buscar</button></form><div id="report-result"></div>';
    var form = document.getElementById('report-form');
    var result = document.getElementById('report-result');

    function perKmCell(v) {
      return v !== null && v !== undefined ? money(v) + '/km' : '—';
    }
    function dayRows(rows) {
      if (!rows.length) return '<p class="muted">Sin datos en ese período.</p>';
      return '<div class="table-wrap"><table><thead><tr><th>Fecha</th><th>Viajes</th><th>Recaudado</th><th>Km</th><th>$/km</th></tr></thead><tbody>' +
        rows.map(function (r) {
          return '<tr><td>' + esc(r.date) + '</td><td>' + esc(r.trips) + '</td><td>' + money(r.total) + '</td><td>' + (r.km !== null ? esc(r.km) + ' km' : '—') + '</td><td>' + perKmCell(r.per_km) + '</td></tr>';
        }).join('') + '</tbody></table></div>';
    }
    function breakdownRows(rows, nameFn) {
      if (!rows.length) return '';
      return '<div class="table-wrap"><table><thead><tr><th>Nombre</th><th>Viajes</th><th>Recaudado</th><th>Km</th><th>$/km</th></tr></thead><tbody>' +
        rows.map(function (r) {
          return '<tr><td>' + esc(nameFn(r)) + '</td><td>' + esc(r.trips) + '</td><td>' + money(r.total) + '</td><td>' + (r.km !== null ? esc(r.km) + ' km' : '—') + '</td><td>' + perKmCell(r.per_km) + '</td></tr>';
        }).join('') + '</tbody></table></div>';
    }

    function csvCell(v) {
      var s = String(v === null || v === undefined ? '' : v);
      return '"' + s.replace(/"/g, '""') + '"';
    }
    function downloadReportCsv(rep) {
      var lines = [];
      var t = rep.totals;
      lines.push('Reporte,' + csvCell(rep.from + ' al ' + rep.to));
      lines.push('Total recaudado,' + t.total);
      lines.push('Viajes,' + t.trips_count);
      lines.push('Km recorridos,' + t.km);
      lines.push('Dinero por km promedio,' + (t.avg_per_km !== null ? t.avg_per_km : ''));
      lines.push('Se quedan los choferes,' + t.driver_keeps);
      lines.push('Gastos,' + t.expenses);
      lines.push('Deben entregar,' + t.handover_to_owner);
      lines.push('');
      lines.push('Por dia,Fecha,Viajes,Recaudado,Km,$/km');
      rep.per_day.forEach(function (r) {
        lines.push(['Por dia', r.date, r.trips, r.total, r.km !== null ? r.km : '', r.per_km !== null ? r.per_km : ''].join(','));
      });
      lines.push('');
      lines.push('Por chofer,Chofer,Viajes,Recaudado,Km,$/km');
      rep.per_driver.forEach(function (r) {
        lines.push(['Por chofer', csvCell(r.driver_name), r.trips, r.total, r.km !== null ? r.km : '', r.per_km !== null ? r.per_km : ''].join(','));
      });
      lines.push('');
      lines.push('Por auto,Auto,Viajes,Recaudado,Km,$/km');
      rep.per_taxi.forEach(function (r) {
        lines.push(['Por auto', csvCell(r.taxi_identifier), r.trips, r.total, r.km !== null ? r.km : '', r.per_km !== null ? r.per_km : ''].join(','));
      });
      lines.push('');
      lines.push('Por metodo de pago,Metodo,Viajes,Recaudado,Se quedan los choferes');
      (rep.per_method || []).forEach(function (r) {
        lines.push(['Por metodo de pago', csvCell(r.method_name), r.trips, r.total, r.driver_keeps].join(','));
      });
      var blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'reporte-' + rep.from + '-' + rep.to + '.csv';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    }

    async function search() {
      var q = 'from=' + encodeURIComponent(form.from.value) + '&to=' + encodeURIComponent(form.to.value);
      if (form.driver_id.value) q += '&driver_id=' + encodeURIComponent(form.driver_id.value);
      if (form.taxi_id.value) q += '&taxi_id=' + encodeURIComponent(form.taxi_id.value);
      if (form.payment_method_id.value) q += '&payment_method_id=' + encodeURIComponent(form.payment_method_id.value);
      result.innerHTML = '<p class="muted">Buscando…</p>';
      try {
        var rep = await api('/api/report?' + q);
        var t = rep.totals;
        var html = '<div class="card"><h3>' + esc(rep.from) + ' al ' + esc(rep.to) + '</h3>' +
          '<p>Total recaudado</p><p class="big-number">' + money(t.total) + '</p>' +
          '<p>Viajes: ' + esc(t.trips_count) + ' · Km recorridos: ' + esc(t.km) + ' km</p>' +
          '<p>Dinero por km (promedio): <strong>' + perKmCell(t.avg_per_km) + '</strong></p>' +
          '<p>Se quedan los choferes: ' + money(t.driver_keeps) + ' · Gastos: ' + money(t.expenses) + ' · Deben entregar: <strong>' + money(t.handover_to_owner) + '</strong></p>' +
          '<p class="muted">El $/km se calcula solo sobre días con kilometraje cargado (jornada cerrada). Los días sin jornada no entran en el promedio.' +
          (form.taxi_id.value ? ' Gastos asignados al auto según el taxi del día de cada gasto.' : '') + '</p></div>' +
          '<button type="button" id="report-csv-btn">Descargar CSV</button>' +
          '<h3>Por día</h3>' + dayRows(rep.per_day);
        if (!form.driver_id.value) html += '<h3>Por chofer</h3>' + breakdownRows(rep.per_driver, function (r) { return r.driver_name; });
        if (!form.taxi_id.value) html += '<h3>Por auto</h3>' + breakdownRows(rep.per_taxi, function (r) { return r.taxi_identifier; });
        if (rep.per_method && rep.per_method.length) {
          html += '<h3>Por método de pago</h3><div class="table-wrap"><table><thead><tr><th>Método</th><th>Viajes</th><th>Recaudado</th><th>Se quedan los choferes</th></tr></thead><tbody>' +
            rep.per_method.map(function (r) {
              return '<tr><td>' + esc(r.method_name) + '</td><td>' + esc(r.trips) + '</td><td>' + money(r.total) + '</td><td>' + money(r.driver_keeps) + '</td></tr>';
            }).join('') + '</tbody></table></div>';
        }
        result.innerHTML = html;
        var csvBtn = document.getElementById('report-csv-btn');
        if (csvBtn) csvBtn.addEventListener('click', function () { downloadReportCsv(rep); });
      } catch (e) { result.innerHTML = '<p class="error">' + esc(e.message) + '</p>'; }
    }

    form.addEventListener('submit', function (ev) { ev.preventDefault(); search(); });
    search();
  }

  // ---------- Cierre del día ----------

  function closeCardsHtml(closes) {
    return closes.map(function (c) {
      var shiftLine = c.shift_taxi
        ? '<p>Taxi del día: ' + esc(c.shift_taxi) +
          (c.shift_entry_time ? ' · Entrada: ' + esc(c.shift_entry_time) + ' · ' + esc(c.shift_entry_km) + ' km' : '') +
          (c.shift_exit_time ? ' · Salida: ' + esc(c.shift_exit_time) + ' · ' + esc(c.shift_exit_km) + ' km' : '') + '</p>' +
          (c.km_driven !== null && c.km_driven !== undefined ? '<p>Km recorridos: ' + esc(c.km_driven) + ' km</p>' : '')
        : '<p class="muted">Sin jornada cargada para ese día.</p>';
      return '<div class="card"><h3>' + esc(c.driver_name) + ' · ' + esc(c.date) + '</h3>' +
        '<p>Viajes: ' + esc(c.trips_count) + '</p>' + shiftLine +
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
    var drivers = [];
    var taxis = [];
    try { drivers = await api('/api/drivers'); } catch (e) { drivers = []; }
    try { taxis = await api('/api/taxis'); } catch (e) { taxis = []; }
    var driverOptions = drivers.map(function (d) {
      return '<option value="' + d.id + '">' + esc(d.name) + '</option>';
    }).join('');
    var taxiOptions = '<option value="">Sin taxi</option>' + taxis.map(function (t) {
      return '<option value="' + t.id + '">' + esc(t.identifier) + '</option>';
    }).join('');
    contentEl.innerHTML = '<h2>Cierres del día (todos los choferes)</h2><form id="close-form" class="row">' +
      '<label>Fecha <input name="date" type="date" value="' + todayLocal() + '" required></label>' +
      '<button type="submit">Ver cierres</button></form><div id="close-result"></div>' +
      '<h3>Cargar o corregir jornada</h3><form id="shift-form" class="row">' +
      '<label>Chofer <select name="driver_id">' + driverOptions + '</select></label>' +
      '<label>Fecha <input name="shift_date" type="date" value="' + todayLocal() + '" required></label>' +
      '<label>Taxi del día <select name="taxi_id">' + taxiOptions + '</select></label>' +
      '<label>Hora de entrada <input name="entry_time" type="time" required></label>' +
      '<label>Km de entrada <input name="entry_km" type="number" step="0.01" min="0" required></label>' +
      '<label>Hora de cierre <input name="exit_time" type="time"></label>' +
      '<label>Km de cierre <input name="exit_km" type="number" step="0.01" min="0"></label>' +
      '<button type="submit">Guardar jornada</button></form>' +
      '<p class="muted">Si un chofer olvidó empezar o cerrar el día, cargalo acá. Guardar reemplaza la jornada de ese chofer y fecha.</p>';
    var form = document.getElementById('close-form');
    var result = document.getElementById('close-result');
    async function load() {
      try {
        var closes = await api('/api/day-close?date=' + encodeURIComponent(form.date.value));
        result.innerHTML = closes.length ? closeCardsHtml(closes) : '<p class="muted">Sin datos para esa fecha.</p>';
      } catch (e) { result.innerHTML = '<p class="error">' + esc(e.message) + '</p>'; }
    }
    form.addEventListener('submit', function (ev) { ev.preventDefault(); load(); });
    var shiftForm = document.getElementById('shift-form');
    shiftForm.addEventListener('submit', async function (ev) {
      ev.preventDefault();
      try {
        await api('/api/shifts', 'POST', {
          driver_id: shiftForm.driver_id.value,
          shift_date: shiftForm.shift_date.value,
          taxi_id: shiftForm.taxi_id.value,
          entry_time: shiftForm.entry_time.value,
          entry_km: shiftForm.entry_km.value,
          exit_time: shiftForm.exit_time.value || null,
          exit_km: shiftForm.exit_km.value === '' ? null : shiftForm.exit_km.value,
        });
        showMessage('Jornada guardada.', 'ok');
        load();
      } catch (e) { showMessage(e.message, 'error'); }
    });
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
      return '<div class="card"><p><strong>' + esc(d.name) + '</strong> · ' + esc(d.phone) + ' · Taxi: ' + esc(d.taxi_identifier || '—') + ' · % día: ' + esc(d.commission_day_pct) + ' · % noche: ' + esc(d.commission_night_pct) + ' · ' + (d.active ? 'Activo' : 'Inactivo') + '</p>' +
        '<div class="row"><button type="button" class="secondary small" data-edit-driver="' + d.id + '">Editar</button>' +
        (d.active ? '<button type="button" class="danger small" data-del-driver="' + d.id + '">Desactivar</button>' : '') + '</div></div>';
    }).join('');
    contentEl.innerHTML = '<h2>Choferes</h2><form id="driver-form">' +
      '<input type="hidden" name="id">' +
      '<label>Nombre <input name="name" type="text" required></label>' +
      '<label>Teléfono <input name="phone" type="text"></label>' +
      '<label>Taxi asignado <select name="taxi_id">' + taxiOptions + '</select></label>' +
      '<label>% del chofer de día <input name="commission_day_pct" type="number" step="0.01" min="0" max="100" required></label>' +
      '<label>% del chofer de noche <input name="commission_night_pct" type="number" step="0.01" min="0" max="100" required></label>' +
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
        commission_day_pct: form.commission_day_pct.value,
        commission_night_pct: form.commission_night_pct.value,
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
        form.commission_day_pct.value = d.commission_day_pct;
        form.commission_night_pct.value = d.commission_night_pct;
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

  // ---------- Mi empresa (solo admin) ----------

  async function renderCompany() {
    var company = await api('/api/company');
    var driverLink = window.location.origin + '/?company=' + company.code;
    contentEl.innerHTML = '<h2>Mi empresa</h2>' +
      '<div class="card"><p><strong>Link para tus choferes</strong></p>' +
      '<p><a href="' + esc(driverLink) + '">' + esc(driverLink) + '</a></p>' +
      '<p><button type="button" id="copy-driver-link-btn">Copiar link</button></p>' +
      '<p class="muted">Mandales este link a tus choferes: abre el ingreso con tu empresa ya seleccionada; cada uno elige su nombre y escribe su PIN. También pueden entrar eligiendo tu empresa con el código <strong>' + esc(company.code) + '</strong>.</p></div>' +
      '<form id="company-form">' +
      '<label>Nombre de la empresa <input name="name" type="text" value="' + esc(company.name) + '" required></label>' +
      '<label>La noche empieza a las (hora 0-23) <input name="night_start" type="number" min="0" max="23" value="' + esc(company.night_start) + '" required></label>' +
      '<label>La noche termina a las (hora 0-23) <input name="night_end" type="number" min="0" max="23" value="' + esc(company.night_end) + '" required></label>' +
      '<button type="submit">Guardar empresa</button></form>' +
      '<p class="muted">El horario de noche define qué viajes se preseleccionan como nocturnos en el celular del chofer; el chofer igual puede cambiar el turno por viaje.</p>';
    document.getElementById('copy-driver-link-btn').addEventListener('click', async function () {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(driverLink);
          showMessage('Link copiado.', 'ok');
          return;
        }
        throw new Error('sin clipboard');
      } catch (e) {
        var tmp = document.createElement('textarea');
        tmp.value = driverLink;
        document.body.appendChild(tmp);
        tmp.select();
        try { document.execCommand('copy'); showMessage('Link copiado.', 'ok'); }
        catch (e2) { showMessage('No se pudo copiar: ' + driverLink, 'error'); }
        tmp.remove();
      }
    });
    document.getElementById('company-form').addEventListener('submit', async function (ev) {
      ev.preventDefault();
      var f = ev.target;
      try {
        await api('/api/company', 'PUT', {
          name: f.name.value,
          night_start: Number(f.night_start.value),
          night_end: Number(f.night_end.value),
        });
        showMessage('Empresa guardada.', 'ok');
        renderTab();
      } catch (e) { showMessage(e.message, 'error'); }
    });
  }

  // ---------- Métodos de pago (solo admin) ----------

  async function renderPaymentMethods() {
    var methods = await api('/api/trips?methods=1');
    var rows = methods.map(function (m) {
      return '<div class="card"><p><strong>' + esc(m.name) + '</strong> · ' + (m.active ? 'Activo' : 'Inactivo') + ' ' +
        '<button type="button" class="small" data-toggle-method="' + m.id + '" data-active="' + (m.active ? '0' : '1') + '">' + (m.active ? 'Desactivar' : 'Activar') + '</button></p></div>';
    }).join('');
    contentEl.innerHTML = '<h2>Métodos de pago</h2>' +
      '<p class="muted">Los métodos que cada chofer puede elegir al cargar un viaje. Desactivar no borra el historial: los viajes viejos conservan su método.</p>' +
      (rows || '<p class="muted">Todavía no hay métodos.</p>') +
      '<h3>Agregar método</h3><form id="method-form" class="row">' +
      '<label>Nombre <input name="name" type="text" required></label>' +
      '<button type="submit">Agregar</button></form>';
    document.getElementById('method-form').addEventListener('submit', async function (ev) {
      ev.preventDefault();
      var f = ev.target;
      try {
        await api('/api/trips?methods=1', 'POST', { name: f.name.value });
        showMessage('Método agregado.', 'ok');
        renderTab();
      } catch (e) { showMessage(e.message, 'error'); }
    });
    contentEl.querySelectorAll('[data-toggle-method]').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        try {
          await api('/api/trips?methods=1&id=' + btn.getAttribute('data-toggle-method'), 'PUT', { active: btn.getAttribute('data-active') === '1' });
          showMessage('Método actualizado.', 'ok');
          renderTab();
        } catch (e) { showMessage(e.message, 'error'); }
      });
    });
  }

  // ---------- Empresas (solo superadmin: dueño de la plataforma) ----------

  async function renderEmpresas() {
    var companies = await api('/api/company?panel=1');
    var origin = window.location.origin;
    var rows = companies.map(function (c) {
      var link = origin + '/?company=' + esc(c.code) + '&login=owner';
      var isOwn = user.company_id === c.id;
      var actions = isOwn
        ? '<p class="muted">Tu empresa (se administra desde tu link de dueño principal).</p>'
        : '<p><button type="button" class="small" data-edit-company="' + c.id + '">Editar</button> ' +
          '<button type="button" class="small" data-toggle-active="' + c.id + '" data-active="' + (c.active ? '0' : '1') + '">' + (c.active ? 'Suspender' : 'Reactivar') + '</button> ' +
          '<button type="button" class="small" data-toggle-paid="' + c.id + '" data-paid="' + (c.payment_status === 'paid' ? 'pending' : 'paid') + '">' + (c.payment_status === 'paid' ? 'Marcar pago pendiente' : 'Marcar pago al día') + '</button> ' +
          '<button type="button" class="danger small" data-del-company="' + c.id + '">Borrar</button></p>' +
          '<div data-edit-form="' + c.id + '"></div>';
      return '<div class="card"><p><strong>' + esc(c.name) + '</strong> · Código: ' + esc(c.code) +
        (isOwn ? ' · Tu empresa' : '') + '</p>' +
        '<p>Dueño: ' + esc(c.owner_name || '—') + (c.owner_email ? ' (' + esc(c.owner_email) + ')' : '') + '</p>' +
        '<p>Estado: ' + (c.active ? 'Activa' : 'Suspendida') + ' · Pago: ' + (c.payment_status === 'paid' ? 'Al día' : 'Pendiente') + '</p>' +
        '<p>Link: <a href="' + link + '">' + link + '</a></p>' + actions + '</div>';
    }).join('');
    contentEl.innerHTML = '<h2>Empresas</h2>' +
      '<p class="muted">Solo vos ves este panel. Acá das de alta a los dueños y los manejás según su pago: podés suspender a quien no pagó (deja de poder entrar) y reactivarlo cuando pague. Borrar elimina la empresa y todos sus datos y no se puede deshacer.</p>' +
      (rows || '<p class="muted">Todavía no hay empresas.</p>') +
      '<h3>Dar de alta una empresa</h3>' +
      '<form id="empresa-form">' +
      '<label>Nombre de la empresa <input name="company_name" type="text" required></label>' +
      '<label>Nombre del dueño <input name="admin_name" type="text" required></label>' +
      '<label>Email del dueño <input name="email" type="email" required></label>' +
      '<label>PIN del dueño <input name="pin" type="password" inputmode="numeric" required></label>' +
      '<button type="submit">Crear empresa</button></form>';
    document.getElementById('empresa-form').addEventListener('submit', async function (ev) {
      ev.preventDefault();
      var f = ev.target;
      try {
        var result = await api('/api/company', 'POST', {
          company_name: f.company_name.value,
          admin_name: f.admin_name.value,
          email: f.email.value,
          pin: f.pin.value,
        });
        var ownerLink = window.location.origin + '/?company=' + result.company.code + '&login=owner';
        showMessage('Empresa creada: ' + result.company.name + ' — código ' + result.company.code + '. Link para el dueño: ' + ownerLink + ' — pasale ese link con su email y PIN.', 'ok');
        renderTab();
      } catch (e) { showMessage(e.message, 'error'); }
    });
    contentEl.querySelectorAll('[data-toggle-active]').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        try {
          await api('/api/company?panel=1&id=' + btn.getAttribute('data-toggle-active'), 'PUT', { active: btn.getAttribute('data-active') === '1' });
          showMessage(btn.getAttribute('data-active') === '1' ? 'Empresa reactivada.' : 'Empresa suspendida: sus usuarios ya no pueden entrar.', 'ok');
          renderTab();
        } catch (e) { showMessage(e.message, 'error'); }
      });
    });
    contentEl.querySelectorAll('[data-toggle-paid]').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        try {
          await api('/api/company?panel=1&id=' + btn.getAttribute('data-toggle-paid'), 'PUT', { payment_status: btn.getAttribute('data-paid') });
          showMessage('Estado de pago actualizado.', 'ok');
          renderTab();
        } catch (e) { showMessage(e.message, 'error'); }
      });
    });
    contentEl.querySelectorAll('[data-del-company]').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        var c = companies.find(function (x) { return String(x.id) === btn.getAttribute('data-del-company'); });
        if (!window.confirm('¿Borrar la empresa "' + (c ? c.name : '') + '" y TODOS sus datos (choferes, viajes, gastos)? No se puede deshacer.')) return;
        try {
          await api('/api/company?panel=1&id=' + btn.getAttribute('data-del-company'), 'DELETE');
          showMessage('Empresa borrada.', 'ok');
          renderTab();
        } catch (e) { showMessage(e.message, 'error'); }
      });
    });
    contentEl.querySelectorAll('[data-edit-company]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var c = companies.find(function (x) { return String(x.id) === btn.getAttribute('data-edit-company'); });
        var holder = contentEl.querySelector('[data-edit-form="' + c.id + '"]');
        holder.innerHTML = '<form class="row">' +
          '<label>Nombre de la empresa <input name="name" type="text" value="' + esc(c.name) + '" required></label>' +
          '<label>Nombre del dueño <input name="owner_name" type="text" value="' + esc(c.owner_name || '') + '" required></label>' +
          '<label>Email del dueño <input name="owner_email" type="email" value="' + esc(c.owner_email || '') + '" required></label>' +
          '<label>PIN nuevo (vacío = no cambia) <input name="pin" type="password" inputmode="numeric"></label>' +
          '<button type="submit">Guardar cambios</button> <button type="button" data-cancel-edit>Cancelar</button></form>';
        var f = holder.querySelector('form');
        f.addEventListener('submit', async function (ev) {
          ev.preventDefault();
          var body = { name: f.name.value, owner_name: f.owner_name.value, owner_email: f.owner_email.value };
          if (f.pin.value) body.pin = f.pin.value;
          try {
            await api('/api/company?panel=1&id=' + c.id, 'PUT', body);
            showMessage('Empresa actualizada.', 'ok');
            renderTab();
          } catch (e) { showMessage(e.message, 'error'); }
        });
        holder.querySelector('[data-cancel-edit]').addEventListener('click', function () { renderTab(); });
      });
    });
  }

  // ---------- Login ----------

  document.getElementById('company-select').addEventListener('change', function (ev) {
    loadLoginUsers(ev.target.value);
  });

  document.getElementById('login-form').addEventListener('submit', async function (ev) {
    ev.preventDefault();
    var pin = document.getElementById('pin-input').value;
    var userId = document.getElementById('user-select').value;
    var companyId = document.getElementById('company-select').value;
    loginError.classList.add('hidden');
    if (!companyId || !userId) return;
    try {
      var data = await api('/api/auth', 'POST', { user_id: Number(userId), company_id: Number(companyId), pin: pin });
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

  // Ingreso de dueños con email y PIN (los dueños creados desde
  // el panel Empresas entran con email + PIN, no con nombre + PIN).
  document.getElementById('show-owner-login-btn').addEventListener('click', function () {
    document.getElementById('owner-login-block').classList.toggle('hidden');
    document.getElementById('owner-login-error').classList.add('hidden');
  });

  document.getElementById('owner-login-form').addEventListener('submit', async function (ev) {
    ev.preventDefault();
    var form = ev.target;
    var errorEl = document.getElementById('owner-login-error');
    errorEl.classList.add('hidden');
    try {
      var data = await api('/api/auth', 'POST', { email: form.email.value, pin: form.pin.value });
      token = data.token;
      user = data.user;
      localStorage.setItem('mt_token', token);
      localStorage.setItem('mt_user', JSON.stringify(user));
      form.reset();
      currentTab = null;
      showApp();
    } catch (e) {
      errorEl.textContent = e.message;
      errorEl.classList.remove('hidden');
    }
  });

  document.getElementById('logout-btn').addEventListener('click', logout);

  if (token && user) { showApp(); } else { showLogin(); }
})();
