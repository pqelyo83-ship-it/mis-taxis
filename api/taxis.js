// /api/taxis — taxis.
// GET: admin ve todos; chofer ve los taxis activos (elige uno por día en su jornada).
// POST, PUT, DELETE: solo admin.

const { getPool, requireAuth, readBody, methodNotAllowed } = require('./_db');

module.exports = async function handler(req, res) {
  const user = await requireAuth(req, res, ['admin', 'driver']);
  if (!user) return;
  const pool = getPool();
  const id = req.query && req.query.id ? Number(req.query.id) : null;

  if (req.method === 'GET') {
    if (user.role === 'admin') {
      const result = await pool.query('SELECT * FROM taxis WHERE company_id = $1 ORDER BY identifier', [user.company_id]);
      res.status(200).json(result.rows);
    } else {
      const result = await pool.query('SELECT * FROM taxis WHERE active = TRUE AND company_id = $1 ORDER BY identifier', [user.company_id]);
      res.status(200).json(result.rows);
    }
    return;
  }

  // Escritura: solo admin.
  if (user.role !== 'admin') {
    res.status(403).json({ error: 'Sin permiso' });
    return;
  }
  const body = readBody(req);

  if (req.method === 'POST') {
    const identifier = String(body.identifier || '').trim();
    const plate = String(body.plate || '').trim();
    if (!identifier || !plate) {
      res.status(400).json({ error: 'Faltan identificador o patente' });
      return;
    }
    const result = await pool.query(
      'INSERT INTO taxis (company_id, identifier, plate, model, year, active) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
      [user.company_id, identifier, plate, String(body.model || ''), body.year ? Number(body.year) : null, body.active !== false]
    );
    res.status(201).json(result.rows[0]);
    return;
  }

  if (req.method === 'PUT') {
    if (!id) {
      res.status(400).json({ error: 'Falta id' });
      return;
    }
    const result = await pool.query(
      'UPDATE taxis SET identifier = $1, plate = $2, model = $3, year = $4, active = $5 WHERE id = $6 AND company_id = $7 RETURNING *',
      [
        String(body.identifier || '').trim(),
        String(body.plate || '').trim(),
        String(body.model || ''),
        body.year ? Number(body.year) : null,
        body.active !== false,
        id,
        user.company_id,
      ]
    );
    if (!result.rows[0]) {
      res.status(404).json({ error: 'Taxi no encontrado' });
      return;
    }
    res.status(200).json(result.rows[0]);
    return;
  }

  if (req.method === 'DELETE') {
    if (!id) {
      res.status(400).json({ error: 'Falta id' });
      return;
    }
    const result = await pool.query('DELETE FROM taxis WHERE id = $1 AND company_id = $2', [id, user.company_id]);
    if (result.rowCount === 0) {
      res.status(404).json({ error: 'Taxi no encontrado' });
      return;
    }
    res.status(200).json({ ok: true });
    return;
  }

  return methodNotAllowed(res);
};
