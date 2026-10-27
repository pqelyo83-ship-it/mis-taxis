-- Mis Taxis — migración v4: % día/noche por chofer + turno por viaje.
-- Cada chofer pasa a tener dos porcentajes (día y noche). Los dos se
-- inicializan con el % único anterior, así nadie cambia de % por la migración.
-- Cada viaje guarda su turno (day/night); los viajes viejos quedan como 'day'
-- y conservan su pct_snapshot, así los cierres viejos no cambian.
ALTER TABLE users ADD COLUMN IF NOT EXISTS commission_day_pct NUMERIC(5,2) CHECK (commission_day_pct >= 0 AND commission_day_pct <= 100);
ALTER TABLE users ADD COLUMN IF NOT EXISTS commission_night_pct NUMERIC(5,2) CHECK (commission_night_pct >= 0 AND commission_night_pct <= 100);
UPDATE users SET commission_day_pct = commission_pct WHERE commission_day_pct IS NULL;
UPDATE users SET commission_night_pct = commission_pct WHERE commission_night_pct IS NULL;
ALTER TABLE trips ADD COLUMN IF NOT EXISTS shift_type VARCHAR(10) NOT NULL DEFAULT 'day' CHECK (shift_type IN ('day', 'night'));
