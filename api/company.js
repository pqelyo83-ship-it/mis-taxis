// /api/company — datos y ajustes de la empresa del usuario (solo admin).
// GET: nombre, código y horario de noche de la empresa.
// PUT: cambia el nombre y el horario de noche (horas 0-23).
// El horario de noche define qué viajes se preseleccionan como nocturnos
// en el celular del chofer; el chofer igual puede cambiar el turno por viaje.

const { getPool, requireAuth, readBody, methodNotAllowed } = require('./_db');

module.exports = async function handler(req, res) {
  const user = await requireAuth(req, res, ['admin']);
  if (!user) return;
  const pool = getPool();
  if (req.method === 'GET') {
    const result = await pool.query('SELECT id, name, code, night_start, night_end FROM companies WHERE id = $1', [user.company_id]);
    if (!result.rows[0]) {
      res.status(404).json({ error: 'Empresa no encontrada' });
      return;
    }
    res.status(200).json(result.rows[0]);
    return;
  }
  if (req.method !== 'PUT') return methodNotAllowed(res);
  const body = readBody(req);
  const name = String(body.name || '').trim();
  const nightStart = Number(body.night_start);
  const nightEnd = Number(body.night_end);
  if (!name || !Number.isInteger(nightStart) || nightStart < 0 || nightStart > 23 ||
      !Number.isInteger(nightEnd) || nightEnd < 0 || nightEnd > 23) {
    res.status(400).json({ error: 'Datos de la empresa inválidos (nombre y horas 0 a 23)' });
    return;
  }
  const result = await pool.query(
    'UPDATE companies SET name = $1, night_start = $2, night_end = $3 WHERE id = $4 RETURNING id, name, code, night_start, night_end',
    [name, nightStart, nightEnd, user.company_id]
  );
  if (!result.rows[0]) {
    res.status(404).json({ error: 'Empresa no encontrada' });
    return;
  }
  res.status(200).json(result.rows[0]);
};
