// GET /api/login-users — lista pública para la pantalla de ingreso, POR EMPRESA:
// solo id, nombre y rol de usuarios activos de esa empresa CON PIN.
// Dueños y choferes entran igual: eligen su nombre y escriben su PIN
// (el ingreso con email y PIN sigue disponible como alternativa para dueños).
// Sin hashes ni PINes.
// Las cuentas de manejo de la app (superadmin) NO aparecen en la lista:
// el único superadmin es el encargado de la plataforma y solo entra por
// su link personal (?name=, abajo). Los dueños de empresa son 'admin' y
// sí aparecen en la lista de su empresa.
// Requiere ?company_id= : sin empresa no se lista a nadie (aislamiento entre empresas).
// Con ?name= devuelve SOLO ese usuario (para links personales tipo
// ?company=CODIGO&user=NOMBRE): no se expone la lista completa.

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
  // Un solo usuario por nombre (link personal): sin lista completa.
  if (req.query && req.query.name) {
    const name = String(req.query.name || '').trim();
    if (!name) {
      res.status(400).json({ error: 'Falta el nombre' });
      return;
    }
    const one = await getPool().query(
      "SELECT id, name, role FROM users WHERE active = TRUE AND company_id = $1 AND pin_hash IS NOT NULL AND LOWER(name) = LOWER($2) ORDER BY id LIMIT 1",
      [companyId, name]
    );
    if (!one.rows[0]) {
      res.status(404).json({ error: 'Usuario no encontrado' });
      return;
    }
    res.status(200).json(one.rows[0]);
    return;
  }
  const result = await getPool().query(
    `SELECT id, name, role FROM users
     WHERE active = TRUE AND company_id = $1 AND pin_hash IS NOT NULL
     AND role <> 'superadmin'
     ORDER BY CASE WHEN role = 'admin' THEN 0 ELSE 1 END, name`,
    [companyId]
  );
  res.status(200).json(result.rows);
};
