// GET /api/day-close — cierre del día.
// Parámetro: ?date=AAAA-MM-DD (si no viene, usa la fecha actual del servidor).
// Por chofer y por día: total recaudado, cuánto se queda el chofer,
// cuánto le tiene que dar al dueño y gastos del día.
// Los gastos se descuentan de la parte del dueño, no de la del chofer:
// a_entregar = total - se_queda_el_chofer - gastos.
// Cierre en efectivo: solo el efectivo entra al chofer; tarjeta, Uber,
// transferencias y demás van a la cuenta del dueño, así que NO entran en
// lo que el chofer entrega en mano:
//   efectivo = suma de viajes con método 'efectivo' (sin importar mayúsculas)
//   a_entregar_en_efectivo = efectivo - se_queda_el_chofer - gastos
// Si da negativo, el dueño le debe al chofer (sus keeps de viajes no
// efectivos son plata que el dueño ya cobró y le debe). Los viajes sin
// método quedan en una línea aparte ('sin método', sin clasificar) y no
// entran en el efectivo. Todo se calcula al leer: los días viejos se
// recalculan con esta cuenta sin tocar ningún viaje guardado.
// Saldo a favor del chofer (NO es un gasto): cuando un día cierra con
// entrega negativa, el dueño le queda debiendo esa plata al chofer y ese
// saldo se descuenta de la entrega de los días cerrados siguientes, hasta
// agotarse (puede cruzar varios días). Solo mueven saldo los días con
// jornada cerrada (exit_km presente); los días abiertos o sin jornada no
// crean ni consumen saldo. El saldo se deriva de los cierres al leer, no
// se guarda en ninguna tabla nueva.
// Liquidación marcada por el dueño (migración v9, columnas settlement y
// settled_at en day_shifts): cada cierre puede quedar "recibido" (el
// chofer entregó) o "pagado" (el dueño pagó lo que debía); sin marca es
// "pendiente". "Recibido" es solo confirmación y no cambia ningún número.
// "Pagado" significa que el dueño ya pagó esa deuda en mano: ese día NO
// genera saldo a favor, así que los días siguientes se calculan sin ese
// descuento. Si esos días ya habían cerrado con el descuento aplicado,
// sus entregas netas se recalculan hacia arriba (quedan pendientes de
// liquidar): la plata no se pierde ni se paga dos veces, solo cambia de
// descuento a pendiente. Si la migración v9 todavía no se aplicó, todo se
// trata como "pendiente" (mismo patrón de fallback 42703 que la nota).
// El chofer ve solo su propio cierre; el admin ve el de todos.
// Visibilidad del chofer: solo los últimos 30 días. Si el chofer pide
// una fecha más vieja, se le devuelve una lista vacía (sin error).
// El cálculo del saldo a favor NO se limita: usa la secuencia completa
// de días cerrados, así que un cierre dentro de la ventana muestra su
// saldo correcto aunque venga de días más viejos. El admin no tiene
// límite.

const { getPool, requireAuth, round2, methodNotAllowed } = require('./_db');

