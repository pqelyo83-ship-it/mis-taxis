-- Mis Taxis — esquema de base de datos (Postgres)
-- Ejecutar antes que seed.sql. Idempotente: se puede correr más de una vez.

CREATE TABLE IF NOT EXISTS taxis (
  id SERIAL PRIMARY KEY,
  identifier TEXT NOT NULL UNIQUE,
  plate TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT '',
  year INTEGER,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'driver')),
  phone TEXT NOT NULL DEFAULT '',
  taxi_id INTEGER REFERENCES taxis(id) ON DELETE SET NULL,
  commission_pct NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (commission_pct >= 0 AND commission_pct <= 100),
  commission_day_pct NUMERIC(5,2) CHECK (commission_day_pct >= 0 AND commission_day_pct <= 100),
  commission_night_pct NUMERIC(5,2) CHECK (commission_night_pct >= 0 AND commission_night_pct <= 100),
  pin_hash TEXT NOT NULL,
  pin_salt TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS trips (
  id SERIAL PRIMARY KEY,
  driver_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  taxi_id INTEGER REFERENCES taxis(id) ON DELETE SET NULL,
  trip_date DATE NOT NULL,
  entry_time TIME,
  entry_km NUMERIC(10,2) CHECK (entry_km >= 0),
  exit_time TIME,
  exit_km NUMERIC(10,2) CHECK (exit_km >= 0),
  amount NUMERIC(10,2) NOT NULL CHECK (amount >= 0),
  pct_snapshot NUMERIC(5,2) NOT NULL CHECK (pct_snapshot >= 0 AND pct_snapshot <= 100),
  shift_type VARCHAR(10) NOT NULL DEFAULT 'day' CHECK (shift_type IN ('day', 'night')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (exit_km IS NULL OR exit_km >= entry_km)
);

CREATE TABLE IF NOT EXISTS expenses (
  id SERIAL PRIMARY KEY,
  driver_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expense_date DATE NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('gasolina', 'arreglos', 'otros')),
  amount NUMERIC(10,2) NOT NULL CHECK (amount >= 0),
  note TEXT NOT NULL DEFAULT '',
  receipt_image TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_trips_driver_date ON trips(driver_id, trip_date);
CREATE INDEX IF NOT EXISTS idx_expenses_driver_date ON expenses(driver_id, expense_date);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

-- Jornada del día (un registro por chofer y día): taxi del día, hora y km
-- de entrada y hora y km de salida. Los viajes después solo llevan monto.
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
