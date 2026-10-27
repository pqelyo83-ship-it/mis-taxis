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
    driver_keeps: driverKeeps,
    owner_share: round2(amount - driverKeeps),
    created_at: row.created_at,
  };
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
    const driver = await pool.query("SELECT id, commission_pct, taxi_id FROM users WHERE id = $1 AND role = 'driver'", [driverId]);
    if (!driver.rows[0]) {
      res.status(400).json({ error: 'Chofer inválido' });
      return;
    }
    const amount = toNumber(body.amount, NaN);
    const entryKm = toNumber(body.entry_km, NaN);
    const exitKm = toNumber(body.exit_km, NaN);
    if (!body.trip_date || !body.entry_time || !body.exit_time || !Number.isFinite(amount) || amount < 0 ||
        !Number.isFinite(entryKm) || entryKm < 0 || !Number.isFinite(exitKm) || exitKm < entryKm) {
      res.status(400).json({ error: 'Datos del viaje inválidos (revisá fecha, horas, kilometraje y monto)' });
      return;
    }
    const taxiId = body.taxi_id ? Number(body.taxi_id) : driver.rows[0].taxi_id;
    const inserted = await pool.query(
      `INSERT INTO trips (driver_id, taxi_id, trip_date, entry_time, entry_km, exit_time, exit_km, amount, pct_snapshot)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [driverId, taxiId, body.trip_date, body.entry_time, entryKm, body.exit_time, exitKm, amount, driver.rows[0].commission_pct]
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
    const entryKm = toNumber(body.entry_km, NaN);
    const exitKm = toNumber(body.exit_km, NaN);
    if (!body.trip_date || !body.entry_time || !body.exit_time || !Number.isFinite(amount) || amount < 0 ||
        !Number.isFinite(entryKm) || entryKm < 0 || !Number.isFinite(exitKm) || exitKm < entryKm) {
      res.status(400).json({ error: 'Datos del viaje inválidos' });
      return;
    }
    const updated = await pool.query(
      `UPDATE trips SET trip_date = $1, entry_time = $2, entry_km = $3, exit_time = $4,
       exit_km = $5, amount = $6 WHERE id = $7 RETURNING *`,
      [body.trip_date, body.entry_time, entryKm, body.exit_time, exitKm, amount, id]
    );
    const full = await pool.query(SELECT_SQL + ' WHERE tr.id = $1', [updated.rows[0].id]);
    res.status(200).json(withSplit(full.rows[0]));
    return;
  }

  return methodNotAllowed(res);
};
