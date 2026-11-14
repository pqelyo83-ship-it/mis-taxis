// /api/report — reportes del administrador.
// Filtros: ?from=YYYY-MM-DD&to=YYYY-MM-DD (por defecto últimos 30 días),
// ?driver_id= (todos si no viene), ?taxi_id= (todos si no viene),
// ?payment_method_id= (todos si no viene).
// Devuelve totales del período, $/km por día y promedio, y desgloses
// por chofer, por taxi y por método de pago.
// $/km: solo se calcula sobre días con kilometraje cargado (jornada con
// salida). Los días sin jornada no entran en el promedio.
// Cadena en efectivo (igual que el cierre del día en /api/day-close):
// solo el efectivo entra al chofer; tarjeta, Uber, transferencias y demás
// van a la cuenta del dueño. Por eso:
//   deben entregar en efectivo = efectivo - se quedan - gastos
// El efectivo es la suma de viajes con método 'efectivo' (sin importar
// mayúsculas ni espacios); los viajes sin método quedan sin clasificar y
// no entran en el efectivo. Si la entrega en efectivo da negativa, el
// dueño les debe esa plata a los choferes. Se mantiene también la cadena
// vieja (handover_to_owner = total - keeps - gastos) por compatibilidad,
// pero las vistas usan la cadena en efectivo. Todo se calcula al leer,
// sin tocar ningún viaje, gasto ni jornada guardada.
// Gastos con filtro de taxi: se asignan al auto según el taxi del día
// de cada gasto (la jornada de ese chofer y fecha); un gasto de un día
// sin jornada no se puede asignar a un auto y queda fuera del reporte
// filtrado por taxi.
// Saldo a favor del chofer (NO es un gasto): cuando un día cierra con
// entrega negativa, el dueño le queda debiendo esa plata y se descuenta
// de la entrega de los días cerrados siguientes, hasta agotarse. Se
// calcula sobre la secuencia COMPLETA de días cerrados de cada chofer
// (todas las fechas, autos y métodos), para que los filtros no corrompan
// el saldo; los días abiertos no mueven saldo. Totales: saldo inicial
// (lo que venía debiendo el dueño al arrancar el período), aplicado en
// el período, entrega neta y saldo restante. Con filtro de auto o método,
// las cifras de saldo son de secuencia completa y pueden no coincidir con
// el efectivo filtrado (la vista lo aclara con una nota).
// Liquidación marcada por el dueño (migración v9): un día marcado
// "pagado" NO genera saldo a favor (el dueño ya pagó esa deuda en mano),
// así que los días siguientes se calculan sin ese descuento; si ya habían
// cerrado con el descuento aplicado, sus entregas netas se recalculan
// hacia arriba (quedan pendientes de liquidar). "Recibido" nunca cambia
// números. Si la migración v9 todavía no se aplicó, todo se trata como
// "pendiente" (fallback 42703).

const { getPool, requireAuth, round2, methodNotAllowed } = require('./_db');

function dateStr(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function isDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
}

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

function daysAgoUtc(n) {
  return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
}

