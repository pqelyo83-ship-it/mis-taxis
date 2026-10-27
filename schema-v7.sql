-- Mis Taxis — migración v7: estado de pago por empresa.
-- El encargado maneja a los dueños según su pago: marca cada empresa
-- como al día o pendiente, y puede suspender (sin acceso) o reactivar.
-- active=FALSE ya existía y ahora se hace cumplir en login y APIs.

ALTER TABLE companies ADD COLUMN IF NOT EXISTS payment_status TEXT NOT NULL DEFAULT 'pending';

ALTER TABLE companies DROP CONSTRAINT IF EXISTS companies_payment_status_check;
ALTER TABLE companies ADD CONSTRAINT companies_payment_status_check CHECK (payment_status IN ('paid', 'pending'));

-- La empresa del dueño de la plataforma está al día por definición.
UPDATE companies SET payment_status = 'paid' WHERE code = 'MISTAX';
