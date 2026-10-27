// Helpers compartidos por las funciones serverless de Mis Taxis.
// Variables de entorno requeridas: DATABASE_URL, SESSION_SECRET.
// Nunca se devuelve un hash de PIN al cliente.

const { Pool } = require('pg');
const crypto = require('crypto');

let pool = null;

function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    });
  }
  return pool;
}

function hashPin(pin, salt) {
  return crypto.createHash('sha256').update(String(salt) + String(pin)).digest('hex');
}

function newSalt() {
  return crypto.randomBytes(16).toString('hex');
}

function signToken(payload) {
  const secret = process.env.SESSION_SECRET || '';
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return body + '.' + sig;
}

function verifyToken(req) {
  try {
    const header = req.headers.authorization || '';
    const match = header.match(/^Bearer (.+)$/);
    if (!match) return null;
    const parts = match[1].split('.');
    if (parts.length !== 2) return null;
    const body = parts[0];
    const sig = parts[1];
    const secret = process.env.SESSION_SECRET || '';
    const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (payload.exp && Date.now() > payload.exp) return null;
    if (!payload.userId || !payload.role) return null;
    return payload;
  } catch (e) {
    return null;
  }
}

// Devuelve el usuario autenticado o responde 401/403 y devuelve null.
// roles: array opcional, por ejemplo ['admin'] o ['admin', 'driver'].
async function requireAuth(req, res, roles) {
  const payload = verifyToken(req);
  if (!payload) {
    res.status(401).json({ error: 'No autorizado' });
    return null;
  }
  if (roles && roles.indexOf(payload.role) === -1) {
    res.status(403).json({ error: 'Sin permiso' });
    return null;
  }
  const result = await getPool().query(
    'SELECT id, name, role, phone, taxi_id, commission_pct, company_id, active FROM users WHERE id = $1',
    [payload.userId]
  );
  const user = result.rows[0];
  if (!user || !user.active) {
    res.status(401).json({ error: 'No autorizado' });
    return null;
  }
  return user;
}

function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  return {};
}

function toNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function methodNotAllowed(res) {
  res.status(405).json({ error: 'Método no permitido' });
}

module.exports = {
  getPool,
  hashPin,
  newSalt,
  signToken,
  verifyToken,
  requireAuth,
  readBody,
  toNumber,
  round2,
  methodNotAllowed,
};
