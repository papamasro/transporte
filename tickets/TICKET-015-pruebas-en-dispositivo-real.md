# [QA-015] Pruebas en dispositivos reales

- **Componente:** toda la app
- **Severidad:** 🟠 Media
- **Estado:** ⏳ Pendiente

---

## 1. Descripción
Los tests corren en Chrome headless con datos simulados. Estos casos no se pueden reproducir bien así:

- Permiso real de GPS: denegado, lento y reintento.
- Instalación: Android con `beforeinstallprompt` real e iOS con "Agregar a inicio" (ícono maskable incluido).
- Rendimiento y animación con más de 1000 colectivos en un Android de gama baja.
- Safari en iOS: `100vh` con la barra dinámica y la safe-area cerca del indicador de inicio.
- Volver de segundo plano: que el refresco se pause y se retome.
- Actualización del service worker en GitHub Pages (cachea unos 10 min) al subir `CACHE_VERSION`.
- Mensaje "ACERCÁ PARA VER COLECTIVOS" con zoom menor a 12 (comportamiento nuevo).
