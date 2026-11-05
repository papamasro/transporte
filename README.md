# Radar AMBA

Dashboard web para visualizar transporte en tiempo real en AMBA:
- Colectivos en mapa (con búsqueda y overlay de recorrido).
- Subte con pronóstico GTFS y tren con estaciones estáticas + arribos SOFSE en vivo al abrir tooltip.
- EcoBici y panel de alertas.
- UI tipo PWA (instalable en mobile/escritorio).

## Stack
- Frontend: HTML + CSS + JavaScript vanilla.
- Mapa: Leaflet 1.9.4 (self-hosted en `assets/vendor/`).
- UI: Tailwind CSS v3 precompilado (`assets/styles/tailwind.css`) + Lucide 0.321.0 (self-hosted).
- Backend de datos: Worker en Cloudflare (`transporte-be`) + KV.

## Arquitectura (alto nivel)
La app se carga desde `index.html` y divide responsabilidades en módulos:

- `js/app/bootstrap.js`
  - Estado global (`cache`, `layers`, `activeTypes`, etc.) y constantes derivadas de `APP_CONFIG` (`BACKEND_URL`, `KV_KEYS`, ...).
  - No define defaults propios: lee todo de `js/app/config.js`.
  - Inicialización de mapa y loop principal de refresco.
  - Orquestación de activación/desactivación de tipos (`bus/subte/train/bike`).

- `js/app/config.js`
  - Única fuente de configuración: URLs base, endpoints (`PATHS`), `KV_KEYS`, `NETWORK` (retry/limits), `TIMEOUTS`, `FEATURES`, `MAP`.
  - Si antes de cargarlo existe un `globalThis.APP_CONFIG` parcial, se mezcla en profundidad sobre los defaults.

- `js/app/services.js`
  - HTTP helper (`fetchAPI`).
  - Retry de requests (`fetchWithRetry`).
  - Carga de datasets en KV (`subte-lines`, `subte-stations`, `train-lines`, `train-stations`) con normalización legacy/v2.
  - Resolución de IDs de estación SOFSE: usa `sofseStationId` del KV si existe; si no, busca por nombre en
    `/infraestructura/estaciones` y elige la mejor coincidencia (con cache y cache negativo de fallos).
  - Fetch de arribos SOFSE por estación con cache TTL.
  - Refresh de subte/ecobici bajo demanda.

- `js/app/consent.js`
  - Banner de consentimiento; inyecta Google Analytics solo tras aceptar.

- `js/app/error-reporter.js`
  - Se carga justo después de `config.js`. Envía errores JS no capturados a `POST /client-errors` (ver Privacidad).

- `js/app/ui.js`
  - Interacciones de panel, estado de conexión (`LIVE/ERROR/CARGANDO`), install prompt y geolocalización.

- `js/features/*`
  - `subte.js`: indexación y helpers de pronóstico subte.
  - `alerts.js`: carga y render de alertas (JSON del worker; si la ruta no existe, parseo del feed como texto).
  - `markers-bus-overlay.js`: búsqueda de colectivos y overlay de recorridos (primero `data/routes/`, después el worker).
  - `markers-ui.js`: factory de markers y tooltips (incluye arribos SOFSE en hover/click para tren).
  - `markers.js`: render principal de capas por tipo.

- `js/shared/utils.js`
  - Utilidades de formato, normalización y color.

## Flujo de datos
1. Al iniciar, se inicializa el mapa y se dispara refresco.
2. Colectivos se consulta primero con retry (1s entre intentos) y refresco periódico (`UPDATE_INTERVAL`).
3. Subte/Tren/EcoBici se cargan al activar cada botón:
   - Subte: KV + pronóstico GTFS.
   - Tren: KV (+ búsqueda por nombre en SOFSE si una estación no trae `sofseStationId`).
   - EcoBici: station info (cacheada 1 h, `TIMEOUTS.bikeStationInfoTtlMs`) + station status en cada refresco.
