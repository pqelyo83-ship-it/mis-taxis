// Mis Taxis — app de una sola página (JavaScript sin compilación).
// Habla solo con estas rutas de la API: /api/auth, /api/login-users,
// /api/company, /api/taxis, /api/drivers,
// /api/trips, /api/expenses, /api/day-close, /api/change-pin, /api/report,
// /api/shifts.

(function () {
  'use strict';

  var token = localStorage.getItem('mt_token') || '';
  var user = null;
  // Ingreso personal (?company=CODIGO&user=NOMBRE): empresa y usuario fijos
  // cuando el link trae un usuario; null en el ingreso normal.
  var fixedLogin = null;
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
  var tripsFilter = { date: todayLocal(), taxi_id: '', driver_id: '' };
  var expensesFilter = { date: todayLocal(), taxi_id: '', driver_id: '' };
  var tripsShowAll = false;
  var expensesShowAll = false;
  // Rangos rápidos del chofer en Mis viajes/Gastos: null (vista por día)
  // o 7 / 14 / 30 días corridos. El admin no usa rangos (tiene Ver todos).
  var tripsRange = null;
  var expensesRange = null;
  var perfDays = 30;
  var inicioDate = '';

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function money(n) {
    return '$' + Number(n || 0).toFixed(2);
  }

  // Línea del desglose por método de pago de un cierre (day-close): cada
  // método con su total; los viajes sin método se marcan como sin clasificar
  // porque no entran en el efectivo que el chofer entrega en mano.
  function methodsLine(c) {
    if (!c.methods || !c.methods.length) return '';
    var parts = c.methods.map(function (m) {
      var name = m.method_name || 'Sin método';
      return esc(name) + ' ' + money(m.total) + (m.method_name ? '' : ' (sin clasificar, no entra en el efectivo)');
    });
    return '<p class="muted">Por método: ' + parts.join(' · ') + '</p>';
  }

  // Línea de entrega en efectivo de un cierre (day-close) o del resumen
  // del reporte. Solo el efectivo entra al chofer; si la cuenta da
  // negativa, el dueño le debe al chofer. Cuando la API trae entrega neta
  // (handover_net), esa es la que se muestra: ya descuenta el saldo a
  // favor aplicado. Si la API todavía no trae handover_net, se muestra la
  // cuenta vieja.
  function handoverCashLine(c, ownerOwesLabel) {
    var val = (c.handover_net !== null && c.handover_net !== undefined) ? c.handover_net
      : (c.handover_cash !== null && c.handover_cash !== undefined ? c.handover_cash : null);
    if (val === null || val === undefined) {
      return 'Debe entregar: <strong>' + money(c.handover_to_owner) + '</strong>';
    }
    if (Number(val) < 0) {
      return esc(ownerOwesLabel) + ': <strong>' + money(-Number(val)) + '</strong>';
    }
    var neto = (c.credit_applied !== null && c.credit_applied !== undefined && Number(c.credit_applied) > 0) ? ' (neto)' : '';
    return 'Debe entregar en efectivo' + neto + ': <strong>' + money(val) + '</strong>';
  }

  // Líneas del saldo a favor del chofer (day-close). Solo se muestran
  // cuando hay saldo, para no agregar ruido: no es un gasto, es plata que
  // el dueño le debe al chofer de liquidaciones anteriores y que se
  // descuenta de la entrega de este día.
  function creditLines(c) {
    if (!c) return '';
    var before = Number(c.credit_before) || 0;
    var applied = Number(c.credit_applied) || 0;
    var after = Number(c.credit_after) || 0;
    if (before <= 0 && applied <= 0 && after <= 0) return '';
    var closed = c.shift_exit_km !== null && c.shift_exit_km !== undefined;
    var html = '';
    if (before > 0) html += '<p>Saldo a favor anterior: ' + money(before) + '</p>';
    if (applied > 0) html += '<p>Saldo aplicado: ' + money(applied) + '</p>';
    if (after > 0 && (closed || after !== before)) html += '<p>Saldo a favor restante: ' + money(after) + '</p>';
    return html;
  }

  // Línea de propinas de un cierre (day-close). Solo se muestra cuando
  // hay propinas en el día: la propina es 100% del chofer y no entra en
  // el debe entregar, así que nunca se suma a ningún otro número.
  function tipsLine(c) {
    if (!c || Number(c.tip_total) <= 0) return '';
    return '<p>Propinas: ' + money(c.tip_total) + ' (100% tuyas)</p>';
  }

  // Línea de estado de liquidación de un cierre (day-close). Solo para
  // días cerrados: un día abierto todavía no tiene nada que liquidar.
  // "Recibido" es confirmación del dueño; "pagado" significa que el dueño
  // ya pagó ese saldo en mano (ese día no genera saldo a favor). Sin
  // marca, el cierre queda pendiente.
  function isClosedClose(c) {
    return c && c.shift_exit_km !== null && c.shift_exit_km !== undefined;
  }

  function settlementLine(c) {
    if (!isClosedClose(c)) return '';
    var st = c.settlement || 'pendiente';
    if (st === 'recibido') return '<p>Liquidación: <strong>Recibido</strong></p>';
    if (st === 'pagado') {
      var html = '<p>Liquidación: <strong>Pagado</strong>';
      if (Number(c.settlement_paid) > 0) html += ' · Se canceló el saldo de este día (' + money(c.settlement_paid) + ')';
      else html += ' · Sin saldo pendiente de este día';
      return html + '</p>';
    }
    var net = (c.handover_net !== null && c.handover_net !== undefined) ? Number(c.handover_net) : null;
    if (net === 0) return '<p class="muted">Liquidación: sin saldo a liquidar.</p>';
    return '<p>Liquidación: <strong>Pendiente</strong></p>';
  }

  // Botones de liquidación (solo el dueño). Se ofrecen según el signo de
  // la entrega neta: recibido para entregas positivas, pagado para
  // negativas; en cero no hay nada que liquidar. El chofer ve solo la
  // línea de estado, sin botones.
  function settlementButtons(c) {
    if (!c || user.role !== 'admin' || !isClosedClose(c)) return '';
    var st = c.settlement || 'pendiente';
    var net = (c.handover_net !== null && c.handover_net !== undefined) ? Number(c.handover_net) : null;
    if (net === null || net === 0) return '';
    var base = ' data-settle-driver="' + c.driver_id + '" data-settle-date="' + esc(c.date) + '"';
    if (st === 'pendiente') {
      return net > 0
        ? '<p><button type="button" data-settle-state="recibido" data-settle-prev="pendiente"' + base + '>Marcar recibido</button></p>'
        : '<p><button type="button" data-settle-state="pagado" data-settle-prev="pendiente"' + base + '>Marcar pagado</button></p>';
    }
    return '<p><button type="button" data-settle-state="pendiente" data-settle-prev="' + esc(st) + '"' + base + '>Quitar marca</button></p>';
  }

  function wireSettleButtons(reload) {
    contentEl.querySelectorAll('[data-settle-state]').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        var state = btn.getAttribute('data-settle-state');
        var prev = btn.getAttribute('data-settle-prev');
        if (state === 'pagado' && !confirm('Marcar pagado significa que ya le pagaste este saldo en mano. Los días siguientes se calculan sin este descuento (si ya lo habían descontado, quedan pendientes). ¿Confirmás?')) return;
        if (state === 'pendiente' && prev === 'pagado' && !confirm('Quitar la marca vuelve a generar el saldo de este día: los días siguientes se recalculan con ese descuento. ¿Confirmás?')) return;
        try {
          await api('/api/shifts', 'POST', { action: 'settle', driver_id: btn.getAttribute('data-settle-driver'), shift_date: btn.getAttribute('data-settle-date'), settlement: state });
          showMessage('Liquidación actualizada.', 'ok');
          if (reload) reload();
        } catch (e) { showMessage(e.message, 'error'); }
      });
    });
  }

  // Un cierre está pendiente de liquidar cuando está cerrado, tiene saldo
  // distinto de cero y todavía no se marcó. Los días abiertos y los días
  // con entrega neta cero no cuentan (no hay nada que liquidar).
  function isPendingClose(c) {
    if (!isClosedClose(c)) return false;
    var net = (c.handover_net !== null && c.handover_net !== undefined) ? Number(c.handover_net) : Number(c.handover_cash) || 0;
    if (net === 0) return false;
    return (c.settlement || 'pendiente') === 'pendiente';
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

  // Límite de visibilidad del chofer: solo los últimos 30 días (hoy y 29
  // días para atrás, en fecha local del teléfono). El admin no tiene
  // límite. Se usa en los selectores de fecha del chofer y en los rangos
  // rápidos de Mis viajes/Gastos. Si un chofer pide algo más viejo, se
  // ajusta a este día (no se le muestra un error).
  function driverWindowStart() {
    return daysAgoLocal(29);
  }
  function clampDriverDate(value) {
    if (user && user.role === 'driver' && value && value < driverWindowStart()) return driverWindowStart();
    return value;
  }
  function driverRangeLabel(range) {
    return range === 7 ? 'la última semana' : (range === 14 ? 'las últimas 2 semanas' : 'el último mes');
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

  // Validación de km: el cierre no puede quedar por debajo de la apertura
  // (el backend también lo bloquea con un CHECK, pero esto avisa en
  // pantalla antes de enviar, sin el error feo posterior). Compara como
  // números (los km admiten decimales); el igual está permitido. Si el
  // cierre está vacío o no es número, no se valida acá y se mantiene el
  // comportamiento actual. Devuelve true si se puede enviar.
  function kmCierreValido(entryKm, exitKm) {
    if (exitKm === '' || exitKm === null || exitKm === undefined) return true;
    var entry = Number(entryKm);
    var exit = Number(exitKm);
    if (isNaN(entry) || isNaN(exit)) return true;
    if (exit < entry) {
      showMessage('El km de cierre no puede ser menor al km de apertura (' + entry + ' km).', 'error');
      return false;
    }
    return true;
  }

  // Checklist "Revisá antes de cerrar" (ítem 6, solo frontend, NO
  // bloqueante): viajes sin método de pago y gastos sin foto del día que
  // se está cerrando. Viaje sin clasificar = payment_method_id null en
  // /api/trips (payment_method_name null); gasto sin foto = has_receipt
  // false en /api/expenses (las listas no traen receipt_image, solo ese
  // booleano). No se inventa ningún umbral de km: el km menor que la
  // apertura ya lo bloquea kmCierreValido.
  function filtrarPendientesCierre(trips, expenses) {
    var viajes = [];
    var gastos = [];
    (trips || []).forEach(function (t) {
      if (t.payment_method_id === null || t.payment_method_id === undefined) viajes.push(t);
    });
    (expenses || []).forEach(function (g) {
      if (!g.has_receipt) gastos.push(g);
    });
    return { viajesSinMetodo: viajes, gastosSinFoto: gastos, total: viajes.length + gastos.length };
  }

  function textoAvisoCierre(p) {
    if (!p || !p.total) return '';
    var parts = [];
    if (p.viajesSinMetodo.length) parts.push(p.viajesSinMetodo.length === 1 ? '1 viaje sin método' : p.viajesSinMetodo.length + ' viajes sin método');
    if (p.gastosSinFoto.length) parts.push(p.gastosSinFoto.length === 1 ? '1 gasto sin foto' : p.gastosSinFoto.length + ' gastos sin foto');
    return 'Revisá antes de cerrar: ' + parts.join(' · ');
  }

  function textoConfirmCierre(p) {
    var lines = ['Revisá antes de cerrar:'];
    p.viajesSinMetodo.forEach(function (t) { lines.push('· Viaje ' + money(t.amount) + ' sin método'); });
    p.gastosSinFoto.forEach(function (g) { lines.push('· Gasto ' + (g.type || 'gasto') + ' ' + money(g.amount) + ' sin foto'); });
    lines.push('¿Igual querés cerrar el día?');
    return lines.join('\n');
  }

  // Carga los pendientes del día que se está cerrando (la fecha del
  // formulario de renderDay, que en el flujo normal es hoy; si se cierra
  // una jornada abierta vieja, corresponde a esa fecha, no a hoy). El
  // chofer siempre ve solo sus datos (el backend fuerza su driver_id);
  // el admin filtra por el chofer de la jornada. limit=all evita el tope
  // de 100 por defecto. Si cualquier consulta falla, devuelve null y el
  // cierre sigue sin aviso ni confirm (nunca bloquea).
  async function cargarPendientesCierre(date, driverId) {
    try {
      var extra = (user.role === 'admin' && driverId) ? '&driver_id=' + encodeURIComponent(driverId) : '';
      var trips = await api('/api/trips?date=' + encodeURIComponent(date) + extra + '&limit=all');
      var expenses = await api('/api/expenses?date=' + encodeURIComponent(date) + extra + '&limit=all');
      return filtrarPendientesCierre(trips, expenses);
    } catch (e) { return null; }
  }

  function mostrarAvisoCierre(p) {
    var el = document.getElementById('day-close-checklist');
    if (el) el.textContent = textoAvisoCierre(p);
  }

  // Tarjeta "Mi taxi hoy" (ítem 7, solo frontend, solo chofer). Usa la
  // fila de /api/day-close del día de hoy: shift_taxi, shift_entry_time,
  // shift_entry_km, shift_exit_km y km_driven (que day-close/shifts solo
  // calculan como salida − entrada cuando ambos existen). En jornada
  // ABIERTA no hay lectura actual de odómetro (los viajes no llevan km),
  // así que NO se inventa un número: se avisa que se calcula al cerrar.
  // OMITIDO DELIBERADAMENTE: cualquier línea de "km para el próximo
  // service" — no existe ningún dato de mantenimiento en day-close,
  // shifts ni taxis (la única aparición de "service" en el código es el
  // ejemplo del placeholder de "Aclaraciones").
  function miTaxiHoyHtml(c) {
    if (!c || !c.shift_taxi) {
      return '<div class="card"><h3>Mi taxi hoy</h3><p class="muted">Todavía no empezaste el día.</p><p><button type="button" data-goto="day">Mi día</button></p></div>';
    }
    var entrada = '<p>Taxi: ' + esc(c.shift_taxi) + '</p>';
    if (c.shift_entry_km !== null && c.shift_entry_km !== undefined) {
      entrada = '<p>Taxi: ' + esc(c.shift_taxi) + ' · Entrada: ' + (c.shift_entry_time ? esc(c.shift_entry_time) + ' · ' : '') + esc(c.shift_entry_km) + ' km</p>';
    }
    if (isClosedClose(c)) {
      if (c.km_driven !== null && c.km_driven !== undefined) {
        return '<div class="card"><h3>Mi taxi hoy</h3>' + entrada + '<p>Km recorridos: ' + esc(c.km_driven) + ' km</p></div>';
      }
      return '<div class="card"><h3>Mi taxi hoy</h3>' + entrada + '</div>';
    }
    return '<div class="card"><h3>Mi taxi hoy</h3>' + entrada + '<p class="muted">Km recorridos: se calculan al cerrar el día.</p></div>';
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
    // Estado base del ingreso (por si una sesión anterior dejó algo oculto).
    fixedLogin = null;
    document.getElementById('company-select-block').classList.remove('hidden');
    document.getElementById('fixed-company-name').classList.add('hidden');
    document.getElementById('fixed-user-name').classList.add('hidden');
    document.querySelector('label[for="user-select"]').classList.remove('hidden');
    document.getElementById('user-select').classList.remove('hidden');
    document.getElementById('pin-login-intro').textContent = 'Elegí tu nombre y escribí tu PIN (dueños y choferes entran igual).';
    // El link de un dueño (?login=owner) muestra SOLO el ingreso con email
    // y PIN: no se carga ni se muestra la lista de empresas, así el dueño
    // no ve los nombres de las otras empresas.
    var params = new URLSearchParams(window.location.search);
    var ownerOnly = params.get('login') === 'owner';
    document.getElementById('pin-login-block').classList.toggle('hidden', ownerOnly);
    document.getElementById('owner-login-block').classList.toggle('hidden', !ownerOnly);
    if (ownerOnly) return;
    // Link personal (?company=CODIGO&user=NOMBRE): muestra SOLO ese usuario
    // y el campo de PIN. No se carga ni se muestra ninguna lista: solo ese
    // usuario puede entrar por acá. Si el usuario no existe, vuelve al
    // ingreso con empresa fija.
    var fixedUser = params.get('user');
    var fixedCode = params.get('company');
    if (fixedUser && fixedCode) { loadFixedUser(fixedCode, fixedUser); return; }
    // Si el link ya trae la empresa (?company=CODIGO), no se muestra ni se
    // carga la lista de empresas: se fija esa empresa y punto.
    if (fixedCode) { loadFixedCompany(fixedCode); return; }
    loadCompanies();
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

  // Ingreso con link (?company=CODIGO): fija esa empresa sin cargar ni
  // mostrar la lista completa. Si el código no existe, vuelve al selector.
  async function loadFixedCompany(code) {
    var select = document.getElementById('company-select');
    var block = document.getElementById('company-select-block');
    var fixedEl = document.getElementById('fixed-company-name');
    try {
      var c = await api('/api/company?code=' + encodeURIComponent(code));
      if (!c || !c.id) throw new Error('sin empresa');
      select.innerHTML = '';
      var opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.name + ' (' + c.code + ')';
      select.appendChild(opt);
      select.value = c.id;
      block.classList.add('hidden');
      fixedEl.innerHTML = 'Empresa: <strong>' + esc(c.name) + '</strong>';
      fixedEl.classList.remove('hidden');
      loadLoginUsers(c.id);
    } catch (e) {
      block.classList.remove('hidden');
      fixedEl.classList.add('hidden');
      loadCompanies();
    }
  }

  // Ingreso personal (?company=CODIGO&user=NOMBRE): muestra SOLO ese usuario
  // y el PIN. No se carga la lista de empresas ni la de nombres: solo ese
  // usuario puede entrar por este link. Si algo falla, vuelve al ingreso
  // con empresa fija.
  async function loadFixedUser(code, userName) {
    try {
      var c = await api('/api/company?code=' + encodeURIComponent(code));
      if (!c || !c.id) throw new Error('sin empresa');
      var u = await api('/api/login-users?company_id=' + encodeURIComponent(c.id) + '&name=' + encodeURIComponent(userName));
      if (!u || !u.id) throw new Error('sin usuario');
      fixedLogin = { company_id: c.id, user_id: u.id };
      // Los dos desplegables quedan ocultos pero con su valor puesto: si un
      // campo obligatorio y oculto queda vacío, el navegador bloquea el
      // envío del formulario y el botón Entrar no hace nada.
      var companySelect = document.getElementById('company-select');
      companySelect.innerHTML = '';
      var copt = document.createElement('option');
      copt.value = c.id;
      copt.textContent = c.name + ' (' + c.code + ')';
      companySelect.appendChild(copt);
      companySelect.value = c.id;
      var userSelect = document.getElementById('user-select');
      userSelect.innerHTML = '';
      var uopt = document.createElement('option');
      uopt.value = u.id;
      uopt.textContent = u.name;
      userSelect.appendChild(uopt);
      userSelect.value = u.id;
      document.getElementById('company-select-block').classList.add('hidden');
      document.getElementById('fixed-company-name').classList.add('hidden');
      document.querySelector('label[for="user-select"]').classList.add('hidden');
      document.getElementById('user-select').classList.add('hidden');
      var fixedUserEl = document.getElementById('fixed-user-name');
      fixedUserEl.innerHTML = 'Usuario: <strong>' + esc(u.name) + '</strong>';
      fixedUserEl.classList.remove('hidden');
      document.getElementById('pin-login-intro').textContent = 'Escribí tu PIN para entrar.';
    } catch (e) {
      fixedLogin = null;
      loadFixedCompany(code);
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
      { id: 'inicio', label: 'Inicio' },
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
      { id: 'resumen', label: 'Resumen' },
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
      'inicio': renderInicio,
      'day': renderDay,
      'trips': renderTrips,
      'new-trip': renderNewTrip,
      'expenses': renderExpenses,
      'close': renderMyClose,
      'closes': renderAllCloses,
      'report': renderReport,
      'resumen': renderResumen,
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

  // ---------- Inicio del chofer ----------
  // Pantalla principal del chofer: su turno en curso, lo que va facturando,
  // lo que le queda y lo que debe entregar, un visor para ver cualquier día
  // pasado y sus últimos 14 días en gráficos. Un toque para ir a cada acción:
  // nada de formularios para ver. (day-close ya limita al chofer a su propio
  // cierre: el chofer nunca ve los números de otro.)

  async function renderInicio() {
    var effDate = clampDriverDate(inicioDate) || todayLocal();
    var closes = [];
    try { closes = await api('/api/day-close?date=' + encodeURIComponent(effDate)); } catch (e) { closes = []; }
    var mine = closes.length ? closes[0] : null;
    var dayCard = '';
    if (!mine || (!mine.shift_taxi && !mine.trips_count && !mine.expenses)) {
      dayCard = '<div class="card"><h3>' + esc(effDate) + '</h3><p class="muted">Sin actividad ese día.</p>' +
        (effDate === todayLocal() ? '<p><button type="button" data-goto="day">Empezar el día</button></p>' : '') + '</div>';
    } else {
      var shiftLine = mine.shift_taxi
        ? '<p>Taxi: ' + esc(mine.shift_taxi) +
          (mine.shift_entry_time ? ' · Entrada: ' + esc(mine.shift_entry_time) + ' · ' + esc(mine.shift_entry_km) + ' km' : '') +
          (mine.shift_exit_time ? ' · Salida: ' + esc(mine.shift_exit_time) + ' · ' + esc(mine.shift_exit_km) + ' km' : ' · Jornada abierta') + '</p>' +
          (mine.km_driven !== null && mine.km_driven !== undefined ? '<p>Km recorridos: ' + esc(mine.km_driven) + ' km</p>' : '')
        : '<p class="muted">Sin jornada cargada para ese día.</p>';
      dayCard = '<div class="card"><h3>' + esc(effDate) + '</h3>' + shiftLine +
        '<p>Viajes: ' + esc(mine.trips_count) + '</p>' +
        '<p>Total facturado</p><p class="big-number">' + money(mine.total_collected) + '</p>' +
        '<p>Te quedás: <strong>' + money(mine.driver_keeps) + '</strong></p>' +
        '<p>Gastos: ' + money(mine.expenses) + '</p>' +
        '<p class="money-line">' + handoverCashLine(mine, 'El dueño te debe') + '</p>' + methodsLine(mine) + creditLines(mine) + settlementLine(mine) + '</div>';
    }
    // "Mi taxi hoy" siempre habla de hoy, aunque el chofer esté viendo un
    // día pasado con el selector de fecha: si ya se está viendo hoy se
    // reutiliza mine (sin llamada extra); si no, se pide day-close de
    // hoy. Si esa llamada falla, la tarjeta se omite (no se afirma que
    // "todavía no empezó el día" sobre un dato que no se pudo leer).
    var miTaxiHoyCard = '';
    if (user.role === 'driver') {
      if (effDate === todayLocal()) {
        miTaxiHoyCard = miTaxiHoyHtml(mine);
      } else {
        try {
          var closesToday = await api('/api/day-close?date=' + encodeURIComponent(todayLocal()));
          miTaxiHoyCard = miTaxiHoyHtml(closesToday.length ? closesToday[0] : null);
        } catch (e) { miTaxiHoyCard = ''; }
      }
    }
    var chartHtml = '';
    try {
      var from14 = daysAgoLocal(13);
      var to14 = todayLocal();
      var trips14 = await api('/api/trips?from=' + encodeURIComponent(from14) + '&to=' + encodeURIComponent(to14));
      var exp14 = await api('/api/expenses?from=' + encodeURIComponent(from14) + '&to=' + encodeURIComponent(to14));
      var byDate = {};
      trips14.forEach(function (t) {
        byDate[t.trip_date] = byDate[t.trip_date] || { facturado: 0, gastos: 0 };
        byDate[t.trip_date].facturado += Number(t.amount);
      });
      exp14.forEach(function (g) {
        byDate[g.expense_date] = byDate[g.expense_date] || { facturado: 0, gastos: 0 };
        byDate[g.expense_date].gastos += Number(g.amount);
      });
      var dates = Object.keys(byDate).sort().reverse();
      if (dates.length) {
        var maxV = 0;
        dates.forEach(function (d) { maxV = Math.max(maxV, byDate[d].facturado, byDate[d].gastos); });
        chartHtml = '<h3>Últimos 14 días</h3>' + dates.map(function (d) {
          var pf = maxV > 0 ? Math.round(byDate[d].facturado / maxV * 100) : 0;
          var pg = maxV > 0 ? Math.round(byDate[d].gastos / maxV * 100) : 0;
          return '<div class="card"><p><strong>' + esc(d) + '</strong> · Facturado: ' + money(byDate[d].facturado) + ' · Gastos: ' + money(byDate[d].gastos) + '</p>' +
            '<div class="perf-bar"><div class="perf-bar-fill" style="width: ' + pf + '%"></div></div>' +
            '<div class="perf-bar"><div class="perf-bar-fill-expense" style="width: ' + pg + '%"></div></div></div>';
        }).join('');
      }
    } catch (e) { /* sin gráfico */ }
    contentEl.innerHTML = '<h2>Inicio</h2>' +
      '<form id="inicio-date-form" class="row"><label>Ver día <input name="date" type="date" value="' + esc(effDate) + '"' + (user.role === 'driver' ? ' min="' + driverWindowStart() + '"' : '') + '></label><button type="submit">Ver</button></form>' +
      (user.role === 'driver' ? '<p class="muted">Podés ver hasta 30 días para atrás.</p>' : '') +
      dayCard + miTaxiHoyCard + chartHtml +
      '<p><button type="button" id="switch-driver-btn">Cambiar de chofer</button></p>' +
      '<p class="muted">Si otro chofer agarra este teléfono, cambiá de usuario en un toque: volvés al ingreso de la empresa y elegís tu nombre + PIN.</p>' +
      '<h3>Ir a</h3><div class="row">' +
      '<button type="button" data-goto="day">Mi día</button>' +
      '<button type="button" data-goto="new-trip">Nuevo viaje</button>' +
      '<button type="button" data-goto="expenses">Gastos</button>' +
      '<button type="button" data-goto="close">Cierre del día</button>' +
      '<button type="button" data-goto="pin">Mi PIN</button></div>';
    var dateForm = document.getElementById('inicio-date-form');
    if (dateForm) dateForm.addEventListener('submit', function (ev) {
      ev.preventDefault();
      inicioDate = clampDriverDate(dateForm.date.value) || '';
      renderInicio();
    });
    var switchBtn = document.getElementById('switch-driver-btn');
    if (switchBtn) switchBtn.addEventListener('click', function () {
      // Cambiar de chofer en un teléfono compartido: se cierra la sesión y
      // se vuelve al ingreso de la empresa (sin usuario fijo), así el
      // próximo chofer solo elige su nombre + PIN. La URL se deja solo con
      // ?company= si la había; showLogin ya resuelve empresa fija o lista.
      try {
        var params = new URLSearchParams(window.location.search);
        var code = params.get('company');
        window.history.replaceState(null, '', window.location.pathname + (code ? '?company=' + encodeURIComponent(code) : ''));
      } catch (e) { /* si no se puede, el ingreso igual muestra la empresa */ }
      currentTab = null;
      inicioDate = '';
      logout();
    });
    contentEl.querySelectorAll('[data-goto]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        currentTab = btn.getAttribute('data-goto');
        buildTabs();
      });
    });
  }

  // ---------- Ficha del chofer (desde el Resumen, solo admin) ----------
  // Tocás un chofer en el ranking del Resumen y ves todo de ese chofer:
  // datos, totales del período (el mismo 7/30 días del chip del Resumen),
  // cierres recientes, viajes y gastos. Solo lectura: no edita ni borra
  // nada y no toca la matemática (reutiliza handoverCashLine, creditLines
  // y closeCardsHtml). El chofer nunca llega acá: el Resumen es una
  // pestaña solo del admin y el rol se vuelve a chequear acá.
  async function renderDriverDetail(driverId) {
    if (user.role !== 'admin') return;
    var drivers = [];
    try { drivers = await api('/api/drivers'); } catch (e) { drivers = []; }
    var d = drivers.find(function (x) { return String(x.id) === String(driverId); }) || { name: 'Chofer' };
    var today = todayLocal();
    var from = daysAgoLocal(perfDays === 7 ? 6 : 29);
    var periodLabel = perfDays === 7 ? 'últimos 7 días' : 'últimos 30 días';
    var headCard = '<div class="card"><p><strong>' + esc(d.name) + '</strong>' +
      (d.taxi_identifier ? ' · Taxi: ' + esc(d.taxi_identifier) : '') +
      (d.commission_day_pct !== undefined && d.commission_day_pct !== null ? ' · % día: ' + esc(d.commission_day_pct) : '') +
      (d.commission_night_pct !== undefined && d.commission_night_pct !== null ? ' · % noche: ' + esc(d.commission_night_pct) : '') +
      (d.phone ? ' · ' + esc(d.phone) : '') +
      (d.active !== undefined ? ' · ' + (d.active ? 'Activo' : 'Inactivo') : '') + '</p></div>';
    contentEl.innerHTML = '<p><button type="button" id="driver-detail-back">← Volver al Resumen</button></p>' +
      '<h2>Ficha del chofer</h2>' + headCard + '<p class="muted">Cargando…</p>';
    document.getElementById('driver-detail-back').addEventListener('click', function () { renderResumen(); });

    var rep = null;
    try { rep = await api('/api/report?driver_id=' + encodeURIComponent(driverId) + '&from=' + encodeURIComponent(from) + '&to=' + encodeURIComponent(today)); } catch (e) { rep = null; }
    var totalsHtml = '<p class="muted">Sin datos del período.</p>';
    if (rep && rep.totals) {
      var t = rep.totals;
      var tClose = { handover_net: t.handover_net, handover_cash: t.handover_cash, credit_applied: t.credit_applied, credit_before: t.opening_credit, credit_after: t.credit_closing, shift_exit_km: 0 };
      totalsHtml = '<div class="card"><p>Total facturado (' + periodLabel + ')</p><p class="big-number">' + money(t.total) + '</p>' +
        '<p>' + esc(t.trips_count) + ' viajes · Efectivo: ' + money(t.cash_total) + ' · Se queda: ' + money(t.driver_keeps) + ' · Gastos: ' + money(t.expenses) + '</p>' +
        '<p class="money-line">' + handoverCashLine(tClose, 'El dueño le debe') + '</p>' + creditLines(tClose) +
        (t.unclassified_total > 0 ? '<p class="muted">Sin método (sin clasificar, no entra en el efectivo): ' + money(t.unclassified_total) + '</p>' : '') +
        (t.km ? '<p class="muted">' + esc(t.km) + ' km' + (t.avg_per_km !== null && t.avg_per_km !== undefined ? ' · ' + money(t.avg_per_km) + '/km' : '') + '</p>' : '') + '</div>';
    }

    // Cierres recientes: los últimos 7 días, solo los días con actividad
    // (jornada, viajes o gastos). Cada cierre ya trae su cadena en
    // efectivo y sus líneas de saldo a favor, así que se reutiliza
    // closeCardsHtml tal cual se ve en Cierres.
    var recentCloses = [];
    try {
      var dates = [];
      for (var i = 0; i < 7; i++) dates.push(daysAgoLocal(i));
      var all = await Promise.all(dates.map(function (dt) { return api('/api/day-close?date=' + encodeURIComponent(dt)).catch(function () { return []; }); }));
      all.forEach(function (closes) {
        var mine = closes.find(function (c) { return String(c.driver_id) === String(driverId); });
        if (mine && (mine.shift_entry_time || Number(mine.trips_count) > 0 || Number(mine.expenses) > 0)) recentCloses.push(mine);
      });
    } catch (e) { recentCloses = []; }

    var trips = [];
    try {
      trips = await api('/api/trips?driver_id=' + encodeURIComponent(driverId) + '&limit=all');
      trips.sort(function (a, b) {
        if (a.trip_date !== b.trip_date) return a.trip_date < b.trip_date ? 1 : -1;
        return Number(b.id) - Number(a.id);
      });
      trips = trips.slice(0, 20);
    } catch (e) { trips = []; }
    var tripRows = trips.map(function (tr) {
      return '<div class="card"><p><strong>' + esc(tr.trip_date) + '</strong>' +
        (tr.taxi_identifier ? ' · ' + esc(tr.taxi_identifier) : '') + ' · Turno: ' + (tr.shift_type === 'night' ? 'Noche' : 'Día') + '</p>' +
        '<p>Monto: ' + money(tr.amount) + ' · %: ' + esc(tr.pct_snapshot) + '% · Te quedás: ' + money(tr.driver_keeps) + ' · Dueño: ' + money(tr.owner_share) + (tr.payment_method_name ? ' · Pago: ' + esc(tr.payment_method_name) : '') + '</p></div>';
    }).join('');

    var expenses = [];
    try {
      expenses = await api('/api/expenses?driver_id=' + encodeURIComponent(driverId) + '&limit=all');
      expenses.sort(function (a, b) {
        if (a.expense_date !== b.expense_date) return a.expense_date < b.expense_date ? 1 : -1;
        return Number(b.id) - Number(a.id);
      });
      expenses = expenses.slice(0, 20);
    } catch (e) { expenses = []; }
    var expRows = expenses.map(function (g) {
      return '<div class="card"><p><strong>' + esc(g.expense_date) + '</strong> · ' + esc(g.type) + ' · ' + money(g.amount) + '</p>' +
        (g.note ? '<p>' + esc(g.note) + '</p>' : '') +
        (g.has_receipt ? '<button type="button" class="small" data-receipt-expense="' + g.id + '">Ver factura</button>' : '') + '</div>';
    }).join('');

    contentEl.innerHTML = '<p><button type="button" id="driver-detail-back">← Volver al Resumen</button></p>' +
      '<h2>Ficha del chofer</h2>' + headCard +
      '<div id="driver-notes-section"></div>' +
      '<h3>Totales (' + periodLabel + ')</h3>' + totalsHtml +
      '<h3>Últimos cierres</h3>' + (recentCloses.length ? closeCardsHtml(recentCloses, true) : '<p class="muted">Sin cierres con actividad en los últimos 7 días.</p>') +
      '<h3>Últimos viajes</h3>' + (tripRows || '<p class="muted">Sin viajes.</p>') +
      '<h3>Últimos gastos</h3>' + (expRows || '<p class="muted">Sin gastos.</p>');
    document.getElementById('driver-detail-back').addEventListener('click', function () { renderResumen(); });
    contentEl.querySelectorAll('[data-receipt-expense]').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        try {
          var data = await api('/api/expenses?receipt=' + btn.getAttribute('data-receipt-expense'));
          showReceiptImage(data.image);
        } catch (e) { showMessage(e.message, 'error'); }
      });
    });
    // Notas y valoración privada del dueño (solo admin: renderDriverDetail
    // ya retornó si el rol no es admin, y esta sección solo existe en la
    // ficha del Resumen). El chofer nunca ve esta sección ni estos datos:
    // ninguna vista del chofer llama a /api/drivers?notes= ni ?rating=.
    var notesEl = document.getElementById('driver-notes-section');
    async function loadOwnerNotes() {
      if (!notesEl || !d.id) { if (notesEl) notesEl.innerHTML = ''; return; }
      try {
        var data = await api('/api/drivers?notes=' + encodeURIComponent(d.id));
        var rating = (data.owner_rating === null || data.owner_rating === undefined) ? '' : data.owner_rating;
        var notesHtml = (data.notes || []).map(function (n) {
          return '<div class="card"><p>' + esc(n.note) + '</p>' +
            '<p class="muted">' + esc(String(n.created_at || '').slice(0, 16).replace('T', ' ')) +
            ' <button type="button" class="small" data-del-note="' + n.id + '">Borrar</button></p></div>';
        }).join('');
        notesEl.innerHTML = '<h3>Notas del dueño</h3>' +
          '<p class="muted">Solo vos ves estas notas y esta valoración. El chofer no las ve.</p>' +
          '<label>Valoración <select id="owner-rating-select">' +
          '<option value="">Sin valorar</option>' +
          '<option value="1"' + (String(rating) === '1' ? ' selected' : '') + '>1 ★</option>' +
          '<option value="2"' + (String(rating) === '2' ? ' selected' : '') + '>2 ★★</option>' +
          '<option value="3"' + (String(rating) === '3' ? ' selected' : '') + '>3 ★★★</option>' +
          '<option value="4"' + (String(rating) === '4' ? ' selected' : '') + '>4 ★★★★</option>' +
          '<option value="5"' + (String(rating) === '5' ? ' selected' : '') + '>5 ★★★★★</option>' +
          '</select></label>' +
          (notesHtml || '<p class="muted">Sin notas todavía.</p>') +
          '<label>Nota nueva <textarea id="owner-note-text" rows="3"></textarea></label>' +
          '<p><button type="button" id="owner-note-save">Guardar nota</button></p>';
        document.getElementById('owner-rating-select').addEventListener('change', async function () {
          try {
            var val = document.getElementById('owner-rating-select').value;
            await api('/api/drivers?rating=' + encodeURIComponent(d.id), 'PUT', { owner_rating: val === '' ? null : Number(val) });
            showMessage('Valoración guardada.', 'ok');
          } catch (e) { showMessage(e.message, 'error'); loadOwnerNotes(); }
        });
        document.getElementById('owner-note-save').addEventListener('click', async function () {
          var textEl = document.getElementById('owner-note-text');
          var text = textEl.value.trim();
          if (!text) { showMessage('Escribí una nota antes de guardar.', 'error'); return; }
          try {
            await api('/api/drivers?notes=' + encodeURIComponent(d.id), 'POST', { note: text });
            showMessage('Nota guardada.', 'ok');
            loadOwnerNotes();
          } catch (e) { showMessage(e.message, 'error'); }
        });
        notesEl.querySelectorAll('[data-del-note]').forEach(function (btn) {
          btn.addEventListener('click', async function () {
            if (!confirm('¿Borrar esta nota?')) return;
            try {
              await api('/api/drivers?notes=' + encodeURIComponent(d.id) + '&note_id=' + encodeURIComponent(btn.getAttribute('data-del-note')), 'DELETE');
              showMessage('Nota borrada.', 'ok');
              loadOwnerNotes();
            } catch (e) { showMessage(e.message, 'error'); }
          });
        });
      } catch (e) { notesEl.innerHTML = '<p class="error">' + esc(e.message) + '</p>'; }
    }
    loadOwnerNotes();
    wireSettleButtons(function () { renderDriverDetail(driverId); });
  }

  // ---------- Mi día (jornada) ----------
  // Al entrar, el chofer carga hora y km de entrada (y el taxi del día).
  // Al terminar, pulsa "Cerrar el día" y carga hora y km de cierre.
  // Después del cierre se muestra el resumen del día.

  // Relevo al empezar el día (ver renderDay, rama sin jornada).
  // relevo: { driver_name, exit_time, exit_km } del último cierre de otro
  // chofer hoy en el taxi elegido, o null. Solo precarga: el chofer puede
  // corregir hora y km antes de enviar; nunca se envía nada por sí solo.
  // tocado: { time, km } — si el chofer ya escribió en un campo, ese
  // campo NO se precarga (nunca se pisa lo que ya escribió).
  function relevoBanner(relevo) {
    if (!relevo || !relevo.driver_name) return '';
    return '<p class="muted" id="relevo-banner">Relevo de ' + esc(relevo.driver_name) +
      ' · El taxi quedó con ' + esc(relevo.exit_km) + ' km a las ' + esc(String(relevo.exit_time).slice(0, 5)) +
      '. Se precargaron hora y km de entrada; podés corregirlos.</p>';
  }
  function relevoPrefill(form, relevo, tocado) {
    if (!form || !relevo) return false;
    if (relevo.exit_km === null || relevo.exit_km === undefined) return false;
    if (relevo.exit_time === null || relevo.exit_time === undefined) return false;
    if (!tocado || !tocado.km) form.entry_km.value = relevo.exit_km;
    if (!tocado || !tocado.time) form.entry_time.value = String(relevo.exit_time).slice(0, 5);
    return true;
  }
  async function relevoBuscar(taxiId, date) {
    if (!taxiId || !date) return null;
    try {
      var r = await api('/api/shifts?last_closed_taxi=' + encodeURIComponent(taxiId) + '&date=' + encodeURIComponent(date));
      return r || null;
    } catch (e) { return null; }
  }
  // Línea en vivo de la entrega al cerrar (rama jornada abierta).
  // Solo texto: no bloquea, no pide confirm extra. Sin número, vacía.
  // Se conserva el texto tipeado tal cual (no se reformatea el número).
  function entregaTaxiLinea(exitKm) {
    if (exitKm === '' || exitKm === null || exitKm === undefined) return '';
    if (!isFinite(Number(exitKm))) return '';
    return 'Entregás el taxi con ' + String(exitKm) + ' km';
  }

  async function renderDay() {
    var taxis = [];
    try { taxis = await api('/api/taxis'); } catch (e) { taxis = []; }
    contentEl.innerHTML = '<h2>Mi día</h2>' +
      '<label>Fecha <input id="day-date" type="date" value="' + todayLocal() + '"' + (user.role === 'driver' ? ' min="' + driverWindowStart() + '"' : '') + '></label>' +
      (user.role === 'driver' ? '<p class="muted">Podés ver hasta 30 días para atrás.</p>' : '') +
      '<div id="day-state"></div>';
    var dateInput = document.getElementById('day-date');
    var stateEl = document.getElementById('day-state');

    function taxiSelect(selectedId) {
      return '<label>Taxi del día <select name="taxi_id" required><option value="">Elegí el taxi…</option>' + taxis.map(function (t) {
        return '<option value="' + t.id + '"' + (selectedId === t.id ? ' selected' : '') + '>' + esc(t.identifier) + '</option>';
      }).join('') + '</select></label>';
    }

    async function load() {
      // El chofer solo ve 30 días para atrás: una fecha más vieja se
      // ajusta al primer día visible (el backend, además, no devuelve
      // nada para fechas fuera de la ventana).
      var date = clampDriverDate(dateInput.value);
      if (date !== dateInput.value) dateInput.value = date;
      try {
        var shifts = await api('/api/shifts?date=' + encodeURIComponent(date));
        var s = shifts && shifts[0] ? shifts[0] : null;
        if (!s) {
          // Sin jornada: entrada del día. La hora se precarga con la actual
          // y la ubicación se captura del teléfono (si da permiso).
          var entryGeo = null;
          stateEl.innerHTML = '<div class="steps"><span class="step active">1 · Empezar</span><span class="step">2 · Cerrar</span><span class="step">3 · Listo</span></div>' + '<form id="day-start-form" class="row">' + taxiSelect(user.taxi_id) +
            '<label>Hora de entrada <input name="entry_time" type="time" value="' + nowTimeLocal() + '" required></label>' +
            '<label>Km del auto <input name="entry_km" type="number" step="0.01" min="0" required></label>' +
            '<button type="submit">Empezar día</button></form>' +
            '<div id="relevo-box"></div>' +
            '<p class="muted" id="day-geo-status">Detectando ubicación…</p>' +
            '<p class="muted">Al entrar, cargá la hora y el kilometraje con el que agarrás el auto.</p>';
          // Relevo: al cambiar el taxi, y al renderizar si ya hay uno
          // preseleccionado (taxi asignado del chofer), buscar el último
          // cierre de otro chofer en el día seleccionado para ese taxi y
          // precargar con él. Solo defaults editables; si no hay cierre,
          // nada cambia y el cartel queda vacío. El aviso de taxi con
          // jornada ABIERTA sigue aparte, en el submit (confirm), sin tocar.
          // El contador relevoSeq descarta respuestas viejas si el chofer
          // cambia de taxi varias veces seguidas antes de que respondan.
          var startForm = document.getElementById('day-start-form');
          var relevoBox = document.getElementById('relevo-box');
          var relevoSeq = 0;
          // Si el chofer escribe hora o km mientras responde la búsqueda
          // de relevo, ese campo no se precarga: nunca se pisa lo tipeado.
          var relevoTocado = { time: false, km: false };
          startForm.entry_time.addEventListener('input', function () { relevoTocado.time = true; });
          startForm.entry_km.addEventListener('input', function () { relevoTocado.km = true; });
          async function aplicarRelevo() {
            if (!startForm || !relevoBox) return;
            var seq = ++relevoSeq;
            var r = await relevoBuscar(startForm.taxi_id.value, date);
            if (seq !== relevoSeq) return;
            if (r) {
              relevoPrefill(startForm, r, relevoTocado);
              relevoBox.innerHTML = relevoBanner(r);
            } else {
              relevoBox.innerHTML = '';
            }
          }
          startForm.taxi_id.addEventListener('change', aplicarRelevo);
          if (startForm.taxi_id.value) aplicarRelevo();
          captureLocation(function (geo) {
            entryGeo = geo;
            var st = document.getElementById('day-geo-status');
            if (st) st.textContent = geo ? 'Ubicación de entrada detectada.' : 'Sin ubicación (revisá los permisos del navegador).';
          });
          document.getElementById('day-start-form').addEventListener('submit', async function (ev) {
            ev.preventDefault();
            var f = ev.target;
            // Fecha, taxi y km son obligatorios. La fecha vive fuera del
            // formulario (el required de HTML no la frena) y el taxi ya
            // no puede quedar vacío ni caer en el primero de la lista
            // sin que el chofer lo elija. Hora y km ya eran required.
            if (!date) { showMessage('Elegí la fecha del día.', 'error'); return; }
            if (!f.taxi_id.value) { showMessage('Elegí el taxi del día.', 'error'); return; }
            // Aviso si otro chofer ya tiene abierta la jornada de este taxi
            // hoy: se nombra al chofer y se pide confirmación antes de abrir
            // una segunda jornada en el mismo auto.
            try {
              var open = [];
              try { open = await api('/api/shifts?open_taxi=' + encodeURIComponent(f.taxi_id.value) + '&date=' + encodeURIComponent(date)); } catch (e) { open = []; }
              if (open.length) {
                var taxiName = (taxis.find(function (t) { return String(t.id) === String(f.taxi_id.value); }) || {}).identifier || 'elegido';
                var names = open.map(function (o) { return o.driver_name; }).join(', ');
                if (!confirm('El taxi ' + taxiName + ' ya tiene jornada abierta hoy por ' + names + '. ¿Igual querés empezar tu día en este taxi?')) return;
              }
            } catch (e) { /* sin aviso, se sigue igual */ }
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
          // Acciones rápidas del día (solo chofer): al arrancar el día el
          // chofer cae acá y tiene que poder cargar viajes y gastos sin
          // quedarse trabado en el formulario de cierre. Reutilizan la
          // navegación data-goto existente; "Cerrar día" baja al formulario
          // de cierre que está justo debajo.
          var quickActions = user.role === 'driver'
            ? '<div class="row"><button type="button" data-goto="new-trip">Cargar viaje</button>' +
              '<button type="button" data-goto="expenses">Cargar gasto</button>' +
              '<button type="button" id="day-goto-close-btn">Cerrar día</button></div>'
            : '';
          stateEl.innerHTML = '<div class="steps"><span class="step done">1 · Empezar</span><span class="step active">2 · Cerrar</span><span class="step">3 · Listo</span></div>' + '<p>Taxi del día: <strong>' + esc(s.taxi_identifier || '—') + '</strong> · Entrada: ' + esc(s.entry_time) + ' · ' + esc(s.entry_km) + ' km' + mapLink(s.entry_lat, s.entry_lng, 'Ver entrada en mapa') + '</p>' + quickActions +
            '<form id="day-close-form" class="row">' +
            '<label>Hora de cierre <input name="exit_time" type="time" value="' + nowTimeLocal() + '" required></label>' +
            '<label>Km con el que queda el auto <input name="exit_km" type="number" step="0.01" min="0" required></label>' +
            '<label>Aclaraciones (opcional) <textarea name="note" rows="2" placeholder="Ej: llevé el auto a service, fui a hacer mandados"></textarea></label>' +
            '<button type="submit">Cerrar el día</button></form>' +
            '<p class="muted" id="day-close-checklist"></p>' +
            '<p class="muted" id="entrega-linea"></p>' +
            '<p class="muted" id="day-geo-status">Detectando ubicación…</p>';
          // Línea en vivo de la entrega: se actualiza mientras se escribe
          // el km de cierre; no bloquea, no pide confirm extra, no toca
          // la validación kmCierreValido del submit.
          (function () {
            var closeForm = document.getElementById('day-close-form');
            var linea = document.getElementById('entrega-linea');
            if (!closeForm || !linea) return;
            closeForm.exit_km.addEventListener('input', function () {
              linea.textContent = entregaTaxiLinea(closeForm.exit_km.value);
            });
          })();
          var checklistPendientes = null;
          cargarPendientesCierre(date, s.driver_id).then(function (p) {
            checklistPendientes = p;
            mostrarAvisoCierre(p);
          });
          captureLocation(function (geo) {
            exitGeo = geo;
            var st = document.getElementById('day-geo-status');
            if (st) st.textContent = geo ? 'Ubicación de salida detectada.' : 'Sin ubicación (revisá los permisos del navegador).';
          });
          document.getElementById('day-close-form').addEventListener('submit', async function (ev) {
            ev.preventDefault();
            var f = ev.target;
            if (!kmCierreValido(s.entry_km, f.exit_km.value)) return;
            if (checklistPendientes && checklistPendientes.total > 0 && !confirm(textoConfirmCierre(checklistPendientes))) return;
            var body = {
              shift_date: date,
              taxi_id: s.taxi_id,
              entry_time: s.entry_time,
              entry_km: s.entry_km,
              exit_time: f.exit_time.value,
              exit_km: f.exit_km.value,
              note: f.note.value,
            };
            if (exitGeo) { body.exit_lat = exitGeo.lat; body.exit_lng = exitGeo.lng; }
            try {
              await api('/api/shifts', 'POST', body);
              showMessage('Día cerrado.', 'ok');
              load();
            } catch (e) { showMessage(e.message, 'error'); }
          });
          stateEl.querySelectorAll('[data-goto]').forEach(function (btn) {
            btn.addEventListener('click', function () {
              currentTab = btn.getAttribute('data-goto');
              buildTabs();
            });
          });
          var gotoCloseBtn = document.getElementById('day-goto-close-btn');
          if (gotoCloseBtn) gotoCloseBtn.addEventListener('click', function () {
            var form = document.getElementById('day-close-form');
            if (form) {
              form.scrollIntoView();
              var t = form.querySelector('input[name="exit_time"]');
              if (t) t.focus();
            }
          });
        } else {
          // Día cerrado: resumen + cierre.
          var closes = await api('/api/day-close?date=' + encodeURIComponent(date));
          var kmLine = (s.km_driven !== null && s.km_driven !== undefined)
            ? ' · Km recorridos: <strong>' + esc(s.km_driven) + ' km</strong>' : '';
          var exitLine = (s.exit_time ? ' · Cierre: ' + esc(s.exit_time) : '') +
            (s.exit_km !== null ? ' · ' + esc(s.exit_km) + ' km' : '');
          stateEl.innerHTML = '<div class="steps"><span class="step done">1 · Empezar</span><span class="step done">2 · Cerrar</span><span class="step active">3 · Listo</span></div>' + '<p><strong>Día cerrado.</strong> Taxi: ' + esc(s.taxi_identifier || '—') +
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
        '<label>Aclaraciones (opcional) <textarea name="note" rows="2" placeholder="Ej: llevé el auto a service, fui a hacer mandados">' + esc(s.note || '') + '</textarea></label>' +
        '<button type="submit">Guardar día</button></form>';
      document.getElementById('day-edit-form').addEventListener('submit', async function (ev) {
        ev.preventDefault();
        var f = ev.target;
        if (!kmCierreValido(f.entry_km.value, f.exit_km.value)) return;
        try {
          await api('/api/shifts', 'POST', {
            shift_date: dateInput.value,
            taxi_id: f.taxi_id.value,
            entry_time: f.entry_time.value,
            entry_km: f.entry_km.value,
            exit_time: f.exit_time.value || null,
            exit_km: f.exit_km.value === '' ? null : f.exit_km.value,
            note: f.note.value,
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
    var tripsQuery = [];
    // Rango rápido del chofer (7/14/30 días): manda sobre el filtro de día.
    if (user.role === 'driver' && tripsRange) {
      tripsQuery.push('from=' + encodeURIComponent(daysAgoLocal(tripsRange - 1)));
      tripsQuery.push('to=' + encodeURIComponent(todayLocal()));
    } else if (tripsFilter.date) {
      tripsQuery.push('date=' + encodeURIComponent(tripsFilter.date));
    }
    if (tripsFilter.taxi_id) tripsQuery.push('taxi_id=' + encodeURIComponent(tripsFilter.taxi_id));
    if (tripsFilter.driver_id) tripsQuery.push('driver_id=' + encodeURIComponent(tripsFilter.driver_id));
    // "Ver todos" ilimitado es solo del admin: el chofer tiene rangos.
    if (tripsShowAll && user.role === 'admin') tripsQuery.push('limit=all');
    var trips = await api('/api/trips' + (tripsQuery.length ? '?' + tripsQuery.join('&') : ''));
    var methods = [];
    try { methods = await api('/api/trips?methods=1'); } catch (e) { methods = []; }
    var taxis = [];
    try { taxis = await api('/api/taxis'); } catch (e) { taxis = []; }
    var drivers = [];
    if (user.role === 'admin') {
      try { drivers = await api('/api/drivers'); } catch (e) { drivers = []; }
    }
    var title = user.role === 'admin' ? 'Todos los viajes' : 'Mis viajes';
    var rows = trips.map(function (t) {
      var shiftLine = t.entry_time
        ? '<p>Entrada: ' + esc(t.entry_time) + ' · ' + esc(t.entry_km) + ' km — Salida: ' + esc(t.exit_time) + ' · ' + esc(t.exit_km) + ' km</p>'
        : '';
      return '<div class="card"><p><strong>' + esc(t.trip_date) + '</strong> · ' + esc(t.driver_name || user.name) +
        (t.taxi_identifier ? ' · ' + esc(t.taxi_identifier) : '') + ' · Turno: ' + (t.shift_type === 'night' ? 'Noche' : 'Día') + mapLink(t.trip_lat, t.trip_lng, 'Mapa') + '</p>' + shiftLine +
        '<p>Monto: ' + money(t.amount) + ' · %: ' + esc(t.pct_snapshot) + '% · Te quedás: ' + money(t.driver_keeps) + ' · Dueño: ' + money(t.owner_share) + (t.payment_method_name ? ' · Pago: ' + esc(t.payment_method_name) : '') + (t.destination ? ' · Destino: ' + esc(t.destination) : '') + '</p>' +
        '<button type="button" class="secondary small" data-edit-trip="' + t.id + '">Editar</button> ' +
        '<button type="button" class="danger small" data-del-trip="' + t.id + '">Borrar</button></div>';
    }).join('');
    var taxiOptions = '<option value="">Todos los autos</option>' + taxis.map(function (t) {
      return '<option value="' + t.id + '"' + (String(t.id) === tripsFilter.taxi_id ? ' selected' : '') + '>' + esc(t.identifier) + '</option>';
    }).join('');
    var driverFilterHtml = '';
    if (user.role === 'admin') {
      driverFilterHtml = '<label>Chofer <select name="driver_id"><option value="">Todos los choferes</option>' + drivers.filter(function (d) { return d.active; }).map(function (d) {
        return '<option value="' + d.id + '"' + (String(d.id) === tripsFilter.driver_id ? ' selected' : '') + '>' + esc(d.name) + '</option>';
      }).join('') + '</select></label>';
    }
    var filterHtml = '<form id="trips-filter" class="row">' +
      '<label>Día <input name="date" type="date" value="' + esc(tripsFilter.date) + '"' + (user.role === 'driver' ? ' min="' + driverWindowStart() + '"' : '') + '></label>' +
      '<label>Auto <select name="taxi_id">' + taxiOptions + '</select></label>' +
      driverFilterHtml +
      '<button type="button" id="trips-filter-clear">Limpiar filtros</button></form>';
    var limitRow;
    if (user.role === 'driver') {
      // El chofer no tiene "Ver todos" ilimitado: hoy, o un rango rápido
      // (última semana / últimas 2 semanas / último mes, tope 30 días).
      var tripsRangeBtns = [7, 14, 30].map(function (n) {
        return '<button type="button" class="chip' + (tripsRange === n ? ' active' : '') + '" data-trips-range="' + n + '">' + (n === 7 ? 'Última semana' : (n === 14 ? 'Últimas 2 semanas' : 'Último mes')) + '</button>';
      }).join(' ');
      limitRow = '<p class="muted">' + (tripsRange
        ? 'Mostrando viajes de ' + driverRangeLabel(tripsRange) + '.'
        : 'Mostrando los últimos 100 viajes' + (tripsFilter.date ? ' del ' + esc(tripsFilter.date) : '') + '.') +
        '</p><p><button type="button" id="trips-range-clear">Hoy</button> ' + tripsRangeBtns + '</p>' +
        '<p class="muted">Podés ver hasta 30 días para atrás.</p>';
    } else {
      limitRow = tripsShowAll
        ? '<p><button type="button" id="trips-show-less">Ver solo hoy</button></p>'
        : '<p class="muted">Mostrando los últimos 100 viajes' + (tripsFilter.date ? ' del ' + esc(tripsFilter.date) : '') + '. <button type="button" id="trips-show-all">Ver todos</button></p>';
    }
    contentEl.innerHTML = '<h2>' + title + '</h2>' + filterHtml + limitRow + (rows || '<p class="muted">Todavía no hay viajes.</p>');
    var filterForm = document.getElementById('trips-filter');
    if (filterForm) {
      filterForm.addEventListener('change', function () {
        // Si se elige un día, manda sobre el rango; si solo cambia el
        // auto, el rango se mantiene. Un día más viejo que 30 días se
        // ajusta al primer día visible (solo chofer).
        if (filterForm.date.value) {
          tripsRange = null;
          tripsFilter.date = clampDriverDate(filterForm.date.value);
        }
        tripsFilter.taxi_id = filterForm.taxi_id.value;
        tripsFilter.driver_id = filterForm.driver_id ? filterForm.driver_id.value : '';
        renderTrips();
      });
      filterForm.addEventListener('submit', function (ev) { ev.preventDefault(); });
      var clearBtn = document.getElementById('trips-filter-clear');
      if (clearBtn) clearBtn.addEventListener('click', function () {
        tripsFilter.date = todayLocal(); tripsFilter.taxi_id = ''; tripsFilter.driver_id = '';
        tripsShowAll = false;
        tripsRange = null;
        renderTrips();
      });
    }
    var showAllBtn = document.getElementById('trips-show-all');
    if (showAllBtn) showAllBtn.addEventListener('click', function () { tripsShowAll = true; tripsFilter.date = ''; renderTrips(); });
    var showLessBtn = document.getElementById('trips-show-less');
    if (showLessBtn) showLessBtn.addEventListener('click', function () { tripsShowAll = false; tripsFilter.date = todayLocal(); renderTrips(); });
    contentEl.querySelectorAll('[data-trips-range]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        tripsRange = Number(btn.getAttribute('data-trips-range'));
        tripsShowAll = false;
        tripsFilter.date = '';
        renderTrips();
      });
    });
    var tripsRangeClear = document.getElementById('trips-range-clear');
    if (tripsRangeClear) tripsRangeClear.addEventListener('click', function () {
      tripsRange = null;
      tripsShowAll = false;
      tripsFilter.date = todayLocal();
      renderTrips();
    });
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
          '<label>Monto ($) <input name="amount" type="number" step="0.01" min="0" value="' + esc(t.amount) + '" required></label>' +
          '<label>Propina (opcional) <input name="tip" type="number" step="0.01" min="0" value="' + esc(t.tip) + '"></label>' +
          '<label>Destino o zona (opcional) <input name="destination" type="text" maxlength="200" value="' + esc(t.destination) + '"></label>' +
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
              tip: f.tip.value,
              destination: f.destination.value,
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
      '<label>Monto del viaje ($) <input name="amount" type="number" step="0.01" min="0" required></label>' +
      '<label>Propina (opcional) <input name="tip" type="number" step="0.01" min="0"></label>' +
      '<label>Destino o zona (opcional) <input name="destination" type="text" maxlength="200"></label>' +
      '<button type="submit">Guardar viaje</button></form>' +
      '<p class="muted" id="trip-geo-status">Detectando ubicación…</p>' +
      '<p class="muted">Solo el monto: la hora y el kilometraje van en "Mi día". El % que se aplica es el de tu turno (día o noche), puesto por el administrador.' + pctNote + ' Si cambia después, tus viajes viejos no cambian.</p>';
  }

  async function renderNewTrip() {
    var tripGeo = null;
    var methods = [];
    try { methods = await api('/api/trips?methods=1'); } catch (e) { methods = []; }
    // Chofer sin día empezado hoy: no se muestra el formulario y se lo
    // manda a empezar el día. Si la consulta falla, se muestra el
    // formulario igual y el backend rechaza el viaje si no hay jornada.
    // El admin siempre ve el formulario (carga y corrige cualquier día).
    if (user.role === 'driver') {
      var todayShifts = null;
      try { todayShifts = await api('/api/shifts?date=' + encodeURIComponent(todayLocal())); } catch (e) { todayShifts = null; }
      if (todayShifts !== null && !todayShifts.length) {
        contentEl.innerHTML = '<h2>Nuevo viaje</h2><p>Para cargar viajes primero tenés que empezar el día.</p><p><button type="button" data-goto="day">Empezar el día</button></p>';
        contentEl.querySelectorAll('[data-goto]').forEach(function (btn) {
          btn.addEventListener('click', function () {
            currentTab = btn.getAttribute('data-goto');
            buildTabs();
          });
        });
        return;
      }
    }
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
        tip: f.tip.value,
        destination: f.destination.value,
      };
      if (tripGeo) { body.trip_lat = tripGeo.lat; body.trip_lng = tripGeo.lng; }
      try {
        var created = await api('/api/trips', 'POST', body);
        showMessage('Viaje guardado. Te quedás ' + money(created.driver_keeps) + ' y al dueño le van ' + money(created.owner_share) + '.', 'ok');
        // Quedarse en el formulario para seguir agregando: antes saltaba
        // a la lista de viajes y había que volver a entrar por cada uno.
        // Solo se limpian los campos propios de cada viaje (monto,
        // propina, destino); fecha, turno y método quedan como estaban.
        // Se enfoca el monto para el próximo viaje y se refresca la
        // ubicación. Los gastos ya volvían solos a su página.
        f.amount.value = '';
        f.tip.value = '';
        f.destination.value = '';
        if (f.amount.focus) f.amount.focus();
        tripGeo = null;
        captureLocation(function (geo) {
          tripGeo = geo;
          var st = document.getElementById('trip-geo-status');
          if (st) st.textContent = geo ? 'Ubicación del viaje detectada.' : 'Sin ubicación (revisá los permisos del navegador).';
        });
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
    var expensesQuery = [];
    // Rango rápido del chofer (7/14/30 días): manda sobre el filtro de día.
    if (user.role === 'driver' && expensesRange) {
      expensesQuery.push('from=' + encodeURIComponent(daysAgoLocal(expensesRange - 1)));
      expensesQuery.push('to=' + encodeURIComponent(todayLocal()));
    } else if (expensesFilter.date) {
      expensesQuery.push('date=' + encodeURIComponent(expensesFilter.date));
    }
    if (expensesFilter.taxi_id) expensesQuery.push('taxi_id=' + encodeURIComponent(expensesFilter.taxi_id));
    if (expensesFilter.driver_id) expensesQuery.push('driver_id=' + encodeURIComponent(expensesFilter.driver_id));
    // "Ver todos" ilimitado es solo del admin: el chofer tiene rangos.
    if (expensesShowAll && user.role === 'admin') expensesQuery.push('limit=all');
    var expenses = await api('/api/expenses' + (expensesQuery.length ? '?' + expensesQuery.join('&') : ''));
    var taxis = [];
    try { taxis = await api('/api/taxis'); } catch (e) { taxis = []; }
    var drivers = [];
    if (user.role === 'admin') {
      try { drivers = await api('/api/drivers'); } catch (e) { drivers = []; }
    }
    var title = user.role === 'admin' ? 'Todos los gastos' : 'Mis gastos';
    var formHtml = '';
    if (user.role === 'driver') {
      formHtml = '<h3>Nuevo gasto</h3><form id="expense-form">' +
        '<label>Fecha <input name="expense_date" type="date" value="' + todayLocal() + '" required></label>' +
        '<label>Tipo <select name="type"><option value="gasolina">Gasolina</option><option value="arreglos">Arreglos</option><option value="otros">Otros</option></select></label>' +
        '<label>Monto ($) <input name="amount" type="number" step="0.01" min="0" required></label>' +
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
    var taxiOptions = '<option value="">Todos los autos</option>' + taxis.map(function (t) {
      return '<option value="' + t.id + '"' + (String(t.id) === expensesFilter.taxi_id ? ' selected' : '') + '>' + esc(t.identifier) + '</option>';
    }).join('');
    var driverFilterHtml = '';
    if (user.role === 'admin') {
      driverFilterHtml = '<label>Chofer <select name="driver_id"><option value="">Todos los choferes</option>' + drivers.filter(function (d) { return d.active; }).map(function (d) {
        return '<option value="' + d.id + '"' + (String(d.id) === expensesFilter.driver_id ? ' selected' : '') + '>' + esc(d.name) + '</option>';
      }).join('') + '</select></label>';
    }
    var filterHtml = '<form id="expenses-filter" class="row">' +
      '<label>Día <input name="date" type="date" value="' + esc(expensesFilter.date) + '"' + (user.role === 'driver' ? ' min="' + driverWindowStart() + '"' : '') + '></label>' +
      '<label>Auto <select name="taxi_id">' + taxiOptions + '</select></label>' +
      driverFilterHtml +
      '<button type="button" id="expenses-filter-clear">Limpiar filtros</button></form>';
    var expensesLimitRow;
    if (user.role === 'driver') {
      // El chofer no tiene "Ver todos" ilimitado: hoy, o un rango rápido
      // (última semana / últimas 2 semanas / último mes, tope 30 días).
      var expensesRangeBtns = [7, 14, 30].map(function (n) {
        return '<button type="button" class="chip' + (expensesRange === n ? ' active' : '') + '" data-expenses-range="' + n + '">' + (n === 7 ? 'Última semana' : (n === 14 ? 'Últimas 2 semanas' : 'Último mes')) + '</button>';
      }).join(' ');
      expensesLimitRow = '<p class="muted">' + (expensesRange
        ? 'Mostrando gastos de ' + driverRangeLabel(expensesRange) + '.'
        : 'Mostrando los últimos 100 gastos' + (expensesFilter.date ? ' del ' + esc(expensesFilter.date) : '') + '.') +
        '</p><p><button type="button" id="expenses-range-clear">Hoy</button> ' + expensesRangeBtns + '</p>' +
        '<p class="muted">Podés ver hasta 30 días para atrás.</p>';
    } else {
      expensesLimitRow = expensesShowAll
        ? '<p><button type="button" id="expenses-show-less">Ver solo hoy</button></p>'
        : '<p class="muted">Mostrando los últimos 100 gastos' + (expensesFilter.date ? ' del ' + esc(expensesFilter.date) : '') + '. <button type="button" id="expenses-show-all">Ver todos</button></p>';
    }
    contentEl.innerHTML = '<h2>' + title + '</h2>' + formHtml + filterHtml + expensesLimitRow + '<h3>Lista</h3>' + (rows || '<p class="muted">Todavía no hay gastos.</p>');
    var filterForm = document.getElementById('expenses-filter');
    if (filterForm) {
      filterForm.addEventListener('change', function () {
        // Si se elige un día, manda sobre el rango; si solo cambia el
        // auto, el rango se mantiene. Un día más viejo que 30 días se
        // ajusta al primer día visible (solo chofer).
        if (filterForm.date.value) {
          expensesRange = null;
          expensesFilter.date = clampDriverDate(filterForm.date.value);
        }
        expensesFilter.taxi_id = filterForm.taxi_id.value;
        expensesFilter.driver_id = filterForm.driver_id ? filterForm.driver_id.value : '';
        renderExpenses();
      });
      filterForm.addEventListener('submit', function (ev) { ev.preventDefault(); });
      var clearBtn = document.getElementById('expenses-filter-clear');
      if (clearBtn) clearBtn.addEventListener('click', function () {
        expensesFilter.date = todayLocal(); expensesFilter.taxi_id = ''; expensesFilter.driver_id = '';
        expensesShowAll = false;
        expensesRange = null;
        renderExpenses();
      });
    }
    var expShowAllBtn = document.getElementById('expenses-show-all');
    if (expShowAllBtn) expShowAllBtn.addEventListener('click', function () { expensesShowAll = true; expensesFilter.date = ''; renderExpenses(); });
    var expShowLessBtn = document.getElementById('expenses-show-less');
    if (expShowLessBtn) expShowLessBtn.addEventListener('click', function () { expensesShowAll = false; expensesFilter.date = todayLocal(); renderExpenses(); });
    contentEl.querySelectorAll('[data-expenses-range]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        expensesRange = Number(btn.getAttribute('data-expenses-range'));
        expensesShowAll = false;
        expensesFilter.date = '';
        renderExpenses();
      });
    });
    var expensesRangeClear = document.getElementById('expenses-range-clear');
    if (expensesRangeClear) expensesRangeClear.addEventListener('click', function () {
      expensesRange = null;
      expensesShowAll = false;
      expensesFilter.date = todayLocal();
      renderExpenses();
    });
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

  // ---------- Balances pendientes (tope del Resumen, solo admin) ----------
  // Balance por chofer = SUMA DE handover_raw (NO de handover_net) sobre
  // sus días CERRADOS con settlement='pendiente', toda la historia. Sumar
  // nets es incorrecto: los nets ya descuentan el saldo a favor aplicado,
  // así que un día negativo viejo quedaría descontado dos veces. Ejemplo:
  // día1 raw -500 y día2 raw +300 → balance -200 (el dueño debe 200),
  // aunque la suma de nets da -500. El raw de un día se replica acá con
  // la misma fórmula que day-close.js: efectivo (método 'efectivo', sin
  // importar mayúsculas ni espacios) − keeps (amount × pct_snapshot) −
  // gastos del día. Se lee de los endpoints existentes, sin tocar el
  // backend: /api/shifts (jornadas con settlement), /api/trips?limit=all
  // y /api/expenses?limit=all (el admin no tiene límite de 30 días en
  // ninguno). Los choferes inactivos también entran (se marcan), porque
  // ninguno de esos endpoints filtra por activo; day-close sí lo hace,
  // por eso no se usa para esto.

  // Redondeo a 2 decimales, igual que round2 en api/_db.js.
  function roundMoney(n) {
    return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
  }

  function isCashMethod(name) {
    return String(name || '').trim().toLowerCase() === 'efectivo';
  }

  // Función de raw por (chofer, fecha) de la última carga de balances.
  // Los viajes y gastos no cambian durante un saldado (solo cambian las
  // marcas de liquidación, que se releen en cada iteración), así que la
  // clausura sigue siendo válida dentro del bucle de saldar.
  var pendingBalanceRawFor = null;

  // Carga los balances pendientes de todos los choferes. Devuelve filas
  // [{driver_id, name, active, balance, pendingCount}] ordenadas por
  // |balance| descendente, solo con balance distinto de cero.
  async function loadPendingBalances(drivers) {
    var shifts = await api('/api/shifts');
    var trips = await api('/api/trips?limit=all');
    var expenses = await api('/api/expenses?limit=all');
    var tripAgg = {};
    trips.forEach(function (t) {
      var key = t.driver_id + '|' + t.trip_date;
      var a = tripAgg[key] || (tripAgg[key] = { cash: 0, keeps: 0 });
      if (isCashMethod(t.payment_method_name)) a.cash += Number(t.amount) || 0;
      a.keeps += (Number(t.amount) || 0) * (Number(t.pct_snapshot) || 0) / 100;
    });
    var expAgg = {};
    expenses.forEach(function (g) {
      var key = g.driver_id + '|' + g.expense_date;
      expAgg[key] = (expAgg[key] || 0) + (Number(g.amount) || 0);
    });
    function rawFor(driverId, date) {
      var key = driverId + '|' + date;
      var ta = tripAgg[key];
      var cash = ta ? roundMoney(ta.cash) : 0;
      var keeps = ta ? roundMoney(ta.keeps) : 0;
      var exp = expAgg[key] !== undefined ? roundMoney(expAgg[key]) : 0;
      return roundMoney(cash - keeps - exp);
    }
    pendingBalanceRawFor = rawFor;
    var driverInfo = {};
    (drivers || []).forEach(function (d) {
      driverInfo[d.id] = { name: d.name, active: d.active !== false };
    });
    var perDriver = {};
    shifts.forEach(function (s) {
      if (s.exit_km === null || s.exit_km === undefined) return;
      var id = s.driver_id;
      var info = driverInfo[id] || { name: s.driver_name || 'Chofer', active: true };
      var entry = perDriver[id] || (perDriver[id] = { driver_id: id, name: info.name, active: info.active, balanceExact: 0, pendingCount: 0 });
      if ((s.settlement || 'pendiente') === 'pendiente') {
        entry.balanceExact += rawFor(id, s.shift_date);
        entry.pendingCount += 1;
      }
    });
    var rows = Object.keys(perDriver).map(function (id) {
      var e = perDriver[id];
      var balance = roundMoney(e.balanceExact);
      if (balance === 0) balance = 0;
      return { driver_id: e.driver_id, name: e.name, active: e.active, balance: balance, pendingCount: e.pendingCount };
    }).filter(function (r) { return r.balance !== 0; });
    rows.sort(function (a, b) { return Math.abs(b.balance) - Math.abs(a.balance); });
    return rows;
  }

  function balancesSectionHtml(rows) {
    if (!rows.length) {
      return '<h3>Balances pendientes</h3><div class="card"><p>Sin balances pendientes — todos saldados.</p></div>';
    }
    var maxAbs = 0;
    rows.forEach(function (r) { maxAbs = Math.max(maxAbs, Math.abs(r.balance)); });
    var cards = rows.map(function (r) {
      var direction = r.balance > 0
        ? 'El chofer te debe ' + money(r.balance)
        : 'Vos le debés ' + money(-r.balance);
      var countText = r.pendingCount === 1 ? '1 cierre pendiente' : r.pendingCount + ' cierres pendientes';
      var pct = maxAbs > 0 ? Math.round(Math.abs(r.balance) / maxAbs * 100) : 0;
      return '<div class="card balance-card"><p class="balance-name"><strong>' + esc(r.name) + '</strong>' + (r.active ? '' : ' (inactivo)') + '</p>' +
        '<p class="balance-direction">' + direction + '</p>' +
        '<p class="muted">' + countText + '</p>' +
        '<div class="balance-bar"><div class="balance-bar-fill" style="width: ' + pct + '%"></div></div>' +
        '<button type="button" data-settle-balance="' + r.driver_id + '" data-driver-name="' + esc(r.name) + '" data-balance="' + r.balance + '" data-pending="' + r.pendingCount + '">Marcar como saldado</button></div>';
    }).join('');
    return '<h3>Balances pendientes</h3><p class="muted">Barras en comparación entre choferes, no una meta.</p>' + cards;
  }

  // Nets de una secuencia de días cerrados, con la misma regla que
  // applyCreditToDays en api/day-close.js: el saldo a favor se descuenta
  // de los días positivos siguientes; un día "pagado" con raw negativo NO
  // genera saldo. days: [{date, raw, settlement}] (se ordena por fecha).
  function creditNets(days) {
    var nets = {};
    var credit = 0;
    days.slice().sort(function (a, b) { return a.date < b.date ? -1 : (a.date > b.date ? 1 : 0); }).forEach(function (d) {
      var applied = 0;
      if (d.raw > 0 && credit > 0) {
        applied = roundMoney(Math.min(credit, d.raw));
        credit = roundMoney(credit - applied);
      } else if (d.raw < 0) {
        if (d.settlement !== 'pagado') credit = roundMoney(credit - d.raw);
      }
      nets[d.date] = roundMoney(d.raw - applied);
    });
    return nets;
  }

  // Saldar TODOS los cierres pendientes de un chofer, de a uno por vez y
  // en orden cronológico, releyendo las jornadas después de cada marca
  // (así el net del día siguiente se recalcula con la marca recién
  // puesta). Signo del momento: net > 0 → 'recibido', net < 0 → 'pagado',
  // net == 0 → 'recibido' (limpia el pendiente; un cierre neto cero puede
  // tener raw distinto de cero y por eso no se puede saltear: si quedara
  // pendiente, su raw seguiría en el balance). Usa el endpoint settle
  // existente, sin cambios de backend.
  async function settleBalance(btn) {
    var driverId = Number(btn.getAttribute('data-settle-balance'));
    var name = btn.getAttribute('data-driver-name') || 'Chofer';
    var balance = Number(btn.getAttribute('data-balance')) || 0;
    var pending = Number(btn.getAttribute('data-pending')) || 0;
    var direction = balance > 0
      ? 'El chofer te debe ' + money(balance)
      : 'Vos le debés ' + money(-balance);
    if (!confirm('¿Marcar como saldado a ' + name + '?\nBalance: ' + direction + '\nCierres pendientes: ' + pending + '\nSe marcan todos los cierres pendientes: positivos como Recibido, negativos como Pagado; el balance vuelve a 0 y los días futuros arrancan limpios.')) return;
    btn.disabled = true;
    btn.textContent = 'Saldando…';
    var done = 0;
    var error = null;
    var remaining = 0;
    try {
      for (var i = 0; i < 500; i++) {
        var shifts = await api('/api/shifts?driver_id=' + encodeURIComponent(driverId));
        var days = shifts.filter(function (s) { return s.exit_km !== null && s.exit_km !== undefined; }).map(function (s) {
          return {
            date: s.shift_date,
            raw: pendingBalanceRawFor ? pendingBalanceRawFor(driverId, s.shift_date) : 0,
            settlement: s.settlement || 'pendiente',
          };
        });
        var pendingDays = days.filter(function (d) { return d.settlement === 'pendiente'; }).sort(function (a, b) { return a.date < b.date ? -1 : (a.date > b.date ? 1 : 0); });
        if (!pendingDays.length) break;
        var nets = creditNets(days);
        var target = pendingDays[0];
        var net = nets[target.date];
        var state = net > 0 ? 'recibido' : (net < 0 ? 'pagado' : 'recibido');
        await api('/api/shifts', 'POST', { action: 'settle', driver_id: driverId, shift_date: target.date, settlement: state });
        done += 1;
      }
      var check = await api('/api/shifts?driver_id=' + encodeURIComponent(driverId));
      remaining = check.filter(function (s) { return s.exit_km !== null && s.exit_km !== undefined && (s.settlement || 'pendiente') === 'pendiente'; }).length;
    } catch (e) { error = e; }
    if (error) {
      showMessage('Se marcaron ' + done + ' cierres de ' + name + ' y se detuvo por un error: ' + error.message + '. Revisá los cierres antes de reintentar.', 'error');
    } else if (remaining > 0) {
      showMessage('Se marcaron ' + done + ' cierres de ' + name + ' pero quedan ' + remaining + ' pendientes (tope de 500). Volvé a tocar Marcar como saldado para seguir.', 'error');
    } else if (done === 0) {
      showMessage('Ya no quedaban cierres pendientes para ' + name + '.', 'ok');
    } else {
      showMessage('Balance de ' + name + ' saldado: ' + done + ' cierres marcados. El balance vuelve a 0.', 'ok');
    }
    renderResumen();
  }

  // ---------- Resumen (página principal del admin) ----------

  async function renderResumen() {
    var today = todayLocal();
    var closes = [];
    try { closes = await api('/api/day-close?date=' + encodeURIComponent(today)); } catch (e) { closes = []; }
    var drivers = [];
    try { drivers = await api('/api/drivers'); } catch (e) { drivers = []; }
    // Balances pendientes (solo admin; si la carga falla, el Resumen
    // igual se muestra y solo esta sección avisa el error).
    var balancesRows = null;
    var balancesError = false;
    if (user.role === 'admin') {
      try { balancesRows = await loadPendingBalances(drivers); } catch (e) { balancesError = true; }
    }

    var totalHoy = 0, viajesHoy = 0, enCalle = 0;
    closes.forEach(function (c) {
      totalHoy += Number(c.total_collected) || 0;
      viajesHoy += Number(c.trips_count) || 0;
      if (c.shift_entry_time) enCalle += 1;
    });
    var dayRank = closes.slice().sort(function (a, b) { return (Number(b.total_collected) || 0) - (Number(a.total_collected) || 0); });
    var maxHoy = dayRank.length ? (Number(dayRank[0].total_collected) || 0) : 0;
    var dayCards = dayRank.map(function (c, i) {
      var total = Number(c.total_collected) || 0;
      var pct = maxHoy > 0 ? Math.round(total / maxHoy * 100) : 0;
      var perKm = (c.km_driven && Number(c.km_driven) > 0) ? money(total / Number(c.km_driven)) + '/km' : '—';
      var note = '';
      if (!c.shift_entry_time) note = ' · Sin jornada';
      else if (!c.shift_exit_time) note = ' · Jornada abierta';
      return '<div class="card" data-driver-detail="' + c.driver_id + '" style="cursor:pointer" title="Ver ficha del chofer"><p><strong>#' + (i + 1) + ' ' + esc(c.driver_name) + '</strong>' +
        (i === 0 && total > 0 ? ' · <strong>Mejor del día</strong>' : '') +
        ' · ' + money(total) + ' · ' + esc(c.trips_count) + ' viajes · ' + perKm +
        ' · ' + handoverCashLine(c, 'El dueño le debe') + note + ' · <span class="muted">Ver ficha ›</span></p>' +
        '<div class="perf-bar"><div class="perf-bar-fill" style="width: ' + pct + '%"></div></div></div>';
    }).join('');

    var kmAlerts = closes.filter(function (c) { return c.km_alert; });
    var openShifts = closes.filter(function (c) { return c.shift_entry_time && !c.shift_exit_time; });
    var missing = closes.filter(function (c) { return !c.shift_entry_time; });
    var alertHtml = '';
    if (!kmAlerts.length && !openShifts.length && !missing.length) {
      alertHtml = '<p class="ok">Sin alertas hoy.</p>';
    } else {
      if (kmAlerts.length) alertHtml += '<p>⚠ Alerta de km: ' + kmAlerts.map(function (c) { return esc(c.driver_name) + ' (' + esc(c.shift_taxi || '') + ', +' + esc(c.km_over) + ' km)'; }).join(', ') + '</p>';
      if (openShifts.length) alertHtml += '<p>Jornadas sin cerrar: ' + openShifts.map(function (c) { return esc(c.driver_name); }).join(', ') + '</p>';
      if (missing.length) alertHtml += '<p>Sin jornada hoy: ' + missing.map(function (c) { return esc(c.driver_name); }).join(', ') + '</p>';
    }

    var from = daysAgoLocal(perfDays === 7 ? 6 : 29);
    var rep = null;
    try { rep = await api('/api/report?from=' + encodeURIComponent(from) + '&to=' + encodeURIComponent(today)); } catch (e) { rep = null; }
    var perfCards = '<p class="muted">Sin datos del período.</p>';
    if (rep && rep.per_driver) {
      var byId = {};
      rep.per_driver.forEach(function (r) { byId[r.driver_id] = r; });
      var seen = {};
      var rows = drivers.filter(function (d) { return d.active; }).map(function (d) {
        seen[d.id] = true;
        var r = byId[d.id];
        return { id: d.id, name: d.name, total: r ? Number(r.total) : 0, trips: r ? Number(r.trips) : 0, per_km: r ? r.per_km : null };
      });
      rep.per_driver.forEach(function (r) {
        if (!seen[r.driver_id]) rows.push({ id: r.driver_id, name: r.driver_name, total: Number(r.total), trips: Number(r.trips), per_km: r.per_km });
      });
      rows.sort(function (a, b) { return b.total - a.total; });
      var maxPerf = rows.length ? rows[0].total : 0;
      perfCards = rows.map(function (r, i) {
        var pct = maxPerf > 0 ? Math.round(r.total / maxPerf * 100) : 0;
        return '<div class="card" data-driver-detail="' + r.id + '" style="cursor:pointer" title="Ver ficha del chofer"><p><strong>#' + (i + 1) + ' ' + esc(r.name) + '</strong>' +
          (i === 0 && r.total > 0 ? ' · <strong>Mejor desempeño</strong>' : '') +
          ' · ' + money(r.total) + ' · ' + esc(r.trips) + ' viajes · ' + (r.per_km !== null && r.per_km !== undefined ? money(r.per_km) + '/km' : '—') + ' · <span class="muted">Ver ficha ›</span></p>' +
          '<div class="perf-bar"><div class="perf-bar-fill" style="width: ' + pct + '%"></div></div></div>';
      }).join('') || '<p class="muted">Sin choferes.</p>';
    }

    var chartHtml = '';
    if (rep && rep.per_day) {
      var expByDate = {};
      try {
        var expRange = await api('/api/expenses?from=' + encodeURIComponent(from) + '&to=' + encodeURIComponent(today));
        expRange.forEach(function (g) {
          expByDate[g.expense_date] = (expByDate[g.expense_date] || 0) + Number(g.amount);
        });
      } catch (e) { /* sin gastos para el gráfico */ }
      var chartDays = rep.per_day.slice(-14);
      if (chartDays.length) {
        var maxChart = 0;
        chartDays.forEach(function (r) {
          maxChart = Math.max(maxChart, Number(r.total), expByDate[r.date] || 0);
        });
        chartHtml = '<h3>Por día</h3>' + chartDays.map(function (r) {
          var gastos = expByDate[r.date] || 0;
          var pf = maxChart > 0 ? Math.round(Number(r.total) / maxChart * 100) : 0;
          var pg = maxChart > 0 ? Math.round(gastos / maxChart * 100) : 0;
          return '<div class="card"><p><strong>' + esc(r.date) + '</strong> · Facturado: ' + money(r.total) + ' · Gastos: ' + money(gastos) + '</p>' +
            '<div class="perf-bar"><div class="perf-bar-fill" style="width: ' + pf + '%"></div></div>' +
            '<div class="perf-bar"><div class="perf-bar-fill-expense" style="width: ' + pg + '%"></div></div></div>';
        }).join('');
      }
    }

    var balancesHtml = '';
    if (user.role === 'admin') {
      if (balancesError) balancesHtml = '<h3>Balances pendientes</h3><div class="card"><p class="error">No se pudieron cargar los balances. Recargá la página para reintentar.</p></div>';
      else if (balancesRows) balancesHtml = balancesSectionHtml(balancesRows);
    }
    contentEl.innerHTML = '<h2>Resumen</h2>' + balancesHtml +
      '<div class="card"><p class="muted">Hoy, ' + esc(today) + '</p>' +
      '<p class="big-number">' + money(totalHoy) + '</p>' +
      '<p>' + esc(viajesHoy) + ' viajes · ' + esc(enCalle) + ' de ' + esc(closes.length) + ' choferes en calle</p></div>' +
      '<h3>Hoy, por chofer</h3>' + (dayCards || '<p class="muted">Sin choferes.</p>') +
      '<h3>Alertas de hoy</h3><div class="card">' + alertHtml + '</div>' +
      '<h3>Desempeño (' + (perfDays === 7 ? 'últimos 7 días' : 'últimos 30 días') + ')</h3>' +
      '<div class="row"><button type="button" data-perf-days="7"' + (perfDays === 7 ? ' class="chip active"' : ' class="chip"') + '>7 días</button>' +
      '<button type="button" data-perf-days="30"' + (perfDays === 30 ? ' class="chip active"' : ' class="chip"') + '>30 días</button></div>' +
      perfCards +
      chartHtml +
      '<h3>Ir a</h3><div class="row">' +
      '<button type="button" data-goto="closes">Cierres</button>' +
      '<button type="button" data-goto="report">Reportes</button>' +
      '<button type="button" data-goto="drivers">Choferes</button>' +
      '<button type="button" data-goto="trips">Viajes</button></div>';
    contentEl.querySelectorAll('[data-perf-days]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        perfDays = Number(btn.getAttribute('data-perf-days'));
        renderResumen();
      });
    });
    contentEl.querySelectorAll('[data-goto]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        currentTab = btn.getAttribute('data-goto');
        buildTabs();
      });
    });
    // Click en un chofer del ranking (hoy o desempeño) → su ficha.
    contentEl.querySelectorAll('[data-driver-detail]').forEach(function (card) {
      card.addEventListener('click', function () {
        renderDriverDetail(card.getAttribute('data-driver-detail'));
      });
    });
    // Botón "Marcar como saldado" de cada balance pendiente.
    contentEl.querySelectorAll('[data-settle-balance]').forEach(function (btn) {
      btn.addEventListener('click', function () { settleBalance(btn); });
    });
  }

  // ---------- Reportes (admin) ----------

  // ---------- Descargar facturas (ZIP) ----------
  // ZIP sin comprimir (STORE): las fotos ya son JPEG, comprimir no achica
  // nada. Se arma en el navegador con las fotos que el admin ya puede ver
  // (una por gasto con foto del período del reporte), sin archivo nuevo en
  // el servidor y sin topar el límite de respuesta de las funciones.

  function zipReceiptName(g) {
    var driver = (g.driver_name || 'chofer').replace(/[^A-Za-z0-9._-]+/g, '_');
    var type = (g.type || 'gasto').replace(/[^A-Za-z0-9._-]+/g, '_');
    return g.expense_date + '_' + driver + '_' + type + '_' + g.id + '.jpg';
  }

  var crcTable = null;
  function crc32(bytes) {
    if (!crcTable) {
      crcTable = new Uint32Array(256);
      for (var n = 0; n < 256; n++) {
        var c = n;
        for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        crcTable[n] = c >>> 0;
      }
    }
    var crc = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  function buildZip(files) {
    var parts = [];
    var central = [];
    var offset = 0;
    files.forEach(function (f) {
      var b64 = f.dataUrl.split(',')[1] || '';
      var bin = atob(b64);
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      var crc = crc32(bytes);
      var nameBytes = new TextEncoder().encode(f.name);
      var lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true);
      lh.setUint16(4, 20, true);
      lh.setUint16(6, 0x0800, true);
      lh.setUint16(8, 0, true);
      lh.setUint16(10, 0, true);
      lh.setUint16(12, 0, true);
      lh.setUint32(14, crc, true);
      lh.setUint32(18, bytes.length, true);
      lh.setUint32(22, bytes.length, true);
      lh.setUint16(26, nameBytes.length, true);
      lh.setUint16(28, 0, true);
      parts.push(lh.buffer, nameBytes, bytes);
      var ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true);
      ch.setUint16(4, 20, true);
      ch.setUint16(6, 20, true);
      ch.setUint16(8, 0x0800, true);
      ch.setUint16(10, 0, true);
      ch.setUint16(12, 0, true);
      ch.setUint16(14, 0, true);
      ch.setUint32(16, crc, true);
      ch.setUint32(20, bytes.length, true);
      ch.setUint32(24, bytes.length, true);
      ch.setUint16(28, nameBytes.length, true);
      ch.setUint32(42, offset, true);
      central.push(ch.buffer, nameBytes);
      offset += 30 + nameBytes.length + bytes.length;
    });
    var centralSize = 0;
    central.forEach(function (p) { centralSize += p.byteLength; });
    var eocd = new DataView(new ArrayBuffer(22));
    eocd.setUint32(0, 0x06054b50, true);
    eocd.setUint16(8, files.length, true);
    eocd.setUint16(10, files.length, true);
    eocd.setUint32(12, centralSize, true);
    eocd.setUint32(16, offset, true);
    parts.push.apply(parts, central);
    parts.push(eocd.buffer);
    return new Blob(parts, { type: 'application/zip' });
  }

  async function downloadReceiptsZip() {
    var form = document.getElementById('report-form');
    var q = [];
    q.push('from=' + encodeURIComponent(form.from.value));
    q.push('to=' + encodeURIComponent(form.to.value));
    if (form.driver_id.value) q.push('driver_id=' + encodeURIComponent(form.driver_id.value));
    if (form.taxi_id.value) q.push('taxi_id=' + encodeURIComponent(form.taxi_id.value));
    var list = [];
    try { list = await api('/api/expenses?' + q.join('&')); } catch (e) { showMessage(e.message, 'error'); return; }
    var withReceipt = list.filter(function (g) { return g.has_receipt; });
    if (!withReceipt.length) { showMessage('Sin facturas con foto en ese período.', 'error'); return; }
    showMessage('Descargando ' + withReceipt.length + ' factura(s)…', 'ok');
    var files = [];
    for (var i = 0; i < withReceipt.length; i++) {
      try {
        var data = await api('/api/expenses?receipt=' + withReceipt[i].id);
        if (data && data.image) files.push({ name: zipReceiptName(withReceipt[i]), dataUrl: data.image });
      } catch (e) { /* una foto que falla no frena el resto */ }
    }
    if (!files.length) { showMessage('No se pudo descargar ninguna factura.', 'error'); return; }
    var blob = buildZip(files);
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'facturas-' + form.from.value + '-' + form.to.value + '.zip';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    showMessage('ZIP descargado con ' + files.length + ' factura(s).', 'ok');
  }

  async function renderReport() {
    var drivers = [];
    var taxis = [];
    var methods = [];
    try { drivers = await api('/api/drivers'); } catch (e) { drivers = []; }
    try { taxis = await api('/api/taxis'); } catch (e) { taxis = []; }
    try { methods = await api('/api/trips?methods=1'); } catch (e) { methods = []; }
    var driverOptions = '<option value="">Todos los choferes</option>' + drivers.filter(function (d) { return d.active; }).map(function (d) {
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
    // Gráfica de efectivo por km por chofer (solo frontend, usa los
    // datos del reporte ya buscado). Efectivo por km = efectivo (solo
    // viajes con método Efectivo) / km de jornadas cerradas del
    // período. Es la versión en efectivo del $/km de la tabla (que usa
    // el recaudado total). Ordenada de mayor a menor; los choferes sin
    // km cerrado aparecen sin barra. Las barras reutilizan .perf-bar,
    // igual que el ranking del Resumen.
    function graficaEfectivoKmPorChofer(rows, withMethodFilter) {
      var data = (rows || []).map(function (r) {
        var km = Number(r.km) || 0;
        var cash = Number(r.cash_total) || 0;
        return { name: r.driver_name, trips: r.trips, km: km, cash: cash,
          value: km > 0 ? Math.round((cash / km + Number.EPSILON) * 100) / 100 : null };
      });
      if (!data.length) return '<p class="muted">Sin datos en ese período.</p>';
      var conBarra = data.filter(function (d) { return d.value !== null; }).sort(function (a, b) { return b.value - a.value; });
      var sinKm = data.filter(function (d) { return d.value === null; });
      var max = conBarra.length ? conBarra[0].value : 0;
      var html = conBarra.map(function (d) {
        var pct = max > 0 ? Math.round((d.value / max) * 100) : 0;
        return '<p><strong>' + esc(d.name) + '</strong> · ' + money(d.value) + '/km en efectivo</p>' +
          '<div class="perf-bar"><div class="perf-bar-fill" style="width: ' + pct + '%"></div></div>' +
          '<p class="muted">Km: ' + esc(d.km) + ' km · Efectivo: ' + money(d.cash) + ' · Viajes: ' + esc(d.trips) + '</p>';
      }).join('');
      sinKm.forEach(function (d) {
        html += '<p><strong>' + esc(d.name) + '</strong> · — sin km cerrado en el período</p>' +
          '<p class="muted">Efectivo: ' + money(d.cash) + ' · Viajes: ' + esc(d.trips) + '</p>';
      });
      return html + '<p class="muted">Efectivo por km = efectivo (solo viajes con método Efectivo) / km de jornadas cerradas del período. Las barras se comparan entre choferes, no son una meta.' +
        (withMethodFilter ? ' Con filtro de método, el efectivo corresponde a ese método.' : '') + '</p>';
    }
    // Rentabilidad de un taxi. Neto = recaudado - gastos (todos los
    // gastos del auto, incluido el combustible, siempre por monto, como
    // cualquier otro gasto). $/km = neto / km; si km <= 0 no se divide
    // y perKm queda null para mostrar '—'. Ojo: este $/km es distinto
    // del $/km del reporte (que es recaudado / km).
    function rentabilidadTaxi(recaudado, gastos, km) {
      var neto = Math.round(((Number(recaudado) || 0) - (Number(gastos) || 0) + Number.EPSILON) * 100) / 100;
      var k = Number(km) || 0;
      return { neto: neto, perKm: k > 0 ? Math.round((neto / k + Number.EPSILON) * 100) / 100 : null };
    }
    // Gastos por taxi a partir de la lista de gastos y la lista de
    // jornadas. Un gasto se asigna al taxi de la jornada de ese chofer
    // y fecha (igual que el backend cuando filtra por auto). Un gasto
    // de un día sin jornada no se puede asignar y queda fuera.
    // Devuelve un objeto { '<taxi_id>': monto }.
    function gastosPorTaxi(expenses, shifts) {
      var taxiByDriverDate = {};
      (shifts || []).forEach(function (s) {
        if (s.taxi_id === null || s.taxi_id === undefined) return;
        taxiByDriverDate[s.driver_id + '|' + s.shift_date] = String(s.taxi_id);
      });
      var out = {};
      (expenses || []).forEach(function (g) {
        var key = taxiByDriverDate[g.driver_id + '|' + g.expense_date];
        if (!key) return;
        out[key] = Math.round((((out[key] || 0) + (Number(g.amount) || 0)) + Number.EPSILON) * 100) / 100;
      });
      return out;
    }
    // Km por taxi en el período, solo de jornadas cerradas (exit_km
    // cargado), igual que el reporte: suma de exit_km - entry_km.
    // from/to son 'YYYY-MM-DD' y comparan como texto. driverId null
    // significa sin filtro de chofer. Devuelve { '<taxi_id>': km }.
    function kmPorTaxi(shifts, from, to, driverId) {
      var out = {};
      (shifts || []).forEach(function (s) {
        if (s.taxi_id === null || s.taxi_id === undefined) return;
        if (s.shift_date < from || s.shift_date > to) return;
        if (driverId && String(s.driver_id) !== String(driverId)) return;
        if (s.exit_km === null || s.exit_km === undefined) return;
        if (s.entry_km === null || s.entry_km === undefined) return;
        var key = String(s.taxi_id);
        out[key] = Math.round((((out[key] || 0) + (Number(s.exit_km) - Number(s.entry_km))) + Number.EPSILON) * 100) / 100;
      });
      return out;
    }
    // Filas de rentabilidad: unión de los taxis del reporte con la
    // lista de taxis, para incluir taxis con km o gastos en el período
    // pero 0 viajes (que per_taxi no trae). Los viajes sin taxi
    // (taxi_id null) no entran en esta tabla. Orden: neto descendente.
    // taxiIdFilter null significa todos los autos.
    function rentabilidadRows(rep, taxis, gastosMap, kmMap, taxiIdFilter) {
      var byTaxi = {};
      (rep.per_taxi || []).forEach(function (r) {
        if (r.taxi_id === null || r.taxi_id === undefined) return;
        if (taxiIdFilter && String(r.taxi_id) !== String(taxiIdFilter)) return;
        byTaxi[String(r.taxi_id)] = { taxi_id: r.taxi_id, taxi_identifier: r.taxi_identifier, trips: Number(r.trips) || 0, recaudado: Number(r.total) || 0, repKm: (r.km === null || r.km === undefined) ? 0 : Number(r.km) };
      });
      (taxis || []).forEach(function (t) {
        if (taxiIdFilter && String(t.id) !== String(taxiIdFilter)) return;
        var key = String(t.id);
        if (!byTaxi[key]) byTaxi[key] = { taxi_id: t.id, taxi_identifier: t.identifier, trips: 0, recaudado: 0, repKm: 0 };
      });
      var rows = [];
      Object.keys(byTaxi).forEach(function (key) {
        var b = byTaxi[key];
        var gastos = gastosMap[key] !== undefined ? gastosMap[key] : 0;
        var km = kmMap[key] !== undefined ? kmMap[key] : b.repKm;
        if (!taxiIdFilter && b.trips === 0 && gastos === 0 && km === 0) return;
        var calc = rentabilidadTaxi(b.recaudado, gastos, km);
        rows.push({ taxi_id: b.taxi_id, taxi_identifier: b.taxi_identifier, trips: b.trips, recaudado: b.recaudado, gastos: gastos, neto: calc.neto, km: km, perKm: calc.perKm });
      });
      rows.sort(function (a, b) { return b.neto - a.neto; });
      return rows;
    }
    function dayRows(rows, showCredit) {
      if (!rows.length) return '<p class="muted">Sin datos en ese período.</p>';
      return '<div class="table-wrap"><table><thead><tr><th>Fecha</th><th>Viajes</th><th>Recaudado</th><th>Efectivo</th><th>Entrega en efectivo</th>' + (showCredit ? '<th>Saldo anterior</th><th>Aplicado</th><th>Entrega neta</th>' : '') + '<th>Km</th><th>$/km</th></tr></thead><tbody>' +
        rows.map(function (r) {
          return '<tr><td>' + esc(r.date) + '</td><td>' + esc(r.trips) + '</td><td>' + money(r.total) + '</td><td>' + money(r.cash_total) + '</td><td>' + money(r.handover_cash) + '</td>' + (showCredit ? '<td>' + money(r.credit_before) + '</td><td>' + money(r.credit_applied) + '</td><td>' + money(r.handover_net) + '</td>' : '') + '<td>' + (r.km !== null ? esc(r.km) + ' km' : '—') + '</td><td>' + perKmCell(r.per_km) + '</td></tr>';
        }).join('') + '</tbody></table></div>';
    }
    function breakdownRows(rows, nameFn, cashCols, showCredit) {
      if (!rows.length) return '';
      var creditCols = cashCols && showCredit;
      return '<div class="table-wrap"><table><thead><tr><th>Nombre</th><th>Viajes</th><th>Recaudado</th>' + (cashCols ? '<th>Se queda</th><th>Entrega en efectivo</th>' : '') + (creditCols ? '<th>Saldo anterior</th><th>Aplicado</th><th>Entrega neta</th><th>Saldo restante</th>' : '') + '<th>Km</th><th>$/km</th></tr></thead><tbody>' +
        rows.map(function (r) {
          return '<tr><td>' + esc(nameFn(r)) + '</td><td>' + esc(r.trips) + '</td><td>' + money(r.total) + '</td>' + (cashCols ? '<td>' + money(r.driver_keeps) + '</td><td>' + money(r.handover_cash) + '</td>' : '') + (creditCols ? '<td>' + money(r.credit_before) + '</td><td>' + money(r.credit_applied) + '</td><td>' + money(r.handover_net) + '</td><td>' + money(r.credit_after) + '</td>' : '') + '<td>' + (r.km !== null ? esc(r.km) + ' km' : '—') + '</td><td>' + perKmCell(r.per_km) + '</td></tr>';
        }).join('') + '</tbody></table></div>';
    }

    function csvCell(v) {
      var s = String(v === null || v === undefined ? '' : v);
      return '"' + s.replace(/"/g, '""') + '"';
    }
    function filterLabel(select) {
      if (!select || !select.options || select.selectedIndex < 0) return 'Todos';
      return select.options[select.selectedIndex].text;
    }
    function downloadReportCsv(rep, form) {
      var lines = [];
      var t = rep.totals;
      function row() { return Array.prototype.slice.call(arguments).join(','); }
      lines.push(row('Reporte de Mis Taxis'));
      lines.push(row('Periodo', csvCell(rep.from + ' al ' + rep.to)));
      lines.push(row('Chofer', csvCell(filterLabel(form.driver_id))));
      lines.push(row('Auto', csvCell(filterLabel(form.taxi_id))));
      lines.push(row('Metodo de pago', csvCell(filterLabel(form.payment_method_id))));
      lines.push('');
      lines.push(row('TOTALES DEL PERIODO'));
      lines.push(row('Concepto', 'Monto ($)'));
      lines.push(row('Total recaudado', t.total));
      lines.push(row('Efectivo (entra al chofer)', t.cash_total));
      lines.push(row('Se quedan los choferes', t.driver_keeps));
      lines.push(row('Parte del dueno (antes de gastos)', t.owner_share_gross));
      lines.push(row('Gastos', t.expenses));
      lines.push(row('Deben entregar en efectivo al dueno', t.handover_cash));
      if (t.opening_credit > 0 || t.credit_applied > 0 || t.credit_closing > 0) {
        lines.push(row('Saldo a favor al inicio del periodo', t.opening_credit));
        lines.push(row('Saldo a favor aplicado en el periodo', t.credit_applied));
        lines.push(row('Entrega neta en el periodo', t.handover_net));
        lines.push(row('Saldo a favor restante', t.credit_closing));
      }
      if (t.unclassified_total > 0) lines.push(row('Sin metodo (sin clasificar, no entra en el efectivo)', t.unclassified_total));
      lines.push(row('Viajes', t.trips_count));
      lines.push(row('Km recorridos (km)', t.km));
      lines.push(row('Dias con jornada cerrada', t.days_with_km));
      lines.push(row('Dinero por km promedio ($/km)', t.avg_per_km !== null ? t.avg_per_km : ''));
      lines.push('');
      lines.push(row('Como se calcula: Efectivo - Se quedan los choferes - Gastos = Deben entregar en efectivo al dueno. Solo el efectivo entra al chofer; tarjeta, Uber y transferencias van a la cuenta del dueno.'));
      lines.push(row('Una entrega en efectivo negativa significa que el dueno les debe esa plata a los choferes. Los viajes sin metodo no entran en el efectivo.'));
      lines.push(row('El saldo a favor no es un gasto: es plata que el dueno le debe al chofer de liquidaciones anteriores y se descuenta de la entrega de los dias siguientes.'));
      if (form.taxi_id.value || form.payment_method_id.value) lines.push(row('Con filtro de auto o metodo, las cifras de saldo son de secuencia completa (todas las fechas, autos y metodos) y pueden no coincidir con el efectivo filtrado.'));
      lines.push(row('El $/km se calcula solo sobre dias con jornada cerrada; los dias sin jornada no entran en el promedio.'));
      if (form.taxi_id.value) lines.push(row('Con filtro de auto, los gastos se asignan segun el taxi del dia de cada gasto.'));
      lines.push('');
      lines.push(row('POR DIA'));
      lines.push(row('Fecha', 'Viajes', 'Recaudado ($)', 'Efectivo ($)', 'Entrega en efectivo ($)', 'Saldo anterior ($)', 'Aplicado ($)', 'Entrega neta ($)', 'Km (km)', '$/km ($)'));
      rep.per_day.forEach(function (r) {
        lines.push(row(r.date, r.trips, r.total, r.cash_total, r.handover_cash, r.credit_before, r.credit_applied, r.handover_net, r.km !== null ? r.km : '', r.per_km !== null ? r.per_km : ''));
      });
      if (!form.driver_id.value) {
        lines.push('');
        lines.push(row('POR CHOFER'));
        lines.push(row('Chofer', 'Viajes', 'Recaudado ($)', 'Se queda ($)', 'Entrega en efectivo ($)', 'Saldo anterior ($)', 'Aplicado ($)', 'Entrega neta ($)', 'Saldo restante ($)', 'Km (km)', '$/km ($)'));
        rep.per_driver.forEach(function (r) {
          lines.push(row(csvCell(r.driver_name), r.trips, r.total, r.driver_keeps, r.handover_cash, r.credit_before, r.credit_applied, r.handover_net, r.credit_after, r.km !== null ? r.km : '', r.per_km !== null ? r.per_km : ''));
        });
      }
      if (!form.taxi_id.value) {
        lines.push('');
        lines.push(row('POR AUTO'));
        lines.push(row('Auto', 'Viajes', 'Recaudado ($)', 'Km (km)', '$/km ($)'));
        rep.per_taxi.forEach(function (r) {
          lines.push(row(csvCell(r.taxi_identifier), r.trips, r.total, r.km !== null ? r.km : '', r.per_km !== null ? r.per_km : ''));
        });
      }
      if (rep.per_method && rep.per_method.length) {
        lines.push('');
        lines.push(row('POR METODO DE PAGO'));
        lines.push(row('Metodo', 'Viajes', 'Recaudado ($)', 'Se quedan los choferes ($)', 'Entra en efectivo'));
        rep.per_method.forEach(function (r) {
          lines.push(row(csvCell(r.method_name), r.trips, r.total, r.driver_keeps, r.is_cash ? 'Si' : (r.is_unclassified ? 'No (sin clasificar)' : 'No')));
        });
      }
      lines.push('');
      lines.push(row('Nota: las celdas vacias de Km y $/km son dias, choferes o autos sin jornada cerrada en el periodo.'));
      var blob = new Blob(['\ufeff' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'reporte-' + rep.from + '-' + rep.to + '.csv';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    }
    async function printReport(rep, form) {
      var companyName = (typeof user !== 'undefined' && user && user.company_name) ? user.company_name : '';
      if (!companyName) {
        try { var c = await api('/api/company'); companyName = c.name || ''; } catch (e) { companyName = ''; }
      }
      var t = rep.totals;
      function pk(v) { return (v !== null && v !== undefined) ? money(v) + '/km' : '—'; }
      function kmCell(v) { return (v !== null && v !== undefined) ? esc(v) + ' km' : '—'; }
      function tableHtml(headers, rows) {
        if (!rows.length) return '<p class="muted">Sin datos en ese período.</p>';
        return '<table><thead><tr>' + headers.map(function (h) { return '<th>' + h + '</th>'; }).join('') + '</tr></thead><tbody>' +
          rows.map(function (r) {
            return '<tr' + (r.hl ? ' class="hl"' : '') + '>' + r.cells.map(function (cell) { return '<td>' + cell + '</td>'; }).join('') + '</tr>';
          }).join('') + '</tbody></table>';
      }
      var perDayRows = rep.per_day.map(function (r) {
        return { cells: [esc(r.date), esc(r.trips), money(r.total), money(r.cash_total), money(r.handover_cash), money(r.credit_before), money(r.credit_applied), money(r.handover_net), kmCell(r.km), pk(r.per_km)] };
      });
      var perDriverRows = rep.per_driver.map(function (r) {
        return { cells: [esc(r.driver_name), esc(r.trips), money(r.total), money(r.driver_keeps), money(r.handover_cash), money(r.credit_before), money(r.credit_applied), money(r.handover_net), money(r.credit_after), kmCell(r.km), pk(r.per_km)] };
      });
      var perTaxiRows = rep.per_taxi.map(function (r) {
        return { cells: [esc(r.taxi_identifier), esc(r.trips), money(r.total), kmCell(r.km), pk(r.per_km)] };
      });
      var perMethodRows = (rep.per_method || []).map(function (r) {
        return { cells: [esc(r.method_name) + (r.is_cash ? ' (efectivo)' : '') + (r.is_unclassified ? ' (sin clasificar, no entra en el efectivo)' : ''), esc(r.trips), money(r.total), money(r.driver_keeps)] };
      });
      var handoverRow = t.handover_cash < 0
        ? { cells: ['El dueño debe a los choferes', money(-t.handover_cash)], hl: true }
        : { cells: ['Deben entregar en efectivo al dueño', money(t.handover_cash)], hl: true };
      var resumenRows = [
        { cells: ['Total recaudado', money(t.total)] },
        { cells: ['Efectivo (entra al chofer)', money(t.cash_total)] },
        { cells: ['Se quedan los choferes', money(t.driver_keeps)] },
        { cells: ['Parte del dueño (antes de gastos)', money(t.owner_share_gross)] },
        { cells: ['Gastos', money(t.expenses)] },
        handoverRow,
        { cells: ['Viajes', esc(t.trips_count)] },
        { cells: ['Km recorridos', esc(t.km) + ' km'] },
        { cells: ['Días con jornada cerrada', esc(t.days_with_km)] },
        { cells: ['Dinero por km promedio', pk(t.avg_per_km)] },
      ];
      if (t.unclassified_total > 0) resumenRows.push({ cells: ['Sin método (sin clasificar, no entra en el efectivo)', money(t.unclassified_total)] });
      if (t.opening_credit > 0 || t.credit_applied > 0 || t.credit_closing > 0) {
        resumenRows.push({ cells: ['Saldo a favor al inicio del período', money(t.opening_credit)] });
        resumenRows.push({ cells: ['Saldo a favor aplicado en el período', money(t.credit_applied)] });
        resumenRows.push({ cells: ['Entrega neta en el período (saldo descontado)', money(t.handover_net)], hl: true });
        resumenRows.push({ cells: ['Saldo a favor restante', money(t.credit_closing)] });
      }
      var html = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Reporte ' + esc(rep.from) + ' al ' + esc(rep.to) + '</title><style>' +
        'body{font-family:system-ui,Arial,sans-serif;color:#111;max-width:800px;margin:24px auto;padding:0 16px;}' +
        'h1{font-size:22px;margin:0 0 4px;}h2{font-size:17px;margin:24px 0 8px;border-bottom:2px solid #111;padding-bottom:4px;}' +
        'table{width:100%;border-collapse:collapse;margin:8px 0 16px;font-size:14px;}' +
        'th,td{border:1px solid #ccc;padding:6px 8px;text-align:left;}th{background:#f2f2f2;}' +
        'td:nth-child(n+2),th:nth-child(n+2){text-align:right;}td:first-child,th:first-child{text-align:left;}' +
        'tr.hl td{font-weight:bold;background:#fef3c7;}' +
        '.muted{color:#666;font-size:13px;}' +
        '@media print{.no-print{display:none;}}' +
        '</style></head><body>' +
        '<div class="no-print"><button onclick="window.print()">Imprimir / Guardar como PDF</button></div>' +
        '<h1>' + esc(companyName || 'Mis Taxis') + '</h1>' +
        '<p><strong>Reporte del ' + esc(rep.from) + ' al ' + esc(rep.to) + '</strong><br>' +
        'Chofer: ' + esc(filterLabel(form.driver_id)) + ' · Auto: ' + esc(filterLabel(form.taxi_id)) + ' · Método de pago: ' + esc(filterLabel(form.payment_method_id)) + '</p>' +
        '<h2>Resumen</h2>' + tableHtml(['Concepto', 'Monto'], resumenRows) +
        '<h2>Por día</h2>' + tableHtml(['Fecha', 'Viajes', 'Recaudado', 'Efectivo', 'Entrega en efectivo', 'Saldo anterior', 'Aplicado', 'Entrega neta', 'Km', '$/km'], perDayRows) +
        (!form.driver_id.value ? '<h2>Por chofer</h2>' + tableHtml(['Chofer', 'Viajes', 'Recaudado', 'Se queda', 'Entrega en efectivo', 'Saldo anterior', 'Aplicado', 'Entrega neta', 'Saldo restante', 'Km', '$/km'], perDriverRows) : '') +
        (!form.taxi_id.value ? '<h2>Por auto</h2>' + tableHtml(['Auto', 'Viajes', 'Recaudado', 'Km', '$/km'], perTaxiRows) : '') +
        (perMethodRows.length ? '<h2>Por método de pago</h2>' + tableHtml(['Método', 'Viajes', 'Recaudado', 'Se quedan los choferes'], perMethodRows) : '') +
        '<p class="muted">Cómo se calcula: Efectivo − Se quedan los choferes − Gastos = Deben entregar en efectivo al dueño. Solo el efectivo entra al chofer; tarjeta, Uber y transferencias van a la cuenta del dueño. Una entrega en efectivo negativa significa que el dueño les debe esa plata a los choferes. Los viajes sin método no entran en el efectivo. El saldo a favor no es un gasto: es plata que el dueño le debe al chofer de liquidaciones anteriores y se descuenta de la entrega de los días siguientes.</p>' +
        ((form.taxi_id.value || form.payment_method_id.value) ? '<p class="muted">Con filtro de auto o método, las cifras de saldo son de secuencia completa (todas las fechas, autos y métodos) y pueden no coincidir con el efectivo filtrado.</p>' : '') +
        '<p class="muted">El $/km se calcula solo sobre días con jornada cerrada; los días sin jornada no entran en el promedio. Las celdas con — son días, choferes o autos sin jornada cerrada en el período.</p>' +
        (form.taxi_id.value ? '<p class="muted">Con filtro de auto, los gastos se asignan según el taxi del día de cada gasto.</p>' : '') +
        '<p class="muted">Reporte generado el ' + esc(todayLocal()) + '.</p>' +
        '</body></html>';
      var w = window.open('', '_blank');
      if (!w) { showMessage('Permitir ventanas emergentes para ver el reporte imprimible.', 'error'); return; }
      w.document.write(html);
      w.document.close();
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
        var hasCredit = (t.opening_credit > 0 || t.credit_applied > 0 || t.credit_closing > 0);
        var html = '<div class="card"><h3>' + esc(rep.from) + ' al ' + esc(rep.to) + '</h3>' +
          '<p>Total recaudado</p><p class="big-number">' + money(t.total) + '</p>' +
          '<p>Viajes: ' + esc(t.trips_count) + ' · Km recorridos: ' + esc(t.km) + ' km</p>' +
          '<p>Dinero por km (promedio): <strong>' + perKmCell(t.avg_per_km) + '</strong></p>' +
          '<p>Efectivo: ' + money(t.cash_total) + ' · Se quedan los choferes: ' + money(t.driver_keeps) + ' · Gastos: ' + money(t.expenses) + ' · ' + (t.handover_cash < 0 ? 'El dueño debe: <strong>' + money(-t.handover_cash) + '</strong>' : 'Deben entregar en efectivo: <strong>' + money(t.handover_cash) + '</strong>') + '</p>' +
          (t.unclassified_total > 0 ? '<p class="muted">Sin método (sin clasificar, no entra en el efectivo): ' + money(t.unclassified_total) + '</p>' : '') +
          (hasCredit ? '<p>Saldo a favor de los choferes al inicio del período: ' + money(t.opening_credit) + ' · Aplicado en el período: ' + money(t.credit_applied) + ' · Entrega neta en el período: ' + money(t.handover_net) + ' · Saldo restante: ' + money(t.credit_closing) + '</p>' : '') +
          '<p class="muted">El $/km se calcula solo sobre días con kilometraje cargado (jornada cerrada). Los días sin jornada no entran en el promedio. Solo el efectivo entra al chofer; tarjeta, Uber y transferencias van a la cuenta del dueño. Una entrega en efectivo negativa significa que el dueño les debe esa plata a los choferes. El saldo a favor no es un gasto: es plata que el dueño le debe al chofer de liquidaciones anteriores y se descuenta de la entrega de los días siguientes.' +
          ((form.taxi_id.value || form.payment_method_id.value) ? ' Con filtro de auto o método, las cifras de saldo son de secuencia completa (todas las fechas, autos y métodos) y pueden no coincidir con el efectivo filtrado.' : '') +
          (form.taxi_id.value ? ' Gastos asignados al auto según el taxi del día de cada gasto.' : '') + '</p></div>' +
          '<button type="button" id="report-csv-btn">Descargar CSV</button>' +
          '<button type="button" id="report-zip-btn">Descargar facturas (ZIP)</button>' +
          '<button type="button" id="report-print-btn">Imprimir reporte</button>' +
          '<h3>Por día</h3>' + dayRows(rep.per_day, hasCredit);
        if (!form.driver_id.value) html += '<h3>Por chofer</h3>' + breakdownRows(rep.per_driver, function (r) { return r.driver_name; }, true, hasCredit) +
          '<h3>Gráfica: efectivo por km por chofer</h3>' + graficaEfectivoKmPorChofer(rep.per_driver, !!form.payment_method_id.value);
        if (!form.taxi_id.value) html += '<h3>Por auto</h3>' + breakdownRows(rep.per_taxi, function (r) { return r.taxi_identifier; });
        var rentabilidadHtml = '';
        try {
          var expQ = 'from=' + encodeURIComponent(form.from.value) + '&to=' + encodeURIComponent(form.to.value);
          if (form.driver_id.value) expQ += '&driver_id=' + encodeURIComponent(form.driver_id.value);
          var expAll = await api('/api/expenses?' + expQ);
          var shiftsAll = await api('/api/shifts');
          var rentRows = rentabilidadRows(rep, taxis, gastosPorTaxi(expAll, shiftsAll), kmPorTaxi(shiftsAll, form.from.value, form.to.value, form.driver_id.value || null), form.taxi_id.value || null);
          var sinTaxi = (rep.per_taxi || []).some(function (r) { return r.taxi_id === null || r.taxi_id === undefined; });
          rentabilidadHtml = '<h3>Rentabilidad por auto</h3>' + (rentRows.length ? '<div class="table-wrap"><table><thead><tr><th>Auto</th><th>Viajes</th><th>Recaudado</th><th>Gastos</th><th>Neto</th><th>Km</th><th>$/km (neto)</th></tr></thead><tbody>' +
            rentRows.map(function (r) {
              return '<tr><td>' + esc(r.taxi_identifier) + '</td><td>' + esc(r.trips) + '</td><td>' + money(r.recaudado) + '</td><td>' + money(r.gastos) + '</td><td>' + money(r.neto) + '</td><td>' + esc(r.km) + ' km</td><td>' + perKmCell(r.perKm) + '</td></tr>';
            }).join('') + '</tbody></table></div>' : '<p class="muted">Sin datos en ese período.</p>') +
            '<p class="muted">Neto = Recaudado − Gastos. Los gastos son todos los del auto en el período, incluido el combustible por monto. $/km = Neto / Km de jornadas cerradas del período; — si el auto no tiene km cerrado.</p>' +
            '<p class="muted">Los gastos de un día sin jornada no se pueden asignar a un auto y quedan fuera de esta tabla, igual que en el reporte con filtro de auto.</p>' +
            (form.payment_method_id.value ? '<p class="muted">Con filtro de método, el recaudado está filtrado por método pero los gastos no (los gastos no tienen método): el neto es orientativo.</p>' : '') +
            (sinTaxi ? '<p class="muted">Hay viajes sin taxi asignado: no entran en esta tabla.</p>' : '');
        } catch (e) { rentabilidadHtml = '<h3>Rentabilidad por auto</h3><p class="error">No se pudo calcular la rentabilidad: ' + esc(e.message) + '</p>'; }
        html += rentabilidadHtml;
        if (rep.per_method && rep.per_method.length) {
          html += '<h3>Por método de pago</h3><div class="table-wrap"><table><thead><tr><th>Método</th><th>Viajes</th><th>Recaudado</th><th>Se quedan los choferes</th></tr></thead><tbody>' +
            rep.per_method.map(function (r) {
              return '<tr><td>' + esc(r.method_name) + (r.is_cash ? ' (efectivo)' : '') + (r.is_unclassified ? ' (sin clasificar, no entra en el efectivo)' : '') + '</td><td>' + esc(r.trips) + '</td><td>' + money(r.total) + '</td><td>' + money(r.driver_keeps) + '</td></tr>';
            }).join('') + '</tbody></table></div>';
        }
        result.innerHTML = html;
        var csvBtn = document.getElementById('report-csv-btn');
        if (csvBtn) csvBtn.addEventListener('click', function () { downloadReportCsv(rep, form); });
        var zipBtn = document.getElementById('report-zip-btn');
        if (zipBtn) zipBtn.addEventListener('click', function () { downloadReceiptsZip(); });
        var printBtn = document.getElementById('report-print-btn');
        if (printBtn) printBtn.addEventListener('click', function () { printReport(rep, form); });
      } catch (e) { result.innerHTML = '<p class="error">' + esc(e.message) + '</p>'; }
    }

    form.addEventListener('submit', function (ev) { ev.preventDefault(); search(); });
    search();
  }

  // ---------- Cierre del día ----------

  function closeCardsHtml(closes, showKmAlert) {
    return closes.map(function (c) {
      var shiftLine = c.shift_taxi
        ? '<p>Taxi del día: ' + esc(c.shift_taxi) +
          (c.shift_entry_time ? ' · Entrada: ' + esc(c.shift_entry_time) + ' · ' + esc(c.shift_entry_km) + ' km' : '') +
          (c.shift_exit_time ? ' · Salida: ' + esc(c.shift_exit_time) + ' · ' + esc(c.shift_exit_km) + ' km' : '') + '</p>' +
          (c.km_driven !== null && c.km_driven !== undefined ? '<p>Km recorridos: ' + esc(c.km_driven) + ' km</p>' : '')
        : '<p class="muted">Sin jornada cargada para ese día.</p>';
      return '<div class="card"><h3>' + esc(c.driver_name) + ' · ' + esc(c.date) + '</h3>' +
        '<p>Viajes: ' + esc(c.trips_count) + '</p>' + shiftLine +
        (showKmAlert && c.km_alert ? '<p class="error">⚠ Alerta de km: este taxi abrió el día ' + esc(c.km_over) + ' km por encima de su último cierre (' + esc(c.prev_exit_km) + ' km).</p>' : '') +
        '<p>Total recaudado</p><p class="big-number">' + money(c.total_collected) + '</p>' +
        '<p>Te quedás / Se queda el chofer: <strong>' + money(c.driver_keeps) + '</strong></p>' +
        '<p>Gastos del día: ' + money(c.expenses) + '</p>' +
        '<p class="money-line">' + handoverCashLine(c, 'El dueño te debe') + '</p>' + methodsLine(c) + creditLines(c) + tipsLine(c) + settlementLine(c) + settlementButtons(c) +
        (c.note ? '<p>Aclaraciones: ' + esc(c.note) + '</p>' : '') +
        '<p class="muted">Solo el efectivo entra al chofer; tarjeta, Uber y transferencias van a la cuenta del dueño. Los gastos se descuentan de la parte del dueño.</p></div>';
    }).join('');
  }

  async function renderMyClose() {
    contentEl.innerHTML = '<h2>Cierre del día</h2><form id="close-form" class="row">' +
      '<label>Fecha <input name="date" type="date" value="' + todayLocal() + '" required' + (user.role === 'driver' ? ' min="' + driverWindowStart() + '"' : '') + '></label>' +
      '<button type="submit">Ver cierre</button></form>' +
      (user.role === 'driver' ? '<p class="muted">Podés ver hasta 30 días para atrás.</p>' : '') + '<div id="close-result"></div>';
    var form = document.getElementById('close-form');
    var result = document.getElementById('close-result');
    async function load() {
      // El chofer solo ve 30 días para atrás: una fecha más vieja se
      // ajusta al primer día visible (el backend, además, no devuelve
      // nada para fechas fuera de la ventana).
      var d = clampDriverDate(form.date.value);
      if (d !== form.date.value) form.date.value = d;
      try {
        var closes = await api('/api/day-close?date=' + encodeURIComponent(form.date.value));
        result.innerHTML = closes.length ? closeCardsHtml(closes) : '<p class="muted">Sin datos para esa fecha.</p>';
        wireSettleButtons(load);
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
    var driverOptions = drivers.filter(function (d) { return d.active; }).map(function (d) {
      return '<option value="' + d.id + '">' + esc(d.name) + '</option>';
    }).join('');
    var taxiOptions = '<option value="">Elegí el taxi…</option>' + taxis.map(function (t) {
      return '<option value="' + t.id + '">' + esc(t.identifier) + '</option>';
    }).join('');
    contentEl.innerHTML = '<h2>Cierres del día (todos los choferes)</h2><form id="close-form" class="row">' +
      '<label>Fecha <input name="date" type="date" value="' + todayLocal() + '" required></label>' +
      '<button type="submit">Ver cierres</button>' +
      '<label><input type="checkbox" id="close-pending-only"> Solo pendientes de liquidar</label></form><div id="close-result"></div>' +
      '<h3>Cargar o corregir jornada</h3><form id="shift-form" class="row">' +
      '<label>Chofer <select name="driver_id">' + driverOptions + '</select></label>' +
      '<label>Fecha <input name="shift_date" type="date" value="' + todayLocal() + '" required></label>' +
      '<label>Taxi del día <select name="taxi_id" required>' + taxiOptions + '</select></label>' +
      '<label>Hora de entrada <input name="entry_time" type="time" required></label>' +
      '<label>Km de entrada <input name="entry_km" type="number" step="0.01" min="0" required></label>' +
      '<label>Hora de cierre <input name="exit_time" type="time"></label>' +
      '<label>Km de cierre <input name="exit_km" type="number" step="0.01" min="0"></label>' +
      '<button type="submit">Guardar jornada</button></form>' +
      '<p class="muted">Si un chofer olvidó empezar o cerrar el día, cargalo acá. Guardar reemplaza la jornada de ese chofer y fecha.</p>';
    var form = document.getElementById('close-form');
    var result = document.getElementById('close-result');
    var pendingOnlyBox = document.getElementById('close-pending-only');
    var lastCloses = [];
    function renderCloses() {
      var pending = lastCloses.filter(isPendingClose);
      var shown = pendingOnlyBox.checked ? pending : lastCloses;
      var alerts = lastCloses.filter(function (c) { return c.km_alert; }).length;
      var banner = alerts ? '<p class="error">⚠ Alerta de km: ' + alerts + ' jornada(s) abrieron con más de 3 km por encima del último cierre de su taxi.</p>' : '';
      banner += '<p>Pendientes de liquidar: ' + pending.length + '.</p>';
      result.innerHTML = banner + (shown.length ? closeCardsHtml(shown, true) : '<p class="muted">Sin datos para esa fecha.</p>');
      wireSettleButtons(load);
    }
    async function load() {
      try {
        lastCloses = await api('/api/day-close?date=' + encodeURIComponent(form.date.value));
        renderCloses();
      } catch (e) { result.innerHTML = '<p class="error">' + esc(e.message) + '</p>'; }
    }
    form.addEventListener('submit', function (ev) { ev.preventDefault(); load(); });
    pendingOnlyBox.addEventListener('change', renderCloses);
    var shiftForm = document.getElementById('shift-form');
    shiftForm.addEventListener('submit', async function (ev) {
      ev.preventDefault();
      if (!shiftForm.taxi_id.value) { showMessage('Elegí el taxi del día.', 'error'); return; }
      if (!kmCierreValido(shiftForm.entry_km.value, shiftForm.exit_km.value)) return;
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
    // Historial de un taxi: filtra las jornadas por taxi y las ordena
    // de más reciente a más vieja (ante igual fecha, id descendente).
    // Km recorridos = km final - km inicial; una jornada abierta (sin
    // km final) queda con estado 'Abierta' y sin km final ni recorridos.
    // Usa km_driven cuando viene del backend y si no lo calcula.
    function historialTaxiRows(shifts, taxiId) {
      var rows = [];
      (shifts || []).forEach(function (s) {
        if (String(s.taxi_id) !== String(taxiId)) return;
        var abierta = s.exit_km === null || s.exit_km === undefined;
        var km = null;
        if (s.km_driven !== null && s.km_driven !== undefined) km = Number(s.km_driven);
        else if (!abierta && s.entry_km !== null && s.entry_km !== undefined) km = Math.round(((Number(s.exit_km) - Number(s.entry_km)) + Number.EPSILON) * 100) / 100;
        rows.push({ id: s.id, date: s.shift_date, driver: s.driver_name || '', entry_km: s.entry_km, exit_km: abierta ? null : s.exit_km, km: abierta ? null : km, estado: abierta ? 'Abierta' : 'Cerrada' });
      });
      rows.sort(function (a, b) {
        if (a.date < b.date) return 1;
        if (a.date > b.date) return -1;
        return (Number(b.id) || 0) - (Number(a.id) || 0);
      });
      return rows;
    }
    var rows = taxis.map(function (t) {
      return '<div class="card"><p><strong>' + esc(t.identifier) + '</strong> · ' + esc(t.plate) + ' · ' + esc(t.model) + ' · ' + esc(t.year || '') + ' · ' + (t.active ? 'Activo' : 'Inactivo') + '</p>' +
        '<div class="row"><button type="button" class="secondary small" data-edit-taxi="' + t.id + '">Editar</button>' +
        '<button type="button" class="secondary small" data-history-taxi="' + t.id + '">Historial</button>' +
        '<button type="button" class="danger small" data-del-taxi="' + t.id + '">Borrar</button></div></div>';
    }).join('');
    contentEl.innerHTML = '<h2>Taxis</h2><form id="taxi-form">' +
      '<input type="hidden" name="id">' +
      '<label>Identificador <input name="identifier" type="text" placeholder="Ej: TAXI-01" required></label>' +
      '<label>Patente (opcional) <input name="plate" type="text"></label>' +
      '<label>Modelo <input name="model" type="text"></label>' +
      '<label>Año <input name="year" type="number" min="1980" max="2100"></label>' +
      '<label><input name="active" type="checkbox" checked> Activo</label>' +
      '<button type="submit">Guardar taxi</button></form><h3>Lista</h3>' +
      (rows || '<p class="muted">Todavía no hay taxis.</p>') +
      '<div id="taxi-history"></div>';
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
    contentEl.querySelectorAll('[data-history-taxi]').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        var taxiId = btn.getAttribute('data-history-taxi');
        var taxi = taxis.find(function (x) { return String(x.id) === String(taxiId); });
        var box = document.getElementById('taxi-history');
        box.innerHTML = '<p class="muted">Buscando historial…</p>';
        try {
          var all = await api('/api/shifts');
          var rows = historialTaxiRows(all, taxiId);
          if (!rows.length) {
            box.innerHTML = '<h3>Historial · ' + esc(taxi ? taxi.identifier : '') + '</h3><p class="muted">Sin jornadas para este taxi.</p><button type="button" class="secondary small" data-close-history>Cerrar</button>';
          } else {
            box.innerHTML = '<h3>Historial · ' + esc(taxi ? taxi.identifier : '') + '</h3><div class="table-wrap"><table><thead><tr><th>Fecha</th><th>Chofer</th><th>Km inicial</th><th>Km final</th><th>Km recorridos</th><th>Estado</th></tr></thead><tbody>' +
              rows.map(function (r) {
                return '<tr><td>' + esc(r.date) + '</td><td>' + esc(r.driver) + '</td><td>' + (r.entry_km !== null && r.entry_km !== undefined ? esc(r.entry_km) + ' km' : '—') + '</td><td>' + (r.exit_km !== null && r.exit_km !== undefined ? esc(r.exit_km) + ' km' : '—') + '</td><td>' + (r.km !== null && r.km !== undefined ? esc(r.km) + ' km' : '—') + '</td><td>' + esc(r.estado) + '</td></tr>';
              }).join('') + '</tbody></table></div><button type="button" class="secondary small" data-close-history>Cerrar</button>';
          }
          var closeBtn = box.querySelector('[data-close-history]');
          if (closeBtn) closeBtn.addEventListener('click', function () { box.innerHTML = ''; });
        } catch (e) { box.innerHTML = '<p class="error">' + esc(e.message) + '</p>'; }
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
    var demo = companies.find(function (c) { return c.name === 'Demo'; });
    var demoLink = demo ? origin + '/?company=' + esc(demo.code) : '';
    var demoCard = !demo
      ? '<div class="card"><p><strong>Link de test</strong></p><p class="muted">La empresa Demo no existe todavía.</p></div>'
      : !demo.active
        ? '<div class="card"><p><strong>Link de test (empresa Demo)</strong></p><p class="muted">La demo está suspendida: reactivala desde su tarjeta para usar el link de test.</p></div>'
        : '<div class="card"><p><strong>Link de test (empresa Demo)</strong></p>' +
          '<p><a href="' + demoLink + '">' + demoLink + '</a> ' +
          '<button type="button" class="small" data-copy-link="' + demoLink + '">Copiar</button></p>' +
          '<p><button type="button" id="regen-demo-link">Generar nuevo link de test</button></p>' +
          '<p class="muted">Al generar uno nuevo, el link anterior deja de llevar a la demo.</p></div>';
    var rows = companies.map(function (c) {
      var link = origin + '/?company=' + esc(c.code) + '&login=owner';
      var companyLink = origin + '/?company=' + esc(c.code);
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
        '<p>Link empresa (admin + choferes): <a href="' + companyLink + '">' + companyLink + '</a> ' +
        '<button type="button" class="small" data-copy-link="' + companyLink + '">Copiar</button></p>' +
        '<p>Link dueño (email y PIN): <a href="' + link + '">' + link + '</a></p>' + actions + '</div>';
    }).join('');
    contentEl.innerHTML = '<h2>Empresas</h2>' +
      '<p class="muted">Solo vos ves este panel. Acá das de alta a los dueños y los manejás según su pago: podés suspender a quien no pagó (deja de poder entrar) y reactivarlo cuando pague. Borrar elimina la empresa y todos sus datos y no se puede deshacer.</p>' +
      demoCard +
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
        var companyLink = window.location.origin + '/?company=' + result.company.code;
        showMessage('Empresa creada: ' + result.company.name + ' — código ' + result.company.code + '. Link empresa (admin + choferes, para enviar cuando paguen): ' + companyLink + ' — Link dueño (email y PIN): ' + ownerLink + '.', 'ok');
        renderTab();
      } catch (e) { showMessage(e.message, 'error'); }
    });
    var regenBtn = document.getElementById('regen-demo-link');
    if (regenBtn) {
      regenBtn.addEventListener('click', async function () {
        if (!window.confirm('¿Generar un nuevo link de test? El link anterior dejará de funcionar.')) return;
        try {
          var result = await api('/api/company?panel=1', 'POST', { regenerate_demo: true });
          showMessage('Nuevo link de test: ' + window.location.origin + '/?company=' + result.code, 'ok');
          renderTab();
        } catch (e) { showMessage(e.message, 'error'); }
      });
    }
    contentEl.querySelectorAll('[data-copy-link]').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        var url = btn.getAttribute('data-copy-link');
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(url);
            showMessage('Link copiado.', 'ok');
            return;
          }
          throw new Error('sin clipboard');
        } catch (e) {
          var tmp = document.createElement('textarea');
          tmp.value = url;
          document.body.appendChild(tmp);
          tmp.select();
          try { document.execCommand('copy'); showMessage('Link copiado.', 'ok'); }
          catch (e2) { showMessage('No se pudo copiar: ' + url, 'error'); }
          tmp.remove();
        }
      });
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
    var userId = fixedLogin ? fixedLogin.user_id : document.getElementById('user-select').value;
    var companyId = fixedLogin ? fixedLogin.company_id : document.getElementById('company-select').value;
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

  // Sin botón para el ingreso con email y PIN en la pantalla principal: los
  // dueños entran con nombre + PIN (aparecen con "(admin)" en la lista). El
  // formulario de email y PIN sigue disponible con el link ?login=owner.

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
