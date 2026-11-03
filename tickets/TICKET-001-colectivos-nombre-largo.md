# [BUG-001] Chips de colectivos muestran texto excesivamente largo y deforman el marcador

- **Componente:** `js/shared/utils.js` (`getBusDisplayLine`, `getVehicleShortName`)
- **Severidad:** 🔴 Alta (UX / UI Bloqueada visualmente)
- **Estado:** ✅ Resuelto (Bloque 1)

---

## 1. Descripción del problema
En el mapa, los marcadores flotantes de los colectivos mostraban etiquetas gigantes como `140hEstacionVillaU...`, `133hPuenteSaaved...`, `107aEstacionCiu...`, `60bBarrancasBelgrano...`.
Esto saturaba el mapa e impedía leer la línea del colectivo rápidamente.

## 2. Causa técnica
En `js/shared/utils.js`, la función `getBusDisplayLine`:
`cleanShortName = shortName.replaceAll(/\s+/g, '').trim()`
Cuando la API devolvía en `route_short_name` la variante concatenada con la cabecera (por ejemplo `"140h - Estación Villa Urquiza"`), la función simplemente eliminaba los espacios en blanco, produciendo una cadena de más de 20 caracteres sin separar.

## 3. Solución implementada
Se refactorizó `getBusDisplayLine` en `js/shared/utils.js` para extraer de forma limpia el número de línea (ej. `140`, `133`, `107`, `60`, `60B`) mediante expresiones regulares con límite estricto de hasta 5 caracteres para el chip del mapa:
```javascript
function getBusDisplayLine(vehicle) {
    const candidates = [
        getVehicleShortName(vehicle),
        vehicle?.route_id,
        vehicle?.trip_headsign
    ];

    for (const candidate of candidates) {
        const str = (candidate || '').toString().trim();
        if (!str) continue;

        const match = str.match(/^(?:linea\s*)?(\d{1,4}\s*[a-zA-Z]?)/i);
        if (match && match[1]) {
            const cleaned = match[1].replaceAll(/\s+/g, '').toUpperCase();
            if (cleaned.length <= 5) return cleaned;
        }

        const innerDigits = str.match(/\b(\d{1,4}[a-zA-Z]?)\b/);
        if (innerDigits && innerDigits[1]) {
            const cleaned = innerDigits[1].toUpperCase();
            if (cleaned.length <= 5) return cleaned;
        }
    }

    const fallback = formatLineName(getVehicleShortName(vehicle) || vehicle?.route_id || '??');
    return fallback.slice(0, 5).toUpperCase();
}
```