module.exports = async function handler(req, res) {
  const user = await requireAuth(req, res, ['admin']);
  if (!user) return;
  if (req.method !== 'GET') return methodNotAllowed(res);
  const pool = getPool();

  const from = isDate(req.query.from) ? req.query.from : daysAgoUtc(30);
  const to = isDate(req.query.to) ? req.query.to : todayUtc();
  if (from > to) {
    res.status(400).json({ error: 'La fecha desde no puede ser mayor que la fecha hasta' });
    return;
  }
  const driverId = req.query.driver_id ? Number(req.query.driver_id) : null;
  const taxiId = req.query.taxi_id ? Number(req.query.taxi_id) : null;
  const methodId = req.query.payment_method_id ? Number(req.query.payment_method_id) : null;

  // Condiciones para viajes (por fecha de viaje). Siempre con empresa.
  const tripCond = ['tr.company_id = $1', 'tr.trip_date BETWEEN $2 AND $3'];
  const tripParams = [user.company_id, from, to];
  if (driverId) { tripParams.push(driverId); tripCond.push('tr.driver_id = $' + tripParams.length); }
  if (taxiId) { tripParams.push(taxiId); tripCond.push('tr.taxi_id = $' + tripParams.length); }
  if (methodId) { tripParams.push(methodId); tripCond.push('tr.payment_method_id = $' + tripParams.length); }
  const tripWhere = 'WHERE ' + tripCond.join(' AND ');
  // Versión por turno: el rango filtra por el día en que empezó el turno
  // del viaje (un viaje de la 01:00 cuenta en el turno que empezó el día
  // anterior, así que entra en el rango de ese día).
  const tripCondAttr = tripCond.slice();
  tripCondAttr[1] = 'COALESCE(sh.shift_date, tr.trip_date) BETWEEN $2 AND $3';
  const tripWhereAttr = 'WHERE ' + tripCondAttr.join(' AND ');
  const tripJoinAttr = ' LEFT JOIN day_shifts sh ON sh.id = tr.shift_id';

  // Condiciones para jornadas (por fecha de jornada). Siempre con empresa.
  const shiftCond = ['s.company_id = $1', 's.shift_date BETWEEN $2 AND $3'];
  const shiftParams = [user.company_id, from, to];
  if (driverId) { shiftParams.push(driverId); shiftCond.push('s.driver_id = $' + shiftParams.length); }
  if (taxiId) { shiftParams.push(taxiId); shiftCond.push('s.taxi_id = $' + shiftParams.length); }
  const shiftWhere = 'WHERE ' + shiftCond.join(' AND ');

  // Viajes por día: cada viaje cuenta en el día en que EMPEZÓ su turno
  // (un viaje de la 01:00 de la madrugada cuenta en el turno de noche
  // que empezó el día anterior, no en un día aparte). Los viajes viejos
  // sin turno atado cuentan por su fecha, como antes.
  let tripsByDay;
  try {
    tripsByDay = await pool.query(
      `SELECT COALESCE(sh.shift_date, tr.trip_date) AS trip_date, COUNT(*) AS trips, COALESCE(SUM(tr.amount), 0) AS total,
              COALESCE(SUM(tr.amount * tr.pct_snapshot / 100), 0) AS keeps,
              COALESCE(SUM(CASE WHEN pm.id IS NULL THEN tr.amount ELSE 0 END), 0) AS unclassified,
              COALESCE(SUM(CASE WHEN LOWER(TRIM(pm.name)) = 'efectivo' THEN tr.amount ELSE 0 END), 0) AS cash
       FROM trips tr LEFT JOIN payment_methods pm ON pm.id = tr.payment_method_id
       LEFT JOIN day_shifts sh ON sh.id = tr.shift_id ${tripWhereAttr} GROUP BY COALESCE(sh.shift_date, tr.trip_date) ORDER BY COALESCE(sh.shift_date, tr.trip_date)`,
      tripParams
    );
  } catch (e) {
    if (e && e.code === '42703') {
      tripsByDay = await pool.query(
        `SELECT tr.trip_date, COUNT(*) AS trips, COALESCE(SUM(tr.amount), 0) AS total,
                COALESCE(SUM(tr.amount * tr.pct_snapshot / 100), 0) AS keeps,
                COALESCE(SUM(CASE WHEN pm.id IS NULL THEN tr.amount ELSE 0 END), 0) AS unclassified,
                COALESCE(SUM(CASE WHEN LOWER(TRIM(pm.name)) = 'efectivo' THEN tr.amount ELSE 0 END), 0) AS cash
         FROM trips tr LEFT JOIN payment_methods pm ON pm.id = tr.payment_method_id ${tripWhere} GROUP BY tr.trip_date ORDER BY tr.trip_date`,
        tripParams
      );
    } else throw e;
  }
  const kmByDay = await pool.query(
    `SELECT s.shift_date, COALESCE(SUM(s.exit_km - s.entry_km), 0) AS km
     FROM day_shifts s ${shiftWhere} AND s.exit_km IS NOT NULL
     GROUP BY s.shift_date ORDER BY s.shift_date`,
    shiftParams
  );
  let tripsByDriver;
  try {
    tripsByDriver = await pool.query(
      `SELECT tr.driver_id, u.name AS driver_name, COUNT(*) AS trips,
              COALESCE(SUM(tr.amount), 0) AS total,
              COALESCE(SUM(tr.amount * tr.pct_snapshot / 100), 0) AS keeps,
              COALESCE(SUM(CASE WHEN pm.id IS NULL THEN tr.amount ELSE 0 END), 0) AS unclassified,
              COALESCE(SUM(CASE WHEN LOWER(TRIM(pm.name)) = 'efectivo' THEN tr.amount ELSE 0 END), 0) AS cash
       FROM trips tr JOIN users u ON u.id = tr.driver_id
       LEFT JOIN payment_methods pm ON pm.id = tr.payment_method_id${tripJoinAttr} ${tripWhereAttr}
       GROUP BY tr.driver_id, u.name ORDER BY total DESC`,
      tripParams
    );
  } catch (e) {
    if (e && e.code === '42703') {
      tripsByDriver = await pool.query(
        `SELECT tr.driver_id, u.name AS driver_name, COUNT(*) AS trips,
                COALESCE(SUM(tr.amount), 0) AS total,
                COALESCE(SUM(tr.amount * tr.pct_snapshot / 100), 0) AS keeps,
                COALESCE(SUM(CASE WHEN pm.id IS NULL THEN tr.amount ELSE 0 END), 0) AS unclassified,
                COALESCE(SUM(CASE WHEN LOWER(TRIM(pm.name)) = 'efectivo' THEN tr.amount ELSE 0 END), 0) AS cash
         FROM trips tr JOIN users u ON u.id = tr.driver_id
         LEFT JOIN payment_methods pm ON pm.id = tr.payment_method_id ${tripWhere}
         GROUP BY tr.driver_id, u.name ORDER BY total DESC`,
        tripParams
      );
    } else throw e;
  }
  const kmByDriver = await pool.query(
    `SELECT s.driver_id, COALESCE(SUM(s.exit_km - s.entry_km), 0) AS km
     FROM day_shifts s ${shiftWhere} AND s.exit_km IS NOT NULL
     GROUP BY s.driver_id`,
    shiftParams
  );
  let tripsByTaxi;
  try {
    tripsByTaxi = await pool.query(
      `SELECT tr.taxi_id, t.identifier AS taxi_identifier, COUNT(*) AS trips,
              COALESCE(SUM(tr.amount), 0) AS total
       FROM trips tr LEFT JOIN taxis t ON t.id = tr.taxi_id${tripJoinAttr} ${tripWhereAttr}
       GROUP BY tr.taxi_id, t.identifier ORDER BY total DESC`,
      tripParams
    );
  } catch (e) {
    if (e && e.code === '42703') {
      tripsByTaxi = await pool.query(
        `SELECT tr.taxi_id, t.identifier AS taxi_identifier, COUNT(*) AS trips,
                COALESCE(SUM(tr.amount), 0) AS total
         FROM trips tr LEFT JOIN taxis t ON t.id = tr.taxi_id ${tripWhere}
         GROUP BY tr.taxi_id, t.identifier ORDER BY total DESC`,
        tripParams
      );
    } else throw e;
  }
  const kmByTaxi = await pool.query(
    `SELECT s.taxi_id, COALESCE(SUM(s.exit_km - s.entry_km), 0) AS km
     FROM day_shifts s ${shiftWhere} AND s.exit_km IS NOT NULL
     GROUP BY s.taxi_id`,
    shiftParams
  );

  // Gastos: filtro de chofer directo; filtro de taxi vía el turno al que
  // está atado el gasto (o la jornada de su fecha si es viejo). Los
  // gastos por día cuentan en el día en que empezó su turno, igual que
  // los viajes. Siempre con empresa.
  const expCond = ['e.company_id = $1', 'e.expense_date BETWEEN $2 AND $3'];
  const expParams = [user.company_id, from, to];
  if (driverId) { expParams.push(driverId); expCond.push('e.driver_id = $' + expParams.length); }
  if (taxiId) {
    expParams.push(taxiId);
    expCond.push('s.taxi_id = $' + expParams.length);
  }
  const expCondAttr = expCond.slice();
  expCondAttr[1] = 'COALESCE(s2.shift_date, e.expense_date) BETWEEN $2 AND $3';
  async function runExpenseQueries(aware) {
    const expJoin = taxiId
      ? (aware
        ? ' LEFT JOIN day_shifts s ON s.company_id = e.company_id AND s.driver_id = e.driver_id AND ((e.shift_id IS NOT NULL AND s.id = e.shift_id) OR (e.shift_id IS NULL AND s.shift_date = e.expense_date))'
        : ' LEFT JOIN day_shifts s ON s.driver_id = e.driver_id AND s.shift_date = e.expense_date AND s.company_id = e.company_id')
      : '';
    const attrJoin = aware ? ' LEFT JOIN day_shifts s2 ON s2.id = e.shift_id' : '';
    const cond = aware ? expCondAttr : expCond;
    const total = await pool.query(
      `SELECT COALESCE(SUM(e.amount), 0) AS total FROM expenses e${attrJoin}${expJoin} WHERE ${cond.join(' AND ')}`,
      expParams
    );
    const byDay = aware
      ? await pool.query(
          `SELECT COALESCE(s2.shift_date, e.expense_date) AS expense_date, COALESCE(SUM(e.amount), 0) AS total FROM expenses e${attrJoin}${expJoin} WHERE ${cond.join(' AND ')} GROUP BY COALESCE(s2.shift_date, e.expense_date)`,
          expParams
        )
      : await pool.query(
          `SELECT e.expense_date, COALESCE(SUM(e.amount), 0) AS total FROM expenses e${expJoin} WHERE ${cond.join(' AND ')} GROUP BY e.expense_date`,
          expParams
        );
    const byDriver = await pool.query(
      `SELECT e.driver_id, COALESCE(SUM(e.amount), 0) AS total FROM expenses e${attrJoin}${expJoin} WHERE ${cond.join(' AND ')} GROUP BY e.driver_id`,
      expParams
    );
    return { total: total, byDay: byDay, byDriver: byDriver };
  }
  let expenseResults;
  try {
    expenseResults = await runExpenseQueries(true);
  } catch (e) {
    // Sin migración v11: gastos por fecha, como antes.
    if (e && e.code === '42703') expenseResults = await runExpenseQueries(false);
    else throw e;
  }
  const expenses = expenseResults.total;
  // Gastos por día y por chofer (mismos filtros que el total): necesarios
  // para la entrega en efectivo por día y por chofer.
  const expensesByDay = expenseResults.byDay;
  const expensesByDriver = expenseResults.byDriver;

  const kmMap = {};
  kmByDay.rows.forEach(function (r) { kmMap[dateStr(r.shift_date)] = Number(r.km); });
  const perDayMap = {};
  tripsByDay.rows.forEach(function (r) {
    const d = dateStr(r.trip_date);
    perDayMap[d] = { date: d, trips: Number(r.trips), total: round2(r.total), keeps: round2(r.keeps), cash_total: round2(r.cash), unclassified_total: round2(r.unclassified), expenses: 0, handover_cash: null, km: null, per_km: null };
  });
  expensesByDay.rows.forEach(function (r) {
    const d = dateStr(r.expense_date);
    if (!perDayMap[d]) perDayMap[d] = { date: d, trips: 0, total: 0, keeps: 0, cash_total: 0, unclassified_total: 0, expenses: 0, handover_cash: null, km: null, per_km: null };
    perDayMap[d].expenses = round2(r.total);
  });
  Object.keys(kmMap).forEach(function (d) {
    if (!perDayMap[d]) perDayMap[d] = { date: d, trips: 0, total: 0, keeps: 0, cash_total: 0, unclassified_total: 0, expenses: 0, handover_cash: null, km: null, per_km: null };
    perDayMap[d].km = round2(kmMap[d]);
  });

  // Saldo a favor del chofer (NO es un gasto): se calcula sobre la
  // secuencia COMPLETA de días cerrados de cada chofer (todas las fechas,
  // autos y métodos), para que los filtros del reporte (auto, método) no
  // corrompan el saldo. Los días abiertos no mueven saldo. Todo se deriva
  // al leer, sin guardar nada nuevo. Ojo: con filtro de auto o método, las
  // cifras de saldo son de secuencia completa y pueden no coincidir con el
  // efectivo filtrado; la vista lo aclara con una nota.
  // La columna settlement puede no existir si la migración v9 todavía no
  // se aplicó: en ese caso todo es "pendiente" (fallback 42703).
  const creditShiftParams = [user.company_id];
  let creditShiftCond = 's.company_id = $1 AND s.exit_km IS NOT NULL';
  if (driverId) { creditShiftParams.push(driverId); creditShiftCond += ' AND s.driver_id = $' + creditShiftParams.length; }
  let creditShifts;
  try {
    creditShifts = await pool.query(
      `SELECT s.id, s.driver_id, s.shift_date, s.settlement FROM day_shifts s WHERE ${creditShiftCond} ORDER BY s.driver_id, s.shift_date, s.id`,
      creditShiftParams
    );
  } catch (e) {
    if (e && e.code === '42703') {
      creditShifts = await pool.query(
        `SELECT s.id, s.driver_id, s.shift_date FROM day_shifts s WHERE ${creditShiftCond} ORDER BY s.driver_id, s.shift_date, s.id`,
        creditShiftParams
      );
    } else throw e;
  }
  const creditTripParams = [user.company_id];
  let creditTripCond = 'tr.company_id = $1';
  if (driverId) { creditTripParams.push(driverId); creditTripCond += ' AND tr.driver_id = $' + creditTripParams.length; }
  let creditTrips;
  try {
    creditTrips = await pool.query(
      `SELECT tr.driver_id, tr.shift_id, tr.trip_date,
              COALESCE(SUM(tr.amount * tr.pct_snapshot / 100), 0) AS keeps,
              COALESCE(SUM(CASE WHEN LOWER(TRIM(pm.name)) = 'efectivo' THEN tr.amount ELSE 0 END), 0) AS cash
       FROM trips tr LEFT JOIN payment_methods pm ON pm.id = tr.payment_method_id
       WHERE ${creditTripCond} GROUP BY tr.driver_id, tr.shift_id, tr.trip_date`,
      creditTripParams
    );
  } catch (e) {
    if (e && e.code === '42703') {
      creditTrips = await pool.query(
        `SELECT tr.driver_id, tr.trip_date,
                COALESCE(SUM(tr.amount * tr.pct_snapshot / 100), 0) AS keeps,
                COALESCE(SUM(CASE WHEN LOWER(TRIM(pm.name)) = 'efectivo' THEN tr.amount ELSE 0 END), 0) AS cash
         FROM trips tr LEFT JOIN payment_methods pm ON pm.id = tr.payment_method_id
         WHERE ${creditTripCond} GROUP BY tr.driver_id, tr.trip_date`,
        creditTripParams
      );
    } else throw e;
  }
  const creditExpParams = [user.company_id];
  let creditExpCond = 'e.company_id = $1';
  if (driverId) { creditExpParams.push(driverId); creditExpCond += ' AND e.driver_id = $' + creditExpParams.length; }
  let creditExpenses;
  try {
    creditExpenses = await pool.query(
      `SELECT e.driver_id, e.shift_id, e.expense_date, COALESCE(SUM(e.amount), 0) AS total FROM expenses e WHERE ${creditExpCond} GROUP BY e.driver_id, e.shift_id, e.expense_date`,
      creditExpParams
    );
  } catch (e) {
    if (e && e.code === '42703') {
      creditExpenses = await pool.query(
        `SELECT e.driver_id, e.expense_date, COALESCE(SUM(e.amount), 0) AS total FROM expenses e WHERE ${creditExpCond} GROUP BY e.driver_id, e.expense_date`,
        creditExpParams
      );
    } else throw e;
  }
  const creditNames = await pool.query(
    `SELECT id, name FROM users WHERE company_id = $1${driverId ? ' AND id = $2' : ''}`,
    driverId ? [user.company_id, driverId] : [user.company_id]
  );
  // Turnos cerrados por chofer, en orden cronológico (fecha de inicio y
  // luego id: un día puede tener más de un turno).
  const creditClosedShifts = {};
  creditShifts.rows.forEach(function (r) {
    if (!creditClosedShifts[r.driver_id]) creditClosedShifts[r.driver_id] = [];
    creditClosedShifts[r.driver_id].push({ id: r.id, date: dateStr(r.shift_date), settlement: r.settlement || 'pendiente' });
  });
  const shiftDateById = {};
  creditShifts.rows.forEach(function (r) { shiftDateById[r.id] = dateStr(r.shift_date); });
  // Viajes y gastos por turno (shift_id) y, para los viejos sin turno,
  // por fecha. También se arman los mapas por fecha de atribución (día
  // en que empezó el turno, o fecha del viaje/gasto si no hay turno)
  // para las fechas con actividad pero sin turno cerrado.
  const creditTripByShift = {};
  const creditTripLegacy = {};
  const creditTripAttr = {};
  creditTrips.rows.forEach(function (r) {
    const did = r.driver_id;
    const cash = round2(r.cash);
    const keeps = round2(r.keeps);
    if (r.shift_id !== null && r.shift_id !== undefined) {
      if (!creditTripByShift[did]) creditTripByShift[did] = {};
      const prev = creditTripByShift[did][r.shift_id] || { cash: 0, keeps: 0 };
      creditTripByShift[did][r.shift_id] = { cash: round2(prev.cash + cash), keeps: round2(prev.keeps + keeps) };
      const d = shiftDateById[r.shift_id] || dateStr(r.trip_date);
      if (!creditTripAttr[did]) creditTripAttr[did] = {};
      const prevA = creditTripAttr[did][d] || { cash: 0, keeps: 0 };
      creditTripAttr[did][d] = { cash: round2(prevA.cash + cash), keeps: round2(prevA.keeps + keeps) };
    } else {
      const d = dateStr(r.trip_date);
      if (!creditTripLegacy[did]) creditTripLegacy[did] = {};
      const prev = creditTripLegacy[did][d] || { cash: 0, keeps: 0 };
      creditTripLegacy[did][d] = { cash: round2(prev.cash + cash), keeps: round2(prev.keeps + keeps) };
      if (!creditTripAttr[did]) creditTripAttr[did] = {};
      const prevA = creditTripAttr[did][d] || { cash: 0, keeps: 0 };
      creditTripAttr[did][d] = { cash: round2(prevA.cash + cash), keeps: round2(prevA.keeps + keeps) };
    }
  });
  const creditExpByShift = {};
  const creditExpLegacy = {};
  const creditExpAttr = {};
  creditExpenses.rows.forEach(function (r) {
    const did = r.driver_id;
    const total = round2(r.total);
    if (r.shift_id !== null && r.shift_id !== undefined) {
      if (!creditExpByShift[did]) creditExpByShift[did] = {};
      creditExpByShift[did][r.shift_id] = round2((creditExpByShift[did][r.shift_id] || 0) + total);
      const d = shiftDateById[r.shift_id] || dateStr(r.expense_date);
      if (!creditExpAttr[did]) creditExpAttr[did] = {};
      creditExpAttr[did][d] = round2((creditExpAttr[did][d] || 0) + total);
    } else {
      const d = dateStr(r.expense_date);
      if (!creditExpLegacy[did]) creditExpLegacy[did] = {};
      creditExpLegacy[did][d] = round2((creditExpLegacy[did][d] || 0) + total);
      if (!creditExpAttr[did]) creditExpAttr[did] = {};
      creditExpAttr[did][d] = round2((creditExpAttr[did][d] || 0) + total);
    }
  });
  const creditNameMap = {};
  creditNames.rows.forEach(function (r) { creditNameMap[r.id] = r.name; });
  function driverCreditData(driverIdKey) {
    const shifts = (creditClosedShifts[driverIdKey] || []).slice();
    const tByShift = creditTripByShift[driverIdKey] || {};
    const tLegacy = creditTripLegacy[driverIdKey] || {};
    const eByShift = creditExpByShift[driverIdKey] || {};
    const eLegacy = creditExpLegacy[driverIdKey] || {};
    const tAttr = creditTripAttr[driverIdKey] || {};
    const eAttr = creditExpAttr[driverIdKey] || {};
    // Los viejos sin turno solo cuentan en el primer turno cerrado de su
    // fecha (si un día tiene dos turnos, no se duplican).
    const firstClosedByDate = {};
    shifts.forEach(function (s) {
      if (firstClosedByDate[s.date] === undefined) firstClosedByDate[s.date] = s.id;
    });
    function rawForShift(s) {
      const ht = tByShift[s.id] || { cash: 0, keeps: 0 };
      const legacy = firstClosedByDate[s.date] === s.id ? (tLegacy[s.date] || { cash: 0, keeps: 0 }) : { cash: 0, keeps: 0 };
      const cash = round2(ht.cash + legacy.cash);
      const keeps = round2(ht.keeps + legacy.keeps);
      const exp = round2((eByShift[s.id] || 0) + (firstClosedByDate[s.date] === s.id ? (eLegacy[s.date] || 0) : 0));
      return round2(cash - keeps - exp);
    }
    function rawFor(d) {
      const t = tAttr[d];
      const cash = t ? round2(t.cash) : 0;
      const keeps = t ? round2(t.keeps) : 0;
      const exp = eAttr[d] !== undefined ? round2(eAttr[d]) : 0;
      return round2(cash - keeps - exp);
    }
    // Paso único: saldo acumulado con lotes implícitos. Un turno marcado
    // "pagado" no genera saldo (el dueño ya pagó esa deuda en mano), así
    // que los turnos siguientes se calculan sin ese descuento. La
    // secuencia es por turno; el mapa por fecha agrega los turnos del
    // mismo día (before del primero, applied/net sumados, after del
    // último) para la tabla por día.
    const byDate = {};
    let credit = 0;
    shifts.forEach(function (s) {
      const raw = rawForShift(s);
      const before = round2(credit);
      let applied = 0;
      let paid = 0;
      if (raw > 0 && credit > 0) {
        applied = round2(Math.min(credit, raw));
        credit = round2(credit - applied);
      } else if (raw < 0) {
        if ((s.settlement || 'pendiente') === 'pagado') paid = round2(-raw);
        else credit = round2(credit - raw);
      }
      const row = byDate[s.date] || (byDate[s.date] = { before: before, applied: 0, net: 0, after: 0, settlement: s.settlement || 'pendiente', paid: 0 });
      row.applied = round2(row.applied + applied);
      row.net = round2(row.net + round2(raw - applied));
      row.after = round2(credit);
      row.settlement = s.settlement || 'pendiente';
      row.paid = round2(row.paid + paid);
    });
    const closedDates = Object.keys(byDate).sort();
    const activityDates = {};
    Object.keys(tAttr).forEach(function (d) { activityDates[d] = true; });
    Object.keys(eAttr).forEach(function (d) { activityDates[d] = true; });
    return { closedDates: closedDates, byDate: byDate, rawFor: rawFor, activityDates: activityDates };
  }
  const creditDriverIds = {};
  Object.keys(creditClosedShifts).forEach(function (id) { creditDriverIds[id] = true; });
  Object.keys(creditTripAttr).forEach(function (id) { creditDriverIds[id] = true; });
  Object.keys(creditExpAttr).forEach(function (id) { creditDriverIds[id] = true; });
  const creditByDriver = {};
  Object.keys(creditDriverIds).forEach(function (id) { creditByDriver[id] = driverCreditData(id); });
  const creditDayMap = {};
  const driverCreditSummary = {};
  Object.keys(creditByDriver).forEach(function (id) {
    const c = creditByDriver[id];
    let opening = 0;
    c.closedDates.forEach(function (d) { if (d < from) opening = c.byDate[d].after; });
    opening = round2(opening);
    let applied = 0, net = 0, closing = opening;
    const periodDates = {};
    c.closedDates.forEach(function (d) { if (d >= from && d <= to) periodDates[d] = true; });
    Object.keys(c.activityDates).forEach(function (d) { if (d >= from && d <= to) periodDates[d] = true; });
    Object.keys(periodDates).sort().forEach(function (d) {
      if (c.byDate[d]) { applied = round2(applied + c.byDate[d].applied); net = round2(net + c.byDate[d].net); }
      else net = round2(net + c.rawFor(d));
    });
    c.closedDates.forEach(function (d) { if (d <= to) closing = c.byDate[d].after; });
    driverCreditSummary[id] = { opening: opening, applied: applied, net: net, closing: round2(closing) };
    c.closedDates.forEach(function (d) {
      if (d < from || d > to) return;
      const row = creditDayMap[d] || (creditDayMap[d] = { before: 0, applied: 0, net: 0 });
      row.before = round2(row.before + c.byDate[d].before);
      row.applied = round2(row.applied + c.byDate[d].applied);
      row.net = round2(row.net + c.byDate[d].net);
    });
    Object.keys(c.activityDates).forEach(function (d) {
      if (d < from || d > to) return;
      if (c.byDate[d]) return;
      const row = creditDayMap[d] || (creditDayMap[d] = { before: 0, applied: 0, net: 0 });
      row.net = round2(row.net + c.rawFor(d));
    });
  });
  // Días con movimiento de saldo pero sin actividad filtrada: se agregan
  // para que las columnas de saldo sumen con los totales. Su entrega bruta
  // es la de secuencia completa (neto + aplicado), no la filtrada.
  Object.keys(creditDayMap).forEach(function (d) {
    if (!perDayMap[d]) {
      const cd0 = creditDayMap[d];
      perDayMap[d] = { date: d, trips: 0, total: 0, keeps: 0, cash_total: 0, unclassified_total: 0, expenses: 0, handover_cash: round2(cd0.net + cd0.applied), km: null, per_km: null };
    }
  });
  const perDay = Object.keys(perDayMap).sort().map(function (d) {
    const row = perDayMap[d];
    if (row.km !== null && row.km > 0) row.per_km = round2(row.total / row.km);
    if (row.handover_cash === null || row.handover_cash === undefined) row.handover_cash = round2((row.cash_total || 0) - (row.keeps || 0) - (row.expenses || 0));
    const cd = creditDayMap[d];
    row.credit_before = cd ? round2(cd.before) : 0;
    row.credit_applied = cd ? round2(cd.applied) : 0;
    row.handover_net = cd ? round2(cd.net) : row.handover_cash;
    return row;
  });

  const expByDriverMap = {};
  expensesByDriver.rows.forEach(function (r) { expByDriverMap[r.driver_id] = Number(r.total); });

  function mergeKm(rows, key, nameKey) {
    const kmByKey = {};
    (key === 'driver' ? kmByDriver.rows : kmByTaxi.rows).forEach(function (r) {
      kmByKey[r.driver_id !== undefined ? r.driver_id : r.taxi_id] = Number(r.km);
    });
    return rows.map(function (r) {
      const id = key === 'driver' ? r.driver_id : r.taxi_id;
      const km = kmByKey[id] !== undefined ? round2(kmByKey[id]) : null;
      const isDriver = key === 'driver';
      const exp = isDriver ? (expByDriverMap[id] !== undefined ? round2(expByDriverMap[id]) : 0) : undefined;
      const keeps = isDriver ? round2(r.keeps) : undefined;
      const cash = isDriver ? round2(r.cash) : undefined;
      const uncl = isDriver ? round2(r.unclassified) : undefined;
      return {
        driver_id: isDriver ? r.driver_id : undefined,
        driver_name: isDriver ? r.driver_name : undefined,
        taxi_id: key === 'taxi' ? r.taxi_id : undefined,
        taxi_identifier: key === 'taxi' ? (r.taxi_identifier || 'Sin taxi') : undefined,
        trips: Number(r.trips),
        total: round2(r.total),
        driver_keeps: keeps,
        cash_total: cash,
        unclassified_total: uncl,
        expenses: exp,
        handover_cash: isDriver ? round2(cash - keeps - exp) : undefined,
        km: km,
        per_km: (km !== null && km > 0) ? round2(Number(r.total) / km) : null,
      };
    });
  }
  const perDriver = mergeKm(tripsByDriver.rows, 'driver');
  const perTaxi = mergeKm(tripsByTaxi.rows, 'taxi');

  // Saldo a favor en las filas por chofer. Los choferes con movimiento de
  // saldo en el período pero sin viajes filtrados se agregan para que las
  // columnas sumen con los totales (su entrega bruta es la de secuencia
  // completa, no la filtrada).
  perDriver.forEach(function (r) {
    const s = driverCreditSummary[r.driver_id];
    r.credit_before = s ? s.opening : 0;
    r.credit_applied = s ? s.applied : 0;
    r.handover_net = s ? s.net : r.handover_cash;
    r.credit_after = s ? s.closing : 0;
  });
  Object.keys(driverCreditSummary).forEach(function (id) {
    const s = driverCreditSummary[id];
    if (!(s.opening > 0 || s.applied > 0 || s.net !== 0 || s.closing > 0)) return;
    if (perDriver.some(function (r) { return String(r.driver_id) === String(id); })) return;
    perDriver.push({
      driver_id: Number(id),
      driver_name: creditNameMap[id] || 'Chofer',
      trips: 0,
      total: 0,
      driver_keeps: 0,
      cash_total: 0,
      unclassified_total: 0,
      expenses: 0,
      handover_cash: round2(s.net + s.applied),
      credit_before: s.opening,
      credit_applied: s.applied,
      handover_net: s.net,
      credit_after: s.closing,
      km: null,
      per_km: null,
    });
  });

  // Desglose por método de pago (cuánto entró por Efectivo, Tarjeta, etc.).
  let tripsByMethod;
  try {
    tripsByMethod = await pool.query(
      `SELECT tr.payment_method_id AS method_id, COALESCE(pm.name, 'Sin método') AS method_name,
              COUNT(*) AS trips, COALESCE(SUM(tr.amount), 0) AS total,
              COALESCE(SUM(tr.amount * tr.pct_snapshot / 100), 0) AS keeps
       FROM trips tr LEFT JOIN payment_methods pm ON pm.id = tr.payment_method_id${tripJoinAttr} ${tripWhereAttr}
       GROUP BY tr.payment_method_id, pm.name ORDER BY total DESC`,
      tripParams
    );
  } catch (e) {
    if (e && e.code === '42703') {
      tripsByMethod = await pool.query(
        `SELECT tr.payment_method_id AS method_id, COALESCE(pm.name, 'Sin método') AS method_name,
                COUNT(*) AS trips, COALESCE(SUM(tr.amount), 0) AS total,
                COALESCE(SUM(tr.amount * tr.pct_snapshot / 100), 0) AS keeps
         FROM trips tr LEFT JOIN payment_methods pm ON pm.id = tr.payment_method_id ${tripWhere}
         GROUP BY tr.payment_method_id, pm.name ORDER BY total DESC`,
        tripParams
      );
    } else throw e;
  }
  const perMethod = tripsByMethod.rows.map(function (r) {
    return {
      method_id: r.method_id,
      method_name: r.method_name,
      trips: Number(r.trips),
      total: round2(r.total),
      driver_keeps: round2(r.keeps),
      is_cash: r.method_id !== null && String(r.method_name).trim().toLowerCase() === 'efectivo',
      is_unclassified: r.method_id === null,
    };
  });

  let total = 0, keeps = 0, tripsCount = 0, cashTotal = 0, unclassifiedTotal = 0, kmTotal = 0, kmDaysRevenue = 0, kmDaysKm = 0, daysWithKm = 0;
  perDay.forEach(function (r) {
    total += r.total; keeps += r.keeps; tripsCount += r.trips;
    cashTotal += r.cash_total; unclassifiedTotal += r.unclassified_total;
    if (r.km !== null) { kmTotal += r.km; daysWithKm += 1; }
    if (r.km !== null && r.km > 0) { kmDaysRevenue += r.total; kmDaysKm += r.km; }
  });
  const expenseTotal = round2(expenses.rows[0].total);
  let openingCredit = 0, appliedCredit = 0, netHandover = 0, closingCredit = 0;
  Object.keys(driverCreditSummary).forEach(function (id) {
    const s = driverCreditSummary[id];
    openingCredit = round2(openingCredit + s.opening);
    appliedCredit = round2(appliedCredit + s.applied);
    netHandover = round2(netHandover + s.net);
    closingCredit = round2(closingCredit + s.closing);
  });
  res.status(200).json({
    from: from,
    to: to,
    totals: {
      trips_count: tripsCount,
      total: round2(total),
      driver_keeps: round2(keeps),
      owner_share_gross: round2(total - keeps),
      expenses: expenseTotal,
      handover_to_owner: round2(total - keeps - expenseTotal),
      cash_total: round2(cashTotal),
      unclassified_total: round2(unclassifiedTotal),
      handover_cash: round2(cashTotal - keeps - expenseTotal),
      opening_credit: openingCredit,
      credit_applied: appliedCredit,
      handover_net: netHandover,
      credit_closing: closingCredit,
      km: round2(kmTotal),
      days_with_km: daysWithKm,
      avg_per_km: kmDaysKm > 0 ? round2(kmDaysRevenue / kmDaysKm) : null,
    },
    per_day: perDay,
    per_driver: perDriver,
    per_taxi: perTaxi,
    per_method: perMethod,
  });
};
