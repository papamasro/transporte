# [MEJORA-010] Métricas agregadas de errores del cliente

- **Componente:** `worker/index.js` (`POST /client-errors`) / `js/app/error-reporter.js`
- **Severidad:** 🟢 Baja
- **Estado:** ⏳ Pendiente

---

## 1. Descripción del problema
Los errores que manda `error-reporter.js` solo quedan en los logs del worker (`wrangler tail` / Workers Logs). No hay forma de ver cuántos errores hay por día, por versión (`CACHE_VERSION`) o por mensaje.

## 2. Solución propuesta
Escribir cada reporte en Workers Analytics Engine (gratis en el plan Free, sin usar KV ni D1) con índices por mensaje, versión y fuente, y consultarlo con la SQL API de Analytics Engine.
