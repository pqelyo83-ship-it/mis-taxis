-- Mis Taxis — datos iniciales (seed)
-- Requiere schema.sql. Idempotente: no duplica si se corre más de una vez.
-- Los PIN se guardan solo como hash SHA-256 (sal + PIN). Nunca se guarda el PIN en texto plano.
-- El PIN provisorio inicial lo conoce el administrador que instaló la app; debe cambiarse
-- desde el panel (el admin cambia su propio PIN y el de cada chofer).

-- Taxi de prueba
INSERT INTO taxis (identifier, plate, model, year, active)
SELECT 'TAXI-01', 'TEST-001', 'Sedán de prueba', 2024, TRUE
WHERE NOT EXISTS (SELECT 1 FROM taxis WHERE identifier = 'TAXI-01');

-- Administrador preexistente (sin registro público)
INSERT INTO users (name, role, phone, taxi_id, commission_pct, pin_hash, pin_salt, active)
SELECT 'Administrador', 'admin', '', NULL, 0,
  'c15f31ea646b4729402fca28c43784aa1244ba5afa3c114c01635604683a7553',
  '9b474ed755b7164232717c50adf85e18', TRUE
WHERE NOT EXISTS (SELECT 1 FROM users WHERE name = 'Administrador' AND role = 'admin');

-- Chofer de prueba (el admin puede editar su %, taxi, teléfono y PIN desde el panel)
INSERT INTO users (name, role, phone, taxi_id, commission_pct, pin_hash, pin_salt, active)
SELECT 'Chofer Test', 'driver', '555-0101',
  (SELECT id FROM taxis WHERE identifier = 'TAXI-01'), 50,
  'ef4db69f87887cc28be36279ccf9a8761bf614e494ab520f6bfb0ca6346dbee0',
  '9d9727c15084ff2034d90f9a05d26b1a', TRUE
WHERE NOT EXISTS (SELECT 1 FROM users WHERE name = 'Chofer Test' AND role = 'driver');