4. En tren, en cada refresco se piden `/trenes/arribosLinea?linea=...` para las líneas en vista (hasta
   `FEATURES.trainLiveMaxLines`). Si el worker no tiene esa ruta (404), se vuelve al pedido por estación
   (`/arribos/estacion/{id}`) al abrir el tooltip.
5. Recorridos de colectivo: si existe `data/routes/index.json` (un `HEAD` por sesión) se usan los JSON estáticos
   por línea; el `route_id` del tiempo real elige el shape exacto y, si no está, se usa la variante de la misma
   línea y sentido más cercana al vehículo. Sin archivos estáticos se usan `/info-trayecto` y `/buscar-linea`.
6. `renderMarkers()` dibuja capas según filtros, viewport y tipos activos.

## Endpoints usados
Base: `https://transporte-be.papamasro.workers.dev`

- Colectivos
  - `/colectivos/vehiclePositionsSimple`
  - `/info-trayecto?route_id=...&tip_id=...&direction=...`
  - `/buscar-linea?numero=...`
  - `/colectivos/serviceAlerts` (crudo) y `/colectivos/serviceAlertsJson` (decodificado, cache 60 s)
- Subte
  - `/subtes/forecastGTFS`
  - `/subtes/serviceAlerts` (crudo) y `/subtes/serviceAlertsJson` (decodificado, cache 60 s)
- Trenes
  - `/trenes/arribosLinea?linea=<id KV>`: arribos de todas las estaciones de la línea (cache 25 s, stale si SOFSE falla)
- Monitoreo
  - `POST /client-errors` (ver Privacidad)
- EcoBici
  - `/ecobici/gbfs/stationInformation`
  - `/ecobici/gbfs/stationStatus`
- KV (Cloudflare Worker)
  - `/obtener-kv?clave=subte-lines`
  - `/obtener-kv?clave=subte-stations`
  - `/obtener-kv?clave=train-lines`
  - `/obtener-kv?clave=train-stations`
- SOFSE vía Worker (configurable)
  - Base default: `https://transporte-be.papamasro.workers.dev/trenes`
  - `.../infraestructura/ramales?idGerencia=...`
  - `.../infraestructura/estaciones?nombre=...`
  - `.../arribos/estacion/{id}?ramal=...&cantidad=6&paraApp=true`

## Configuración
Toda la configuración está en `js/app/config.js` (incluye la URL base del backend y todos los paths,
p. ej. `PATHS.bikeRoutes` para `/obtener-bicisenda`).

## CSS (Tailwind) y dependencias de front
El sitio se publica como archivos estáticos, sin build en el deploy. Por eso el CSS de Tailwind
se genera localmente y **se commitea** en `assets/styles/tailwind.css`.

```bash
npm install          # una vez (instala tailwindcss 3.4.17 fijado)
npm run build:css    # regenera assets/styles/tailwind.css (minificado)
npm run watch:css    # opcional, regenera al guardar
```

- Hay que correr `npm run build:css` y commitear el resultado **cada vez que se agreguen clases nuevas**
  en `index.html` o en `js/**/*.js` (las clases dentro de template strings también se detectan).
- Las clases deben escribirse completas y literales: `bg-${color}-500` no se genera. Si hace falta una
  clase dinámica, agregarla al `safelist` de `tailwind.config.js`.
- Orden de carga en `index.html`: `leaflet.css` → `tailwind.css` → `main.css` (los overrides de `main.css` ganan).
- Leaflet y Lucide están en `assets/vendor/<lib>-<versión>/` (copias exactas del paquete npm). Para actualizarlos,
  bajar la nueva versión con `npm pack <lib>@<versión>`, copiar los archivos de `dist/` (en Leaflet, también `images/`)
  a una carpeta con la nueva versión y actualizar las rutas en `index.html`.
- Todos los `<script>` de `index.html` usan `defer`; si se agrega uno nuevo, también debe llevar `defer` para
  mantener el orden de ejecución.

