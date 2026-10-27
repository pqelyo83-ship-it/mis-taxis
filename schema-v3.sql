-- Mis Taxis — migración v3: foto de la factura en gastos.
-- La foto se guarda comprimida (JPEG, lado máximo 1200px) como data URL
-- en texto, para no depender de ningún servicio externo de archivos.
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS receipt_image TEXT;
