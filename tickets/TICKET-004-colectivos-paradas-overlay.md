# [BUG-004] Paradas de colectivo incompletas o escasas al desplegar recorrido

- **Componente:** `js/features/markers-bus-overlay.js` (`renderLineSearchOverlay`)
- **Severidad:** 🟠 Media (Funcionalidad de trayecto incompleta)
- **Estado:** ✅ Resuelto

---

## 1. Descripción del problema
Al buscar una línea de colectivo (ej. "60", "152"), se dibujaba el trazado de la polilínea en el mapa pero no aparecía ninguna parada a lo largo del recorrido.

## 2. Causa técnica
`renderLineSearchOverlay()` recorría los recorridos devueltos por `/buscar-linea` y únicamente agregaba las polilíneas a `layers.busRoute`, omitiendo completamente el renderizado de paradas en `layers.busStops`.

## 3. Solución implementada
Se añadió el recorrido y dibujo automático de las paradas asociadas a cada variante en `renderLineSearchOverlay`, utilizando `circleMarker` con deduplicación por coordenadas para mostrar todas las paradas oficiales del ramal con sus nombres respectivos al pasar el cursor.

## 4. Seguimiento (2026-11-04)
El overlay ahora puede tomar recorridos y paradas de archivos estáticos (`data/routes/`, generados con `scripts/build-static-routes.py`) en lugar de `/buscar-linea` e `/info-trayecto`, que consumían la cuota de D1. Si los archivos no existen, vuelve al worker. Además:
- La búsqueda prioriza la coincidencia exacta: "60" muestra 60 y 60A, pero no 160 ni 600.
- Los recorridos se cachean 10 min (los vacíos o fallidos, 2 min) en lugar de invalidarse en cada refresco.
- El recorrido se oculta al cerrar el popup del colectivo, salvo que se haya abierto con una búsqueda de línea.

Ver [TICKET-006](TICKET-006-gtfs-actualizacion-automatica.md) para la generación de `data/routes/`.
