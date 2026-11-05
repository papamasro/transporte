# [DECISIÓN-012] Revisar si se mantiene el pipeline de agentes de IA en los PRs

- **Componente:** `.github/workflows/multi-agent-pipeline.yml` / `scripts/agent-*.mjs`
- **Severidad:** 🟢 Baja
- **Estado:** ⏳ Pendiente de decisión

---

## 1. Contexto
El pipeline corre tres agentes de Gemini (QA, Lead, Coder) en cada PR y publica un comentario. Consume la API key de Gemini, y ahora `ci.yml` corre tests reales (unitarios, worker y e2e).

## 2. Opciones
- Mantenerlo tal cual (ya está endurecido: permisos mínimos, diff por archivo, actions fijadas por SHA, aviso de contenido generado).
- Correrlo solo a pedido (`workflow_dispatch` o un label en el PR).
- Eliminarlo.
