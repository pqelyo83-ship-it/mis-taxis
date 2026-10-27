// /api/receipt — foto de la factura de un gasto.
// GET ?id=: devuelve la foto guardada (data URL JPEG).
// Solo el admin o el chofer dueño del gasto pueden verla.
// Las listas de gastos no traen la foto (solo has_receipt) para no pesar.

const { getPool, requireAuth, methodNotAllowed } = require('./_db');

module.exports = async function handler(req, res) {
  const user = await requireAuth(req, res, ['admin', 'driver']);
  if (!user) return;
  if (req.method !== 'GET') return methodNotAllowed(res);
  const id = req.query && req.query.id ? Number(req.query.id) : null;
  if (!id) {
    res.status(400).json({ error: 'Falta id' });
    return;
  }
  const pool = getPool();
  const result = await pool.query('SELECT driver_id, company_id, receipt_image FROM expenses WHERE id = $1', [id]);
  const row = result.rows[0];
  if (!row) {
    res.status(404).json({ error: 'Gasto no encontrado' });
    return;
  }
  if (row.company_id !== user.company_id) {
    res.status(403).json({ error: 'Sin permiso' });
    return;
  }
  if (user.role === 'driver' && row.driver_id !== user.id) {
    res.status(403).json({ error: 'Sin permiso' });
    return;
  }
  if (!row.receipt_image) {
    res.status(404).json({ error: 'Este gasto no tiene foto' });
    return;
  }
  res.status(200).json({ image: row.receipt_image });
};
