// GET /api/day-close — cierre del turno.
// Parámetro: ?date=AAAA-MM-DD (cierres de los turnos que EMPEZARON ese
// día; un día puede tener más de un turno) o ?shift_id= (un turno).
// Si no viene ninguno, usa la fecha actual del servidor.
// Por chofer y por turno: total recaudado, cuánto se queda el chofer,
// cuánto le tiene que dar al dueño y gastos del turno.
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
// entran en el efectivo. Todo se calcula al leer: los turnos viejos se
// recalculan con esta cuenta sin tocar ningún viaje guardado.
// Turno de noche (migración v11): un turno que empieza un día y cierra
// al otro es UN solo cierre. Los viajes y gastos se atan al turno
// (shift_id); los de la madrugada cuentan en el cierre del turno que
// empezó el día anterior, no en un día aparte. Los registros viejos sin
// shift_id se cuentan por fecha (trip_date = shift_date), como antes.
// Saldo a favor del chofer (NO es un gasto): cuando un turno cierra con
// entrega negativa, el dueño le queda debiendo esa plata al chofer y ese
// saldo se descuenta de la entrega de los turnos cerrados siguientes,
// hasta agotarse (puede cruzar varios turnos). Solo mueven saldo los
// turnos cerrados (exit_km presente); los turnos abiertos o sin turno no
// crean ni consumen saldo. El saldo se deriva de los cierres al leer, no
// se guarda en ninguna tabla nueva.
// Liquidación marcada por el dueño (migración v9, columnas settlement y
// settled_at en day_shifts): cada cierre puede quedar "recibido" (el
// chofer entregó) o "pagado" (el dueño pagó lo que debía); sin marca es
// "pendiente". "Recibido" es solo confirmación y no cambia ningún número.
// "Pagado" significa que el dueño ya pagó esa deuda en mano: ese turno
// NO genera saldo a favor, así que los turnos siguientes se calculan sin
// ese descuento. Si esos turnos ya habían cerrado con el descuento
// aplicado, sus entregas netas se recalculan hacia arriba (quedan
// pendientes de liquidar): la plata no se pierde ni se paga dos veces,
// solo cambia de descuento a pendiente. Si la migración v9 todavía no se
// aplicó, todo se trata como "pendiente" (mismo patrón de fallback 42703
// que la nota).
// El chofer ve solo su propio cierre; el admin ve el de todos.
// Visibilidad del chofer: solo los últimos 30 días. Si el chofer pide
// una fecha más vieja, se le devuelve una lista vacía (sin error).
// El cálculo del saldo a favor NO se limita: usa la secuencia completa
// de turnos cerrados, así que un cierre dentro de la ventana muestra su
// saldo correcto aunque venga de turnos más viejos. El admin no tiene
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

// Aplica el saldo a favor sobre turnos cerrados en orden cronológico
// (por fecha de inicio y luego por id: un día puede tener más de un
// turno). shifts: [{ id, date, raw, settlement }] con raw = entrega en
// efectivo bruta. Devuelve { byId: { turnoId: { before, applied, net,
// after, settlement, paid } }, finalCredit }.
// Regla: applied = min(saldo, max(raw, 0)); net = raw - applied;
// saldo nuevo = saldo - applied + max(-raw, 0), SALVO que el turno esté
// marcado "pagado": el dueño ya pagó esa deuda en mano, así que ese
// turno NO genera saldo a favor (no entra ningún lote) y paid = -raw.
// Los turnos siguientes se calculan sin ese descuento: si ya habían
// cerrado con el descuento aplicado, sus entregas netas se recalculan
// hacia arriba (la plata no se pierde: queda como pendiente de
// liquidar). La suma total no cambia, solo se mueve de descuento a
// pendiente. La marca "recibido" nunca cambia números (es solo
// confirmación).
function applyCreditToShifts(shifts) {
  const byId = {};
  let credit = 0;
  shifts.forEach(function (d) {
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
    byId[d.id] = {
      before: before,
      applied: applied,
      net: round2(d.raw - applied),
      after: round2(credit),
      settlement: d.settlement || 'pendiente',
      paid: paid,
    };
  });
  const last = shifts.length ? byId[shifts[shifts.length - 1].id] : null;
  return { byId: byId, finalCredit: last ? last.after : 0 };
}

