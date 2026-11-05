# [FEATURE-013] Estado del subte por línea

- **Componente:** `js/features/subte.js` / `js/features/markers.js` / `js/features/alerts.js` / worker (`/subtes/serviceAlertsJson`)
- **Severidad:** 🟢 Baja (feature nueva)
- **Estado:** ⏳ Pendiente

---

## 1. Descripción
El estado de cada línea (normal, servicio limitado, interrumpida) solo aparece mezclado dentro del panel de alertas.

## 2. Solución propuesta
Usar `informed_entity.route_id` de `/subtes/serviceAlertsJson` para marcar cada línea con un indicador en el mapa y en el filtro de líneas, con el texto de la alerta en el tooltip.
