// /api/report — reportes del administrador.
// Filtros: ?from=YYYY-MM-DD&to=YYYY-MM-DD (por defecto últimos 30 días),
// ?driver_id= (todos si no viene), ?taxi_id= (todos si no viene),
// ?payment_method_id= (todos si no viene).
// Devuelve totales del período, $/km por día y promedio, y desgloses
// por chofer, por taxi y por método de pago.
// $/km: solo se calcula sobre días con kilometraje cargado (jornada con
// salida). Los días sin jornada no entran en el promedio.
// Gastos con filtro de taxi: se asignan al auto según el taxi del día
// de cada gasto (la jornada de ese chofer y fecha); un gasto de un día
// sin jornada no se puede asignar a un auto y queda fuera del reporte
// filtrado por taxi.

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

  // Condiciones para jornadas (por fecha de jornada). Siempre con empresa.
  const shiftCond = ['s.company_id = $1', 's.shift_date BETWEEN $2 AND $3'];
  const shiftParams = [user.company_id, from, to];
  if (driverId) { shiftParams.push(driverId); shiftCond.push('s.driver_id = $' + shiftParams.length); }
  if (taxiId) { shiftParams.push(taxiId); shiftCond.push('s.taxi_id = $' + shiftParams.length); }
  const shiftWhere = 'WHERE ' + shiftCond.join(' AND ');

  const tripsByDay = await pool.query(
    `SELECT tr.trip_date, COUNT(*) AS trips, COALESCE(SUM(tr.amount), 0) AS total,
            COALESCE(SUM(tr.amount * tr.pct_snapshot / 100), 0) AS keeps
     FROM trips tr ${tripWhere} GROUP BY tr.trip_date ORDER BY tr.trip_date`,
    tripParams
  );
  const kmByDay = await pool.query(
    `SELECT s.shift_date, COALESCE(SUM(s.exit_km - s.entry_km), 0) AS km
     FROM day_shifts s ${shiftWhere} AND s.exit_km IS NOT NULL
     GROUP BY s.shift_date ORDER BY s.shift_date`,
    shiftParams
  );
  const tripsByDriver = await pool.query(
    `SELECT tr.driver_id, u.name AS driver_name, COUNT(*) AS trips,
            COALESCE(SUM(tr.amount), 0) AS total
     FROM trips tr JOIN users u ON u.id = tr.driver_id ${tripWhere}
     GROUP BY tr.driver_id, u.name ORDER BY total DESC`,
    tripParams
  );
  const kmByDriver = await pool.query(
    `SELECT s.driver_id, COALESCE(SUM(s.exit_km - s.entry_km), 0) AS km
     FROM day_shifts s ${shiftWhere} AND s.exit_km IS NOT NULL
     GROUP BY s.driver_id`,
    shiftParams
  );
  const tripsByTaxi = await pool.query(
    `SELECT tr.taxi_id, t.identifier AS taxi_identifier, COUNT(*) AS trips,
            COALESCE(SUM(tr.amount), 0) AS total
     FROM trips tr LEFT JOIN taxis t ON t.id = tr.taxi_id ${tripWhere}
     GROUP BY tr.taxi_id, t.identifier ORDER BY total DESC`,
    tripParams
  );
  const kmByTaxi = await pool.query(
    `SELECT s.taxi_id, COALESCE(SUM(s.exit_km - s.entry_km), 0) AS km
     FROM day_shifts s ${shiftWhere} AND s.exit_km IS NOT NULL
     GROUP BY s.taxi_id`,
    shiftParams
  );

  // Gastos: filtro de chofer directo; filtro de taxi vía la jornada del día.
  // Siempre con empresa.
  const expCond = ['e.company_id = $1', 'e.expense_date BETWEEN $2 AND $3'];
  const expParams = [user.company_id, from, to];
  let expJoin = '';
  if (driverId) { expParams.push(driverId); expCond.push('e.driver_id = $' + expParams.length); }
  if (taxiId) {
    expJoin = ' LEFT JOIN day_shifts s ON s.driver_id = e.driver_id AND s.shift_date = e.expense_date';
    expParams.push(taxiId);
    expCond.push('s.taxi_id = $' + expParams.length);
  }
  const expenses = await pool.query(
    `SELECT COALESCE(SUM(e.amount), 0) AS total FROM expenses e${expJoin} WHERE ${expCond.join(' AND ')}`,
    expParams
  );

  const kmMap = {};
  kmByDay.rows.forEach(function (r) { kmMap[dateStr(r.shift_date)] = Number(r.km); });
  const perDayMap = {};
  tripsByDay.rows.forEach(function (r) {
    const d = dateStr(r.trip_date);
    perDayMap[d] = { date: d, trips: Number(r.trips), total: round2(r.total), keeps: round2(r.keeps), km: null, per_km: null };
  });
  Object.keys(kmMap).forEach(function (d) {
    if (!perDayMap[d]) perDayMap[d] = { date: d, trips: 0, total: 0, keeps: 0, km: null, per_km: null };
    perDayMap[d].km = round2(kmMap[d]);
  });
  const perDay = Object.keys(perDayMap).sort().map(function (d) {
    const row = perDayMap[d];
    if (row.km !== null && row.km > 0) row.per_km = round2(row.total / row.km);
    return row;
  });

  function mergeKm(rows, key, nameKey) {
    const kmByKey = {};
    (key === 'driver' ? kmByDriver.rows : kmByTaxi.rows).forEach(function (r) {
      kmByKey[r.driver_id !== undefined ? r.driver_id : r.taxi_id] = Number(r.km);
    });
    return rows.map(function (r) {
      const id = key === 'driver' ? r.driver_id : r.taxi_id;
      const km = kmByKey[id] !== undefined ? round2(kmByKey[id]) : null;
      return {
        driver_id: key === 'driver' ? r.driver_id : undefined,
        driver_name: key === 'driver' ? r.driver_name : undefined,
        taxi_id: key === 'taxi' ? r.taxi_id : undefined,
        taxi_identifier: key === 'taxi' ? (r.taxi_identifier || 'Sin taxi') : undefined,
        trips: Number(r.trips),
        total: round2(r.total),
        km: km,
        per_km: (km !== null && km > 0) ? round2(Number(r.total) / km) : null,
      };
    });
  }
  const perDriver = mergeKm(tripsByDriver.rows, 'driver');
  const perTaxi = mergeKm(tripsByTaxi.rows, 'taxi');

  // Desglose por método de pago (cuánto entró por Efectivo, Tarjeta, etc.).
  const tripsByMethod = await pool.query(
    `SELECT tr.payment_method_id AS method_id, COALESCE(pm.name, 'Sin método') AS method_name,
            COUNT(*) AS trips, COALESCE(SUM(tr.amount), 0) AS total,
            COALESCE(SUM(tr.amount * tr.pct_snapshot / 100), 0) AS keeps
     FROM trips tr LEFT JOIN payment_methods pm ON pm.id = tr.payment_method_id ${tripWhere}
     GROUP BY tr.payment_method_id, pm.name ORDER BY total DESC`,
    tripParams
  );
  const perMethod = tripsByMethod.rows.map(function (r) {
    return {
      method_id: r.method_id,
      method_name: r.method_name,
      trips: Number(r.trips),
      total: round2(r.total),
      driver_keeps: round2(r.keeps),
    };
  });

  let total = 0, keeps = 0, tripsCount = 0, kmTotal = 0, kmDaysRevenue = 0, kmDaysKm = 0, daysWithKm = 0;
  perDay.forEach(function (r) {
    total += r.total; keeps += r.keeps; tripsCount += r.trips;
    if (r.km !== null) { kmTotal += r.km; daysWithKm += 1; }
    if (r.km !== null && r.km > 0) { kmDaysRevenue += r.total; kmDaysKm += r.km; }
  });
  const expenseTotal = round2(expenses.rows[0].total);
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
