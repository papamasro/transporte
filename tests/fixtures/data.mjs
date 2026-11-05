// Fixtures sintéticos y deterministas (sin datos reales ni archivos de varios MB).
// Centro del mapa al iniciar: -34.6037, -58.3816 (zoom 13 mobile / 14 desktop).

export const CENTER = { lat: -34.6037, lon: -58.3816 };

// PRNG determinista (mulberry32) para que cada corrida genere exactamente los mismos datos.
function rng(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// Las líneas 60/60A/160/601 prueban la semántica de búsqueda por token ("60" != "160" != "601").
const LINES = ['60', '60A', '160', '601', '152', '39', '29', '64', '12', '17', '100', '109', '111', '115', '124'];
export const XSS_HEADSIGN = '<img src=x onerror="window.__xss=1">Destino';
export const XSS_AGENCY = '<script>window.__xss=2</script>Empresa';

// step: cada snapshot avanza ~stepMeters a cada colectivo en su rumbo (para animación y popups).
export function makeBuses({ count = 300, step = 0, stepMeters = 60, spread = 0.014 } = {}) {
    const random = rng(1234);
    const metersPerDegLat = 111320;
    const metersPerDegLon = 111320 * Math.cos(CENTER.lat * Math.PI / 180);
    const buses = [];
    for (let index = 0; index < count; index += 1) {
        const line = LINES[index % LINES.length];
        // Línea 60: sobre el meridiano del centro (el recorrido estático pasa por ahí).
        const baseLat = CENTER.lat + (random() * 2 - 1) * spread;
        const baseLon = line === '60' ? CENTER.lon + (random() * 2 - 1) * 0.002 : CENTER.lon + (random() * 2 - 1) * spread;
        const heading = line === '60' ? 0 : random() * 2 * Math.PI;
        const distance = step * stepMeters;
        const isXss = index === 7;
        buses.push({
            route_id: line === '60' ? '1277' : String(800 + (index % LINES.length)),
            latitude: Number((baseLat + Math.cos(heading) * distance / metersPerDegLat).toFixed(6)),
            longitude: Number((baseLon + Math.sin(heading) * distance / metersPerDegLon).toFixed(6)),
            speed: 8,
            timestamp: 1793750000 + step * 30,
            id: String(1000 + index),
            direction: 0,
            agency_name: isXss ? XSS_AGENCY : 'EMPRESA DE PRUEBA S.A.',
            agency_id: 1,
            route_short_name: isXss ? '39' : line,
            tip_id: `${10000 + index}-1`,
            trip_headsign: isXss ? XSS_HEADSIGN : `Destino ${line}`
        });
    }
    return buses;
}

// ─── Subte ──────────────────────────────────────────────────────────────────
export const SUBTE_LINES = {
    LineaA: { short: 'A', color: '#18cccc', stations: ['A1', 'A2', 'A3'] },
    LineaB: { short: 'B', color: '#eb0909', stations: ['B1', 'B2'] }
};
export const SUBTE_STATIONS = {
    A1: { name: 'Plaza de Mayo', lat: -34.6088, lon: -58.3709 },
    A2: { name: 'Perú', lat: -34.6086, lon: -58.3742 },
    A3: { name: 'Piedras', lat: -34.6089, lon: -58.3792 },
    B1: { name: 'Florida', lat: -34.6033, lon: -58.3747 },
    B2: { name: 'Carlos Pellegrini', lat: -34.6037, lon: -58.3807 }
};
export function makeSubteForecast(nowSec) {
    return {
        Header: { timestamp: nowSec },
        Entity: [{
            ID: 'LineaA_A11',
            Linea: {
                Trip_Id: 'A11',
                Route_Id: 'LineaA',
                Direction_ID: 1,
                Estaciones: [
                    { stop_id: 'A1N', stop_name: 'Plaza de Mayo', arrival: { time: nowSec + 120, delay: 0 }, departure: { time: nowSec + 140, delay: 0 } },
                    { stop_id: 'A2N', stop_name: 'Perú', arrival: { time: nowSec + 240, delay: 60 }, departure: { time: nowSec + 260, delay: 60 } }
                ]
            }
        }]
    };
}

// ─── Trenes ─────────────────────────────────────────────────────────────────
export const TRAIN_LINES = {
    lines: { mitre: { short: 'Mitre', name: 'Línea Mitre', color: '#0ea5e9', stationIds: ['T1', 'T2'] } }
};
export const TRAIN_STATIONS = {
    stations: {
        T1: { name: 'Retiro', lat: -34.5915, lon: -58.3746, sofseStationId: 1 },
        T2: { name: 'Palermo', lat: -34.5781, lon: -58.4269, sofseStationId: 2 }
    }
};
export function makeTrainLineArrivals(nowSec) {
    const arrivals = segundos => ({
        timestamp: nowSec,
        results: [{ arribo: { segundos, anden: { nombre: '1' } }, servicio: { hasta: { estacion: { nombre: 'Tigre' } }, ramal: { nombre: 'Tigre' } } }]
    });
    return {
        linea: 'mitre',
        stations: {
            T1: { ok: true, sofseStationId: 1, data: arrivals(300) },
            T2: { ok: true, sofseStationId: 2, data: arrivals(120) }
        }
    };
}

// ─── Ecobici ────────────────────────────────────────────────────────────────
export const BIKE_INFO = {
    data: {
        stations: [
            { station_id: '2', name: '002 - Retiro I', lat: -34.5924, lon: -58.3747, capacity: 40 },
            { station_id: '3', name: '003 - ADUANA', lat: -34.6122, lon: -58.3693, capacity: 26 },
            { station_id: '4', name: '004 - Plaza Roma', lat: -34.6025, lon: -58.3685, capacity: 20 }
        ]
    }
};
export const BIKE_STATUS = {
    data: {
        stations: [
            { station_id: '2', num_bikes_available: 6, num_docks_available: 34 },
            { station_id: '3', num_bikes_available: 0, num_docks_available: 26 },
            { station_id: '4', num_bikes_available: 3, num_docks_available: 17 }
        ]
    }
};
export const BIKE_ROUTES = {
    type: 'FeatureCollection',
    features: [{
        type: 'Feature',
        properties: { id: 1, nombre: 'Ciclovía de prueba' },
        geometry: { type: 'LineString', coordinates: [[-58.3800, -34.6060], [-58.3700, -34.6050], [-58.3650, -34.6000]] }
    }]
};

// ─── Alertas ────────────────────────────────────────────────────────────────
export const SUBTE_ALERTS = {
    alerts: [{
        header_text: 'Estación Medrano cerrada',
        description_text: 'Estación Medrano cerrada por obras de renovación integral.',
        informed_entity: [{ route_id: 'LineaB' }]
    }]
};
export const BUS_ALERTS = {
    alerts: [{ header_text: 'Desvío línea 60', description_text: 'La línea 60 circula desviada por obras en Av. Corrientes.' }]
};

// ─── Recorridos ─────────────────────────────────────────────────────────────
// Recorrido N-S sobre el meridiano del centro: los colectivos 60 quedan a < 300 m.
export const ROUTE_60_SHAPE = Array.from({ length: 21 }, (_, index) => ({
    lat: Number((CENTER.lat - 0.05 + index * 0.005).toFixed(5)),
    lon: CENTER.lon
}));

function encodeSigned(value) {
    let current = value < 0 ? ~(value << 1) : (value << 1);
    let out = '';
    while (current >= 0x20) {
        out += String.fromCharCode((0x20 | (current & 0x1f)) + 63);
        current >>= 5;
    }
    return out + String.fromCharCode(current + 63);
}

export function encodePolyline(points) {
    let lastLat = 0;
    let lastLon = 0;
    return points.map(point => {
        const lat = Math.round(point.lat * 1e5);
        const lon = Math.round(point.lon * 1e5);
        const chunk = encodeSigned(lat - lastLat) + encodeSigned(lon - lastLon);
        lastLat = lat;
        lastLon = lon;
        return chunk;
    }).join('');
}

// Formato de data/routes/<linea>.json (scripts/build-static-routes.py).
export function makeStaticRouteFile60() {
    return {
        agencies: { 1: 'EMPRESA DE PRUEBA S.A.' },
        stops: {
            s1: ['Parada Norte', ROUTE_60_SHAPE[12].lat, CENTER.lon],
            s2: ['Parada Sur', ROUTE_60_SHAPE[8].lat, CENTER.lon]
        },
        routes: { 1277: { short: '60', dirs: { 0: 'v60' } } },
        variants: {
            v60: {
                route_id: '1277',
                short: '60',
                trip_id: 'T60',
                headsign: 'Constitución',
                direction: 0,
                agency_id: 1,
                shape: encodePolyline(ROUTE_60_SHAPE),
                stops: ['s1', 's2']
            }
        }
    };
}

// Respuestas del worker cuando no hay datos estáticos publicados.
export const TRAYECTO_60 = {
    info: { trip_id: 'T60', route_short_name: '60', trip_headsign: 'Constitución', direction_id: 0 },
    shape: ROUTE_60_SHAPE,
    stops: [{ name: 'Parada Norte', lat: ROUTE_60_SHAPE[12].lat, lon: CENTER.lon }]
};
export const LINE_SEARCH_60 = {
    recorridos: [
        { route_id: 1277, route_short_name: '60', trip_headsign: 'Constitución', shape: ROUTE_60_SHAPE },
        { route_id: 1278, route_short_name: '60A', trip_headsign: 'Barrancas', shape: ROUTE_60_SHAPE.map(p => ({ lat: p.lat, lon: p.lon + 0.004 })) }
    ]
};
