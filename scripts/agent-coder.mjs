import { GoogleGenAI } from '@google/genai';
import * as fs from 'fs';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function runCoderAgent() {
  console.log('💻 [3/3] Agente Senior Frontend Dev: Implementando correcciones según plan del TL...');

  const leadPlan = fs.readFileSync('lead-plan.md', 'utf-8');
  const codebase = process.env.CODE_CONTEXT || 'No hay contexto disponible.';

  const prompt = `
    Sos un Senior Frontend Developer experto en HTML5 semántico, CSS moderno y JavaScript limpio (KISS, SOLID).
    Tu trabajo es implementar las soluciones especificadas en el Plan Técnico del Team Lead.

    Plan del Team Lead:
    ${leadPlan}

    Código / Contexto:
    \`\`\`text
    ${codebase.slice(0, 15000)}
    \`\`\`

    Generá los bloques de código corregidos, refactorizados y listos para producción.
    Especificá para cada archivo:
    - Ruta del archivo
    - Bloque de código original vs bloque reemplazado
    - Explicación breve de la mejora aplicada
  `;

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: prompt,
  });

  const qaReport = fs.existsSync('qa-report.md') ? fs.readFileSync('qa-report.md', 'utf-8') : '';
  const fullReport = `# 🤖 Reporte Consolidado del Pipeline Multagente\n\n` +
    `${qaReport}\n\n---\n\n` +
    `${leadPlan}\n\n---\n\n` +
    `## 💻 Solución e Implementación (Senior Dev)\n\n${response.text}`;

  fs.writeFileSync('FINAL_MULTIAGENT_REPORT.md', fullReport);
  console.log('✅ Agente Coder finalizado. Reporte consolidado en FINAL_MULTIAGENT_REPORT.md');
}

runCoderAgent().catch(console.error);
