// GET /api/login-users — lista pública para la pantalla de ingreso:
// solo id, nombre y rol de usuarios activos. Sin hashes ni PINes.
// La pantalla muestra los nombres para que cada uno seleccione el suyo y ponga su PIN.

const { getPool, methodNotAllowed } = require('./_db');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res);
  const result = await getPool().query(
    "SELECT id, name, role FROM users WHERE active = TRUE ORDER BY CASE WHEN role = 'admin' THEN 0 ELSE 1 END, name"
  );
  res.status(200).json(result.rows);
};
