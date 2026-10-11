import { GoogleGenAI } from '@google/genai';
import * as fs from 'fs';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function runBusinessAgent() {
  console.log('📊 [1/3] Agente Negocio & UX: Analizando interfaz y flujo...');

  const codebase = process.env.CODE_CONTEXT || 'No hay contexto disponible.';

  const prompt = `
    Sos un Product Owner y UX Specialist senior enfocado en aplicaciones web (HTML/CSS/JS).
    Analizá el siguiente código/estructura de repositorio y generá recomendaciones de valor de negocio y UI/UX.

    Estructurá tu respuesta estrictamente así:
    ## 🎯 Análisis de Negocio y UX
    ### Ticket 1: [Nombre corto]
    - **Problema UI/UX:**
    - **Propuesta de Mejora:**
    - **Criterio de Aceptación:**

    Código/Estructura recibida:
    \`\`\`text
    ${codebase.slice(0, 12000)}
    \`\`\`
  `;

  const response = await ai.models.generateContent({
    model: 'gemini-3.8-flash',
    contents: prompt,
  });

  fs.writeFileSync('business-report.md', response.text);
  console.log('✅ Agente Negocio finalizado. Reporte guardado en business-report.md');
}

runBusinessAgent().catch(console.error);