module.exports = async function handler(req, res) {
  const user = await requireAuth(req, res, ['admin', 'driver']);
  if (!user) return;
  if (req.method !== 'GET') return methodNotAllowed(res);
  const pool = getPool();

  let date = req.query && req.query.date ? String(req.query.date) : null;
  const shiftId = req.query && req.query.shift_id ? Number(req.query.shift_id) : null;
  if (!date && !shiftId) {
    const today = await pool.query('SELECT CURRENT_DATE AS d');
    date = today.rows[0].d;
    if (date instanceof Date) date = date.toISOString().slice(0, 10);
  }

  // Límite de visibilidad del chofer (ver encabezado): una fecha más
  // vieja que 30 días no devuelve nada. Esto va ANTES del cálculo del
  // saldo a favor y no lo toca: para fechas dentro de la ventana, la
  // secuencia completa se calcula exactamente igual que antes.
  if (user.role === 'driver' && date && date < driverWindowStart()) {
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
    // Secuencia completa de saldo a favor: TODOS los turnos cerrados del
    // chofer (no solo los anteriores a la fecha pedida), porque una marca
    // "pagado" cancela solo lo que queda sin absorber, y eso depende de
    // los turnos siguientes. Solo los turnos cerrados mueven saldo; los
    // abiertos no entran en esta lista. La columna settlement puede no
    // existir si la migración v9 todavía no se aplicó: en ese caso todo
    // es "pendiente" (fallback 42703, igual que la nota en shifts).
    let closedAll;
    try {
      closedAll = await pool.query(
        'SELECT id, shift_date, exit_date, settlement FROM day_shifts WHERE driver_id = $1 AND exit_km IS NOT NULL ORDER BY shift_date, id',
        [driver.id]
      );
    } catch (e) {
      if (e && e.code === '42703') {
        closedAll = await pool.query(
          'SELECT id, shift_date, exit_date FROM day_shifts WHERE driver_id = $1 AND exit_km IS NOT NULL ORDER BY shift_date, id',
          [driver.id]
        );
      } else throw e;
    }
    // Viajes y gastos atados al turno (shift_id) y, para los viejos sin
    // turno, por fecha (= shift_date). Las dos vías se suman, pero los
    // viejos sin turno solo cuentan en el PRIMER turno de su fecha (si
    // un día tiene dos turnos, no se duplican): son registros de antes
    // de la v11, cuando había un solo turno por día.
    let firstShiftIdByDate = {};
    const allShiftIds = await pool.query(
      'SELECT id, shift_date FROM day_shifts WHERE driver_id = $1 ORDER BY shift_date, id',
      [driver.id]
    );
    allShiftIds.rows.forEach(function (r) {
      const d = dateKey(r.shift_date);
      if (firstShiftIdByDate[d] === undefined) firstShiftIdByDate[d] = r.id;
    });
    let tripsByShift = new Map();
    let tripsByDate = new Map();
    try {
      const tripsAll = await pool.query(
        `SELECT t.shift_id, t.trip_date, COALESCE(SUM(t.amount * t.pct_snapshot / 100), 0) AS keeps,
                COALESCE(SUM(CASE WHEN LOWER(TRIM(pm.name)) = 'efectivo' THEN t.amount ELSE 0 END), 0) AS cash
         FROM trips t LEFT JOIN payment_methods pm ON pm.id = t.payment_method_id
         WHERE t.driver_id = $1 GROUP BY t.shift_id, t.trip_date`,
        [driver.id]
      );
      tripsAll.rows.forEach(function (r) {
        const keeps = round2(r.keeps);
        const cash = round2(r.cash);
        if (r.shift_id !== null && r.shift_id !== undefined) {
          const prev = tripsByShift.get(r.shift_id) || { cash: 0, keeps: 0 };
          tripsByShift.set(r.shift_id, { cash: round2(prev.cash + cash), keeps: round2(prev.keeps + keeps) });
        } else {
          const d = dateKey(r.trip_date);
          const prev = tripsByDate.get(d) || { cash: 0, keeps: 0 };
          tripsByDate.set(d, { cash: round2(prev.cash + cash), keeps: round2(prev.keeps + keeps) });
        }
      });
    } catch (e) {
      if (e && e.code === '42703') {
        // Sin migración v11: todo se cuenta por fecha, como antes.
        const tripsAll = await pool.query(
          `SELECT t.trip_date, COALESCE(SUM(t.amount * t.pct_snapshot / 100), 0) AS keeps,
                  COALESCE(SUM(CASE WHEN LOWER(TRIM(pm.name)) = 'efectivo' THEN t.amount ELSE 0 END), 0) AS cash
           FROM trips t LEFT JOIN payment_methods pm ON pm.id = t.payment_method_id
           WHERE t.driver_id = $1 GROUP BY t.trip_date`,
          [driver.id]
        );
        tripsAll.rows.forEach(function (r) {
          tripsByDate.set(dateKey(r.trip_date), { cash: round2(r.cash), keeps: round2(r.keeps) });
        });
      } else throw e;
    }
    let expByShift = new Map();
    let expByDate = new Map();
    try {
      const expAll = await pool.query(
        'SELECT shift_id, expense_date, COALESCE(SUM(amount), 0) AS total FROM expenses WHERE driver_id = $1 GROUP BY shift_id, expense_date',
        [driver.id]
      );
      expAll.rows.forEach(function (r) {
        const total = round2(r.total);
        if (r.shift_id !== null && r.shift_id !== undefined) {
          expByShift.set(r.shift_id, round2((expByShift.get(r.shift_id) || 0) + total));
        } else {
          const d = dateKey(r.expense_date);
          expByDate.set(d, round2((expByDate.get(d) || 0) + total));
        }
      });
    } catch (e) {
      if (e && e.code === '42703') {
        const expAll = await pool.query(
          'SELECT expense_date, COALESCE(SUM(amount), 0) AS total FROM expenses WHERE driver_id = $1 GROUP BY expense_date',
          [driver.id]
        );
        expAll.rows.forEach(function (r) { expByDate.set(dateKey(r.expense_date), round2(r.total)); });
      } else throw e;
    }
    function shiftMoney(sh) {
      const d = dateKey(sh.shift_date);
      const ht = tripsByShift.get(sh.id) || { cash: 0, keeps: 0 };
      const isFirst = firstShiftIdByDate[d] === sh.id;
      const legacy = isFirst ? (tripsByDate.get(d) || { cash: 0, keeps: 0 }) : { cash: 0, keeps: 0 };
      const cash = round2(ht.cash + legacy.cash);
      const keeps = round2(ht.keeps + legacy.keeps);
      const exp = round2((expByShift.get(sh.id) || 0) + (isFirst ? (expByDate.get(d) || 0) : 0));
      return { cash: cash, keeps: keeps, exp: exp, raw: round2(cash - keeps - exp) };
    }
    const allShifts = closedAll.rows.map(function (r) {
      const m = shiftMoney(r);
      return { id: r.id, date: dateKey(r.shift_date), raw: m.raw, settlement: r.settlement || 'pendiente' };
    });
    const creditSeq = applyCreditToShifts(allShifts);

    // Turnos pedidos: uno por shift_id, o todos los que empezaron en la
    // fecha pedida (un día puede tener más de un turno). Si la fecha no
    // tiene ningún turno del chofer, se devuelve un cierre vacío (sin
    // jornada) como antes: el Resumen y la ficha del chofer cuentan con
    // esa fila para mostrar "Sin jornada".
    let wanted = [];
    if (shiftId) {
      const one = await pool.query(
        `SELECT s.*, t.identifier AS taxi_identifier FROM day_shifts s
         LEFT JOIN taxis t ON t.id = s.taxi_id
         WHERE s.id = $1 AND s.driver_id = $2`,
        [shiftId, driver.id]
      );
      if (one.rows[0]) wanted = [one.rows[0]];
    } else {
      const list = await pool.query(
        `SELECT s.*, t.identifier AS taxi_identifier FROM day_shifts s
         LEFT JOIN taxis t ON t.id = s.taxi_id
         WHERE s.driver_id = $1 AND s.shift_date = $2 ORDER BY s.id`,
        [driver.id, date]
      );
      wanted = list.rows;
    }
    if (!shiftId && wanted.length === 0) {
      let creditBeforeEmpty = 0;
      allShifts.forEach(function (s) {
        if (s.date < date) creditBeforeEmpty = creditSeq.byId[s.id].after;
      });
      closes.push({
        driver_id: driver.id,
        driver_name: driver.name,
        date: date,
        shift_id: null,
        exit_date: null,
        trips_count: 0,
        total_collected: 0,
        tip_total: 0,
        driver_keeps: 0,
        expenses: 0,
        owner_share_gross: 0,
        handover_to_owner: 0,
        cash_total: 0,
        handover_cash: 0,
        handover_raw: 0,
        credit_before: creditBeforeEmpty,
        credit_applied: 0,
        handover_net: 0,
        credit_after: creditBeforeEmpty,
        settlement: 'pendiente',
        settled_at: null,
        settlement_paid: 0,
        unclassified_total: 0,
        methods: [],
        note: null,
        shift_taxi: null,
        shift_entry_time: null,
        shift_entry_km: null,
        shift_exit_time: null,
        shift_exit_km: null,
        km_driven: null,
        km_alert: false,
        km_over: null,
        prev_exit_km: null,
        auto_closed: false,
        km_backwards: false,
      });
    }
    for (const sh of wanted) {
      const d = dateKey(sh.shift_date);
      const m = shiftMoney(sh);
      const isClosed = sh.exit_km !== null && sh.exit_km !== undefined;
      const seqRow = isClosed ? creditSeq.byId[sh.id] : null;
      // Detalle del turno: viajes, gastos, propinas y desglose por
      // método, con la misma atribución (por turno, con fallback por
      // fecha para los registros viejos).
      let tripDetail;
      try {
        tripDetail = await pool.query(
          'SELECT COALESCE(SUM(amount), 0) AS total, COALESCE(SUM(amount * pct_snapshot / 100), 0) AS keeps, COUNT(*) AS trips FROM trips WHERE driver_id = $1 AND (shift_id = $2 OR (shift_id IS NULL AND trip_date = $3 AND NOT EXISTS (SELECT 1 FROM day_shifts s2 WHERE s2.driver_id = $1 AND s2.shift_date = $3 AND s2.id < $2)))',
          [driver.id, sh.id, d]
        );
      } catch (e) {
        if (e && e.code === '42703') {
          tripDetail = await pool.query(
            'SELECT COALESCE(SUM(amount), 0) AS total, COALESCE(SUM(amount * pct_snapshot / 100), 0) AS keeps, COUNT(*) AS trips FROM trips WHERE driver_id = $1 AND trip_date = $2',
            [driver.id, d]
          );
        } else throw e;
      }
      let expenseDetail;
      try {
        expenseDetail = await pool.query(
          'SELECT COALESCE(SUM(amount), 0) AS total FROM expenses WHERE driver_id = $1 AND (shift_id = $2 OR (shift_id IS NULL AND expense_date = $3 AND NOT EXISTS (SELECT 1 FROM day_shifts s2 WHERE s2.driver_id = $1 AND s2.shift_date = $3 AND s2.id < $2)))',
          [driver.id, sh.id, d]
        );
      } catch (e) {
        if (e && e.code === '42703') {
          expenseDetail = await pool.query(
            'SELECT COALESCE(SUM(amount), 0) AS total FROM expenses WHERE driver_id = $1 AND expense_date = $2',
            [driver.id, d]
          );
        } else throw e;
      }
      // Propinas del turno: una suma aparte, solo para informar. Nunca se
      // mezcla con total, keeps, efectivo, gastos ni saldo a favor (esas
      // consultas quedan intactas). Si la migración v10 todavía no se
      // aplicó (error 42703, mismo patrón que el fallback de settlement),
      // el turno informa 0 en vez de romper el cierre.
      let tipTotal = 0;
      try {
        let tips;
        try {
          tips = await pool.query(
            'SELECT COALESCE(SUM(tip), 0) AS total FROM trips WHERE driver_id = $1 AND (shift_id = $2 OR (shift_id IS NULL AND trip_date = $3 AND NOT EXISTS (SELECT 1 FROM day_shifts s2 WHERE s2.driver_id = $1 AND s2.shift_date = $3 AND s2.id < $2)))',
            [driver.id, sh.id, d]
          );
        } catch (e) {
          if (e && e.code === '42703') {
            tips = await pool.query(
              'SELECT COALESCE(SUM(tip), 0) AS total FROM trips WHERE driver_id = $1 AND trip_date = $2',
              [driver.id, d]
            );
          } else throw e;
        }
        tipTotal = round2(tips.rows[0].total);
      } catch (e) {
        if (e && e.code !== '42703') throw e;
      }
      // Desglose por método de pago del turno (el nombre del método es el
      // que puso el admin; 'efectivo' se reconoce sin importar mayúsculas
      // ni espacios. Los viajes sin método quedan en el grupo NULL).
      let byMethod;
      try {
        byMethod = await pool.query(
          `SELECT pm.name AS method_name, COALESCE(SUM(t.amount), 0) AS total, COUNT(*) AS trips
           FROM trips t LEFT JOIN payment_methods pm ON pm.id = t.payment_method_id
           WHERE t.driver_id = $1 AND (t.shift_id = $2 OR (t.shift_id IS NULL AND t.trip_date = $3 AND NOT EXISTS (SELECT 1 FROM day_shifts s2 WHERE s2.driver_id = $1 AND s2.shift_date = $3 AND s2.id < $2)))
           GROUP BY pm.name ORDER BY total DESC`,
          [driver.id, sh.id, d]
        );
      } catch (e) {
        if (e && e.code === '42703') {
          byMethod = await pool.query(
            `SELECT pm.name AS method_name, COALESCE(SUM(t.amount), 0) AS total, COUNT(*) AS trips
             FROM trips t LEFT JOIN payment_methods pm ON pm.id = t.payment_method_id
             WHERE t.driver_id = $1 AND t.trip_date = $2
             GROUP BY pm.name ORDER BY total DESC`,
            [driver.id, d]
          );
        } else throw e;
      }
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
      const total = round2(tripDetail.rows[0].total);
      const keeps = round2(tripDetail.rows[0].keeps);
      const expenseTotal = round2(expenseDetail.rows[0].total);
      const kmDriven = sh.entry_km !== null && sh.exit_km !== null
        ? round2(Number(sh.exit_km) - Number(sh.entry_km))
        : null;
      // Alerta de km (solo para el admin): si el taxi abrió el turno con
      // más de 3 km por encima de su último cierre, el dueño lo ve en
      // Cierres. Se calcula al leer (sin columna nueva): el cierre
      // anterior es el último cierre de ese taxi antes de este turno (por
      // fecha de inicio y luego por id).
      let kmAlert = false;
      let kmOver = null;
      let prevExitKm = null;
      if (user.role === 'admin' && sh.taxi_id && sh.entry_km !== null) {
        const prev = await pool.query(
          `SELECT exit_km FROM day_shifts
           WHERE company_id = $1 AND taxi_id = $2 AND exit_km IS NOT NULL AND id <> $3
             AND (shift_date < $4 OR (shift_date = $4 AND id < $3))
           ORDER BY shift_date DESC, id DESC LIMIT 1`,
          [sh.company_id, sh.taxi_id, sh.id, d]
        );
        if (prev.rows[0]) {
          prevExitKm = Number(prev.rows[0].exit_km);
          kmOver = round2(Number(sh.entry_km) - prevExitKm);
          kmAlert = kmOver > 3;
        }
      }
      // Saldo a favor del turno pedido: si el turno está cerrado, la fila
      // viene de la secuencia completa (ya con las marcas aplicadas); un
      // turno abierto no consume ni crea saldo (su entrega neta es la
      // bruta y su saldo es el acumulado ajustado de los turnos cerrados
      // anteriores).
      const handoverCashRaw = round2(cashTotal - keeps - expenseTotal);
      let creditBefore, creditApplied, handoverNet, creditAfter, settlementPaid;
      if (isClosed && seqRow) {
        creditBefore = seqRow.before;
        creditApplied = seqRow.applied;
        handoverNet = seqRow.net;
        creditAfter = seqRow.after;
        settlementPaid = seqRow.paid;
      } else {
        creditBefore = 0;
        allShifts.forEach(function (s) {
          if (s.date < d || (s.date === d && s.id < sh.id)) creditBefore = creditSeq.byId[s.id].after;
        });
        creditApplied = 0;
        handoverNet = handoverCashRaw;
        creditAfter = creditBefore;
        settlementPaid = 0;
      }
      closes.push({
        driver_id: driver.id,
        driver_name: driver.name,
        date: d,
        shift_id: sh.id,
        exit_date: sh.exit_date ? dateKey(sh.exit_date) : null,
        trips_count: Number(tripDetail.rows[0].trips),
        total_collected: total,
        tip_total: tipTotal,
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
        settlement: (isClosed && seqRow) ? seqRow.settlement : (sh.settlement || 'pendiente'),
        settled_at: sh.settled_at || null,
        settlement_paid: settlementPaid,
        unclassified_total: unclassifiedTotal,
        methods: methods,
        note: sh.note || null,
        shift_taxi: sh.taxi_identifier || null,
        shift_entry_time: sh.entry_time,
        shift_entry_km: sh.entry_km,
        shift_exit_time: sh.exit_time,
        shift_exit_km: sh.exit_km,
        km_driven: kmDriven,
        km_alert: kmAlert,
        km_over: kmAlert ? kmOver : null,
        prev_exit_km: prevExitKm,
        // Cierre automático por relevo (v12): el turno se cerró solo
        // cuando otro chofer abrió el mismo taxi. km_backwards marca que
        // el km de cierre quedó por debajo del de entrada (el odómetro no
        // cierra): es la diferencia que el dueño tiene que revisar.
        auto_closed: sh.auto_closed === true,
        km_backwards: isClosed && kmDriven !== null && kmDriven < 0,
      });
    }
  }

  res.status(200).json(closes);
};
