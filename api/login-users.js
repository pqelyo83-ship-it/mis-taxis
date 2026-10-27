// GET /api/login-users — lista pública para la pantalla de ingreso, POR EMPRESA:
// solo id, nombre y rol de usuarios activos de esa empresa CON PIN y SIN email
// (los dueños con email no entran acá: ellos usan el ingreso con email y PIN).
// Sin hashes ni PINes.
// Requiere ?company_id= : sin empresa no se lista a nadie (aislamiento entre empresas).

const { getPool, methodNotAllowed } = require('./_db');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res);
  const companyId = req.query && req.query.company_id ? Number(req.query.company_id) : null;
  if (!companyId) {
    res.status(400).json({ error: 'Falta la empresa' });
    return;
  }
  // Empresa suspendida: no se lista a nadie.
  const company = await getPool().query('SELECT id FROM companies WHERE id = $1 AND active = TRUE', [companyId]);
  if (!company.rows[0]) {
    res.status(200).json([]);
    return;
  }
  const result = await getPool().query(
    "SELECT id, name, role FROM users WHERE active = TRUE AND company_id = $1 AND pin_hash IS NOT NULL AND email IS NULL ORDER BY CASE WHEN role = 'admin' THEN 0 ELSE 1 END, name",
    [companyId]
  );
  res.status(200).json(result.rows);
};
