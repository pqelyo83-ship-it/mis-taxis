// GET /api/companies — lista pública de empresas activas (id, nombre, código).
// Solo se exponen nombre y código: la lista alimenta el selector de empresa
// de la pantalla de ingreso. Los datos de cada empresa quedan aislados por
// company_id en el resto de la API.

const { getPool, methodNotAllowed } = require('./_db');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res);
  const result = await getPool().query(
    'SELECT id, name, code FROM companies WHERE active = TRUE ORDER BY name'
  );
  res.status(200).json(result.rows);
};
