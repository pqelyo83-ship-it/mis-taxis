// /api/expenses — gastos del chofer (gasolina, arreglos, otros).
// Los gastos se descuentan de la parte del dueño, no de la del chofer.
// GET: admin ve todos; chofer ve solo los suyos.
// Visibilidad del chofer: solo los últimos 30 días (hoy y 29 días para
// atrás, en fecha del servidor), igual que en trips.js. Se aplica siempre
// a las lecturas del chofer, incluida la foto de la factura. El admin no
// tiene límite. Esto solo limita lo que se ve; no toca montos ni fechas.
// POST: chofer crea solo gastos propios; admin puede crear para cualquier chofer.
// DELETE: el dueño del gasto o el admin.

const { getPool, requireAuth, readBody, toNumber, methodNotAllowed } = require('./_db');

function dateStr(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

// Primer día visible para el chofer: hoy menos 29 días (ventana de 30
// días corridos, en fecha del servidor en UTC). El admin no tiene límite.
function driverWindowStart() {
  return new Date(Date.now() - 29 * 24 * 3600 * 1000).toISOString().slice(0, 10);
}

function publicExpense(row) {
  return {
    id: row.id,
    driver_id: row.driver_id,
    driver_name: row.driver_name || null,
    shift_id: row.shift_id || null,
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
    const found = await pool.query('SELECT driver_id, company_id, expense_date, receipt_image FROM expenses WHERE id = $1', [receiptId]);
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
    // La foto de un gasto más viejo que 30 días no se muestra al chofer
    // (la lista ya no la incluye; esto es el resguardo para llamadas
    // directas por id). El admin no tiene límite.
    if (user.role === 'driver' && dateStr(row.expense_date) < driverWindowStart()) {
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
    // Límite de visibilidad del chofer (ver encabezado): siempre se acota
    // a los últimos 30 días, venga el pedido como venga.
    if (user.role === 'driver') {
      params.push(driverWindowStart());
      conditions.push('e.expense_date >= $' + params.length);
    }
    if (req.query && req.query.date) {
      params.push(String(req.query.date));
      conditions.push('e.expense_date = $' + params.length);
    }
    if (req.query && req.query.from && req.query.to) {
      params.push(String(req.query.from));
      var fromIdx = params.length;
      params.push(String(req.query.to));
      conditions.push('e.expense_date BETWEEN $' + fromIdx + ' AND $' + params.length);
    }
    // Gastos de un turno (?shift_id=): el turno de noche incluye los
    // gastos de la madrugada, aunque su fecha sea el día siguiente.
    if (req.query && req.query.shift_id) {
      params.push(Number(req.query.shift_id));
      conditions.push('e.shift_id = $' + params.length);
    }
    let join = '';
    if (req.query && req.query.taxi_id) {
      // El auto del gasto es el del turno al que está atado; si el
      // gasto es viejo (sin turno), el de la jornada de su fecha.
      join = ' LEFT JOIN day_shifts s ON s.company_id = e.company_id AND s.driver_id = e.driver_id AND ((e.shift_id IS NOT NULL AND s.id = e.shift_id) OR (e.shift_id IS NULL AND s.shift_date = e.expense_date))';
      params.push(Number(req.query.taxi_id));
      conditions.push('s.taxi_id = $' + params.length);
    }
    var limitSql = '';
    if (req.query && req.query.limit === 'all') limitSql = '';
    else if (req.query && req.query.limit) limitSql = ' LIMIT ' + Math.min(Math.max(Number(req.query.limit) || 100, 1), 1000);
    else if (req.query && (req.query.from || req.query.to)) limitSql = '';
    else limitSql = ' LIMIT 100';
    const result = await pool.query(
      'SELECT e.*, u.name AS driver_name FROM expenses e JOIN users u ON u.id = e.driver_id' + join +
      ' WHERE ' + conditions.join(' AND ') + ' ORDER BY e.expense_date DESC, e.id DESC' + limitSql,
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
    // El gasto queda atado al turno abierto del chofer (si tiene uno):
    // así un gasto de nafta a las 02:00 cuenta en el cierre del turno
    // de noche que empezó el día anterior. El admin puede pasar
    // shift_id explícito; sin turno abierto el gasto queda sin atar y
    // el cierre lo cuenta por fecha, como antes.
    let expenseShiftId = null;
    if (user.role === 'driver') {
      const openShift = await pool.query(
        'SELECT id FROM day_shifts WHERE driver_id = $1 AND company_id = $2 AND exit_km IS NULL ORDER BY shift_date DESC, id DESC LIMIT 1',
        [driverId, driver.rows[0].company_id]
      );
      expenseShiftId = openShift.rows[0] ? openShift.rows[0].id : null;
    } else if (body.shift_id) {
      const given = await pool.query(
        'SELECT id FROM day_shifts WHERE id = $1 AND driver_id = $2 AND company_id = $3',
        [Number(body.shift_id), driverId, driver.rows[0].company_id]
      );
      expenseShiftId = given.rows[0] ? given.rows[0].id : null;
    }
    const result = await (async function insertExpense() {
      try {
        return await pool.query(
          'INSERT INTO expenses (company_id, driver_id, expense_date, type, amount, note, receipt_image, shift_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *',
          [driver.rows[0].company_id, driverId, body.expense_date, body.type, amount, String(body.note || ''), receiptImage || null, expenseShiftId]
        );
      } catch (e) {
        // Si la migración v11 todavía no se aplicó, el gasto se guarda
        // igual (sin turno atado) en vez de trabar la carga.
        if (e && e.code === '42703') {
          return await pool.query(
            'INSERT INTO expenses (company_id, driver_id, expense_date, type, amount, note, receipt_image) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
            [driver.rows[0].company_id, driverId, body.expense_date, body.type, amount, String(body.note || ''), receiptImage || null]
          );
        }
        throw e;
      }
    })();
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
