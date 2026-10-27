-- Mis Taxis — migración v2: jornada por día + viajes solo con monto.
-- Idempotente: se puede correr más de una vez.
-- La jornada del día (un registro por chofer y día) guarda el taxi del día,
-- la hora y km de entrada y la hora y km de salida. Los viajes después
-- solo llevan monto; el taxi del viaje se toma de la jornada de ese día.
-- Los viajes viejos conservan sus datos de entrada/salida.

CREATE TABLE IF NOT EXISTS day_shifts (
  id SERIAL PRIMARY KEY,
  driver_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  shift_date DATE NOT NULL,
  taxi_id INTEGER REFERENCES taxis(id) ON DELETE SET NULL,
  entry_time TIME NOT NULL,
  entry_km NUMERIC(10,2) NOT NULL CHECK (entry_km >= 0),
  exit_time TIME,
  exit_km NUMERIC(10,2) CHECK (exit_km >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (driver_id, shift_date),
  CHECK (exit_km IS NULL OR exit_km >= entry_km)
);

CREATE INDEX IF NOT EXISTS idx_shifts_driver_date ON day_shifts(driver_id, shift_date);

-- Los viajes nuevos solo llevan monto: entrada/salida pasan a ser opcionales.
ALTER TABLE trips ALTER COLUMN entry_time DROP NOT NULL;
ALTER TABLE trips ALTER COLUMN entry_km DROP NOT NULL;
ALTER TABLE trips ALTER COLUMN exit_time DROP NOT NULL;
ALTER TABLE trips ALTER COLUMN exit_km DROP NOT NULL;
