// Genera test/.local-d1.sql: tablas GTFS SIN índices (peor caso, como un import con solo
// INSERTs) con los datos reales de la línea 60 capturados más relleno sintético para que los
// rows_read de un full scan sean visibles. Solo para la base local de `wrangler dev`.
import { readFileSync, writeFileSync } from 'node:fs';

const FILLER_SHAPES = Number(process.env.FILLER_SHAPES || 400);
const POINTS_PER_SHAPE = 450;
const STOPS_PER_TRIP = 40;

const linea = JSON.parse(readFileSync(new URL('./fixtures/linea60.json', import.meta.url)));
const trayecto = JSON.parse(readFileSync(new URL('./fixtures/trayecto.json', import.meta.url)));
const q = value => (value === null || value === undefined ? 'NULL' : `'${String(value).replaceAll("'", "''")}'`);

const out = [
    'DROP TABLE IF EXISTS routes; DROP TABLE IF EXISTS trips; DROP TABLE IF EXISTS shapes;',
    'DROP TABLE IF EXISTS stops; DROP TABLE IF EXISTS stop_times;',
    'DROP TABLE IF EXISTS shape_ranges; DROP TABLE IF EXISTS trip_stop_ranges;',
    'CREATE TABLE routes (route_id TEXT, agency_id TEXT, route_short_name TEXT, route_long_name TEXT, route_type INTEGER);',
    'CREATE TABLE trips (trip_id TEXT, route_id TEXT, service_id TEXT, trip_headsign TEXT, direction_id INTEGER, shape_id TEXT);',
    'CREATE TABLE shapes (shape_id TEXT, shape_pt_sequence INTEGER, shape_pt_lat REAL, shape_pt_lon REAL);',
    'CREATE TABLE stops (stop_id TEXT, stop_code TEXT, stop_name TEXT, stop_lat REAL, stop_lon REAL);',
    'CREATE TABLE stop_times (trip_id TEXT, arrival_time TEXT, departure_time TEXT, stop_id TEXT, stop_sequence INTEGER);',
];

const batches = { routes: [], trips: [], shapes: [], stops: [], stop_times: [] };
const seenRoutes = new Set();
let stopCounter = 0;

function addTrip(routeId, shortName, tripId, shapeId, headsign, direction, points, stops) {
    if (!seenRoutes.has(routeId)) {
        seenRoutes.add(routeId);
        batches.routes.push(`(${q(routeId)}, '1', ${q(shortName)}, NULL, 3)`);
    }
    batches.trips.push(`(${q(tripId)}, ${q(routeId)}, 'S', ${q(headsign)}, ${direction}, ${q(shapeId)})`);
    points.forEach((point, index) => batches.shapes.push(`(${q(shapeId)}, ${index}, ${point.lat}, ${point.lon})`));
    stops.forEach((stop, index) => {
        stopCounter += 1;
        const stopId = `S${stopCounter}`;
        batches.stops.push(`(${q(stopId)}, NULL, ${q(stop.stop_name)}, ${stop.lat}, ${stop.lon})`);
        batches.stop_times.push(`(${q(tripId)}, '08:00:00', '08:00:00', ${q(stopId)}, ${index})`);
    });
}

const realTripId = trayecto.info.trip_id;
for (const recorrido of linea.recorridos) {
    const isTrayecto = recorrido.trip_id === realTripId;
    addTrip(recorrido.route_id, recorrido.route_short_name, recorrido.trip_id, recorrido.shape_id,
        recorrido.trip_headsign, isTrayecto ? trayecto.info.direction_id : 0, recorrido.shape,
        isTrayecto ? trayecto.stops : recorrido.shape.slice(0, STOPS_PER_TRIP).map(p => ({ stop_name: 'Parada', ...p })));
}
for (let i = 0; i < FILLER_SHAPES; i += 1) {
    const points = Array.from({ length: POINTS_PER_SHAPE }, (_, j) => ({ lat: -34.6 + j / 1e4, lon: -58.4 + i / 1e4 }));
    addTrip(`9${i}`, String(100 + (i % 300)) + 'ABCDEFGH'[i % 8], `9${i}DI0`, `9${i}0`, 'Relleno', i % 2, points, points.slice(0, STOPS_PER_TRIP).map(p => ({ stop_name: 'Relleno', ...p })));
}

for (const [table, rows] of Object.entries(batches)) {
    for (let i = 0; i < rows.length; i += 500) out.push(`INSERT INTO ${table} VALUES\n${rows.slice(i, i + 500).join(',\n')};`);
}
writeFileSync(new URL('./.local-d1.sql', import.meta.url), out.join('\n') + '\n');
console.log(Object.fromEntries(Object.entries(batches).map(([table, rows]) => [table, rows.length])));
