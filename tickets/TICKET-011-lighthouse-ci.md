# [MEJORA-011] Lighthouse en CI

- **Componente:** `.github/workflows/ci.yml`
- **Severidad:** 🟢 Baja
- **Estado:** ⏳ Pendiente

---

## 1. Descripción del problema
Los tests e2e cubren funcionalidad, pero una regresión de rendimiento, accesibilidad o PWA no hace fallar el PR.

## 2. Solución propuesta
Agregar un job con Lighthouse CI contra el sitio servido bajo `/transporte/` con el backend mockeado (como en Playwright), con umbrales mínimos para Performance, Accessibility, Best Practices y PWA, y subir el reporte como artefacto.
