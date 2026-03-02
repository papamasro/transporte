# Estructura del proyecto

## Raíz
- `index.html`: entrada principal de la app.
- `manifest.webmanifest`: configuración PWA.
- `sw.js`: service worker.
- `scripts/`: utilidades auxiliares (por ejemplo ETL/carga de datos).

## Assets
- `assets/icons/`: todos los íconos (`icon-192.png`, `icon-512.png`, `icon.svg`).
- `assets/styles/main.css`: estilos globales de la UI.

## JavaScript
- `js/app/ui.js`: funciones de interfaz (panel, badge de estado, instalación, geolocalización).
- `js/app/services.js`: llamadas HTTP, reintentos y carga de datos (colectivos/KV/subte/ecobici).
- `js/app/bootstrap.js`: estado/config global + inicialización de mapa y orquestación principal.
- `js/shared/utils.js`: funciones utilitarias reutilizables (formatos, colores, helpers).
- `js/features/markers.js`: render de capas y marcadores.
- `js/features/subte.js`: lógica de pronósticos/subte.
- `js/features/alerts.js`: panel y parseo de alertas.

## Convención rápida
- `app/` = arranque y coordinación.
- `features/` = módulos de negocio/funcionalidad.
- `shared/` = helpers transversales.
- `assets/` = recursos estáticos.
