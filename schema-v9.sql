-- Mis Taxis — migración v9: liquidación marcada por el dueño.
-- Cada cierre (una jornada por chofer y día) puede quedar marcado por el
-- dueño como "recibido" (el chofer le entregó la plata) o "pagado" (el
-- dueño le pagó lo que le debía). Sin marca, el cierre queda "pendiente".
-- "Recibido" es solo confirmación y no cambia ningún número. "Pagado"
-- significa que el dueño ya pagó esa deuda en mano: ese día NO genera
-- saldo a favor, así que los días siguientes se calculan sin ese
-- descuento (si ya habían cerrado con el descuento aplicado, sus
-- entregas netas se recalculan hacia arriba y quedan pendientes). Los
-- cierres viejos nacen "pendiente": ningún número guardado cambia con
-- esta migración.

ALTER TABLE day_shifts ADD COLUMN IF NOT EXISTS settlement TEXT NOT NULL DEFAULT 'pendiente';
ALTER TABLE day_shifts ADD COLUMN IF NOT EXISTS settled_at TIMESTAMPTZ;
UPDATE day_shifts SET settlement = 'pendiente' WHERE settlement IS NULL OR settlement NOT IN ('pendiente', 'recibido', 'pagado');
