# [BUG-003] Ausencia de formaciones de trenes en movimiento sobre el mapa

- **Componente:** `js/features/markers.js` (`renderTrainLayer`) / `js/app/bootstrap.js` (`layers.trainVehicles`) / `assets/styles/main.css` (`.train-moving-badge`)
- **Severidad:** 🟡 Media (Feature incompleta)
- **Estado:** ✅ Resuelto

---

## 1. Descripción del problema
El usuario esperaba ver trenes desplazándose visualmente sobre las vías en tiempo real, pero solo se dibujaban las vías estáticas y los marcadores fijos de estaciones.

## 2. Causa técnica
SOFSE (Trenes Argentinos) no expone coordenadas GPS en vivo para formaciones individuales; solo expone el cronograma de arribos estimados por estación (`/arribos/estacion/{id}`). No existía ninguna capa ni cálculo para proyectar formaciones visuales.

## 3. Solución implementada
1. Se creó una nueva capa `layers.trainVehicles` conectada al mapa.
2. En `renderTrainLayer()`, se implementó la proyección dinámica de formaciones sobre las vías: para cada estación con arribo programado en los próximos 15 minutos, se dibuja un marcador de tren (`🚆 En X min`) interpolando su posición a lo largo de las vías hacia la estación.
3. Se agregaron tooltips informativos que detallan el destino, próxima estación, andén y tiempo estimado de llegada.
