// /api/shifts — turnos (jornadas) por chofer.
// Un turno es una sesión de trabajo: empieza un día y puede cerrar al
// otro (turno de noche). Por eso la fecha de inicio vive en shift_date
// y la fecha de cierre en exit_date (migración v11): un turno que
// empieza el 6/11 a las 22:00 y cierra el 7/11 a las 04:00 es UN solo
// turno, no dos días. Los viajes y gastos se atan al turno abierto
// (trips.shift_id / expenses.shift_id), no a la fecha del calendario.
// Un chofer puede tener varios turnos empezando el mismo día (por
// ejemplo, cierra la noche a la mañana y vuelve a salir a la tarde),
// pero NUNCA dos turnos abiertos a la vez (índice parcial v11 +
// chequeo acá). GET: chofer ve sus turnos; admin ve todos
// (?driver_id=, ?date=). POST: crea un turno nuevo o edita uno
// existente (?id en el body). El chofer solo maneja sus propios turnos;
// el admin puede cargar el de cualquier chofer.
// Visibilidad del chofer en lecturas: solo los últimos 30 días (hoy y 29
// días para atrás, en fecha del servidor), igual que en trips.js. Una
// fecha más vieja no devuelve nada; sin fecha, la lista queda acotada a
// la ventana. El admin no tiene límite. Solo limita lo que se ve: no
// toca la creación ni la edición de turnos.

const { getPool, requireAuth, readBody, toNumber, round2, methodNotAllowed } = require('./_db');

function dateStr(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

// Primer día visible para el chofer: hoy menos 29 días (ventana de 30
// días corridos, en fecha del servidor en UTC). El admin no tiene límite.
function driverWindowStart() {
  return new Date(Date.now() - 29 * 24 * 3600 * 1000).toISOString().slice(0, 10);
}

function withKm(row) {
  const km = row.entry_km !== null && row.exit_km !== null
    ? round2(Number(row.exit_km) - Number(row.entry_km))
    : null;
  return {
    id: row.id,
    driver_id: row.driver_id,
    driver_name: row.driver_name || null,
    shift_date: dateStr(row.shift_date),
    exit_date: row.exit_date ? dateStr(row.exit_date) : null,
    taxi_id: row.taxi_id,
    taxi_identifier: row.taxi_identifier || null,
    entry_time: row.entry_time,
    entry_km: row.entry_km,
    exit_time: row.exit_time,
    exit_km: row.exit_km,
    entry_lat: row.entry_lat,
    entry_lng: row.entry_lng,
    exit_lat: row.exit_lat,
    exit_lng: row.exit_lng,
    note: row.note || null,
    settlement: row.settlement || 'pendiente',
    settled_at: row.settled_at || null,
    km_driven: km,
    auto_closed: row.auto_closed === true,
    created_at: row.created_at,
  };
}

function validLat(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= -90 && n <= 90 ? n : null;
}

function validLng(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= -180 && n <= 180 ? n : null;
}

function geoPair(latV, lngV) {
  if (latV === undefined && lngV === undefined) return null;
  const lat = validLat(latV);
  const lng = validLng(lngV);
  return lat !== null && lng !== null ? { lat, lng } : null;
}

function isDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
}

const SELECT_SQL = `
  SELECT s.*, u.name AS driver_name, t.identifier AS taxi_identifier
  FROM day_shifts s
  JOIN users u ON u.id = s.driver_id
  LEFT JOIN taxis t ON t.id = s.taxi_id
`;

