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
  entry_time TIME NOT NULL,
  entry_km NUMERIC(10,2) NOT NULL CHECK (entry_km >= 0),
  exit_time TIME NOT NULL,
  exit_km NUMERIC(10,2) NOT NULL CHECK (exit_km >= 0),
  amount NUMERIC(10,2) NOT NULL CHECK (amount >= 0),
  pct_snapshot NUMERIC(5,2) NOT NULL CHECK (pct_snapshot >= 0 AND pct_snapshot <= 100),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (exit_km >= entry_km)
);

CREATE TABLE IF NOT EXISTS expenses (
  id SERIAL PRIMARY KEY,
  driver_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expense_date DATE NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('gasolina', 'arreglos', 'otros')),
  amount NUMERIC(10,2) NOT NULL CHECK (amount >= 0),
  note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_trips_driver_date ON trips(driver_id, trip_date);
CREATE INDEX IF NOT EXISTS idx_expenses_driver_date ON expenses(driver_id, expense_date);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
