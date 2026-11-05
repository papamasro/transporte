# [SEGURIDAD-007] Rotar credenciales de GCBA y limpiar el historial de git

- **Componente:** credenciales GCBA / `git stash` / historial de `origin/main`
- **Severidad:** 🔴 Alta
- **Estado:** ⏳ Pendiente

---

## 1. Descripción del problema
- Las credenciales de GCBA (`API_KEY` / `API_SECRET`) estuvieron en texto plano en `worker/index.js` y `worker/index-monolithic.js`. No llegaron a ninguna rama, pero siguen en `stash@{0}` (commit `2b8fddf`).
- El commit `1e8b7e8` ("add train and db"), publicado en `origin/main`, subió `node_modules/` completo: un binario `workerd` de ~100 MB y `node_modules/.cache/wrangler/wrangler-account.json`, con el id y el nombre de la cuenta de Cloudflare. Se borró en `ebb02ab`, pero sigue en el historial.

## 2. Estado actual
- El worker ya lee `env.GCBA_CLIENT_ID` y `env.GCBA_CLIENT_SECRET`.
- `.gitignore` ignora `node_modules/`, `.wrangler/`, `.env*` y `worker/.dev.vars`.

## 3. Pasos
1. Rotar las credenciales en GCBA y cargarlas con `npx wrangler secret put`.
2. `git stash drop` cuando ya no se necesite el stash.
3. Opcional (reescribe historial publicado y requiere force-push): `git filter-repo --path node_modules --invert-paths`, avisando a cualquiera que tenga un clon.
