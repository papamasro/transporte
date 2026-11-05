# [BUG-002] Horarios y ETA de Subtes desfasados o erróneos en los tooltips

- **Componente:** `js/features/subte.js` / `js/features/markers-ui.js` (`buildSubteTooltip`) / `js/shared/utils.js` (`formatEtaMinutes`, `formatTimestamp`)
- **Severidad:** 🟠 Media-Alta (Información confusa / inconsistente)
- **Estado:** ✅ Resuelto (regresión en el panel de cercanos corregida el 2026-11-04)

---

## 1. Descripción del problema
Al abrir una estación de subte, los arribos pronosticados mostraban tiempos inconsistentes (minutos negativos, arribos desfasados con la hora real o etiquetas "Próximo" permanentes).

## 2. Causa técnica
En `buildSubteTooltip`:
`referenceTs = globalThis.cache.subteTimestamp || Math.floor(Date.now() / 1000)`
`subteTimestamp` reflejaba la marca de tiempo de cuando el worker procesó el feed, arrastrando retrasos y diferencias de zona horaria contra el reloj local del dispositivo del usuario.

## 3. Solución implementada
1. Se sincronizó el cálculo del ETA para que siempre se contraste contra el tiempo real del cliente `Math.floor(Date.now() / 1000)`.
2. Se filtran automáticamente arribos que ya pasaron (`arrivalTime < ahora - 60s`).
3. `formatTimestamp` formatea las horas asegurando la zona horaria de Buenos Aires (`America/Argentina/Buenos_Aires`).

## 4. Seguimiento (2026-11-04)
La misma causa seguía presente en el panel de cercanos:

- `getSubteEtaInfo` (`js/features/nearby.js`) usaba `subteTimestamp` como "ahora". Ahora usa `Date.now()`.
- Con cercanos abierto el filtro de subte queda apagado, así que el forecast nunca se refrescaba y aparecían arribos que ya habían pasado. Ahora se vuelve a pedir si tiene más de 60 s (`cache.subteFetchedAt`).
- `getEtaMinutes` no reconocía "Próximo" (lo que devuelve `formatEtaMinutes`), así que el subte que estaba llegando quedaba último. Los ítems ahora llevan `etaMinutes` numérico.