## Tests y CI
- `npm test` = `test:unit` + `test:worker` + `test:e2e`. Requiere `npm ci` y `npx playwright install chromium`.
- `npm run test:unit`: `node:test` en `tests/unit/` (utils, feature flags, ingesta de la animación) cargando los
  scripts clásicos en un `vm`.
- `npm run test:e2e`: Playwright (chromium, proyectos `mobile` 390×844 táctil y `desktop` 1440×900). Levanta
  `tests/server.mjs` sirviendo el repo bajo `/transporte/` (puerto `E2E_PORT`, default 8141). Backend, tiles, GA y
  `data/routes/` se mockean con fixtures sintéticos (`tests/fixtures/`): no sale ningún request a internet.
- `npm run test:worker`: tests unitarios del worker (sin wrangler).
- `.github/workflows/ci.yml` (PRs y push a `main`): verifica que `tailwind.css` esté regenerado, `node --check`,
  unit tests, tests del worker y e2e; si falla sube `playwright-report/` como artefacto.

## Feature flags y polling
- `js/app/feature-flags.config.js` (todo `true` por defecto) se mezcla sobre los defaults de `js/app/feature-flags.js`.
  Un flag apagado oculta su UI (clase `.feature-off`) y evita su fetch. `busAnimation` controla la animación.
- Intervalos en `APP_CONFIG.POLLING` (`config.js`): colectivos 30 s solo con la capa activa y zoom ≥ `busMinZoom`
  (o una búsqueda); subte/ecobici/trenes 60 s; panel de cercanos 30 s. Con la pestaña oculta no hay polling.

## Pipeline multiagente (CI)
`.github/workflows/multi-agent-pipeline.yml` corre `scripts/agent-qa.mjs` → `agent-lead.mjs` → `agent-coder.mjs`
(Gemini, `@google/genai` fijado en `package-lock.json`) sobre el diff y publica el reporte como comentario en el PR.

- Requiere el secret `GEMINI_API_KEY`; si no está (p. ej. PRs desde forks) el pipeline se omite.
- El comentario es contenido generado por IA: nunca se ejecuta y se marca como tal.
- Prueba local: `git diff > /tmp/diff.txt && GEMINI_API_KEY=... CODE_CONTEXT_FILE=/tmp/diff.txt AGENT_OUTPUT_DIR=/tmp/agents node scripts/agent-qa.mjs`
  (modelo configurable con `GEMINI_MODEL`, default `gemini-2.5-flash`).

## Estructura del proyecto
Resumen rápido:

- `index.html`
- `manifest.webmanifest`
- `sw.js`
- `assets/`
  - `icons/`
  - `styles/main.css`
  - `styles/tailwind.css` (generado con `npm run build:css`)
  - `vendor/` (Leaflet y Lucide self-hosted)
- `js/`
  - `app/`
  - `features/`
  - `shared/`
- `scripts/`


## PWA
- Manifest: `manifest.webmanifest`
- Service worker: `sw.js` (registrado con ruta/scope relativos `./`, funciona bajo un subpath).
  - Precachea el app shell (`PRECACHE_PATHS`): HTML, manifest, íconos, CSS, JS y vendor.
  - Assets estáticos del mismo origen: stale-while-revalidate. Navegación: network-first con fallback a `index.html` cacheado.
  - `data/routes/*.json`: no se precachean; stale-while-revalidate en un cache aparte (`radar-amba-data-v1`,
    máx. 80 archivos) que sobrevive a los cambios de `CACHE_VERSION`.
  - Backend (`transporte-be.*.workers.dev`), tiles del mapa y demás requests cross-origin no pasan por el cache del SW.
  - **En cada deploy que cambie archivos del shell, subir `CACHE_VERSION` en `sw.js`.** Si se agrega/quita un
    `<script>`/`<link>` en `index.html`, actualizar también `PRECACHE_PATHS` (si falta un archivo, la instalación falla).
- Íconos: `assets/icons/*`

