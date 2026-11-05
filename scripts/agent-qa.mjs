import { UNTRUSTED_NOTICE, generate, readCodeContext, runAgent, untrustedBlock, writeOutput } from './agent-common.mjs';

async function runQAAgent() {
  console.log('🔍 [1/3] Agente QA & Tester: Auditando funcionalidades, mapa y experiencia de usuario...');

  const codebase = readCodeContext(15000);

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

    ${UNTRUSTED_NOTICE}

    Código / Contexto (diff):
    ${untrustedBlock('DIFF', codebase)}
  `;

  const report = await generate(prompt);
  const target = writeOutput('qa-report.md', report);
  console.log(`✅ Agente QA finalizado. Tickets guardados en ${target}`);
}

runAgent(runQAAgent);
