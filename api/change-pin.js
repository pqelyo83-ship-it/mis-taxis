// POST /api/change-pin — el usuario autenticado cambia su propio PIN.
// Body: { new_pin }. El token de sesión prueba la identidad; no hace falta el PIN anterior.
// El admin usa esto para su propio PIN; el PIN de los choferes se cambia desde /api/drivers.

const { getPool, requireAuth, hashPin, newSalt, methodNotAllowed } = require('./_db');

module.exports = async function handler(req, res) {
  const user = await requireAuth(req, res, ['admin', 'driver']);
  if (!user) return;
  if (req.method !== 'POST') return methodNotAllowed(res);
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const newPin = String(body.new_pin || '');
  if (!newPin || newPin.length < 4) {
    res.status(400).json({ error: 'El PIN nuevo debe tener al menos 4 caracteres' });
    return;
  }
  const salt = newSalt();
  await getPool().query('UPDATE users SET pin_hash = $1, pin_salt = $2 WHERE id = $3', [hashPin(newPin, salt), salt, user.id]);
  res.status(200).json({ ok: true });
};
