// GET /api/day-close — cierre del día.
// Parámetro: ?date=AAAA-MM-DD (si no viene, usa la fecha actual del servidor).
// Por chofer y por día: total recaudado, cuánto se queda el chofer,
// cuánto le tiene que dar al dueño y gastos del día.
// Los gastos se descuentan de la parte del dueño, no de la del chofer:
// a_entregar = total - se_queda_el_chofer - gastos.
// El chofer ve solo su propio cierre; el admin ve el de todos.

const { getPool, requireAuth, round2, methodNotAllowed } = require('./_db');

module.exports = async function handler(req, res) {
  const user = await requireAuth(req, res, ['admin', 'driver']);
  if (!user) return;
  if (req.method !== 'GET') return methodNotAllowed(res);
  const pool = getPool();

  let date = req.query && req.query.date ? String(req.query.date) : null;
  if (!date) {
    const today = await pool.query('SELECT CURRENT_DATE AS d');
    date = today.rows[0].d;
    if (date instanceof Date) date = date.toISOString().slice(0, 10);
  }

  let drivers;
  if (user.role === 'admin') {
    const result = await pool.query("SELECT id, name FROM users WHERE role = 'driver' AND active = TRUE ORDER BY name");
    drivers = result.rows;
  } else {
    drivers = [{ id: user.id, name: user.name }];
  }

  const closes = [];
  for (const driver of drivers) {
    const trips = await pool.query(
      'SELECT COALESCE(SUM(amount), 0) AS total, COALESCE(SUM(amount * pct_snapshot / 100), 0) AS keeps, COUNT(*) AS trips FROM trips WHERE driver_id = $1 AND trip_date = $2',
      [driver.id, date]
    );
    const expenses = await pool.query(
      'SELECT COALESCE(SUM(amount), 0) AS total FROM expenses WHERE driver_id = $1 AND expense_date = $2',
      [driver.id, date]
    );
    const total = round2(trips.rows[0].total);
    const keeps = round2(trips.rows[0].keeps);
    const expenseTotal = round2(expenses.rows[0].total);
    closes.push({
      driver_id: driver.id,
      driver_name: driver.name,
      date: date,
      trips_count: Number(trips.rows[0].trips),
      total_collected: total,
      driver_keeps: keeps,
      expenses: expenseTotal,
      owner_share_gross: round2(total - keeps),
      handover_to_owner: round2(total - keeps - expenseTotal),
    });
  }

  res.status(200).json(closes);
};
