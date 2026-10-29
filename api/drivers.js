// /api/drivers — choferes. Solo admin.
// GET: lista de choferes (sin hashes de PIN).
// POST: crea chofer con PIN (se guarda solo el hash con sal).
// PUT: edita nombre, teléfono, taxi, % y, si viene un PIN nuevo, lo reemplaza.
// DELETE: desactiva al chofer (no borra su historial de viajes ni gastos).

const { getPool, requireAuth, readBody, hashPin, newSalt, methodNotAllowed } = require('./_db');

function publicDriver(row) {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    taxi_id: row.taxi_id,
    taxi_identifier: row.taxi_identifier || null,
    commission_pct: row.commission_pct,
    commission_day_pct: row.commission_day_pct !== null && row.commission_day_pct !== undefined ? row.commission_day_pct : row.commission_pct,
    commission_night_pct: row.commission_night_pct !== null && row.commission_night_pct !== undefined ? row.commission_night_pct : row.commission_pct,
    active: row.active,
    created_at: row.created_at,
  };
}

// Valoración del dueño: entero 1 a 5, o null para quitarla (sin valorar).
// Devuelve false si el valor es inválido (distinto de null y de 1..5).
function validRating(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 5 ? n : false;
}

// Chofer de la empresa del admin, o null. SELECT explícito (nunca u.*
// devuelto tal cual): solo se necesitan id y owner_rating, y nunca se
// exponen pin_hash/pin_salt. Un chofer de otra empresa da null, igual
// que uno inexistente, para no revelar cuál de los dos casos es.
async function ownedDriver(pool, driverId, companyId) {
  const result = await pool.query("SELECT id, owner_rating FROM users WHERE id = $1 AND role = 'driver' AND company_id = $2", [driverId, companyId]);
  return result.rows[0] || null;
}

function validPct(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
}

