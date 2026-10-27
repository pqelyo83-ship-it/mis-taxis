-- Mis Taxis — migración v6: dueño de la plataforma (superadmin) y
-- ingreso de dueños por email y contraseña.
-- El usuario actual (Administrador de Mis Taxis) pasa a ser superadmin:
-- sigue administrando su empresa con PIN y además ve el panel Empresas,
-- donde da de alta nuevas empresas con email y contraseña para sus dueños.
-- Los dueños nuevos entran con email y contraseña (sin PIN); los choferes
-- siguen con nombre + PIN. El registro público se cierra.

-- Dueños por email: credenciales con hash scrypt (no texto plano).
ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- Los dueños nuevos no tienen PIN: el hash del PIN pasa a ser opcional.
ALTER TABLE users ALTER COLUMN pin_hash DROP NOT NULL;
ALTER TABLE users ALTER COLUMN pin_salt DROP NOT NULL;

-- Nuevo rol superadmin (dueño de la plataforma).
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin', 'driver', 'superadmin'));

-- El Administrador actual de Mis Taxis pasa a ser el superadmin.
UPDATE users SET role = 'superadmin'
WHERE id IN (
  SELECT id FROM users
  WHERE company_id = (SELECT id FROM companies WHERE code = 'MISTAX')
    AND name = 'Administrador' AND role = 'admin'
  ORDER BY id LIMIT 1
);

-- Métodos de pago por empresa (misma migración v6: aún no aplicada).
-- Cada empresa tiene sus propios métodos (Efectivo, Tarjeta, etc.) y el
-- dueño agrega los que trabaje. Desactivar no borra el historial: los
-- viajes viejos conservan su método.
CREATE TABLE IF NOT EXISTS payment_methods (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  name TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pm_company_name ON payment_methods(company_id, LOWER(name));

ALTER TABLE trips ADD COLUMN IF NOT EXISTS payment_method_id INTEGER REFERENCES payment_methods(id);

-- Métodos por defecto para las empresas existentes.
INSERT INTO payment_methods (company_id, name)
SELECT c.id, t.m FROM companies c
CROSS JOIN (VALUES ('Efectivo'), ('Tarjeta'), ('Transferencia')) AS t(m)
WHERE NOT EXISTS (
  SELECT 1 FROM payment_methods pm
  WHERE pm.company_id = c.id AND LOWER(pm.name) = LOWER(t.m)
);
