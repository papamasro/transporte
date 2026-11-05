# [BUG-003] Ausencia de formaciones de trenes en movimiento sobre el mapa

- **Componente:** `js/features/markers.js` (`renderTrainLayer`) / `js/app/bootstrap.js` (`layers.trainVehicles`) / `assets/styles/main.css` (`.train-moving-badge`)
- **Severidad:** 🟡 Media (Feature incompleta)
- **Estado:** ✅ Resuelto (reabierto y corregido el 2026-11-04; el endpoint por línea requiere deploy del worker)

---

## 1. Descripción del problema
El usuario esperaba ver trenes desplazándose visualmente sobre las vías en tiempo real, pero solo se dibujaban las vías estáticas y los marcadores fijos de estaciones.

## 2. Causa técnica
SOFSE (Trenes Argentinos) no expone coordenadas GPS en vivo para formaciones individuales; solo expone el cronograma de arribos estimados por estación (`/arribos/estacion/{id}`). No existía ninguna capa ni cálculo para proyectar formaciones visuales.

## 3. Solución implementada
1. Se creó una nueva capa `layers.trainVehicles` conectada al mapa.
2. En `renderTrainLayer()`, se implementó la proyección dinámica de formaciones sobre las vías: para cada estación con arribo programado en los próximos 15 minutos, se dibuja un marcador de tren (`🚆 En X min`) interpolando su posición a lo largo de las vías hacia la estación.
3. Se agregaron tooltips informativos que detallan el destino, próxima estación, andén y tiempo estimado de llegada.

## 4. Seguimiento (2026-11-04)
La solución anterior nunca llegó a dibujar trenes:

1. **Clave equivocada:** `renderTrainLayer()` leía `arrivalData.arribos`, pero el caché guarda `{ data: { arrivals: [...] } }`. El array siempre quedaba vacío. Se corrigió a `arrivals`, y el ETA se recalcula contra el reloj actual (`estimatedArrivalTs - ahora`) porque el caché puede estar viejo.
2. **Caché incompleto:** los arribos solo se cargaban al abrir el popup de una estación o desde cercanos (hasta 4 estaciones), así que la capa nunca mostraba la red. El worker ahora expone `/trenes/arribosLinea?linea=<id>`, que junta los arribos de todas las estaciones de una línea con caché de 25 s. El frontend lo pide para hasta 4 líneas en vista y, si da 404 (worker sin desplegar), vuelve al pedido por estación.

**Limitaciones conocidas:**
- Las posiciones son interpoladas a partir de ETAs, no son GPS. Convendría aclararlo en la interfaz.
- La interpolación siempre asume que el tren viene desde la estación anterior de la lista, sin importar el sentido.
- `/trenes/arribosLinea` necesita que las estaciones del KV tengan `sofseStationId` y `sofseRamalId`.