module.exports = async function handler(req, res) {
  const user = await requireAuth(req, res, ['admin']);
  if (!user) return;
  const pool = getPool();
  const id = req.query && req.query.id ? Number(req.query.id) : null;

  if (req.method === 'GET') {
    // Notas y valoración del dueño: GET /api/drivers?notes=<driver_id>.
    // Solo admin (ya lo exige requireAuth arriba) y solo un chofer de su
    // empresa. Devuelve { driver_id, owner_rating, notes } con las notas
    // más recientes primero. Esta es la ÚNICA respuesta que trae notas o
    // valoración; la lista general de abajo sigue usando publicDriver y
    // nunca las incluye.
    if (req.query && req.query.notes !== undefined) {
      const driverId = Number(req.query.notes);
      if (!driverId) {
        res.status(400).json({ error: 'Falta el chofer' });
        return;
      }
      const driver = await ownedDriver(pool, driverId, user.company_id);
      if (!driver) {
        res.status(403).json({ error: 'Chofer no encontrado o fuera de tu empresa' });
        return;
      }
      const notes = await pool.query(
        'SELECT id, driver_id, note, created_at FROM driver_notes WHERE company_id = $1 AND driver_id = $2 ORDER BY created_at DESC, id DESC',
        [user.company_id, driverId]
      );
      res.status(200).json({
        driver_id: driverId,
        owner_rating: driver.owner_rating !== null && driver.owner_rating !== undefined ? driver.owner_rating : null,
        notes: notes.rows,
      });
      return;
    }
    const result = await pool.query(
      `SELECT u.*, t.identifier AS taxi_identifier FROM users u
       LEFT JOIN taxis t ON t.id = u.taxi_id
       WHERE u.role = 'driver' AND u.company_id = $1 ORDER BY u.name`,
      [user.company_id]
    );
    res.status(200).json(result.rows.map(publicDriver));
    return;
  }

  const body = readBody(req);

  // Notas del dueño: POST /api/drivers?notes=<driver_id> { note }.
  if (req.method === 'POST' && req.query && req.query.notes !== undefined) {
    const driverId = Number(req.query.notes);
    if (!driverId) {
      res.status(400).json({ error: 'Falta el chofer' });
      return;
    }
    const driver = await ownedDriver(pool, driverId, user.company_id);
    if (!driver) {
      res.status(403).json({ error: 'Chofer no encontrado o fuera de tu empresa' });
      return;
    }
    const note = String(body.note || '').trim();
    if (!note) {
      res.status(400).json({ error: 'La nota no puede estar vacía' });
      return;
    }
    if (note.length > 2000) {
      res.status(400).json({ error: 'La nota es demasiado larga (máximo 2000 caracteres)' });
      return;
    }
    const created = await pool.query(
      'INSERT INTO driver_notes (company_id, driver_id, note) VALUES ($1, $2, $3) RETURNING id, driver_id, note, created_at',
      [user.company_id, driverId, note]
    );
    res.status(201).json(created.rows[0]);
    return;
  }

  // Valoración del dueño: PUT /api/drivers?rating=<driver_id> { owner_rating }.
  // owner_rating null (o vacío) quita la valoración; 1 a 5 la fija.
  if (req.method === 'PUT' && req.query && req.query.rating !== undefined) {
    const driverId = Number(req.query.rating);
    if (!driverId) {
      res.status(400).json({ error: 'Falta el chofer' });
      return;
    }
    const driver = await ownedDriver(pool, driverId, user.company_id);
    if (!driver) {
      res.status(403).json({ error: 'Chofer no encontrado o fuera de tu empresa' });
      return;
    }
    const rating = validRating(body.owner_rating);
    if (rating === false) {
      res.status(400).json({ error: 'La valoración debe ser un número entero de 1 a 5 (o vacía para quitarla)' });
      return;
    }
    const updated = await pool.query(
      "UPDATE users SET owner_rating = $1 WHERE id = $2 AND role = 'driver' AND company_id = $3 RETURNING id, owner_rating",
      [rating, driverId, user.company_id]
    );
    res.status(200).json({ driver_id: updated.rows[0].id, owner_rating: updated.rows[0].owner_rating });
    return;
  }

  // Borrar una nota del dueño: DELETE /api/drivers?notes=<driver_id>&note_id=<id>.
  // La nota debe pertenecer a ese chofer y a la empresa del admin.
  if (req.method === 'DELETE' && req.query && req.query.notes !== undefined) {
    const driverId = Number(req.query.notes);
    const noteId = Number(req.query.note_id);
    if (!driverId || !noteId) {
      res.status(400).json({ error: 'Faltan chofer y nota' });
      return;
    }
    const driver = await ownedDriver(pool, driverId, user.company_id);
    if (!driver) {
      res.status(403).json({ error: 'Chofer no encontrado o fuera de tu empresa' });
      return;
    }
    const deleted = await pool.query(
      'DELETE FROM driver_notes WHERE id = $1 AND driver_id = $2 AND company_id = $3 RETURNING id',
      [noteId, driverId, user.company_id]
    );
    if (!deleted.rows[0]) {
      res.status(403).json({ error: 'Nota no encontrada o fuera de tu empresa' });
      return;
    }
    res.status(200).json({ ok: true });
    return;
  }

  if (req.method === 'POST') {
    const name = String(body.name || '').trim();
    const pin = String(body.pin || '');
    // % día y % noche; si viene solo el % viejo, vale para los dos.
    const dayPct = validPct(body.commission_day_pct !== undefined ? body.commission_day_pct : body.commission_pct);
    const nightPct = validPct(body.commission_night_pct !== undefined ? body.commission_night_pct : body.commission_pct);
    if (!name || !pin || dayPct === null || nightPct === null) {
      res.status(400).json({ error: 'Faltan nombre, PIN o % válido (0 a 100) para día y noche' });
      return;
    }
    const salt = newSalt();
    const result = await pool.query(
      `INSERT INTO users (company_id, name, role, phone, taxi_id, commission_pct, commission_day_pct, commission_night_pct, pin_hash, pin_salt, active)
       VALUES ($1, $2, 'driver', $3, $4, $5, $6, $7, $8, $9, TRUE) RETURNING *`,
      [user.company_id, name, String(body.phone || ''), body.taxi_id ? Number(body.taxi_id) : null, dayPct, dayPct, nightPct, hashPin(pin, salt), salt]
    );
    res.status(201).json(publicDriver(result.rows[0]));
    return;
  }

  if (req.method === 'PUT') {
    if (!id) {
      res.status(400).json({ error: 'Falta id' });
      return;
    }
    const current = await pool.query("SELECT * FROM users WHERE id = $1 AND role = 'driver' AND company_id = $2", [id, user.company_id]);
    if (!current.rows[0]) {
      res.status(404).json({ error: 'Chofer no encontrado' });
      return;
    }
    // En edición, solo cambian los % que vienen en el body.
    const dayPct = body.commission_day_pct !== undefined || body.commission_pct !== undefined
      ? validPct(body.commission_day_pct !== undefined ? body.commission_day_pct : body.commission_pct) : null;
    const nightPct = body.commission_night_pct !== undefined || body.commission_pct !== undefined
      ? validPct(body.commission_night_pct !== undefined ? body.commission_night_pct : body.commission_pct) : null;
    if ((body.commission_day_pct !== undefined || body.commission_pct !== undefined) && dayPct === null) {
      res.status(400).json({ error: '% día inválido (0 a 100)' });
      return;
    }
    if ((body.commission_night_pct !== undefined || body.commission_pct !== undefined) && nightPct === null) {
      res.status(400).json({ error: '% noche inválido (0 a 100)' });
      return;
    }
    let pinHash = current.rows[0].pin_hash;
    let pinSalt = current.rows[0].pin_salt;
    if (body.pin !== undefined && String(body.pin) !== '') {
      pinSalt = newSalt();
      pinHash = hashPin(String(body.pin), pinSalt);
    }
    const newDay = dayPct !== null ? dayPct : (current.rows[0].commission_day_pct !== null ? current.rows[0].commission_day_pct : current.rows[0].commission_pct);
    const newNight = nightPct !== null ? nightPct : (current.rows[0].commission_night_pct !== null ? current.rows[0].commission_night_pct : current.rows[0].commission_pct);
    const result = await pool.query(
      `UPDATE users SET name = $1, phone = $2, taxi_id = $3, commission_pct = $4,
       commission_day_pct = $5, commission_night_pct = $6,
       pin_hash = $7, pin_salt = $8, active = $9 WHERE id = $10 RETURNING *`,
      [
        String(body.name || current.rows[0].name).trim(),
        String(body.phone !== undefined ? body.phone : current.rows[0].phone),
        body.taxi_id ? Number(body.taxi_id) : null,
        newDay,
        newDay,
        newNight,
        pinHash,
        pinSalt,
        body.active !== false,
        id,
      ]
    );
    res.status(200).json(publicDriver(result.rows[0]));
    return;
  }

  if (req.method === 'DELETE') {
    if (!id) {
      res.status(400).json({ error: 'Falta id' });
      return;
    }
    await pool.query("UPDATE users SET active = FALSE WHERE id = $1 AND role = 'driver' AND company_id = $2", [id, user.company_id]);
    res.status(200).json({ ok: true });
    return;
  }

  return methodNotAllowed(res);
};
