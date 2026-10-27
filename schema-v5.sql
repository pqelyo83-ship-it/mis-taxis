-- Mis Taxis — migración v5: multi-empresa + geolocalización.
-- Cada empresa (flota) es un espacio aislado: todos los datos llevan
-- company_id y cada consulta filtra por la empresa del usuario.
-- La flota actual pasa a ser la empresa inicial "Mis Taxis".
-- Geolocalización: coordenadas opcionales (NULL si el teléfono no las comparte).

CREATE TABLE IF NOT EXISTS companies (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  code VARCHAR(8) NOT NULL UNIQUE,
  night_start INT NOT NULL DEFAULT 22 CHECK (night_start >= 0 AND night_start <= 23),
  night_end INT NOT NULL DEFAULT 6 CHECK (night_end >= 0 AND night_end <= 23),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO companies (name, code) SELECT 'Mis Taxis', 'MISTAX'
WHERE NOT EXISTS (SELECT 1 FROM companies WHERE code = 'MISTAX');

ALTER TABLE users ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id);
ALTER TABLE taxis ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id);
ALTER TABLE trips ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id);
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id);
ALTER TABLE day_shifts ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id);

ALTER TABLE day_shifts ADD COLUMN IF NOT EXISTS entry_lat NUMERIC(9,6);
ALTER TABLE day_shifts ADD COLUMN IF NOT EXISTS entry_lng NUMERIC(9,6);
ALTER TABLE day_shifts ADD COLUMN IF NOT EXISTS exit_lat NUMERIC(9,6);
ALTER TABLE day_shifts ADD COLUMN IF NOT EXISTS exit_lng NUMERIC(9,6);
ALTER TABLE trips ADD COLUMN IF NOT EXISTS trip_lat NUMERIC(9,6);
ALTER TABLE trips ADD COLUMN IF NOT EXISTS trip_lng NUMERIC(9,6);

UPDATE users SET company_id = (SELECT id FROM companies WHERE code = 'MISTAX') WHERE company_id IS NULL;
UPDATE taxis SET company_id = (SELECT id FROM companies WHERE code = 'MISTAX') WHERE company_id IS NULL;
-- El identificador del taxi debe ser único solo dentro de cada empresa
-- (dos empresas pueden tener su propio TAXI-01).
ALTER TABLE taxis DROP CONSTRAINT IF EXISTS taxis_identifier_key;
ALTER TABLE taxis ADD CONSTRAINT taxis_company_identifier_key UNIQUE (company_id, identifier);
UPDATE trips SET company_id = (SELECT id FROM companies WHERE code = 'MISTAX') WHERE company_id IS NULL;
UPDATE expenses SET company_id = (SELECT id FROM companies WHERE code = 'MISTAX') WHERE company_id IS NULL;
UPDATE day_shifts SET company_id = (SELECT id FROM companies WHERE code = 'MISTAX') WHERE company_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_users_company ON users(company_id);
CREATE INDEX IF NOT EXISTS idx_taxis_company ON taxis(company_id);
CREATE INDEX IF NOT EXISTS idx_trips_company ON trips(company_id);
CREATE INDEX IF NOT EXISTS idx_expenses_company ON expenses(company_id);
CREATE INDEX IF NOT EXISTS idx_shifts_company ON day_shifts(company_id);
