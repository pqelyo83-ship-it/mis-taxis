// /api/company — rutas de empresa (multi-empresa).
// Para no superar el límite de 12 funciones serverless del plan gratuito
// de Vercel, este único archivo atiende las rutas de empresa:
//   GET /api/company?list=1 — lista pública de empresas activas (pantalla de ingreso).
//   POST /api/company       — registro público de una empresa nueva.
//   GET /api/company        — datos de la empresa (solo admin).
//   PUT /api/company        — nombre y horario de noche (solo admin).
// El horario de noche define qué viajes se preseleccionan como nocturnos
// en el celular del chofer; el chofer igual puede cambiar el turno por viaje.

const { getPool, requireAuth, readBody, hashPin, newSalt, methodNotAllowed } = require('./_db');

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function makeCode() {
  const crypto = require('crypto');
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
  }
  return code;
}

module.exports = async function handler(req, res) {
  const pool = getPool();

  // Lista pública de empresas activas (id, nombre, código). Solo se exponen
  // nombre y código: alimenta el selector de empresa de la pantalla de ingreso.
  if (req.method === 'GET' && req.query && req.query.list === '1') {
    const result = await pool.query(
      'SELECT id, name, code FROM companies WHERE active = TRUE ORDER BY name'
    );
    res.status(200).json(result.rows);
    return;
  }

  // Registro público de una empresa nueva (venta a otros dueños).
  // Body: { company_name, admin_name, pin }.
  // Crea la empresa (con código corto único) y su primer administrador.
  // No hay aprobación previa en esta versión: cualquier dueño puede registrarse.
  if (req.method === 'POST') {
    const body = readBody(req);
    const companyName = String(body.company_name || '').trim();
    const adminName = String(body.admin_name || '').trim();
    const pin = String(body.pin || '');
    if (!companyName || !adminName || !pin || pin.length < 4) {
      res.status(400).json({ error: 'Faltan nombre de la empresa, nombre del dueño o PIN (mínimo 4 caracteres)' });
      return;
    }
    let code = null;
    for (let attempt = 0; attempt < 10 && !code; attempt++) {
      const candidate = makeCode();
      const exists = await pool.query('SELECT id FROM companies WHERE code = $1', [candidate]);
      if (!exists.rows[0]) code = candidate;
    }
    if (!code) {
      res.status(500).json({ error: 'No se pudo generar el código de empresa, intentá de nuevo' });
      return;
    }
    const company = await pool.query(
      'INSERT INTO companies (name, code, active) VALUES ($1, $2, TRUE) RETURNING *',
      [companyName, code]
    );
    const salt = newSalt();
    await pool.query(
      `INSERT INTO users (company_id, name, role, phone, taxi_id, commission_pct, pin_hash, pin_salt, active)
       VALUES ($1, $2, 'admin', '', NULL, 0, $3, $4, TRUE)`,
      [company.rows[0].id, adminName, hashPin(pin, salt), salt]
    );
    res.status(201).json({
      company: { id: company.rows[0].id, name: company.rows[0].name, code: company.rows[0].code },
    });
    return;
  }

  // Resto: solo admin de la empresa.
  const user = await requireAuth(req, res, ['admin']);
  if (!user) return;
  if (req.method === 'GET') {
    const result = await pool.query('SELECT id, name, code, night_start, night_end FROM companies WHERE id = $1', [user.company_id]);
    if (!result.rows[0]) {
      res.status(404).json({ error: 'Empresa no encontrada' });
      return;
    }
    res.status(200).json(result.rows[0]);
    return;
  }
  if (req.method === 'PUT') {
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
    return;
  }
  return methodNotAllowed(res);
};
