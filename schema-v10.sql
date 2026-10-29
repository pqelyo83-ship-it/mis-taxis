-- Mis Taxis — migración v10: propina y destino opcional por viaje +
-- notas y valoración privada del dueño por chofer.
-- NO APLICADA: este archivo es solo texto para aplicar en Neon antes
-- del deploy del backend (los INSERT/UPDATE de trips.js ya referencian
-- tip y destination sin fallback: si el backend nuevo sale antes que
-- esta migración, crear/editar viajes falla; los GET y day-close sí
-- degradan con gracia a 0/null sin ella).
--
-- Ítem 8: la propina queda FUERA del reparto % y FUERA del debe entregar:
-- es plata del chofer al 100% y nunca se suma a recaudado, keeps,
-- efectivo, gastos, saldo a favor ni liquidación. Solo se informa aparte
-- (tip_total en day-close). Los viajes viejos nacen con propina 0.
-- Ítem 10: el destino es solo texto libre opcional, nunca obligatorio,
-- y no lleva link a Maps. Los viajes viejos nacen sin destino.
-- Ítem 11: notas y valoración SOLO para el dueño (admin). Nunca visibles
-- para choferes, ni siquiera su propia nota/valoración: las notas viven
-- en driver_notes (ningún endpoint de chofer la consulta) y owner_rating
-- solo se devuelve en la rama ?notes= / ?rating= de /api/drivers, que
-- exige rol admin. Los choferes viejos nacen sin valorar (NULL) y sin notas.

-- Propina opcional por viaje. Mismo tipo que trips.amount (NUMERIC(10,2)).
-- NOT NULL DEFAULT 0: los viajes viejos quedan en 0 sin backfill manual.
-- El CHECK impide propinas negativas a nivel de base, igual que amount.
ALTER TABLE trips ADD COLUMN IF NOT EXISTS tip NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (tip >= 0);

-- Destino o zona opcional por viaje. Texto libre, nullable: vacío = NULL.
-- Sin CHECK de largo en la base: el tope de 200 caracteres se aplica
-- recortando en el backend (y con maxlength en el frontend).
ALTER TABLE trips ADD COLUMN IF NOT EXISTS destination TEXT;

-- Notas privadas del dueño por chofer. Una fila por nota, más reciente
-- primero (created_at DESC, id DESC). Borrado por nota individual.
CREATE TABLE IF NOT EXISTS driver_notes (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  driver_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  note TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_driver_notes_driver ON driver_notes(driver_id, created_at DESC);

-- Valoración actual del dueño por chofer (1 a 5). NULL = sin valorar.
-- Al ser nullable, el CHECK deja pasar NULL y solo restringe 1–5 cuando
-- hay valor, igual que los CHECK de commission_day_pct/night_pct.
ALTER TABLE users ADD COLUMN IF NOT EXISTS owner_rating INT;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_owner_rating_check;
ALTER TABLE users ADD CONSTRAINT users_owner_rating_check CHECK (owner_rating BETWEEN 1 AND 5);
