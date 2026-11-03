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