## Notas de mantenimiento
- Si cambiás claves KV, endpoints o la URL base del backend, actualizar en `js/app/config.js`.
- Si agregás un nuevo tipo de capa, seguir patrón:
  - fetch en `services.js`
  - estado/orquestación en `bootstrap.js`
  - render en `features/markers.js` + `markers-ui.js`.

## Scripts
- `scripts/loadBusSQL.py`: convierte archivos GTFS (`stops.txt`, `routes.txt`, `trips.txt`, `shapes.txt`,
  `stop_times.txt`) del directorio actual en `.sql` con `INSERT` por lotes. Valida los campos numéricos
  (las filas inválidas se omiten con aviso). Uso: `python3 scripts/loadBusSQL.py` desde la carpeta del GTFS.
- `scripts/train-lines-redis.json` / `scripts/train-stations-redis.json`: snapshot de los datasets de tren
  (formato v3, con `sofseStationId`) que se cargan en las claves KV `train-lines` / `train-stations`.
- `scripts/agent-*.mjs`: pipeline multiagente de CI (ver arriba).
- `scripts/build-static-routes.py`: genera `data/routes/` (un JSON por línea + `index.json`) desde el GTFS de
  colectivos del GCBA (solo stdlib). Shapes simplificados con Douglas-Peucker (7 m) y codificados como polyline
  (precisión 5), paradas del viaje más completo de cada shape y mapa `route_id → sentido → shape`
  (en el GTFS "horarios" cada `route_id` es un ramal+sentido con un único shape, el mismo id que usa el tiempo real).
  Hay que regenerarlo cada vez que el GCBA publica un GTFS nuevo: los `route_id` cambian entre versiones.

  ```bash
  # GTFS (≈200 MB): https://apitransporte.buenosaires.gob.ar/colectivos/feed-gtfs?client_id=...&client_secret=...
  curl -sS -o /tmp/gtfs.zip "https://apitransporte.buenosaires.gob.ar/colectivos/feed-gtfs?client_id=$GCBA_CLIENT_ID&client_secret=$GCBA_CLIENT_SECRET"
  curl -sS -o /tmp/live.json https://transporte-be.papamasro.workers.dev/colectivos/vehiclePositionsSimple
  python3 scripts/build-static-routes.py --gtfs /tmp/gtfs.zip --realtime-sample /tmp/live.json
  ```

  `--realtime-sample` imprime cuántos vehículos en vivo matchean por `route_id`; si da cerca de 0 %, el GTFS no es
  la misma versión que el feed en vivo. Test: `python3 scripts/test_build_static_routes.py`.

## Worker (`worker/`)
- `cd worker && npm install`, `npm run test:unit` (sin red) y `npm run dev` + `npm run test:local` (ver
  `worker/test/mock-upstream.mjs` para correrlo contra un upstream simulado).
- Secrets: `GCBA_CLIENT_ID` / `GCBA_CLIENT_SECRET` con `wrangler secret put`; en local, `worker/.dev.vars`
  (ignorado por git, ver `.dev.vars.example`).
- Deploy: `cd worker && npx wrangler deploy`.

## Privacidad
- Google Analytics solo se carga si el usuario acepta en el banner de consentimiento (`js/app/consent.js`).
  La elección se guarda en `localStorage` (`radaramba.analytics-consent-v1`) y se puede cambiar desde
  "Privacidad y estadísticas" en el panel. Respeta el flag `analytics` si `feature-flags.js` está cargado.
- La última ubicación del usuario se guarda en `localStorage` y se borra al cargar si tiene más de 7 días.
- Reporte de errores (`js/app/error-reporter.js`): es funcional, no analytics, así que no depende del banner.
  Solo envía errores JS no capturados (mensaje, archivo/línea, stack recortado, user agent, versión de la app y
  la URL sin query ni hash), con números de muchos decimales (coordenadas) reemplazados por `<num>`. No manda
  ubicación, IDs de usuario ni cookies. Máximo 5 por sesión, sin duplicados, desactivado en localhost
  (`APP_CONFIG.ERROR_REPORTING`). El worker solo los escribe en los logs de Cloudflare (no se guardan en KV/D1).
