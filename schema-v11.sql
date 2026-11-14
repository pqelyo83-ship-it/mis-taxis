-- Mis Taxis — migración v11: turnos nocturnos que cruzan la medianoche.
-- Problema: la jornada era un registro por chofer y fecha (UNIQUE
-- driver_id + shift_date), con hora de entrada y de cierre pero sin fecha
-- de cierre. Un turno de noche (empieza un día, termina al otro) no
-- entraba: a la medianoche el chofer tenía que cerrar y volver a abrir
-- otro día para seguir cargando viajes, y después ya no podía volver a
-- empezar ese mismo día porque la fecha ya tenía una jornada cerrada.
-- Además el relevo y el aviso de taxi ocupado solo miraban la fecha
-- elegida, así que de madrugada no encontraban el cierre del compañero
-- (que quedó guardado con la fecha de ayer).
--
-- Cambios:
-- 1. day_shifts.exit_date DATE: fecha en que se cerró el turno (la
--    fecha de inicio sigue en shift_date). Un turno de noche queda como
--    UN solo turno: empieza el día 6 a las 22:00 y cierra el día 7 a
--    las 04:00, con exit_date = 7/11.
-- 2. Se quita UNIQUE (driver_id, shift_date): un chofer puede tener
--    más de un turno empezando el mismo día (por ejemplo, cierra la
--    noche a la mañana y vuelve a salir a la tarde). Lo que sigue siendo
--    único es el turno ABIERTO: un chofer no puede tener dos turnos
--    abiertos a la vez (índice parcial sobre exit_km IS NULL).
-- 3. trips.shift_id y expenses.shift_id: cada viaje y cada gasto quedan
--    atados al turno abierto al momento de cargarlos (no a la fecha del
--    calendario). Así los viajes de las 01:00 y las 03:00 de la
--    madrugada cuentan en el cierre del turno de noche que empezó el día
--    anterior, no en un día aparte. Los registros viejos (sin shift_id)
--    se rellenan con el turno de su misma fecha; si no había turno ese
--    día quedan en NULL y el cierre los sigue contando por fecha, como
--    antes.
-- Idempotente: se puede correr más de una vez.

ALTER TABLE day_shifts ADD COLUMN IF NOT EXISTS exit_date DATE;

ALTER TABLE trips ADD COLUMN IF NOT EXISTS shift_id INTEGER REFERENCES day_shifts(id) ON DELETE SET NULL;
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS shift_id INTEGER REFERENCES day_shifts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_trips_shift ON trips(shift_id);
CREATE INDEX IF NOT EXISTS idx_expenses_shift ON expenses(shift_id);

-- Un solo turno abierto por chofer (los cerrados pueden ser varios).
CREATE UNIQUE INDEX IF NOT EXISTS idx_shifts_one_open_per_driver
  ON day_shifts(driver_id) WHERE exit_km IS NULL;

-- Quitar el UNIQUE viejo (un turno por chofer y fecha). El nombre de la
-- restricción es el que genera Postgres para UNIQUE (driver_id,
-- shift_date) en day_shifts.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'day_shifts_driver_id_shift_date_key'
      AND conrelid = 'day_shifts'::regclass
  ) THEN
    ALTER TABLE day_shifts DROP CONSTRAINT day_shifts_driver_id_shift_date_key;
  END IF;
END $$;

-- Relleno: los turnos ya cerrados cierran el mismo día que empezaron.
UPDATE day_shifts SET exit_date = shift_date
WHERE exit_km IS NOT NULL AND exit_date IS NULL;

-- Relleno: viajes y gastos viejos se atan al turno de su fecha.
UPDATE trips t SET shift_id = (
  SELECT s.id FROM day_shifts s
  WHERE s.driver_id = t.driver_id AND s.shift_date = t.trip_date
  ORDER BY s.id LIMIT 1
)
WHERE t.shift_id IS NULL;

UPDATE expenses e SET shift_id = (
  SELECT s.id FROM day_shifts s
  WHERE s.driver_id = e.driver_id AND s.shift_date = e.expense_date
  ORDER BY s.id LIMIT 1
)
WHERE e.shift_id IS NULL;
