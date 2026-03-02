# Estructura del proyecto

> Para explicación funcional y arquitectura completa, ver [README.md](README.md).

## Raíz
- `index.html`: entrypoint del frontend.
- `manifest.webmanifest`: configuración PWA.
- `sw.js`: service worker.
- `README.md`: documentación general del proyecto.
- `STRUCTURE.md`: mapa rápido de carpetas y módulos.
- `scripts/`: utilidades de soporte (ej: carga/transformación de datos).

## Assets
- `assets/icons/`: íconos de app (`icon-192.png`, `icon-512.png`, `icon.svg`).
- `assets/styles/main.css`: estilos globales.

## JavaScript
- `js/app/bootstrap.js`: estado global + inicialización + orquestación.
- `js/app/services.js`: fetch/retry + carga de datos backend/KV.
- `js/app/ui.js`: interacciones UI (panel, status, instalación, geolocalización).
- `js/shared/utils.js`: helpers reutilizables.
- `js/features/subte.js`: helpers/indexación de pronóstico subte.
- `js/features/alerts.js`: carga y render de alertas.
- `js/features/markers-bus-overlay.js`: overlay de recorridos de colectivos.
- `js/features/markers-ui.js`: tooltips y creación de marcadores.
- `js/features/markers.js`: render de capas visibles (bus/subte/tren/bici).

## Convenciones
- `app/`: coordinación general de la aplicación.
- `features/`: lógica funcional por dominio.
- `shared/`: utilidades comunes.
- `assets/`: recursos estáticos.
