import { GoogleGenAI } from '@google/genai';
import * as fs from 'fs';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function runLeadAgent() {
  console.log('🏗️ [2/3] Agente Team Lead: Evaluando tickets de QA y priorizando el backlog técnico...');

  let qaReport = '';
  if (fs.existsSync('qa-report.md')) {
    qaReport = fs.readFileSync('qa-report.md', 'utf-8');
  } else if (fs.existsSync('business-report.md')) {
    qaReport = fs.readFileSync('business-report.md', 'utf-8');
  }

  const codebase = process.env.CODE_CONTEXT || 'No hay contexto disponible.';

  const prompt = `
    Sos un Tech Lead & Software Architect experto en desarrollo web Frontend (HTML5, CSS3, JS Vanilla, Leaflet) y performance.
    
    Revisá el reporte de tickets del Agente QA y comparalo con el código para priorizar las tareas y armar el plan técnico.

    Reporte de QA:
    ${qaReport}

    Código / Contexto:
    \`\`\`text
    ${codebase.slice(0, 15000)}
    \`\`\`

    Estructurá tu salida así:
    ## 📐 Plan Técnico de Arquitectura & Priorización (Team Lead)
    1. **Matriz de Priorización:**
       - **P0 (Inmediato / Blocker UX):** [Tickets a resolver primero]
       - **P1 (Alta Prioridad):** [Tickets de consistencia y datos]
       - **P2 (Media Prioridad / Mejoras):** [Mejoras visuales o features secundarias]
    2. **Estrategia Técnica de Refactorización:** [Qué archivos modificar, qué funciones alterar, patrones KISS/SOLID]
    3. **Instrucciones Directas para el Senior Frontend Developer:** [Paso a paso exacto para implementar cada fix]
  `;

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: prompt,
  });

  fs.writeFileSync('lead-plan.md', response.text);
  console.log('✅ Agente Team Lead finalizado. Plan guardado en lead-plan.md');
}

runLeadAgent().catch(console.error);
