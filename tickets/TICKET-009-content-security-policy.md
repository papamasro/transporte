# [SEGURIDAD-009] Agregar Content Security Policy

- **Componente:** `index.html`
- **Severidad:** 🟡 Media
- **Estado:** ⏳ Pendiente

---

## 1. Descripción del problema
Los datos de las APIs ya se escapan antes de insertarse en el HTML (`escapeHtml` / `safeCssColor`), pero no hay una segunda barrera si algún punto queda sin escapar.

## 2. Solución propuesta
GitHub Pages no permite headers propios, así que va como `<meta http-equiv="Content-Security-Policy">`:
- `script-src 'self' https://www.googletagmanager.com` (Analytics solo después del consentimiento).
- `connect-src 'self'`, el `BACKEND_URL` y los dominios de Analytics.
- `img-src 'self' data:` y el dominio de los tiles de Esri.
- `style-src 'self'`, verificando antes si hay estilos inline que lo impidan.
- `frame-ancestors` no funciona en `meta`; queda sin cubrir en Pages.

Validar con los tests e2e y con la consola sin errores de CSP.
