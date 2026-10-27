// /api/shifts — jornada del día por chofer.
// Un registro por chofer y día: taxi del día, hora y km de entrada,
// hora y km de salida (la salida se completa al terminar el día).
// GET: chofer ve sus jornadas; admin ve todas (?driver_id=, ?date=).
// POST: crea o actualiza la jornada (un registro por chofer y día).
// El chofer solo maneja sus propias jornadas; el admin puede cargar la de cualquier chofer.

const { getPool, requireAuth, readBody, toNumber, round2, methodNotAllowed } = require('./_db');

function dateStr(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
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
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const result = await pool.query(SELECT_SQL + ' ' + where + ' ORDER BY s.shift_date DESC', params);
    res.status(200).json(result.rows.map(withKm));
    return;
  }

  if (req.method !== 'POST') return methodNotAllowed(res);
  const body = readBody(req);
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
  // Ubicación opcional (el teléfono la comparte solo con permiso).
  const entryGeo = geoPair(body.entry_lat, body.entry_lng);
  const exitGeo = geoPair(body.exit_lat, body.exit_lng);
  const saved = await pool.query(
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
    [driver.rows[0].company_id, driverId, body.shift_date, taxiId, body.entry_time, entryKm, exitTime, exitKm,
     entryGeo ? entryGeo.lat : null, entryGeo ? entryGeo.lng : null,
     exitGeo ? exitGeo.lat : null, exitGeo ? exitGeo.lng : null]
  );
  const full = await pool.query(SELECT_SQL + ' WHERE s.id = $1', [saved.rows[0].id]);
  res.status(200).json(withKm(full.rows[0]));
};
