# [TAREA-005] Desplegar el worker optimizado, los índices de D1 y los recorridos estáticos

- **Componente:** `worker/` (`index.js`, `wrangler.toml`, `migrations/`, `sql/optional/`) / `data/routes/` / GitHub Pages
- **Severidad:** 🔴 Alta (la cuota de D1 se agota con el worker actual)
- **Estado:** ⏳ Pendiente (requiere login de `papamasro` en git y `wrangler login`)

---

## 1. Descripción del problema
El worker desplegado consume la cuota gratuita de Cloudflare. En una base local con ~195k puntos de shape, una sola llamada a `/buscar-linea?numero=60` leía 6,25 M de filas de D1 (el límite diario Free es 5 M), y cada `/info-trayecto` unas 230k. Además, las posiciones de colectivos se piden a GCBA en cada request, sin caché, con 4 a 34 s de espera.

## 2. Causa técnica
- `/buscar-linea` recorría `shapes` entera una vez por ramal.
- `/info-trayecto` comparaba con `REPLACE(trip_id, '-', '')` dentro de un `OR`, lo que impide usar índices.
- El proxy a GCBA no tenía caché, y las rutas `*KV` desplegadas devuelven 500 porque falta el binding.

## 3. Solución preparada (sin desplegar)
- Worker reescrito en un solo archivo con Workers Cache, caché en memoria y Cache API (stale-while-revalidate, una sola llamada upstream por clave, copia vieja si GCBA falla) y sin escrituras a KV.
- Consultas D1 reescritas y migración `migrations/0001_indexes.sql`; `sql/optional/0002_row_ranges.sql` si el diagnóstico muestra `SCAN`.
- Rutas nuevas: `/*/serviceAlertsJson`, `/trenes/arribosLinea`, `POST /client-errors`.

## 4. Pasos
Desde `worker/`:
1. `npm install && npx wrangler login`
2. `npx wrangler d1 list` y `npx wrangler kv namespace list`, y completar los ids en `wrangler.toml`. `wrangler deploy` pisa los bindings del dashboard, así que tienen que ser correctos.
3. `npx wrangler versions list --name transporte-be` para anotar la versión actual (rollback: `npx wrangler rollback <version-id>`).
4. `npx wrangler secret list --name transporte-be`; si faltan, `npx wrangler secret put GCBA_CLIENT_ID` y `GCBA_CLIENT_SECRET`.
5. `./scripts/d1-diagnostico.sh <DB>` y `npx wrangler d1 migrations apply <DB> --remote`.
6. `npm run check && npx wrangler deploy`.
7. Verificar: dos llamadas a `/subtes/forecastGTFS`; la segunda debe responder `cf-cache-status: HIT`.
8. Generar `data/routes/` (ver [TICKET-006](TICKET-006-gtfs-actualizacion-automatica.md)), commitear y pushear el frontend.

## 5. Riesgos
- CORS quedó restringido a `https://papamasro.github.io` y localhost. Otro origen recibe 403 (`ALLOWED_ORIGINS="*"` lo abre).
- Las posiciones de colectivos pueden llegar con hasta ~60 s de atraso, a cambio de responder al instante.
- Los requests no bajan: los HIT de caché también cuentan en los 100k diarios.
