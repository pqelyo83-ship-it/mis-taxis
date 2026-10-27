// POST /api/auth — ingreso solo con PIN (sin email ni registro).
// Body: { pin }. Respuesta: { token, user: { id, name, role, taxi_id, commission_pct } }.

const crypto = require('crypto');
const { getPool, hashPin, signToken, methodNotAllowed } = require('./_db');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res);
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const pin = String(body.pin || '');
  if (!pin) {
    res.status(400).json({ error: 'Falta el PIN' });
    return;
  }
  // Si viene user_id, el PIN se verifica solo contra ese usuario
  // (así dos usuarios nunca se confunden aunque compartan PIN).
  // Sin user_id se mantiene el comportamiento anterior: primer coincidente.
  const userId = body.user_id !== undefined ? Number(body.user_id)
    : (body.userId !== undefined ? Number(body.userId) : null);

  let match = null;
  if (userId) {
    const result = await getPool().query(
      'SELECT id, name, role, phone, taxi_id, commission_pct, commission_day_pct, commission_night_pct, pin_hash, pin_salt, active FROM users WHERE id = $1',
      [userId]
    );
    const row = result.rows[0];
    if (!row || !row.active) {
      res.status(401).json({ error: 'PIN incorrecto' });
      return;
    }
    const digest = hashPin(pin, row.pin_salt);
    const a = Buffer.from(digest);
    const b = Buffer.from(row.pin_hash);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      res.status(401).json({ error: 'PIN incorrecto' });
      return;
    }
    match = row;
  } else {
    const result = await getPool().query(
      'SELECT id, name, role, phone, taxi_id, commission_pct, commission_day_pct, commission_night_pct, pin_hash, pin_salt, active FROM users'
    );
    for (const row of result.rows) {
      if (!row.active) continue;
      const digest = hashPin(pin, row.pin_salt);
      const a = Buffer.from(digest);
      const b = Buffer.from(row.pin_hash);
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
        match = row;
        break;
      }
    }
  }
  if (!match) {
    res.status(401).json({ error: 'PIN incorrecto' });
    return;
  }

  const token = signToken({
    userId: match.id,
    role: match.role,
    name: match.name,
    exp: Date.now() + 7 * 24 * 60 * 60 * 1000,
  });
  res.status(200).json({
    token,
    user: {
      id: match.id,
      name: match.name,
      role: match.role,
      phone: match.phone,
      taxi_id: match.taxi_id,
      commission_pct: match.commission_pct,
      commission_day_pct: match.commission_day_pct !== null && match.commission_day_pct !== undefined ? match.commission_day_pct : match.commission_pct,
      commission_night_pct: match.commission_night_pct !== null && match.commission_night_pct !== undefined ? match.commission_night_pct : match.commission_pct,
    },
  });
};
