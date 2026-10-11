import { GoogleGenAI } from '@google/genai';
import * as fs from 'fs';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function runCoderAgent() {
  console.log('💻 [3/3] Agente Senior Frontend Dev: Escribiendo refactor y solución...');

  const leadPlan = fs.readFileSync('lead-plan.md', 'utf-8');
  const codebase = process.env.CODE_CONTEXT || 'No hay contexto disponible.';

  const prompt = `
    Sos un Senior Frontend Developer experto en HTML5 semántico, CSS moderno y JavaScript limpio.
    Tu trabajo es implementar las soluciones especificadas en el Plan del Team Lead.

    Plan Técnico del Lead:
    ${leadPlan}

    Código / Archivos sobre los que trabajar:
    \`\`\`text
    ${codebase.slice(0, 12000)}
    \`\`\`

    Generá los bloques de código corregidos, refactorizados y optimizados.
    Estructurá tu respuesta en Markdown incluyendo fragmentos de código listos para copiar y pegar o integrar.
  `;

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: prompt,
  });

  // Consolida todo en un reporte final
  const businessReport = fs.readFileSync('business-report.md', 'utf-8');
  const fullReport = `# 🤖 Reporte de Auditoría y Refactorización Multagente\n\n` +
    `${businessReport}\n\n---\n\n` +
    `${leadPlan}\n\n---\n\n` +
    `## 💻 Solución e Implementación (Senior Dev)\n\n${response.text}`;

  fs.writeFileSync('FINAL_MULTIAGENT_REPORT.md', fullReport);
  console.log('✅ Agente Coder finalizado. Reporte consolidado en FINAL_MULTIAGENT_REPORT.md');
}

runCoderAgent().catch(console.error);
