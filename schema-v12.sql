-- Mis Taxis — migración v12: cierre automático por relevo y km del auto.
-- Problema: el kilometraje es del auto, no del chofer. Si dos choferes
-- usan el mismo taxi y el primero no cierra su turno, el segundo podía
-- abrir otro turno en el mismo taxi con cualquier km: el aviso de taxi
-- ocupado era solo una confirmación y el bloqueo de km solo miraba el
-- último cierre. Así entró Liber el 16/11 en Taxi 74 con 229117 km,
-- 58 km por debajo del último cierre (229175), mientras el turno de
-- Diego seguía abierto en ese taxi.
--
-- Cambios:
-- 1. day_shifts.auto_closed BOOLEAN: el turno se cerró solo cuando otro
--    chofer abrió el mismo taxi (el cierre toma el km/hora/fecha con los
--    que arranca el turno nuevo). El dueño lo ve en Cierres y en Resumen.
-- 2. Se quita el CHECK (exit_km >= entry_km): un cierre automático
--    puede quedar con km de cierre por debajo del de entrada (el odómetro
--    no cierra), y eso es justamente la diferencia que el dueño tiene que
--    ver, no un error de base. El cierre manual sigue sin permitir km de
--    cierre menor que el de entrada (validación en api/shifts.js).
-- Idempotente: se puede correr más de una vez.

ALTER TABLE day_shifts ADD COLUMN IF NOT EXISTS auto_closed BOOLEAN NOT NULL DEFAULT FALSE;

-- Quitar el CHECK de exit_km >= entry_km, cualquiera sea su nombre
-- (Postgres lo genera solo si no se le puso nombre al crearlo).
DO $$
DECLARE
  c RECORD;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'day_shifts'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%exit_km%entry_km%'
  LOOP
    EXECUTE 'ALTER TABLE day_shifts DROP CONSTRAINT ' || quote_ident(c.conname);
  END LOOP;
END $$;
