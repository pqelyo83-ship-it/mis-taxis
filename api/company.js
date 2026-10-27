// /api/company — rutas de empresa (multi-empresa).
// Para no superar el límite de 12 funciones serverless del plan gratuito
// de Vercel, este único archivo atiende las rutas de empresa:
//   GET /api/company?list=1   — lista pública de empresas activas (pantalla de ingreso).
//   GET /api/company?panel=1  — lista de empresas con su dueño (solo superadmin).
//   POST /api/company         — alta de empresa + dueño con email y PIN (solo superadmin).
//   PUT /api/company?panel=1&id= — editar empresa/dueño, suspender/reactivar, pago (solo superadmin, nunca la propia).
//   DELETE /api/company?panel=1&id= — borrar empresa y todos sus datos (solo superadmin, nunca la propia).
//   GET /api/company          — datos de la empresa (solo admin).
//   PUT /api/company          — nombre y horario de noche (solo admin).
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

  // Alta de empresa + dueño con email y PIN.
  // Solo el superadmin (dueño de la plataforma) da altas. El registro
  // público está cerrado: nadie se crea una empresa sin pasar por él.
  // Body: { company_name, admin_name, email, pin }.
  if (req.method === 'POST') {
    const user = await requireAuth(req, res, ['admin']);
    if (!user) return;
    if (!user.is_superadmin) {
      res.status(403).json({ error: 'Sin permiso' });
      return;
    }
    const body = readBody(req);
    const companyName = String(body.company_name || '').trim();
    const adminName = String(body.admin_name || '').trim();
    const email = String(body.email || '').trim().toLowerCase();
    const pin = String(body.pin || '');
    if (!companyName || !adminName || !email || email.indexOf('@') === -1 || !pin || pin.length < 4) {
      res.status(400).json({ error: 'Faltan nombre de la empresa, nombre del dueño, email válido o PIN (mínimo 4 caracteres)' });
      return;
    }
    const taken = await pool.query('SELECT id FROM users WHERE LOWER(email) = $1', [email]);
    if (taken.rows[0]) {
      res.status(400).json({ error: 'Ese email ya está en uso' });
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
    // Métodos de pago por defecto de la empresa nueva.
    await pool.query(
      `INSERT INTO payment_methods (company_id, name)
       SELECT $1, t.m FROM (VALUES ('Efectivo'), ('Tarjeta'), ('Transferencia')) AS t(m)
       WHERE NOT EXISTS (SELECT 1 FROM payment_methods WHERE company_id = $1 AND LOWER(name) = LOWER(t.m))`,
      [company.rows[0].id]
    );
    const salt = newSalt();
    await pool.query(
      `INSERT INTO users (company_id, name, role, phone, email, password_hash, pin_hash, pin_salt, taxi_id, commission_pct, active)
       VALUES ($1, $2, 'admin', '', $3, NULL, $4, $5, NULL, 0, TRUE)`,
      [company.rows[0].id, adminName, email, hashPin(pin, salt), salt]
    );
    res.status(201).json({
      company: { id: company.rows[0].id, name: company.rows[0].name, code: company.rows[0].code },
    });
    return;
  }

  // Resto: admin de la empresa (el superadmin opera su propia empresa).
  const user = await requireAuth(req, res, ['admin']);
  if (!user) return;

  // Editar empresa/dueño desde el panel (solo superadmin, nunca la propia).
  // Body parcial: { name, owner_name, owner_email, pin (vacío = no cambia),
  //   active, payment_status ('paid' | 'pending') }.
  if (req.method === 'PUT' && req.query && req.query.panel === '1') {
    if (!user.is_superadmin) {
      res.status(403).json({ error: 'Sin permiso' });
      return;
    }
    const targetId = req.query.id ? Number(req.query.id) : null;
    if (!targetId || targetId === user.company_id) {
      res.status(403).json({ error: 'No podés modificar tu propia empresa desde acá' });
      return;
    }
    const company = await pool.query('SELECT id FROM companies WHERE id = $1', [targetId]);
    if (!company.rows[0]) {
      res.status(404).json({ error: 'Empresa no encontrada' });
      return;
    }
    const owner = await pool.query("SELECT id FROM users WHERE company_id = $1 AND role = 'admin' ORDER BY id LIMIT 1", [targetId]);
    if (!owner.rows[0]) {
      res.status(404).json({ error: 'Dueño no encontrado' });
      return;
    }
    const ownerId = owner.rows[0].id;
    const body = readBody(req);
    if (body.name !== undefined) {
      const name = String(body.name || '').trim();
      if (!name) {
        res.status(400).json({ error: 'Falta el nombre de la empresa' });
        return;
      }
      await pool.query('UPDATE companies SET name = $1 WHERE id = $2', [name, targetId]);
    }
    if (body.active !== undefined) {
      await pool.query('UPDATE companies SET active = $1 WHERE id = $2', [body.active !== false, targetId]);
    }
    if (body.payment_status !== undefined) {
      if (body.payment_status !== 'paid' && body.payment_status !== 'pending') {
        res.status(400).json({ error: 'Estado de pago inválido' });
        return;
      }
      await pool.query('UPDATE companies SET payment_status = $1 WHERE id = $2', [body.payment_status, targetId]);
    }
    if (body.owner_name !== undefined) {
      const ownerName = String(body.owner_name || '').trim();
      if (!ownerName) {
        res.status(400).json({ error: 'Falta el nombre del dueño' });
        return;
      }
      await pool.query('UPDATE users SET name = $1 WHERE id = $2', [ownerName, ownerId]);
    }
    if (body.owner_email !== undefined) {
      const ownerEmail = String(body.owner_email || '').trim().toLowerCase();
      if (!ownerEmail || ownerEmail.indexOf('@') === -1) {
        res.status(400).json({ error: 'Email inválido' });
        return;
      }
      const taken = await pool.query('SELECT id FROM users WHERE LOWER(email) = $1 AND id <> $2', [ownerEmail, ownerId]);
      if (taken.rows[0]) {
        res.status(400).json({ error: 'Ese email ya está en uso' });
        return;
      }
      await pool.query('UPDATE users SET email = $1 WHERE id = $2', [ownerEmail, ownerId]);
    }
    if (body.pin !== undefined && body.pin !== '') {
      const pin = String(body.pin || '');
      if (pin.length < 4) {
        res.status(400).json({ error: 'El PIN debe tener mínimo 4 caracteres' });
        return;
      }
      const salt = newSalt();
      await pool.query('UPDATE users SET pin_hash = $1, pin_salt = $2 WHERE id = $3', [hashPin(pin, salt), salt, ownerId]);
    }
    res.status(200).json({ ok: true });
    return;
  }

  // Borrar empresa y TODOS sus datos (solo superadmin, nunca la propia).
  // Irreversible: el frontend pide confirmación antes de llamar.
  if (req.method === 'DELETE' && req.query && req.query.panel === '1') {
    if (!user.is_superadmin) {
      res.status(403).json({ error: 'Sin permiso' });
      return;
    }
    const targetId = req.query.id ? Number(req.query.id) : null;
    if (!targetId || targetId === user.company_id) {
      res.status(403).json({ error: 'No podés borrar tu propia empresa' });
      return;
    }
    const company = await pool.query('SELECT id FROM companies WHERE id = $1', [targetId]);
    if (!company.rows[0]) {
      res.status(404).json({ error: 'Empresa no encontrada' });
      return;
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM trips WHERE company_id = $1', [targetId]);
      await client.query('DELETE FROM expenses WHERE company_id = $1', [targetId]);
      await client.query('DELETE FROM day_shifts WHERE company_id = $1', [targetId]);
      await client.query('DELETE FROM payment_methods WHERE company_id = $1', [targetId]);
      await client.query('DELETE FROM users WHERE company_id = $1', [targetId]);
      await client.query('DELETE FROM taxis WHERE company_id = $1', [targetId]);
      await client.query('DELETE FROM companies WHERE id = $1', [targetId]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
    res.status(200).json({ ok: true });
    return;
  }

  // Panel Empresas (solo superadmin): todas las empresas con su dueño.
  if (req.method === 'GET' && req.query && req.query.panel === '1') {
    if (!user.is_superadmin) {
      res.status(403).json({ error: 'Sin permiso' });
      return;
    }
    const result = await pool.query(
      `SELECT c.id, c.name, c.code, c.active, c.payment_status, c.created_at,
        (SELECT name FROM users u WHERE u.company_id = c.id AND u.role IN ('admin', 'superadmin') ORDER BY u.id LIMIT 1) AS owner_name,
        (SELECT email FROM users u WHERE u.company_id = c.id AND u.role IN ('admin', 'superadmin') ORDER BY u.id LIMIT 1) AS owner_email
       FROM companies c ORDER BY c.created_at DESC`
    );
    res.status(200).json(result.rows);
    return;
  }

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