module.exports = async function handler(req, res) {
  const user = await requireAuth(req, res, ['admin', 'driver']);
  if (!user) return;
  const pool = getPool();

  if (req.method === 'GET') {
    // Turno abierto del chofer (?open_only=1, opcional ?driver_id= para
    // el admin). Es el turno al que se atan los viajes y gastos nuevos:
    // puede haber empezado ayer (turno de noche) y seguir abierto hoy.
    // Devuelve el turno o null. La ventana de 30 días del chofer no se
    // aplica acá: un turno abierto de ayer tiene que aparecer hoy.
    if (req.query && req.query.open_only === '1') {
      const openDriverId = user.role === 'admin' && req.query.driver_id
        ? Number(req.query.driver_id) : user.id;
      const open = await pool.query(
        SELECT_SQL + ' WHERE s.company_id = $1 AND s.driver_id = $2 AND s.exit_km IS NULL ORDER BY s.shift_date DESC, s.id DESC LIMIT 1',
        [user.company_id, openDriverId]
      );
      res.status(200).json(open.rows[0] ? withKm(open.rows[0]) : null);
      return;
    }
    // Turnos abiertos de un taxi (?open_taxi=<id>). Lo usa el aviso de
    // "Empezar día": si otro chofer ya tiene abierta la jornada de ese
    // taxi, el que empieza ve su nombre y confirma. Sin filtro de fecha:
    // un turno de noche abierto ayer sigue ocupando el taxi hoy de
    // madrugada. Devuelve solo lo mínimo (chofer, taxi y fecha de
    // inicio); el chofer no ve jornadas de otros salvo este aviso
    // puntual. Abierta = sin km de cierre. El parámetro ?date= se acepta
    // por compatibilidad pero ya no filtra (el turno abierto no tiene
    // fecha de cierre y el de ayer sigue vigente).
    if (req.query && req.query.open_taxi) {
      const taxiId = Number(req.query.open_taxi);
      if (!taxiId) {
        res.status(400).json({ error: 'Falta el taxi' });
        return;
      }
      const params = [user.company_id, taxiId];
      let openSql = `SELECT s.driver_id, u.name AS driver_name, s.taxi_id, t.identifier AS taxi_identifier, s.shift_date
        FROM day_shifts s JOIN users u ON u.id = s.driver_id
        LEFT JOIN taxis t ON t.id = s.taxi_id
        WHERE s.company_id = $1 AND s.taxi_id = $2 AND s.exit_km IS NULL`;
      if (user.role === 'driver') {
        params.push(user.id);
        openSql += ' AND s.driver_id <> $' + params.length;
      }
      openSql += ' ORDER BY s.shift_date DESC, s.id DESC';
      const open = await pool.query(openSql, params);
      res.status(200).json(open.rows.map(function (r) {
        return { driver_id: r.driver_id, driver_name: r.driver_name, taxi_id: r.taxi_id, taxi_identifier: r.taxi_identifier, shift_date: dateStr(r.shift_date) };
      }));
      return;
    }
    // Turnos cerrados automáticamente por relevo (?auto_closed=1, solo
    // admin). Lo usa el Resumen para avisarle al dueño que hay cierres
    // automáticos con diferencia de km para revisar. Sin la migración
    // v12 no hay ninguno: devuelve lista vacía.
    if (req.query && req.query.auto_closed === '1') {
      if (user.role !== 'admin') {
        res.status(403).json({ error: 'Sin permiso' });
        return;
      }
      let autoRows = [];
      try {
        const found = await pool.query(
          SELECT_SQL + ' WHERE s.company_id = $1 AND s.auto_closed = TRUE ORDER BY s.shift_date DESC, s.id DESC LIMIT 20',
          [user.company_id]
        );
        autoRows = found.rows;
      } catch (e) {
        if (e && e.code === '42703') autoRows = [];
        else throw e;
      }
      res.status(200).json(autoRows.map(withKm));
      return;
    }
    // Último cierre de un taxi (?last_closed_taxi=<id>). Lo usa el
    // relevo al empezar el día: si otro chofer ya cerró en ese taxi, el
    // que empieza precarga hora y km de entrada con ese cierre y ve
    // "Relevo de [nombre]". Sin filtro de fecha: el cierre del compañero
    // de anoche quedó guardado con la fecha de ayer y de madrugada sigue
    // siendo el último estado del taxi. Devuelve SOLO nombre, hora y km
    // de cierre (más la fecha de inicio del turno, para mostrar "ayer"):
    // nunca montos, viajes, gastos ni datos de otros días. Cerrada = con
    // hora y km de cierre (sin ellos no hay nada que precargar).
    // "Última" = mayor fecha de inicio del turno, luego mayor hora de
    // cierre (desempate por id mayor). Para el chofer se excluye su
    // propio turno: si el último cierre es suyo, no hay relevo y
    // devuelve null. El parámetro ?date= se acepta por compatibilidad
    // pero ya no filtra.
    if (req.query && req.query.last_closed_taxi) {
      const taxiId = Number(req.query.last_closed_taxi);
      if (!taxiId) {
        res.status(400).json({ error: 'Falta el taxi' });
        return;
      }
      const params = [user.company_id, taxiId];
      // Sin la migración v11 (exit_date) se usa la versión vieja: mismo
      // último cierre, sin fecha de cierre. El relevo igual precarga.
      async function runLastClosed(withExitDate) {
        let lastSql = 'SELECT u.name AS driver_name, s.exit_time, s.exit_km, s.shift_date' +
          (withExitDate ? ', s.exit_date' : '') +
          ` FROM day_shifts s JOIN users u ON u.id = s.driver_id
        WHERE s.company_id = $1 AND s.taxi_id = $2 AND s.exit_km IS NOT NULL AND s.exit_time IS NOT NULL`;
        const p = params.slice();
        if (user.role === 'driver') {
          p.push(user.id);
          lastSql += ' AND s.driver_id <> $' + p.length;
        }
        lastSql += withExitDate
          ? ' ORDER BY s.shift_date DESC, s.exit_date DESC NULLS LAST, s.exit_time DESC, s.id DESC LIMIT 1'
          : ' ORDER BY s.shift_date DESC, s.exit_time DESC, s.id DESC LIMIT 1';
        return pool.query(lastSql, p);
      }
      let last;
      try {
        last = await runLastClosed(true);
      } catch (e) {
        if (e && e.code === '42703') last = await runLastClosed(false);
        else throw e;
      }
      if (!last.rows[0]) {
        res.status(200).json(null);
        return;
      }
      res.status(200).json({
        driver_name: last.rows[0].driver_name,
        exit_time: last.rows[0].exit_time,
        exit_km: last.rows[0].exit_km,
        shift_date: dateStr(last.rows[0].shift_date),
        exit_date: last.rows[0].exit_date ? dateStr(last.rows[0].exit_date) : null,
      });
      return;
    }
    const conditions = [];
    const params = [];
    // Aislamiento por empresa: siempre.
    params.push(user.company_id);
    conditions.push('s.company_id = $' + params.length);
    if (user.role === 'driver') {
      params.push(user.id);
      conditions.push('s.driver_id = $' + params.length);
    } else if (req.query && req.query.driver_id) {
      params.push(Number(req.query.driver_id));
      conditions.push('s.driver_id = $' + params.length);
    }
    if (req.query && req.query.date) {
      params.push(String(req.query.date));
      conditions.push('s.shift_date = $' + params.length);
    }
    // Límite de visibilidad del chofer (ver encabezado): una fecha más
    // vieja que 30 días no devuelve nada; sin fecha, la lista queda
    // acotada a la ventana.
    if (user.role === 'driver') {
      if (req.query && req.query.date && String(req.query.date) < driverWindowStart()) {
        res.status(200).json([]);
        return;
      }
      params.push(driverWindowStart());
      conditions.push('s.shift_date >= $' + params.length);
    }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const result = await pool.query(SELECT_SQL + ' ' + where + ' ORDER BY s.shift_date DESC, s.id DESC', params);
    res.status(200).json(result.rows.map(withKm));
    return;
  }

  if (req.method !== 'POST') return methodNotAllowed(res);
  const body = readBody(req);
  // Marcar liquidación (solo el dueño): POST /api/shifts con
  // { action: 'settle', shift_id, settlement }. La marca vive en la
  // jornada (day_shifts.settlement), por eso va en este archivo y no
  // en uno nuevo (límite de 12 funciones). "Recibido" es solo
  // confirmación; "pagado" significa que el dueño ya pagó esa deuda en
  // mano, así que ese turno no genera saldo a favor en day-close/report
  // (los turnos siguientes se calculan sin ese descuento). Volver a
  // "pendiente" desmarca (por ejemplo, si se marcó por error) y el
  // saldo vuelve a calcularse. Guardar un turno nunca toca la marca. Si
  // la migración v9 todavía no se aplicó, se avisa en vez de fallar con
  // un error críptico. Por compatibilidad se acepta también
  // { driver_id, shift_date } (sin shift_id), pero SOLO si ese día hay
  // un único turno cerrado de ese chofer: con dos turnos el mismo día la
  // fecha no alcanza para saber cuál marcar.
  if (body.action === 'settle') {
    if (user.role !== 'admin') {
      res.status(403).json({ error: 'Sin permiso' });
      return;
    }
    const settlement = String(body.settlement || '');
    if (['pendiente', 'recibido', 'pagado'].indexOf(settlement) === -1) {
      res.status(400).json({ error: 'Estado de liquidación inválido' });
      return;
    }
    let settleShift = null;
    if (body.shift_id) {
      const found = await pool.query(
        'SELECT id, exit_km FROM day_shifts WHERE id = $1 AND company_id = $2',
        [Number(body.shift_id), user.company_id]
      );
      settleShift = found.rows[0] || null;
      if (!settleShift) {
        res.status(400).json({ error: 'Turno no encontrado' });
        return;
      }
    } else {
      const settleDriverId = Number(body.driver_id);
      const settleDate = String(body.shift_date || '');
      if (!settleDriverId || !isDate(settleDate)) {
        res.status(400).json({ error: 'Faltan chofer y fecha' });
        return;
      }
      const settleDriver = await pool.query("SELECT id, company_id FROM users WHERE id = $1 AND role = 'driver'", [settleDriverId]);
      if (!settleDriver.rows[0] || settleDriver.rows[0].company_id !== user.company_id) {
        res.status(400).json({ error: 'Chofer inválido' });
        return;
      }
      const matches = await pool.query(
        'SELECT id, exit_km FROM day_shifts WHERE driver_id = $1 AND shift_date = $2 AND company_id = $3 AND exit_km IS NOT NULL ORDER BY id',
        [settleDriverId, settleDate, user.company_id]
      );
      if (!matches.rows.length) {
        res.status(400).json({ error: 'No hay jornada cargada para ese día' });
        return;
      }
      if (matches.rows.length > 1) {
        res.status(400).json({ error: 'Ese día tiene más de un turno: marcá la liquidación desde el cierre del turno' });
        return;
      }
      settleShift = matches.rows[0];
    }
    if (settleShift.exit_km === null || settleShift.exit_km === undefined) {
      res.status(400).json({ error: 'El turno todavía está abierto' });
      return;
    }
    try {
      await pool.query(
        "UPDATE day_shifts SET settlement = $1, settled_at = CASE WHEN $1 = 'pendiente' THEN NULL ELSE NOW() END WHERE id = $2",
        [settlement, settleShift.id]
      );
    } catch (e) {
      if (e && e.code === '42703') {
        res.status(400).json({ error: 'La liquidación todavía no está disponible: falta aplicar la migración v9' });
        return;
      }
      throw e;
    }
    const full = await pool.query(SELECT_SQL + ' WHERE s.id = $1', [settleShift.id]);
    res.status(200).json(withKm(full.rows[0]));
    return;
  }
  const driverId = user.role === 'admin' && body.driver_id ? Number(body.driver_id) : user.id;
  const driver = await pool.query("SELECT id, company_id FROM users WHERE id = $1 AND role = 'driver'", [driverId]);
  if (!driver.rows[0] || driver.rows[0].company_id !== user.company_id) {
    res.status(400).json({ error: 'Chofer inválido' });
    return;
  }
  const entryKm = toNumber(body.entry_km, NaN);
  const exitKm = body.exit_km === undefined || body.exit_km === '' || body.exit_km === null
    ? null
    : toNumber(body.exit_km, NaN);
  const exitTime = body.exit_time ? String(body.exit_time) : null;
  if (!body.shift_date || !isDate(body.shift_date) || !body.entry_time || !Number.isFinite(entryKm) || entryKm < 0 ||
      (exitKm !== null && (!Number.isFinite(exitKm) || exitKm < 0 || exitKm < entryKm))) {
    res.status(400).json({ error: 'Datos de la jornada inválidos (revisá fecha, hora y kilometraje)' });
    return;
  }
  // Fecha de cierre (solo cuando se cierra el turno): no puede ser
  // anterior a la fecha de inicio. Si no viene y se está cerrando, se
  // usa la fecha actual del servidor. Si el turno se reabre (sin km de
  // cierre), la fecha de cierre se borra.
  let exitDate = null;
  if (exitKm !== null) {
    if (body.exit_date && isDate(body.exit_date)) exitDate = body.exit_date;
    else {
      const todayRow = await pool.query('SELECT CURRENT_DATE AS d');
      exitDate = dateStr(todayRow.rows[0].d);
    }
    if (exitDate < body.shift_date) {
      res.status(400).json({ error: 'La fecha de cierre no puede ser anterior a la fecha de inicio' });
      return;
    }
  }
  const taxiId = body.taxi_id ? Number(body.taxi_id) : null;
  // El taxi es obligatorio al abrir el día: sin taxi no hay jornada.
  // Además debe ser un taxi de la empresa del chofer.
  if (!taxiId) {
    res.status(400).json({ error: 'Elegí el taxi del día' });
    return;
  }
  const taxi = await pool.query('SELECT id FROM taxis WHERE id = $1 AND company_id = $2', [taxiId, driver.rows[0].company_id]);
  if (!taxi.rows[0]) {
    res.status(400).json({ error: 'Taxi inválido' });
    return;
  }
  // Ubicación opcional (el teléfono la comparte solo con permiso).
  const entryGeo = geoPair(body.entry_lat, body.entry_lng);
  const exitGeo = geoPair(body.exit_lat, body.exit_lng);
  // Aclaraciones del día (opcional): solo se tocan si vienen en el body.
  // Si no vienen (por ejemplo, el formulario del admin), se conserva la
  // anterior; si vienen vacías, se borran. Tope de 1000 caracteres.
  const noteProvided = typeof body.note === 'string';
  const noteValue = noteProvided ? body.note.trim().slice(0, 1000) : null;

  // Editar un turno existente (body.id): el chofer solo edita los
  // suyos; el admin cualquiera de su empresa. Reabrir (quitar el km de
  // cierre) solo se permite si el chofer no tiene OTRO turno abierto.
  const editId = body.id ? Number(body.id) : null;
  if (editId) {
    const current = await pool.query('SELECT * FROM day_shifts WHERE id = $1 AND company_id = $2', [editId, user.company_id]);
    if (!current.rows[0]) {
      res.status(400).json({ error: 'Turno no encontrado' });
      return;
    }
    if (user.role === 'driver' && current.rows[0].driver_id !== user.id) {
      res.status(403).json({ error: 'Sin permiso' });
      return;
    }
    if (exitKm === null && current.rows[0].exit_km !== null) {
      const otherOpen = await pool.query(
        'SELECT id FROM day_shifts WHERE driver_id = $1 AND exit_km IS NULL AND id <> $2 LIMIT 1',
        [driverId, editId]
      );
      if (otherOpen.rows[0]) {
        res.status(400).json({ error: 'Ya tenés otro turno abierto: cerralo antes de reabrir este' });
        return;
      }
    }
    // Actualizar un turno existente (cerrar, corregir o reabrir): si la
    // migración v11 (exit_date) o v8 (note) todavía no se aplicó, se
    // guarda el turno igual sin esos campos en vez de trabar el cierre
    // del día (mismo patrón que insertShift abajo).
    async function updateShift(withNote, withExitDate) {
      // Parámetros en orden, cada valor referenciado una sola vez (el
      // armado anterior repetía $7 en las cuatro coordenadas y dejaba
      // $8-$10 sin referenciar: el cierre daba 500 aunque el SQL en
      // texto plano andaba bien en Neon).
      const sets = [];
      const vals = [];
      const set = (col, value) => { vals.push(value); sets.push(col + ' = $' + vals.length); };
      const setKeep = (col, value) => { vals.push(value); sets.push(col + ' = COALESCE($' + vals.length + ', ' + col + ')'); };
      set('taxi_id', taxiId);
      set('entry_time', body.entry_time);
      set('entry_km', entryKm);
      set('exit_time', exitTime);
      set('exit_km', exitKm);
      if (withExitDate) set('exit_date', exitDate);
      setKeep('entry_lat', entryGeo ? entryGeo.lat : null);
      setKeep('entry_lng', entryGeo ? entryGeo.lng : null);
      setKeep('exit_lat', exitGeo ? exitGeo.lat : null);
      setKeep('exit_lng', exitGeo ? exitGeo.lng : null);
      if (withNote) set('note', noteValue);
      vals.push(editId);
      return pool.query(
        'UPDATE day_shifts SET ' + sets.join(', ') + ' WHERE id = $' + vals.length + ' RETURNING *',
        vals
      );
    }
    let upd;
    try {
      upd = await updateShift(noteProvided, true);
    } catch (e) {
      if (e && e.code === '42703') {
        try { upd = await updateShift(noteProvided, false); }
        catch (e2) {
          if (e2 && e2.code === '42703') upd = await updateShift(false, false);
          else throw e2;
        }
      } else throw e;
    }
    const full = await pool.query(SELECT_SQL + ' WHERE s.id = $1', [upd.rows[0].id]);
    res.status(200).json(withKm(full.rows[0]));
    return;
  }

  // Crear un turno nuevo: el chofer no puede tener otro turno abierto
  // (ni siquiera de ayer: un turno de noche abierto sigue vigente).
  // El índice parcial v11 lo respalda en la base; acá se da el mensaje
  // claro antes de intentar el insert.
  const alreadyOpen = await pool.query(
    'SELECT id, shift_date FROM day_shifts WHERE driver_id = $1 AND exit_km IS NULL LIMIT 1',
    [driverId]
  );
  if (alreadyOpen.rows[0]) {
    res.status(400).json({ error: 'Ya tenés un turno abierto del ' + dateStr(alreadyOpen.rows[0].shift_date) + ': cerralo antes de empezar otro' });
    return;
  }
  // Km de entrada y último cierre del taxi (regla del dueño, Nov 2026):
  // el km es del auto, no del chofer, y el cierre de un turno NO siempre
  // es la apertura del siguiente: el dueño puede usar el auto para uso
  // personal o moverlo entre turnos. Por eso NUNCA se bloquea la apertura
  // por km: si el chofer entra varios km por encima del último cierre,
  // se abre igual y la diferencia queda marcada para el dueño en Cierres
  // y en Resumen (alerta de km, mismo umbral de 3 km). Si el km es un
  // error de tipeo, el dueño lo corrige en Cierres.
  const lastClose = await pool.query(
    'SELECT exit_km, shift_date FROM day_shifts WHERE company_id = $1 AND taxi_id = $2 AND exit_km IS NOT NULL ORDER BY shift_date DESC, id DESC LIMIT 1',
    [driver.rows[0].company_id, taxiId]
  );
  const prevKm = lastClose.rows[0] ? Number(lastClose.rows[0].exit_km) : null;
  // Cierre automático por relevo (v12, pedido del dueño Nov 2026): el
  // kilometraje es del auto, no del chofer. Si otro chofer tiene un turno
  // abierto en este taxi, abrir lo cierra con el km/hora/fecha con los
  // que arranca el turno nuevo (el auto siguió andando con el compañero
  // y el km de entrada de hoy ES el km de cierre del turno anterior).
  // La diferencia queda marcada (auto_closed) y el dueño la ve en
  // Cierres y en Resumen. Con turno abierto ajeno NO se aplica el
  // bloqueo de +3 km: el compañero anduvo desde el último cierre, así
  // que entrar por encima es lo esperado; si el km no cierra, el dueño
  // lo ve y lo corrige en Cierres. Solo se cierran turnos abiertos
  // empezados hasta la fecha del turno nuevo.
  const openOthers = await pool.query(
    'SELECT s.id, s.driver_id, s.shift_date, s.entry_km, u.name AS driver_name FROM day_shifts s JOIN users u ON u.id = s.driver_id WHERE s.company_id = $1 AND s.taxi_id = $2 AND s.exit_km IS NULL AND s.driver_id <> $3 AND s.shift_date <= $4 ORDER BY s.shift_date, s.id',
    [driver.rows[0].company_id, taxiId, driverId, body.shift_date]
  );
  const others = openOthers.rows;
  // (v13, Nov 2026: sin bloqueo de km al abrir — ver comentario de arriba.
  // La diferencia con el último cierre se avisa al dueño en Cierres/Resumen.)
  async function insertShift(q, withNote, withExitDate) {
    const cols = ['company_id', 'driver_id', 'shift_date', 'taxi_id', 'entry_time', 'entry_km', 'exit_time', 'exit_km',
      'entry_lat', 'entry_lng', 'exit_lat', 'exit_lng'];
    const vals = [driver.rows[0].company_id, driverId, body.shift_date, taxiId, body.entry_time, entryKm, exitTime, exitKm,
      entryGeo ? entryGeo.lat : null, entryGeo ? entryGeo.lng : null,
      exitGeo ? exitGeo.lat : null, exitGeo ? exitGeo.lng : null];
    if (withExitDate) { cols.push('exit_date'); vals.push(exitDate); }
    if (withNote) { cols.push('note'); vals.push(noteValue); }
    const placeholders = vals.map(function (_, i) { return '$' + (i + 1); }).join(', ');
    return q.query(
      'INSERT INTO day_shifts (' + cols.join(', ') + ') VALUES (' + placeholders + ') RETURNING *',
      vals
    );
  }
  // Si las migraciones v8 (note) o v11 (exit_date) todavía no se
  // aplicaron, se guarda el turno igual (sin esos campos) en vez de
  // trabar el inicio o el cierre del día.
  async function insertShiftTx(q) {
    const combos = [[true, true], [true, false], [false, false]];
    let lastErr = null;
    for (const combo of combos) {
      try { return await insertShift(q, combo[0], combo[1]); }
      catch (e) {
        if (e && e.code === '42703') { lastErr = e; continue; }
        throw e;
      }
    }
    throw lastErr;
  }
  let saved;
  let autoClosedInfo = [];
  if (!others.length) {
    try {
      saved = await insertShiftTx(pool);
    } catch (e) {
      if (e && e.code === '23505') {
        res.status(400).json({ error: 'Ya tenés un turno abierto: cerralo antes de empezar otro' });
        return;
      }
      throw e;
    }
  } else {
    // Con relevo, el cierre del turno anterior y la creación del nuevo
    // van en una sola transacción: si no se puede crear el turno, el
    // anterior no se toca.
    let hasAutoClosed = false;
    try {
      const col = await pool.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'day_shifts' AND column_name = 'auto_closed'");
      hasAutoClosed = col.rows.length > 0;
    } catch (e) { hasAutoClosed = false; }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const o of others) {
        await client.query(
          hasAutoClosed
            ? 'UPDATE day_shifts SET exit_km = $1, exit_date = $2, exit_time = $3, auto_closed = TRUE WHERE id = $4'
            : 'UPDATE day_shifts SET exit_km = $1, exit_date = $2, exit_time = $3 WHERE id = $4',
          [entryKm, body.shift_date, body.entry_time, o.id]
        );
        autoClosedInfo.push({
          driver_name: o.driver_name,
          shift_date: dateStr(o.shift_date),
          entry_km: Number(o.entry_km),
          exit_km: entryKm,
          km_driven: round2(entryKm - Number(o.entry_km)),
          km_diff_vs_last_close: prevKm !== null ? round2(entryKm - prevKm) : null,
        });
      }
      saved = await insertShiftTx(client);
      await client.query('COMMIT');
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (e2) { /* ya está cerrado */ }
      if (e && e.code === '23514') {
        res.status(400).json({ error: 'No se pudo cerrar el turno abierto de ' + others[0].driver_name + ' en este taxi con ' + entryKm + ' km (el km no cierra). Pedile al dueño que lo cierre en Cierres.' });
        return;
      }
      if (e && e.code === '23505') {
        res.status(400).json({ error: 'Ya tenés un turno abierto: cerralo antes de empezar otro' });
        return;
      }
      throw e;
    } finally {
      client.release();
    }
  }
  const full = await pool.query(SELECT_SQL + ' WHERE s.id = $1', [saved.rows[0].id]);
  const created = withKm(full.rows[0]);
  if (autoClosedInfo.length) created.auto_closed_shifts = autoClosedInfo;
  res.status(200).json(created);
};
