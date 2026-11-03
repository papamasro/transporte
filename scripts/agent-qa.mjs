import { GoogleGenAI } from '@google/genai';
import * as fs from 'fs';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function runQAAgent() {
  console.log('🔍 [1/3] Agente QA & Tester: Auditando funcionalidades, mapa y experiencia de usuario...');

  const codebase = process.env.CODE_CONTEXT || 'No hay contexto disponible.';

  const prompt = `
    Sos un QA Lead & Software Tester Senior especializado en aplicaciones web frontend interactivas con Leaflet, APIs REST en tiempo real y UI/UX de mapas.

    Tu objetivo es analizar el código, detectar fallos funcionales, inconsistencias de datos y bugs visuales.

    Puntos clave a auditar:
    1. Visualización de colectivos: textos de líneas demasiado largos o truncados, deformación de chips.
    2. Recorridos de colectivos: paradas faltantes, errores en trazado de shapes.
    3. Subtes: cálculo de horarios, timestamps GTFS, tiempos de espera irreales o negativos.
    4. Trenes: visualización estática vs tiempo real, sincronización con estaciones SOFSE.
    5. Módulo Cercanos y Geolocalización: cálculo de distancias, filtros por radio.

    Estructurá tu salida en Markdown con tickets estructurados:
    # 📋 Reporte de QA & Auditoría Funcional
    
    ### Ticket [QA-XXX]: [Título del problema]
    - **Componente:** [Archivo / Función afectada]
    - **Severidad:** [Crítica / Alta / Media / Baja]
    - **Problema Detectado:** [Descripción detallada]
    - **Comportamiento Esperado:** [Lo que debería suceder]
    - **Criterio de Aceptación:** [Condición para darlo por resuelto]

    Código / Contexto:
    \`\`\`text
    ${codebase.slice(0, 15000)}
    \`\`\`
  `;

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: prompt,
  });

  fs.writeFileSync('qa-report.md', response.text);
  console.log('✅ Agente QA finalizado. Tickets guardados en qa-report.md');
}

runQAAgent().catch(console.error);

