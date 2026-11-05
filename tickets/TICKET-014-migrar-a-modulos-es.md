# [REFACTOR-014] Migrar de scripts globales a módulos ES

- **Componente:** `js/**` / `index.html` / `sw.js` (`PRECACHE_PATHS`)
- **Severidad:** 🟢 Baja
- **Estado:** ⏳ Pendiente

---

## 1. Descripción del problema
Los scripts son clásicos con `defer` y comparten más de 20 variables globales (`cache`, `layers`, `activeTypes`, `nearbyState`, etc.). El orden de carga en `index.html` importa, y es fácil romper algo al mover código.

## 2. Solución propuesta
Migrar de a un archivo por vez a `<script type="module">` con imports explícitos y un store de estado con eventos, apoyándose en los tests e2e para detectar regresiones. Actualizar `PRECACHE_PATHS` y el test que lo compara con `index.html`.
