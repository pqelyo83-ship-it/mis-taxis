-- Mis Taxis — migración v8: aclaraciones del día.
-- Campo opcional en la jornada para que el chofer deje constancia al
-- cierre (por ejemplo: llevó el auto a service, fue a hacer mandados).
-- El dueño lo ve en Cierres y el chofer puede corregirlo en "Editar día".
-- Los días viejos quedan sin aclaraciones (la columna nace vacía).

ALTER TABLE day_shifts ADD COLUMN IF NOT EXISTS note TEXT;
