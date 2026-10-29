// /api/shifts — jornada del día por chofer.
// Un registro por chofer y día: taxi del día, hora y km de entrada,
// hora y km de salida (la salida se completa al terminar el día).
// GET: chofer ve sus jornadas; admin ve todas (?driver_id=, ?date=).
// POST: crea o actualiza la jornada (un registro por chofer y día).
// El chofer solo maneja sus propias jornadas; el admin puede cargar la de cualquier chofer.
// Visibilidad del chofer en lecturas: solo los últimos 30 días (hoy y 29
// días para atrás, en fecha del servidor), igual que en trips.js. Una
// fecha más vieja no devuelve nada; sin fecha, la lista queda acotada a
// la ventana. El admin no tiene límite. Solo limita lo que se ve: no
// toca la creación ni la edición de jornadas.

const { getPool, requireAuth, readBody, toNumber, round2, methodNotAllowed } = require('./_db');

function dateStr(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

// Primer día visible para el chofer: hoy menos 29 días (ventana de 30
// días corridos, en fecha del servidor en UTC). El admin no tiene límite.
function driverWindowStart() {
  return new Date(Date.now() - 29 * 24 * 3600 * 1000).toISOString().slice(0, 10);
}

function withKm(row) {
  const km = row.entry_km !== null && row.exit_km !== null
    ? round2(Number(row.exit_km) - Number(row.entry_km))
    : null;
  return {
    id: row.id,
    driver_id: row.driver_id,
    driver_name: row.driver_name || null,
    shift_date: dateStr(row.shift_date),
    taxi_id: row.taxi_id,
    taxi_identifier: row.taxi_identifier || null,
    entry_time: row.entry_time,
    entry_km: row.entry_km,
    exit_time: row.exit_time,
    exit_km: row.exit_km,
    entry_lat: row.entry_lat,
    entry_lng: row.entry_lng,
    exit_lat: row.exit_lat,
    exit_lng: row.exit_lng,
    note: row.note || null,
    settlement: row.settlement || 'pendiente',
    settled_at: row.settled_at || null,
    km_driven: km,
    created_at: row.created_at,
  };
}

function validLat(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= -90 && n <= 90 ? n : null;
}

function validLng(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= -180 && n <= 180 ? n : null;
}

function geoPair(latV, lngV) {
  if (latV === undefined && lngV === undefined) return null;
  const lat = validLat(latV);
  const lng = validLng(lngV);
  return lat !== null && lng !== null ? { lat, lng } : null;
}

const SELECT_SQL = `
  SELECT s.*, u.name AS driver_name, t.identifier AS taxi_identifier
  FROM day_shifts s
  JOIN users u ON u.id = s.driver_id
  LEFT JOIN taxis t ON t.id = s.taxi_id
`;

module.exports = async function handler(req, res) {
  const user = await requireAuth(req, res, ['admin', 'driver']);
  if (!user) return;
  const pool = getPool();

  if (req.method === 'GET') {
    // Jornadas abiertas de un taxi en un día (?open_taxi=<id>&date=AAAA-MM-DD).
    // Lo usa el aviso de "Empezar día": si otro chofer ya tiene abierta la
    // jornada de ese taxi, el que empieza ve su nombre y confirma.
    // Devuelve solo lo mínimo (chofer y taxi); el chofer no ve jornadas de
    // otros salvo este aviso puntual. Abierta = sin km de cierre.
    if (req.query && req.query.open_taxi) {
      const taxiId = Number(req.query.open_taxi);
      const date = req.query.date ? String(req.query.date) : '';
      if (!taxiId || !date) {
        res.status(400).json({ error: 'Faltan taxi y fecha' });
        return;
      }
      // Límite de visibilidad del chofer (ver encabezado): el aviso de
      // taxi ocupado solo opera sobre el día que se está empezando,
      // siempre dentro de la ventana; una fecha más vieja no devuelve nada.
      if (user.role === 'driver' && date < driverWindowStart()) {
        res.status(200).json([]);
        return;
      }
      const params = [user.company_id, taxiId, date];
      let openSql = `SELECT s.driver_id, u.name AS driver_name, s.taxi_id, t.identifier AS taxi_identifier, s.shift_date
        FROM day_shifts s JOIN users u ON u.id = s.driver_id
        LEFT JOIN taxis t ON t.id = s.taxi_id
        WHERE s.company_id = $1 AND s.taxi_id = $2 AND s.shift_date = $3 AND s.exit_km IS NULL`;
      if (user.role === 'driver') {
        params.push(user.id);
        openSql += ' AND s.driver_id <> $' + params.length;
      }
      openSql += ' ORDER BY s.id';
      const open = await pool.query(openSql, params);
      res.status(200).json(open.rows.map(function (r) {
        return { driver_id: r.driver_id, driver_name: r.driver_name, taxi_id: r.taxi_id, taxi_identifier: r.taxi_identifier, shift_date: dateStr(r.shift_date) };
      }));
      return;
    }
    const conditions = [];
    const params = [];
    // Aislamiento por empresa: siempre.
    params.push(user.company_id);
    conditions.push('s.company_id = $' + params.length);
    if (user.role === 'driver') {
      params.push(user.id);
      conditions.push('s.driver_id = $' + params.length);
    } else if (req.query && req.query.driver_id) {
      params.push(Number(req.query.driver_id));
      conditions.push('s.driver_id = $' + params.length);
    }
    if (req.query && req.query.date) {
      params.push(String(req.query.date));
      conditions.push('s.shift_date = $' + params.length);
    }
    // Límite de visibilidad del chofer (ver encabezado): una fecha más
    // vieja que 30 días no devuelve nada; sin fecha, la lista queda
    // acotada a la ventana.
    if (user.role === 'driver') {
      if (req.query && req.query.date && String(req.query.date) < driverWindowStart()) {
        res.status(200).json([]);
        return;
      }
      params.push(driverWindowStart());
      conditions.push('s.shift_date >= $' + params.length);
    }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const result = await pool.query(SELECT_SQL + ' ' + where + ' ORDER BY s.shift_date DESC', params);
    res.status(200).json(result.rows.map(withKm));
    return;
  }

  if (req.method !== 'POST') return methodNotAllowed(res);
  const body = readBody(req);
  // Marcar liquidación (solo el dueño): POST /api/shifts con
  // { action: 'settle', driver_id, shift_date, settlement }. La marca vive
  // en la jornada (day_shifts.settlement), por eso va en este archivo y no
  // en uno nuevo (límite de 12 funciones). No crea ni modifica jornadas:
  // exige una jornada cerrada existente del chofer en la empresa del
  // dueño. "Recibido" es solo confirmación; "pagado" significa que el
  // dueño ya pagó esa deuda en mano, así que ese día no genera saldo a
  // favor en day-close/report (los días siguientes se calculan sin ese
  // descuento). Volver a "pendiente" desmarca (por ejemplo, si se marcó
  // por error) y el saldo vuelve a calcularse. Guardar una jornada nunca
  // toca la marca. Si la migración v9 todavía no se aplicó, se avisa en
  // vez de fallar con un error críptico.
  if (body.action === 'settle') {
    if (user.role !== 'admin') {
      res.status(403).json({ error: 'Sin permiso' });
      return;
    }
    const settlement = String(body.settlement || '');
    if (['pendiente', 'recibido', 'pagado'].indexOf(settlement) === -1) {
      res.status(400).json({ error: 'Estado de liquidación inválido' });
      return;
    }
    const settleDriverId = Number(body.driver_id);
    const settleDate = String(body.shift_date || '');
    if (!settleDriverId || !/^\d{4}-\d{2}-\d{2}$/.test(settleDate)) {
      res.status(400).json({ error: 'Faltan chofer y fecha' });
      return;
    }
    const settleDriver = await pool.query("SELECT id, company_id FROM users WHERE id = $1 AND role = 'driver'", [settleDriverId]);
    if (!settleDriver.rows[0] || settleDriver.rows[0].company_id !== user.company_id) {
      res.status(400).json({ error: 'Chofer inválido' });
      return;
    }
    const settleShift = await pool.query(
      'SELECT id, exit_km FROM day_shifts WHERE driver_id = $1 AND shift_date = $2 AND company_id = $3',
      [settleDriverId, settleDate, user.company_id]
    );
    if (!settleShift.rows[0]) {
      res.status(400).json({ error: 'No hay jornada cargada para ese día' });
      return;
    }
    if (settleShift.rows[0].exit_km === null || settleShift.rows[0].exit_km === undefined) {
      res.status(400).json({ error: 'La jornada todavía está abierta' });
      return;
    }
    try {
      await pool.query(
        "UPDATE day_shifts SET settlement = $1, settled_at = CASE WHEN $1 = 'pendiente' THEN NULL ELSE NOW() END WHERE id = $2",
        [settlement, settleShift.rows[0].id]
      );
    } catch (e) {
      if (e && e.code === '42703') {
        res.status(400).json({ error: 'La liquidación todavía no está disponible: falta aplicar la migración v9' });
        return;
      }
      throw e;
    }
    const full = await pool.query(SELECT_SQL + ' WHERE s.id = $1', [settleShift.rows[0].id]);
    res.status(200).json(withKm(full.rows[0]));
    return;
  }
  const driverId = user.role === 'admin' && body.driver_id ? Number(body.driver_id) : user.id;
  const driver = await pool.query("SELECT id, company_id FROM users WHERE id = $1 AND role = 'driver'", [driverId]);
  if (!driver.rows[0] || driver.rows[0].company_id !== user.company_id) {
    res.status(400).json({ error: 'Chofer inválido' });
    return;
  }
  const entryKm = toNumber(body.entry_km, NaN);
  const exitKm = body.exit_km === undefined || body.exit_km === '' || body.exit_km === null
    ? null
    : toNumber(body.exit_km, NaN);
  const exitTime = body.exit_time ? String(body.exit_time) : null;
  if (!body.shift_date || !body.entry_time || !Number.isFinite(entryKm) || entryKm < 0 ||
      (exitKm !== null && (!Number.isFinite(exitKm) || exitKm < 0 || exitKm < entryKm))) {
    res.status(400).json({ error: 'Datos de la jornada inválidos (revisá fecha, hora y kilometraje)' });
    return;
  }
  const taxiId = body.taxi_id ? Number(body.taxi_id) : null;
  // El taxi es obligatorio al abrir el día: sin taxi no hay jornada.
  // Además debe ser un taxi de la empresa del chofer.
  if (!taxiId) {
    res.status(400).json({ error: 'Elegí el taxi del día' });
    return;
  }
  const taxi = await pool.query('SELECT id FROM taxis WHERE id = $1 AND company_id = $2', [taxiId, driver.rows[0].company_id]);
  if (!taxi.rows[0]) {
    res.status(400).json({ error: 'Taxi inválido' });
    return;
  }
  // Ubicación opcional (el teléfono la comparte solo con permiso).
  const entryGeo = geoPair(body.entry_lat, body.entry_lng);
  const exitGeo = geoPair(body.exit_lat, body.exit_lng);
  // Aclaraciones del día (opcional): solo se tocan si vienen en el body.
  // Si no vienen (por ejemplo, el formulario del admin), se conserva la
  // anterior; si vienen vacías, se borran. Tope de 1000 caracteres.
  const noteProvided = typeof body.note === 'string';
  const noteValue = noteProvided ? body.note.trim().slice(0, 1000) : null;
  const baseParams = [driver.rows[0].company_id, driverId, body.shift_date, taxiId, body.entry_time, entryKm, exitTime, exitKm,
    entryGeo ? entryGeo.lat : null, entryGeo ? entryGeo.lng : null,
    exitGeo ? exitGeo.lat : null, exitGeo ? exitGeo.lng : null];
  async function saveShift(withNote) {
    if (!withNote) {
      return pool.query(
        `INSERT INTO day_shifts (company_id, driver_id, shift_date, taxi_id, entry_time, entry_km, exit_time, exit_km, entry_lat, entry_lng, exit_lat, exit_lng)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (driver_id, shift_date) DO UPDATE
           SET taxi_id = EXCLUDED.taxi_id, entry_time = EXCLUDED.entry_time,
               entry_km = EXCLUDED.entry_km, exit_time = EXCLUDED.exit_time,
               exit_km = EXCLUDED.exit_km,
               entry_lat = COALESCE(EXCLUDED.entry_lat, day_shifts.entry_lat),
               entry_lng = COALESCE(EXCLUDED.entry_lng, day_shifts.entry_lng),
               exit_lat = COALESCE(EXCLUDED.exit_lat, day_shifts.exit_lat),
               exit_lng = COALESCE(EXCLUDED.exit_lng, day_shifts.exit_lng)
         RETURNING *`,
        baseParams
      );
    }
    return pool.query(
      `INSERT INTO day_shifts (company_id, driver_id, shift_date, taxi_id, entry_time, entry_km, exit_time, exit_km, entry_lat, entry_lng, exit_lat, exit_lng, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (driver_id, shift_date) DO UPDATE
         SET taxi_id = EXCLUDED.taxi_id, entry_time = EXCLUDED.entry_time,
             entry_km = EXCLUDED.entry_km, exit_time = EXCLUDED.exit_time,
             exit_km = EXCLUDED.exit_km,
             entry_lat = COALESCE(EXCLUDED.entry_lat, day_shifts.entry_lat),
             entry_lng = COALESCE(EXCLUDED.entry_lng, day_shifts.entry_lng),
             exit_lat = COALESCE(EXCLUDED.exit_lat, day_shifts.exit_lat),
             exit_lng = COALESCE(EXCLUDED.exit_lng, day_shifts.exit_lng),
             note = COALESCE(EXCLUDED.note, day_shifts.note)
       RETURNING *`,
      baseParams.concat([noteValue])
    );
  }
  // Si la migración v8 todavía no se aplicó, la columna note no existe:
  // en ese caso se guarda la jornada igual (sin aclaraciones) en vez de
  // trabar el inicio o el cierre del día.
  let saved;
  try {
    saved = await saveShift(true);
  } catch (e) {
    if (e && e.code === '42703') saved = await saveShift(false);
    else throw e;
  }
  const full = await pool.query(SELECT_SQL + ' WHERE s.id = $1', [saved.rows[0].id]);
  res.status(200).json(withKm(full.rows[0]));
};