function dateKey(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

// Primer día visible para el chofer: hoy menos 29 días (ventana de 30
// días corridos, en fecha del servidor en UTC). El admin no tiene límite.
function driverWindowStart() {
  return new Date(Date.now() - 29 * 24 * 3600 * 1000).toISOString().slice(0, 10);
}

// Aplica el saldo a favor sobre días cerrados en orden cronológico.
// days: [{ date, raw, settlement }] con raw = entrega en efectivo bruta.
// Devuelve { byDate: { fecha: { before, applied, net, after, settlement, paid } }, finalCredit }.
// Regla: applied = min(saldo, max(raw, 0)); net = raw - applied;
// saldo nuevo = saldo - applied + max(-raw, 0), SALVO que el día esté
// marcado "pagado": el dueño ya pagó esa deuda en mano, así que ese día
// NO genera saldo a favor (no entra ningún lote) y paid = -raw. Los días
// siguientes se calculan sin ese descuento: si ya habían cerrado con el
// descuento aplicado, sus entregas netas se recalculan hacia arriba (la
// plata no se pierde: queda como pendiente de liquidar). La suma total
// no cambia, solo se mueve de descuento a pendiente. La marca "recibido"
// nunca cambia números (es solo confirmación).
function applyCreditToDays(days) {
  const byDate = {};
  let credit = 0;
  days.forEach(function (d) {
    const before = round2(credit);
    let applied = 0;
    let paid = 0;
    if (d.raw > 0 && credit > 0) {
      applied = round2(Math.min(credit, d.raw));
      credit = round2(credit - applied);
    } else if (d.raw < 0) {
      if (d.settlement === 'pagado') {
        paid = round2(-d.raw);
      } else {
        credit = round2(credit - d.raw);
      }
    }
    byDate[d.date] = {
      before: before,
      applied: applied,
      net: round2(d.raw - applied),
      after: round2(credit),
      settlement: d.settlement || 'pendiente',
      paid: paid,
    };
  });
  const last = days.length ? byDate[days[days.length - 1].date] : null;
  return { byDate: byDate, finalCredit: last ? last.after : 0 };
}

module.exports = async function handler(req, res) {
  const user = await requireAuth(req, res, ['admin', 'driver']);
  if (!user) return;
  if (req.method !== 'GET') return methodNotAllowed(res);
  const pool = getPool();

  let date = req.query && req.query.date ? String(req.query.date) : null;
  if (!date) {
    const today = await pool.query('SELECT CURRENT_DATE AS d');
    date = today.rows[0].d;
    if (date instanceof Date) date = date.toISOString().slice(0, 10);
  }

  // Límite de visibilidad del chofer (ver encabezado): una fecha más
  // vieja que 30 días no devuelve nada. Esto va ANTES del cálculo del
  // saldo a favor y no lo toca: para fechas dentro de la ventana, la
  // secuencia completa se calcula exactamente igual que antes.
  if (user.role === 'driver' && date < driverWindowStart()) {
    res.status(200).json([]);
    return;
  }

  let drivers;
  if (user.role === 'admin') {
    const result = await pool.query("SELECT id, name FROM users WHERE role = 'driver' AND active = TRUE AND company_id = $1 ORDER BY name", [user.company_id]);
    drivers = result.rows;
  } else {
    drivers = [{ id: user.id, name: user.name }];
  }

  const closes = [];
  for (const driver of drivers) {
    // Secuencia completa de saldo a favor: TODOS los días cerrados del
    // chofer (no solo los anteriores a la fecha pedida), porque una marca
    // "pagado" cancela solo lo que queda sin absorber, y eso depende de
    // los días siguientes. Solo los días cerrados mueven saldo; los
    // abiertos no entran en esta lista. La columna settlement puede no
    // existir si la migración v9 todavía no se aplicó: en ese caso todo
    // es "pendiente" (fallback 42703, igual que la nota en shifts).
    let closedAll;
    try {
      closedAll = await pool.query(
        'SELECT shift_date, settlement FROM day_shifts WHERE driver_id = $1 AND exit_km IS NOT NULL ORDER BY shift_date, id',
        [driver.id]
      );
    } catch (e) {
      if (e && e.code === '42703') {
        closedAll = await pool.query(
          'SELECT shift_date FROM day_shifts WHERE driver_id = $1 AND exit_km IS NOT NULL ORDER BY shift_date, id',
          [driver.id]
        );
      } else throw e;
    }
    const tripsAll = await pool.query(
      `SELECT t.trip_date, COALESCE(SUM(t.amount * t.pct_snapshot / 100), 0) AS keeps,
              COALESCE(SUM(CASE WHEN LOWER(TRIM(pm.name)) = 'efectivo' THEN t.amount ELSE 0 END), 0) AS cash
       FROM trips t LEFT JOIN payment_methods pm ON pm.id = t.payment_method_id
       WHERE t.driver_id = $1 GROUP BY t.trip_date`,
      [driver.id]
    );
    const expAll = await pool.query(
      'SELECT expense_date, COALESCE(SUM(amount), 0) AS total FROM expenses WHERE driver_id = $1 GROUP BY expense_date',
      [driver.id]
    );
    const allTripMap = {};
    tripsAll.rows.forEach(function (r) { allTripMap[dateKey(r.trip_date)] = r; });
    const allExpMap = {};
    expAll.rows.forEach(function (r) { allExpMap[dateKey(r.expense_date)] = Number(r.total); });
    const allDays = closedAll.rows.map(function (r) {
      const d = dateKey(r.shift_date);
      const ht = allTripMap[d];
      const hCash = ht ? round2(ht.cash) : 0;
      const hKeeps = ht ? round2(ht.keeps) : 0;
      const hExp = allExpMap[d] !== undefined ? round2(allExpMap[d]) : 0;
      return { date: d, raw: round2(hCash - hKeeps - hExp), settlement: r.settlement || 'pendiente' };
    });
    const creditSeq = applyCreditToDays(allDays);
    const reqRow = creditSeq.byDate[date] || null;
    const trips = await pool.query(
      'SELECT COALESCE(SUM(amount), 0) AS total, COALESCE(SUM(amount * pct_snapshot / 100), 0) AS keeps, COUNT(*) AS trips FROM trips WHERE driver_id = $1 AND trip_date = $2',
      [driver.id, date]
    );
    const expenses = await pool.query(
      'SELECT COALESCE(SUM(amount), 0) AS total FROM expenses WHERE driver_id = $1 AND expense_date = $2',
      [driver.id, date]
    );
    // Desglose por método de pago del día (el nombre del método es el que
    // puso el admin; 'efectivo' se reconoce sin importar mayúsculas ni
    // espacios. Los viajes sin método quedan en el grupo NULL).
    const byMethod = await pool.query(
      `SELECT pm.name AS method_name, COALESCE(SUM(t.amount), 0) AS total, COUNT(*) AS trips
       FROM trips t LEFT JOIN payment_methods pm ON pm.id = t.payment_method_id
       WHERE t.driver_id = $1 AND t.trip_date = $2
       GROUP BY pm.name ORDER BY total DESC`,
      [driver.id, date]
    );
    const methods = byMethod.rows.map(function (r) {
      return { method_name: r.method_name || null, total: round2(r.total), trips: Number(r.trips) };
    });
    let cashTotal = 0;
    let unclassifiedTotal = 0;
    methods.forEach(function (m) {
      if (m.method_name === null) unclassifiedTotal += m.total;
      else if (String(m.method_name).trim().toLowerCase() === 'efectivo') cashTotal += m.total;
    });
    cashTotal = round2(cashTotal);
    unclassifiedTotal = round2(unclassifiedTotal);
    const shift = await pool.query(
      `SELECT s.*, t.identifier AS taxi_identifier FROM day_shifts s
       LEFT JOIN taxis t ON t.id = s.taxi_id
       WHERE s.driver_id = $1 AND s.shift_date = $2`,
      [driver.id, date]
    );
    const total = round2(trips.rows[0].total);
    const keeps = round2(trips.rows[0].keeps);
    const expenseTotal = round2(expenses.rows[0].total);
    const sh = shift.rows[0] || null;
    const kmDriven = sh && sh.entry_km !== null && sh.exit_km !== null
      ? round2(Number(sh.exit_km) - Number(sh.entry_km))
      : null;
    // Alerta de km (solo para el admin): si el taxi abrió el día con más de
    // 3 km por encima de su último cierre, el dueño lo ve en Cierres. Se
    // calcula al leer (sin columna nueva): el cierre anterior es el último
    // cierre de ese taxi antes de esta jornada (por fecha y luego por id).
    let kmAlert = false;
    let kmOver = null;
    let prevExitKm = null;
    if (user.role === 'admin' && sh && sh.taxi_id && sh.entry_km !== null) {
      const prev = await pool.query(
        `SELECT exit_km FROM day_shifts
         WHERE company_id = $1 AND taxi_id = $2 AND exit_km IS NOT NULL AND id <> $3
           AND (shift_date < $4 OR (shift_date = $4 AND id < $3))
         ORDER BY shift_date DESC, id DESC LIMIT 1`,
        [sh.company_id, sh.taxi_id, sh.id, date]
      );
      if (prev.rows[0]) {
        prevExitKm = Number(prev.rows[0].exit_km);
        kmOver = round2(Number(sh.entry_km) - prevExitKm);
        kmAlert = kmOver > 3;
      }
    }
    // Saldo a favor del día pedido: si la jornada está cerrada, la fila
    // viene de la secuencia completa (ya con las marcas aplicadas); un
    // día abierto no consume ni crea saldo (su entrega neta es la bruta
    // y su saldo es el acumulado ajustado de los días cerrados anteriores).
    const handoverCashRaw = round2(cashTotal - keeps - expenseTotal);
    const isClosed = !!(sh && sh.exit_km !== null && sh.exit_km !== undefined);
    let creditBefore, creditApplied, handoverNet, creditAfter, settlementPaid;
    if (isClosed && reqRow) {
      creditBefore = reqRow.before;
      creditApplied = reqRow.applied;
      handoverNet = reqRow.net;
      creditAfter = reqRow.after;
      settlementPaid = reqRow.paid;
    } else {
      creditBefore = 0;
      allDays.forEach(function (d) {
        if (d.date < date) creditBefore = creditSeq.byDate[d.date].after;
      });
      creditApplied = 0;
      handoverNet = handoverCashRaw;
      creditAfter = creditBefore;
      settlementPaid = 0;
    }
    closes.push({
      driver_id: driver.id,
      driver_name: driver.name,
      date: date,
      trips_count: Number(trips.rows[0].trips),
      total_collected: total,
      driver_keeps: keeps,
      expenses: expenseTotal,
      owner_share_gross: round2(total - keeps),
      handover_to_owner: round2(total - keeps - expenseTotal),
      cash_total: cashTotal,
      handover_cash: handoverCashRaw,
      handover_raw: handoverCashRaw,
      credit_before: creditBefore,
      credit_applied: creditApplied,
      handover_net: handoverNet,
      credit_after: creditAfter,
      settlement: (isClosed && reqRow) ? reqRow.settlement : (sh && sh.settlement ? sh.settlement : 'pendiente'),
      settled_at: sh ? (sh.settled_at || null) : null,
      settlement_paid: settlementPaid,
      unclassified_total: unclassifiedTotal,
      methods: methods,
      note: sh ? (sh.note || null) : null,
      shift_taxi: sh ? sh.taxi_identifier : null,
      shift_entry_time: sh ? sh.entry_time : null,
      shift_entry_km: sh ? sh.entry_km : null,
      shift_exit_time: sh ? sh.exit_time : null,
      shift_exit_km: sh ? sh.exit_km : null,
      km_driven: kmDriven,
      km_alert: kmAlert,
      km_over: kmAlert ? kmOver : null,
      prev_exit_km: prevExitKm,
    });
  }

  res.status(200).json(closes);
};
