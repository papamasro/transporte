# Radar AMBA

Dashboard web para visualizar transporte en tiempo real en AMBA:
- Colectivos en mapa (con búsqueda y overlay de recorrido).
- Subte y tren con datos estáticos en Cloudflare KV.
- EcoBici y panel de alertas.
- UI tipo PWA (instalable en mobile/escritorio).

## Stack
- Frontend: HTML + CSS + JavaScript vanilla.
- Mapa: Leaflet.
- UI: Tailwind CSS (CDN) + Lucide icons.
- Backend de datos: Worker en Cloudflare (`transporte-be`) + KV.

## Arquitectura (alto nivel)
La app se carga desde `index.html` y divide responsabilidades en módulos:

- `js/app/bootstrap.js`
  - Estado/config global (`BACKEND_URL`, `KV_KEYS`, `cache`, `layers`, etc.).
  - Inicialización de mapa y loop principal de refresco.
  - Orquestación de activación/desactivación de tipos (`bus/subte/train/bike`).

- `js/app/services.js`
  - HTTP helper (`fetchAPI`).
  - Retry de requests (`fetchWithRetry`).
  - Carga de datasets en KV (`subte-lines`, `subte-stations`, `train-lines`, `train-stations`).
  - Refresh de subte/ecobici bajo demanda.

- `js/app/ui.js`
  - Interacciones de panel, estado de conexión (`LIVE/ERROR/CARGANDO`), install prompt y geolocalización.

- `js/features/*`
  - `subte.js`: indexación y helpers de pronóstico subte.
  - `alerts.js`: carga y render de alertas.
  - `markers-bus-overlay.js`: búsqueda de colectivos y overlay de recorridos.
  - `markers-ui.js`: factory de markers y tooltips.
  - `markers.js`: render principal de capas por tipo.

- `js/shared/utils.js`
  - Utilidades de formato, normalización y color.

## Flujo de datos
1. Al iniciar, se inicializa el mapa y se dispara refresco.
2. Colectivos se consulta primero con retry (1s entre intentos) y refresco periódico (`UPDATE_INTERVAL`).
3. Subte/Tren/EcoBici se cargan al activar cada botón:
   - Subte: KV + pronóstico GTFS.
   - Tren: KV.
   - EcoBici: station info + station status.
4. `renderMarkers()` dibuja capas según filtros, viewport y tipos activos.

## Endpoints usados
Base: `https://transporte-be.papamasro.workers.dev`

- Colectivos
  - `/colectivos/vehiclePositionsSimple`
  - `/info-trayecto?route_id=...&tip_id=...&direction=...`
  - `/buscar-linea?numero=...`
  - `/colectivos/serviceAlerts`
- Subte
  - `/subtes/forecastGTFS`
  - `/subtes/serviceAlerts`
- EcoBici
  - `/ecobici/gbfs/stationInformation`
  - `/ecobici/gbfs/stationStatus`
- KV (Cloudflare Worker)
  - `/obtener-kv?clave=subte-lines`
  - `/obtener-kv?clave=subte-stations`
  - `/obtener-kv?clave=train-lines`
  - `/obtener-kv?clave=train-stations`

## Estructura del proyecto
Resumen rápido (detalle en `STRUCTURE.md`):

- `index.html`
- `manifest.webmanifest`
- `sw.js`
- `assets/`
  - `icons/`
  - `styles/main.css`
- `js/`
  - `app/`
  - `features/`
  - `shared/`
- `scripts/`


## PWA
- Manifest: `manifest.webmanifest`
- Service worker: `sw.js`
- Íconos: `assets/icons/*`

## Notas de mantenimiento
- Si cambiás claves KV o endpoint base, actualizar en `js/app/bootstrap.js`.
- Si agregás un nuevo tipo de capa, seguir patrón:
  - fetch en `services.js`
  - estado/orquestación en `bootstrap.js`
  - render en `features/markers.js` + `markers-ui.js`.
