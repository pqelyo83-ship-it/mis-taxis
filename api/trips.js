// /api/trips — viajes por viaje (no resúmenes diarios).
// Cada viaje guarda el % del chofer al momento del viaje (pct_snapshot):
// si el admin cambia el % después, los viajes viejos no cambian.
// Cada viaje responde además con cuánto se queda el chofer y cuánto va al dueño.
// GET: admin ve todos; chofer ve solo los suyos. Filtros: ?date=AAAA-MM-DD, ?driver_id= (admin).
// POST: chofer crea solo viajes propios; admin puede crear para cualquier chofer.
// PUT, DELETE: el dueño del viaje o el admin.

const { getPool, requireAuth, readBody, toNumber, round2, methodNotAllowed } = require('./_db');

function dateStr(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function withSplit(row) {
  const amount = Number(row.amount);
  const pct = Number(row.pct_snapshot);
  const driverKeeps = round2((amount * pct) / 100);
  return {
    id: row.id,
    driver_id: row.driver_id,
    driver_name: row.driver_name || null,
    taxi_id: row.taxi_id,
    taxi_identifier: row.taxi_identifier || null,
    trip_date: dateStr(row.trip_date),
    entry_time: row.entry_time,
    entry_km: row.entry_km,
    exit_time: row.exit_time,
    exit_km: row.exit_km,
    amount: row.amount,
    pct_snapshot: row.pct_snapshot,
    shift_type: row.shift_type || 'day',
    trip_lat: row.trip_lat,
    trip_lng: row.trip_lng,
    driver_keeps: driverKeeps,
    owner_share: round2(amount - driverKeeps),
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

function geoPair(body) {
  if (body.trip_lat === undefined && body.trip_lng === undefined) return null;
  const lat = validLat(body.trip_lat);
  const lng = validLng(body.trip_lng);
  return lat !== null && lng !== null ? { lat, lng } : null;
}

const SELECT_SQL = `
  SELECT tr.*, u.name AS driver_name, t.identifier AS taxi_identifier
  FROM trips tr
  JOIN users u ON u.id = tr.driver_id
  LEFT JOIN taxis t ON t.id = tr.taxi_id
`;

module.exports = async function handler(req, res) {
  const user = await requireAuth(req, res, ['admin', 'driver']);
  if (!user) return;
  const pool = getPool();
  const id = req.query && req.query.id ? Number(req.query.id) : null;

  if (req.method === 'GET') {
    const conditions = [];
    const params = [];
    // Aislamiento por empresa: siempre, para chofer y admin.
    params.push(user.company_id);
    conditions.push('tr.company_id = $' + params.length);
    if (user.role === 'driver') {
      params.push(user.id);
      conditions.push('tr.driver_id = $' + params.length);
    } else if (req.query && req.query.driver_id) {
      params.push(Number(req.query.driver_id));
      conditions.push('tr.driver_id = $' + params.length);
    }
    if (req.query && req.query.date) {
      params.push(String(req.query.date));
      conditions.push('tr.trip_date = $' + params.length);
    }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const result = await pool.query(SELECT_SQL + ' ' + where + ' ORDER BY tr.trip_date DESC, tr.entry_time DESC', params);
    res.status(200).json(result.rows.map(withSplit));
    return;
  }

  const body = readBody(req);

  if (req.method === 'POST') {
    const driverId = user.role === 'admin' && body.driver_id ? Number(body.driver_id) : user.id;
    const driver = await pool.query("SELECT id, commission_pct, commission_day_pct, commission_night_pct, taxi_id, company_id FROM users WHERE id = $1 AND role = 'driver'", [driverId]);
    if (!driver.rows[0] || driver.rows[0].company_id !== user.company_id) {
      res.status(400).json({ error: 'Chofer inválido' });
      return;
    }
    const amount = toNumber(body.amount, NaN);
    // Turno del viaje: 'day' o 'night'. El % que se aplica es el del turno.
    const shiftType = body.shift_type === 'night' ? 'night' : 'day';
    const pct = shiftType === 'night'
      ? (driver.rows[0].commission_night_pct !== null ? driver.rows[0].commission_night_pct : driver.rows[0].commission_pct)
      : (driver.rows[0].commission_day_pct !== null ? driver.rows[0].commission_day_pct : driver.rows[0].commission_pct);
    if (!body.trip_date || !Number.isFinite(amount) || amount < 0) {
      res.status(400).json({ error: 'Datos del viaje inválidos (revisá fecha y monto)' });
      return;
    }
    // El taxi del viaje: el de la jornada de ese día, si hay una;
    // si no, el taxi asignado al chofer. Los viajes ya no llevan horas ni km.
    let taxiId = body.taxi_id ? Number(body.taxi_id) : null;
    if (!taxiId) {
      const shift = await pool.query(
        'SELECT taxi_id FROM day_shifts WHERE driver_id = $1 AND shift_date = $2',
        [driverId, body.trip_date]
      );
      taxiId = shift.rows[0] ? shift.rows[0].taxi_id : driver.rows[0].taxi_id;
    }
    const geo = geoPair(body);
    const inserted = await pool.query(
      `INSERT INTO trips (company_id, driver_id, taxi_id, trip_date, entry_time, entry_km, exit_time, exit_km, amount, pct_snapshot, shift_type, trip_lat, trip_lng)
       VALUES ($1, $2, $3, $4, NULL, NULL, NULL, NULL, $5, $6, $7, $8, $9) RETURNING *`,
      [driver.rows[0].company_id, driverId, taxiId, body.trip_date, amount, pct, shiftType, geo ? geo.lat : null, geo ? geo.lng : null]
    );
    const full = await pool.query(SELECT_SQL + ' WHERE tr.id = $1', [inserted.rows[0].id]);
    res.status(201).json(withSplit(full.rows[0]));
    return;
  }

  if (req.method === 'PUT' || req.method === 'DELETE') {
    if (!id) {
      res.status(400).json({ error: 'Falta id' });
      return;
    }
    const current = await pool.query('SELECT * FROM trips WHERE id = $1', [id]);
    if (!current.rows[0]) {
      res.status(404).json({ error: 'Viaje no encontrado' });
      return;
    }
    if (current.rows[0].company_id !== user.company_id) {
      res.status(403).json({ error: 'Sin permiso' });
      return;
    }
    if (user.role === 'driver' && current.rows[0].driver_id !== user.id) {
      res.status(403).json({ error: 'Sin permiso' });
      return;
    }
    if (req.method === 'DELETE') {
      await pool.query('DELETE FROM trips WHERE id = $1', [id]);
      res.status(200).json({ ok: true });
      return;
    }
    const amount = toNumber(body.amount, NaN);
    if (!body.trip_date || !Number.isFinite(amount) || amount < 0) {
      res.status(400).json({ error: 'Datos del viaje inválidos' });
      return;
    }
    const taxiId = body.taxi_id ? Number(body.taxi_id) : current.rows[0].taxi_id;
    // Si cambia el turno, el % se recalcula con el % actual del chofer para ese turno.
    const newShiftType = body.shift_type === 'night' || body.shift_type === 'day'
      ? body.shift_type : (current.rows[0].shift_type || 'day');
    let newPct = current.rows[0].pct_snapshot;
    if (newShiftType !== (current.rows[0].shift_type || 'day')) {
      const driver = await pool.query("SELECT commission_pct, commission_day_pct, commission_night_pct FROM users WHERE id = $1", [current.rows[0].driver_id]);
      const d = driver.rows[0] || {};
      newPct = newShiftType === 'night'
        ? (d.commission_night_pct !== null && d.commission_night_pct !== undefined ? d.commission_night_pct : d.commission_pct)
        : (d.commission_day_pct !== null && d.commission_day_pct !== undefined ? d.commission_day_pct : d.commission_pct);
    }
    // La ubicación solo cambia si viene en el body; si no, se conserva.
    const geo = geoPair(body);
    const newLat = geo ? geo.lat : current.rows[0].trip_lat;
    const newLng = geo ? geo.lng : current.rows[0].trip_lng;
    const updated = await pool.query(
      `UPDATE trips SET trip_date = $1, amount = $2, taxi_id = $3, shift_type = $4, pct_snapshot = $5, trip_lat = $6, trip_lng = $7 WHERE id = $8 RETURNING *`,
      [body.trip_date, amount, taxiId, newShiftType, newPct, newLat, newLng, id]
    );
    const full = await pool.query(SELECT_SQL + ' WHERE tr.id = $1', [updated.rows[0].id]);
    res.status(200).json(withSplit(full.rows[0]));
    return;
  }

  return methodNotAllowed(res);
};
