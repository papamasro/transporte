import {
  MODEL,
  UNTRUSTED_NOTICE,
  generate,
  readCodeContext,
  readOutput,
  runAgent,
  untrustedBlock,
  writeOutput,
} from './agent-common.mjs';

async function runCoderAgent() {
  console.log('💻 [3/3] Agente Senior Frontend Dev: Implementando correcciones según plan del TL...');

  const qaReport = readOutput('qa-report.md');
  const leadPlan = readOutput('lead-plan.md');
  const codebase = readCodeContext(15000);

  const prompt = `
    Sos un Senior Frontend Developer experto en HTML5 semántico, CSS moderno y JavaScript limpio (KISS, SOLID).
    Tu trabajo es proponer las soluciones especificadas en el Plan Técnico del Team Lead.

    ${UNTRUSTED_NOTICE}

    Plan del Team Lead:
    ${untrustedBlock('PLAN_TL', leadPlan || 'No hay plan del Team Lead disponible; basate sólo en el diff.')}

    Código / Contexto (diff):
    ${untrustedBlock('DIFF', codebase)}

    Generá los bloques de código corregidos y refactorizados como propuesta para revisión humana.
    Especificá para cada archivo:
    - Ruta del archivo
    - Bloque de código original vs bloque reemplazado
    - Explicación breve de la mejora aplicada
  `;

  const solution = await generate(prompt);

  const sections = [
    `# 🤖 Reporte Consolidado del Pipeline Multagente\n\n_Modelo: \`${MODEL}\`_`,
    qaReport || '_Sin reporte de QA._',
    leadPlan || '_Sin plan del Team Lead._',
    `## 💻 Propuesta de Implementación (Senior Dev)\n\n${solution}`,
  ];
  const target = writeOutput('FINAL_MULTIAGENT_REPORT.md', sections.join('\n\n---\n\n'));
  console.log(`✅ Agente Coder finalizado. Reporte consolidado en ${target}`);
}

runAgent(runCoderAgent);
