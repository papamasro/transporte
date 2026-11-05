import {
  UNTRUSTED_NOTICE,
  generate,
  readCodeContext,
  readOutput,
  runAgent,
  untrustedBlock,
  writeOutput,
} from './agent-common.mjs';

async function runLeadAgent() {
  console.log('🏗️ [2/3] Agente Team Lead: Evaluando tickets de QA y priorizando el backlog técnico...');

  const qaReport = readOutput('qa-report.md') || 'No hay reporte de QA disponible.';
  const codebase = readCodeContext(15000);

  const prompt = `
    Sos un Tech Lead & Software Architect experto en desarrollo web Frontend (HTML5, CSS3, JS Vanilla, Leaflet) y performance.
    
    Revisá el reporte de tickets del Agente QA y comparalo con el código para priorizar las tareas y armar el plan técnico.

    ${UNTRUSTED_NOTICE}

    Reporte de QA:
    ${untrustedBlock('REPORTE_QA', qaReport)}

    Código / Contexto (diff):
    ${untrustedBlock('DIFF', codebase)}

    Estructurá tu salida así:
    ## 📐 Plan Técnico de Arquitectura & Priorización (Team Lead)
    1. **Matriz de Priorización:**
       - **P0 (Inmediato / Blocker UX):** [Tickets a resolver primero]
       - **P1 (Alta Prioridad):** [Tickets de consistencia y datos]
       - **P2 (Media Prioridad / Mejoras):** [Mejoras visuales o features secundarias]
    2. **Estrategia Técnica de Refactorización:** [Qué archivos modificar, qué funciones alterar, patrones KISS/SOLID]
    3. **Instrucciones Directas para el Senior Frontend Developer:** [Paso a paso exacto para implementar cada fix]
  `;

  const plan = await generate(prompt);
  const target = writeOutput('lead-plan.md', plan);
  console.log(`✅ Agente Team Lead finalizado. Plan guardado en ${target}`);
}

runAgent(runLeadAgent);
