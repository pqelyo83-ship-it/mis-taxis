# Mis Taxis

App para administrar un negocio de taxis. Interfaz en español, pensada para el celular (botones grandes, uso con una mano). Moneda: USD.

## Qué hace

- **Ingreso solo con PIN.** No hay registro con email ni contraseñas. Cada chofer entra con su PIN personal y el administrador con su PIN de admin.
- **Solo el admin crea taxis, choferes y %** (la comisión de cada chofer sobre lo recaudado). Los choferes no se registran solos ni pueden cambiar su % ni su PIN.
- **Viajes por viaje:** cada viaje lleva fecha, hora de entrada, kilometraje de entrada, hora de salida, kilometraje de salida y monto. Cada viaje muestra el % vigente al momento del viaje (si el admin lo cambia después, los viajes viejos no cambian), cuánto se queda el chofer y cuánto va al dueño.
- **Gastos:** el chofer carga gasolina, arreglos u otros, con monto, fecha y nota. Los gastos se descuentan de la parte del dueño, no de la del chofer.
- **Cierre del día:** por chofer y por día, total recaudado, cuánto se queda el chofer, cuánto le tiene que dar al dueño y gastos del día. El chofer ve solo su cierre; el admin ve el de todos.

## Ponerla en marcha (Vercel + Postgres gratis)

1. **Base de datos:** creá una base Postgres gratuita (por ejemplo en Neon) y corrí los scripts en orden, por ejemplo con `psql`:
   - `schema.sql` (crea las tablas)
   - `seed.sql` (crea el administrador, un taxi de prueba y un chofer de prueba)
2. **Variables de entorno en Vercel** (proyecto → Settings → Environment Variables):
   - `DATABASE_URL`: la cadena de conexión de tu Postgres.
   - `SESSION_SECRET`: una frase secreta larga cualquiera, solo para firmar los tokens de sesión. No la compartas ni la subas al código.
3. **Publicar:** conectá este repositorio a un proyecto de Vercel. Vercel sirve los archivos estáticos (`index.html`, `app.js`, `styles.css`) y las funciones de `api/` automáticamente. El archivo `vercel.json` ya trae la configuración.
4. **Entrar por primera vez:** abrí la URL publicada y entrá con el PIN del administrador. El PIN provisorio inicial es el que configuró quien instaló la app (en `seed.sql` solo está guardado como hash, nunca en texto plano). En cuanto entres, cambialo en la pestaña **Mi PIN**.
5. **Agregar choferes:** como admin, andá a **Choferes** → completá nombre, teléfono, taxi asignado, % y PIN → Guardar. El chofer entra desde su celular con ese PIN y ve solo lo suyo.
6. **Chofer de prueba:** la app trae un chofer de prueba con un taxi de prueba y un % de ejemplo. El admin puede editarlo o desactivarlo desde **Choferes**; desactivar conserva su historial.

## Rutas de la API

- `POST /api/auth` — ingreso con PIN, devuelve token de sesión.
- `GET/POST/PUT/DELETE /api/taxis` — taxis (escritura solo admin).
- `GET/POST/PUT/DELETE /api/drivers` — choferes (solo admin; borrar desactiva, no borra historial).
- `GET/POST/PUT/DELETE /api/trips` — viajes (el chofer solo ve y toca los suyos).
- `GET/POST/DELETE /api/expenses` — gastos (el chofer solo ve y toca los suyos).
- `GET /api/day-close?date=AAAA-MM-DD` — cierre del día.
- `POST /api/change-pin` — el usuario cambia su propio PIN.

Ninguna ruta devuelve hashes de PIN al cliente.

## Seguridad

- Los PIN se guardan solo como hash SHA-256 con sal por usuario.
- Los tokens de sesión se firman con HMAC usando `SESSION_SECRET` y vencen a los 7 días.
- No hay ningún secreto, contraseña ni cadena de conexión escrita en el código: todo llega por variables de entorno.
