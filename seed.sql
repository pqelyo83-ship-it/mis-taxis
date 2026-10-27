-- Mis Taxis — datos iniciales (seed)
-- Requiere schema.sql. Idempotente: no duplica si se corre más de una vez.
-- Los PIN se guardan solo como hash SHA-256 (sal + PIN). Nunca se guarda el PIN en texto plano.
-- El PIN provisorio inicial lo conoce el administrador que instaló la app; debe cambiarse
-- desde el panel (el admin cambia su propio PIN y el de cada chofer).

-- Empresa inicial
INSERT INTO companies (name, code, payment_status) SELECT 'Mis Taxis', 'MISTAX', 'paid'
WHERE NOT EXISTS (SELECT 1 FROM companies WHERE code = 'MISTAX');

-- Taxi de prueba
INSERT INTO taxis (company_id, identifier, plate, model, year, active)
SELECT (SELECT id FROM companies WHERE code = 'MISTAX'), 'TAXI-01', 'TEST-001', 'Sedán de prueba', 2024, TRUE
WHERE NOT EXISTS (SELECT 1 FROM taxis WHERE identifier = 'TAXI-01' AND company_id = (SELECT id FROM companies WHERE code = 'MISTAX'));

-- Administrador preexistente (sin registro público): es el dueño de la
-- plataforma (superadmin) y a la vez admin de la empresa inicial.
INSERT INTO users (company_id, name, role, phone, taxi_id, commission_pct, pin_hash, pin_salt, active)
SELECT (SELECT id FROM companies WHERE code = 'MISTAX'), 'Administrador', 'superadmin', '', NULL, 0,
  'c15f31ea646b4729402fca28c43784aa1244ba5afa3c114c01635604683a7553',
  '9b474ed755b7164232717c50adf85e18', TRUE
WHERE NOT EXISTS (SELECT 1 FROM users WHERE name = 'Administrador' AND role = 'superadmin' AND company_id = (SELECT id FROM companies WHERE code = 'MISTAX'));

-- Métodos de pago por defecto de la empresa inicial
INSERT INTO payment_methods (company_id, name)
SELECT (SELECT id FROM companies WHERE code = 'MISTAX'), t.m FROM (VALUES ('Efectivo'), ('Tarjeta'), ('Transferencia')) AS t(m)
WHERE NOT EXISTS (SELECT 1 FROM payment_methods WHERE company_id = (SELECT id FROM companies WHERE code = 'MISTAX') AND LOWER(name) = LOWER(t.m));

-- Chofer de prueba (el admin puede editar sus % día/noche, taxi, teléfono y PIN desde el panel)
INSERT INTO users (company_id, name, role, phone, taxi_id, commission_pct, commission_day_pct, commission_night_pct, pin_hash, pin_salt, active)
SELECT (SELECT id FROM companies WHERE code = 'MISTAX'), 'Chofer Test', 'driver', '555-0101',
  (SELECT id FROM taxis WHERE identifier = 'TAXI-01' AND company_id = (SELECT id FROM companies WHERE code = 'MISTAX')), 50, 50, 50,
  'ef4db69f87887cc28be36279ccf9a8761bf614e494ab520f6bfb0ca6346dbee0',
  '9d9727c15084ff2034d90f9a05d26b1a', TRUE
WHERE NOT EXISTS (SELECT 1 FROM users WHERE name = 'Chofer Test' AND role = 'driver' AND company_id = (SELECT id FROM companies WHERE code = 'MISTAX'));
