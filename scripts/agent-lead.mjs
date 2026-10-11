import { GoogleGenAI } from '@google/genai';
import * as fs from 'fs';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function runLeadAgent() {
  console.log('🏗️ [2/3] Agente Team Lead: Evaluando arquitectura y viabilidad técnica...');

  const businessReport = fs.readFileSync('business-report.md', 'utf-8');
  const codebase = process.env.CODE_CONTEXT || 'No hay contexto disponible.';

  const prompt = `
    Sos un Tech Lead & Software Architect experto en desarrollo web Frontend (HTML5, CSS3, JS Vanilla/ES modules) y performance web.
    
    Revisá la propuesta del Agente de Negocio y comparala con el código actual para definir la estrategia técnica.

    Propuesta de Negocio:
    ${businessReport}

    Código Actual / Diff:
    \`\`\`text
    ${codebase.slice(0, 12000)}
    \`\`\`

    Estructurá tu salida así:
    ## 📐 Plan Técnico de Arquitectura (Team Lead)
    1. **Evaluación de Deuda Técnica:** [Análisis técnico breve]
    2. **Estrategia de Refactorización:** [Que modificar en HTML, CSS y JS]
    3. **Instrucciones Directas para el Dev Senior:** [Especificaciones precisas de qué métodos, clases o etiquetas tocar]
  `;

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: prompt,
  });

  fs.writeFileSync('lead-plan.md', response.text);
  console.log('✅ Agente Team Lead finalizado. Plan guardado en lead-plan.md');
}

runLeadAgent().catch(console.error);
