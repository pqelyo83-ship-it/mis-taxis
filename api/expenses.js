// /api/expenses — gastos del chofer (gasolina, arreglos, otros).
// Los gastos se descuentan de la parte del dueño, no de la del chofer.
// GET: admin ve todos; chofer ve solo los suyos.
// POST: chofer crea solo gastos propios; admin puede crear para cualquier chofer.
// DELETE: el dueño del gasto o el admin.

const { getPool, requireAuth, readBody, toNumber, methodNotAllowed } = require('./_db');

function dateStr(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function publicExpense(row) {
  return {
    id: row.id,
    driver_id: row.driver_id,
    driver_name: row.driver_name || null,
    expense_date: dateStr(row.expense_date),
    type: row.type,
    amount: row.amount,
    note: row.note,
    has_receipt: !!row.receipt_image,
    created_at: row.created_at,
  };
}

const TYPES = ['gasolina', 'arreglos', 'otros'];

module.exports = async function handler(req, res) {
  const user = await requireAuth(req, res, ['admin', 'driver']);
  if (!user) return;
  const pool = getPool();
  const id = req.query && req.query.id ? Number(req.query.id) : null;

  // Foto de la factura: GET /api/expenses?receipt=<id>.
  // Solo el admin o el chofer dueño del gasto pueden verla.
  // Las listas no traen la foto (solo has_receipt) para no pesar.
  if (req.method === 'GET' && req.query && req.query.receipt) {
    const receiptId = Number(req.query.receipt);
    if (!receiptId) {
      res.status(400).json({ error: 'Falta id' });
      return;
    }
    const found = await pool.query('SELECT driver_id, company_id, receipt_image FROM expenses WHERE id = $1', [receiptId]);
    const row = found.rows[0];
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
    return;
  }

  if (req.method === 'GET') {
    // Filtros: día (expense_date), auto (taxi de la jornada de ese día)
    // y chofer (solo admin; el chofer siempre ve solo sus gastos).
    const conditions = ['e.company_id = $1'];
    const params = [user.company_id];
    if (user.role === 'driver') {
      params.push(user.id);
      conditions.push('e.driver_id = $' + params.length);
    } else if (req.query && req.query.driver_id) {
      params.push(Number(req.query.driver_id));
      conditions.push('e.driver_id = $' + params.length);
    }
    if (req.query && req.query.date) {
      params.push(String(req.query.date));
      conditions.push('e.expense_date = $' + params.length);
    }
    let join = '';
    if (req.query && req.query.taxi_id) {
      join = ' LEFT JOIN day_shifts s ON s.driver_id = e.driver_id AND s.shift_date = e.expense_date AND s.company_id = e.company_id';
      params.push(Number(req.query.taxi_id));
      conditions.push('s.taxi_id = $' + params.length);
    }
    const result = await pool.query(
      'SELECT e.*, u.name AS driver_name FROM expenses e JOIN users u ON u.id = e.driver_id' + join +
      ' WHERE ' + conditions.join(' AND ') + ' ORDER BY e.expense_date DESC, e.id DESC',
      params
    );
    res.status(200).json(result.rows.map(publicExpense));
    return;
  }

  const body = readBody(req);

  if (req.method === 'POST') {
    const driverId = user.role === 'admin' && body.driver_id ? Number(body.driver_id) : user.id;
    const amount = toNumber(body.amount, NaN);
    if (!body.expense_date || TYPES.indexOf(body.type) === -1 || !Number.isFinite(amount) || amount < 0) {
      res.status(400).json({ error: 'Datos del gasto inválidos (fecha, tipo y monto)' });
      return;
    }
    const driver = await pool.query("SELECT id, company_id FROM users WHERE id = $1 AND role = 'driver'", [driverId]);
    if (!driver.rows[0] || driver.rows[0].company_id !== user.company_id) {
      res.status(400).json({ error: 'Chofer inválido' });
      return;
    }
    // La foto llega ya comprimida desde el celular (JPEG, lado máximo 1200px).
    // Se guarda como data URL en texto; el tope protege la base gratuita.
    const receiptImage = typeof body.receipt_image === 'string' ? body.receipt_image : '';
    if (receiptImage && (!receiptImage.startsWith('data:image/jpeg;base64,') || receiptImage.length > 700000)) {
      res.status(400).json({ error: 'La foto de la factura es demasiado grande' });
      return;
    }
    const result = await pool.query(
      'INSERT INTO expenses (company_id, driver_id, expense_date, type, amount, note, receipt_image) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
      [driver.rows[0].company_id, driverId, body.expense_date, body.type, amount, String(body.note || ''), receiptImage || null]
    );
    res.status(201).json(publicExpense(result.rows[0]));
    return;
  }

  if (req.method === 'DELETE') {
    if (!id) {
      res.status(400).json({ error: 'Falta id' });
      return;
    }
    const current = await pool.query('SELECT * FROM expenses WHERE id = $1', [id]);
    if (!current.rows[0]) {
      res.status(404).json({ error: 'Gasto no encontrado' });
      return;
    }
    if (current.rows[0].company_id !== user.company_id) {
      res.status(403).json({ error: 'Sin permiso' });
      return;
    }
    if (user.role === 'driver' && current.rows[0].driver_id !== user.id) {
      res.status(403).json({ error: 'Sin permiso' });
      return;
    }
    await pool.query('DELETE FROM expenses WHERE id = $1', [id]);
    res.status(200).json({ ok: true });
    return;
  }

  return methodNotAllowed(res);
};
