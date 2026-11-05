# [MEJORA-006] Generar y actualizar automáticamente los recorridos estáticos (`data/routes/`)

- **Componente:** `scripts/build-static-routes.py` / `data/routes/` / `.github/workflows/`
- **Severidad:** 🟠 Media-Alta (sin esto el cruce de ids se degrada con cada GTFS nuevo)
- **Estado:** 🟡 Workflow listo (`.github/workflows/gtfs-routes.yml`, lunes 06:17 UTC + manual). Falta cargar los secrets `GCBA_CLIENT_ID` / `GCBA_CLIENT_SECRET` en el repo y correrlo una vez.

---

## 1. Descripción del problema
`data/routes/` todavía no existe: la API de GCBA no respondió al intentar bajar el GTFS. Mientras tanto, el frontend sigue pidiendo los recorridos al worker (D1).

## 2. Causa técnica
El `route_id` de las posiciones en vivo coincide con el `route_id` del GTFS, pero GCBA renumera las rutas entre versiones (en 2024 la ruta 834 era la "315E"; hoy es la "152"). Con un GTFS de 2024, solo el 51,7 % de los colectivos se asoció a su recorrido (usando nombre de línea y variante más cercana como respaldo). Con un GTFS de la misma versión que el feed en vivo, el match debería ser exacto.

## 3. Solución propuesta
1. Primera generación manual (comandos también en el README):
   ```bash
   curl -sS -o /tmp/gtfs.zip "https://apitransporte.buenosaires.gob.ar/colectivos/feed-gtfs?client_id=$GCBA_CLIENT_ID&client_secret=$GCBA_CLIENT_SECRET"
   curl -sS -o /tmp/live.json https://transporte-be.papamasro.workers.dev/colectivos/vehiclePositionsSimple
   python3 scripts/build-static-routes.py --gtfs /tmp/gtfs.zip --realtime-sample /tmp/live.json
   ```
   Revisar el porcentaje de match exacto del reporte.
2. GitHub Action semanal (`schedule`) que baje el GTFS, regenere `data/routes/` y abra un PR o commitee si cambió. Necesita `GCBA_CLIENT_ID` y `GCBA_CLIENT_SECRET` como secrets del repo, permisos mínimos y actions fijadas por SHA, como en `ci.yml`.
3. Que el job falle si el match exacto baja de un umbral (por ejemplo 90 %).
