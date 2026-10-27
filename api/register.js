// POST /api/register — registro público de una empresa nueva (venta a otros dueños).
// Body: { company_name, admin_name, pin }.
// Crea la empresa (con código corto único para identificarla) y su primer
// administrador. El dueño después agrega sus choferes y taxis desde el panel.
// No hay aprobación previa en esta versión: cualquier dueño puede registrarse.

const { getPool, hashPin, newSalt, methodNotAllowed } = require('./_db');

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
  if (req.method !== 'POST') return methodNotAllowed(res);
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const companyName = String(body.company_name || '').trim();
  const adminName = String(body.admin_name || '').trim();
  const pin = String(body.pin || '');
  if (!companyName || !adminName || !pin || pin.length < 4) {
    res.status(400).json({ error: 'Faltan nombre de la empresa, nombre del dueño o PIN (mínimo 4 caracteres)' });
    return;
  }
  const pool = getPool();
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
};
