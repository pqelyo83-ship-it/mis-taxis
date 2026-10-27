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
    const result = await pool.query("SELECT id, name FROM users WHERE role = 'driver' AND active = TRUE AND company_id = $1 ORDER BY name", [user.company_id]);
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
    const shift = await pool.query(
      `SELECT s.*, t.identifier AS taxi_identifier FROM day_shifts s
       LEFT JOIN taxis t ON t.id = s.taxi_id
       WHERE s.driver_id = $1 AND s.shift_date = $2`,
      [driver.id, date]
    );
    const total = round2(trips.rows[0].total);
    const keeps = round2(trips.rows[0].keeps);
    const expenseTotal = round2(expenses.rows[0].total);
    const sh = shift.rows[0] || null;
    const kmDriven = sh && sh.entry_km !== null && sh.exit_km !== null
      ? round2(Number(sh.exit_km) - Number(sh.entry_km))
      : null;
    // Alerta de km (solo para el admin): si el taxi abrió el día con más de
    // 3 km por encima de su último cierre, el dueño lo ve en Cierres. Se
    // calcula al leer (sin columna nueva): el cierre anterior es el último
    // cierre de ese taxi antes de esta jornada (por fecha y luego por id).
    let kmAlert = false;
    let kmOver = null;
    let prevExitKm = null;
    if (user.role === 'admin' && sh && sh.taxi_id && sh.entry_km !== null) {
      const prev = await pool.query(
        `SELECT exit_km FROM day_shifts
         WHERE company_id = $1 AND taxi_id = $2 AND exit_km IS NOT NULL AND id <> $3
           AND (shift_date < $4 OR (shift_date = $4 AND id < $3))
         ORDER BY shift_date DESC, id DESC LIMIT 1`,
        [sh.company_id, sh.taxi_id, sh.id, date]
      );
      if (prev.rows[0]) {
        prevExitKm = Number(prev.rows[0].exit_km);
        kmOver = round2(Number(sh.entry_km) - prevExitKm);
        kmAlert = kmOver > 3;
      }
    }
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
      shift_taxi: sh ? sh.taxi_identifier : null,
      shift_entry_time: sh ? sh.entry_time : null,
      shift_entry_km: sh ? sh.entry_km : null,
      shift_exit_time: sh ? sh.exit_time : null,
      shift_exit_km: sh ? sh.exit_km : null,
      km_driven: kmDriven,
      km_alert: kmAlert,
      km_over: kmAlert ? kmOver : null,
      prev_exit_km: prevExitKm,
    });
  }

  res.status(200).json(closes);
};
