# [SEGURIDAD-008] Rate limiting del worker contra consumo externo de cuota

- **Componente:** Cloudflare (reglas WAF) / `worker/index.js`
- **Severidad:** 🟠 Media
- **Estado:** ⏳ Pendiente

---

## 1. Descripción del problema
CORS solo frena a los navegadores. Cualquiera puede llamar al worker con `curl` o un script y consumir los 100k requests diarios del plan gratuito, o forzar consultas a D1 y a GCBA.

## 2. Solución propuesta
1. Regla de rate limiting de Cloudflare (el plan Free incluye una), por ejemplo 60 requests por minuto por IP sobre `transporte-be.papamasro.workers.dev/*`, con bloqueo de 1 minuto.
2. Revisar después del deploy con las métricas de Workers qué rutas concentran los requests y ajustar el umbral.
3. `POST /client-errors` ya tiene un límite en memoria por isolate (10/min por IP), que es aproximado.
