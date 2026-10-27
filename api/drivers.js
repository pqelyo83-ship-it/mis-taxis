// /api/drivers — choferes. Solo admin.
// GET: lista de choferes (sin hashes de PIN).
// POST: crea chofer con PIN (se guarda solo el hash con sal).
// PUT: edita nombre, teléfono, taxi, % y, si viene un PIN nuevo, lo reemplaza.
// DELETE: desactiva al chofer (no borra su historial de viajes ni gastos).

const { getPool, requireAuth, readBody, hashPin, newSalt, methodNotAllowed } = require('./_db');

function publicDriver(row) {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    taxi_id: row.taxi_id,
    taxi_identifier: row.taxi_identifier || null,
    commission_pct: row.commission_pct,
    active: row.active,
    created_at: row.created_at,
  };
}

module.exports = async function handler(req, res) {
  const user = await requireAuth(req, res, ['admin']);
  if (!user) return;
  const pool = getPool();
  const id = req.query && req.query.id ? Number(req.query.id) : null;

  if (req.method === 'GET') {
    const result = await pool.query(
      `SELECT u.*, t.identifier AS taxi_identifier FROM users u
       LEFT JOIN taxis t ON t.id = u.taxi_id
       WHERE u.role = 'driver' ORDER BY u.name`
    );
    res.status(200).json(result.rows.map(publicDriver));
    return;
  }

  const body = readBody(req);

  if (req.method === 'POST') {
    const name = String(body.name || '').trim();
    const pin = String(body.pin || '');
    const pct = Number(body.commission_pct);
    if (!name || !pin || !Number.isFinite(pct) || pct < 0 || pct > 100) {
      res.status(400).json({ error: 'Faltan nombre, PIN o % válido (0 a 100)' });
      return;
    }
    const salt = newSalt();
    const result = await pool.query(
      `INSERT INTO users (name, role, phone, taxi_id, commission_pct, pin_hash, pin_salt, active)
       VALUES ($1, 'driver', $2, $3, $4, $5, $6, TRUE) RETURNING *`,
      [name, String(body.phone || ''), body.taxi_id ? Number(body.taxi_id) : null, pct, hashPin(pin, salt), salt]
    );
    res.status(201).json(publicDriver(result.rows[0]));
    return;
  }

  if (req.method === 'PUT') {
    if (!id) {
      res.status(400).json({ error: 'Falta id' });
      return;
    }
    const current = await pool.query("SELECT * FROM users WHERE id = $1 AND role = 'driver'", [id]);
    if (!current.rows[0]) {
      res.status(404).json({ error: 'Chofer no encontrado' });
      return;
    }
    const pct = Number(body.commission_pct);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
      res.status(400).json({ error: '% inválido (0 a 100)' });
      return;
    }
    let pinHash = current.rows[0].pin_hash;
    let pinSalt = current.rows[0].pin_salt;
    if (body.pin !== undefined && String(body.pin) !== '') {
      pinSalt = newSalt();
      pinHash = hashPin(String(body.pin), pinSalt);
    }
    const result = await pool.query(
      `UPDATE users SET name = $1, phone = $2, taxi_id = $3, commission_pct = $4,
       pin_hash = $5, pin_salt = $6, active = $7 WHERE id = $8 RETURNING *`,
      [
        String(body.name || current.rows[0].name).trim(),
        String(body.phone !== undefined ? body.phone : current.rows[0].phone),
        body.taxi_id ? Number(body.taxi_id) : null,
        pct,
        pinHash,
        pinSalt,
        body.active !== false,
        id,
      ]
    );
    res.status(200).json(publicDriver(result.rows[0]));
    return;
  }

  if (req.method === 'DELETE') {
    if (!id) {
      res.status(400).json({ error: 'Falta id' });
      return;
    }
    await pool.query("UPDATE users SET active = FALSE WHERE id = $1 AND role = 'driver'", [id]);
    res.status(200).json({ ok: true });
    return;
  }

  return methodNotAllowed(res);
};
