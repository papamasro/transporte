// Smoke test contra `wrangler dev` (http://127.0.0.1:8787) + test/mock-upstream.mjs (:8799).
// Uso: node test/smoke.mjs [--slow]   (--slow agrega las pruebas de stale/stale-on-error, ~70 s)
const WORKER = process.env.WORKER_URL || 'http://127.0.0.1:8787';
const MOCK = process.env.MOCK_URL || 'http://127.0.0.1:8799';
const APP_ORIGIN = 'https://papamasro.github.io';
const slow = process.argv.includes('--slow');

let failures = 0;
const check = (name, condition, detail = '') => {
    if (!condition) failures += 1;
    console.log(`${condition ? 'OK  ' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`);
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function call(path, { origin = APP_ORIGIN, method = 'GET', headers = {}, body: requestBody } = {}) {
    const started = performance.now();
    const response = await fetch(`${WORKER}${path}`, { method, body: requestBody, headers: { ...(origin ? { Origin: origin } : {}), ...headers } });
    const body = method === 'HEAD' ? new Uint8Array() : new Uint8Array(await response.arrayBuffer());
    return { response, body, ms: Math.round(performance.now() - started), text: () => new TextDecoder().decode(body), json: () => JSON.parse(new TextDecoder().decode(body)) };
}
const status = r => r.response.headers.get('x-worker-cache');
const mockHits = async () => (await (await fetch(`${MOCK}/__stats`)).json()).hits;
const setFail = on => fetch(`${MOCK}/__fail?on=${on ? 1 : 0}`);

// Colectivos: MISS -> HIT, sin llamadas extra al upstream.
await fetch(`${MOCK}/__reset`);
const bus1 = await call('/colectivos/vehiclePositionsSimple');
const bus2 = await call('/colectivos/vehiclePositionsSimple');
check('bus 1ª llamada MISS', bus1.response.status === 200 && status(bus1) === 'MISS', `${bus1.ms} ms, ${bus1.body.length} B`);
check('bus 2ª llamada HIT desde caché', status(bus2) === 'HIT' && bus2.ms < 300, `${bus2.ms} ms`);
check('bus payload idéntico al upstream', bus2.body.length === 1806841);
check('bus Cache-Control', /max-age=20, stale-while-revalidate=40, stale-if-error=600/.test(bus2.response.headers.get('cache-control')), bus2.response.headers.get('cache-control'));
check('bus 1 sola llamada upstream', (await mockHits())['/colectivos/vehiclePositionsSimple'] === 1);

// Single-flight: 6 requests simultáneos a una clave fría -> 1 llamada upstream.
await fetch(`${MOCK}/__reset`);
const concurrent = await Promise.all(Array.from({ length: 6 }, () => call('/colectivos/vehiclePositionsSimple?sf=1')));
check('single-flight: 6 requests concurrentes OK', concurrent.every(r => r.response.status === 200));
check('single-flight: 1 llamada upstream', (await mockHits())['/colectivos/vehiclePositionsSimple'] === 1, JSON.stringify(await mockHits()));

// ETag / 304
const etag = bus2.response.headers.get('etag');
const notModified = await call('/colectivos/vehiclePositionsSimple', { headers: { 'If-None-Match': etag } });
check('If-None-Match -> 304', notModified.response.status === 304 && notModified.body.length === 0);

// Snapshots compatibles con la ruta KV vieja.
const snapshots = await call('/colectivos/vehiclePositionsKV');
const snapshotJson = snapshots.json();
check('vehiclePositionsKV {current, prev}', Array.isArray(snapshotJson.current?.data) && 'prev' in snapshotJson && Number.isFinite(snapshotJson.current.ts), `${snapshotJson.current?.data?.length} vehículos`);

// Resto de proxies GCBA y alias.
for (const path of ['/subtes/forecastGTFS', '/ecobici/gbfs/stationStatus', '/ecobici/gbfs/stationInformation', '/subtes/serviceAlerts', '/colectivos/serviceAlerts']) {
    const first = await call(path);
    const second = await call(path);
    check(`${path} 200 + HIT`, first.response.status === 200 && status(second) === 'HIT', `${first.response.headers.get('content-type')}, ${first.body.length} B`);
}

// KV estático (MY_REDIS): whitelist + caché.
const kv1 = await call('/obtener-kv?clave=train-lines');
const kv2 = await call('/obtener-kv?clave=train-lines');
check('obtener-kv train-lines 200 + HIT', kv1.response.status === 200 && status(kv2) === 'HIT' && Object.keys(kv1.json().lines || {}).length > 0);
check('obtener-kv clave fuera de whitelist -> 404', (await call('/obtener-kv?clave=secreto-x')).response.status === 404);
check('obtener-kv sin clave -> 400', (await call('/obtener-kv')).response.status === 400);

// D1
const linea1 = await call('/buscar-linea?numero=60');
const linea2 = await call('/buscar-linea?numero=60');
const recorridos = linea1.json().recorridos || [];
check('buscar-linea 60 -> 32 recorridos', recorridos.length === 32, `rows_read=${linea1.response.headers.get('x-d1-rows-read')}, ${linea1.ms} ms`);
check('buscar-linea excluye 600..699 (relleno)', recorridos.every(r => /^60[A-Z]/.test(r.route_short_name)));
check('buscar-linea mojibake corregido', recorridos.some(r => r.trip_headsign.includes('Estación')) && !recorridos.some(r => r.trip_headsign.includes('Ã')));
check('buscar-linea 2ª llamada HIT', status(linea2) === 'HIT', `${linea2.ms} ms`);
const trayecto = await call('/info-trayecto?trip_id=1277DI0');
const trayectoJson = trayecto.json();
check('info-trayecto trip real: 291 puntos / 41 paradas', trayectoJson.shape?.length === 291 && trayectoJson.stops?.length === 41, `rows_read=${trayecto.response.headers.get('x-d1-rows-read')}`);
check('info-trayecto paradas con name', trayectoJson.stops?.[0]?.name === trayectoJson.stops?.[0]?.stop_name);
const byLinea = await call('/info-trayecto?trip_id=54955-1&tip_id=54955-1&linea=60C&direction=0');
check('info-trayecto tip_id realtime + linea -> fallback por línea', byLinea.response.status === 200 && byLinea.json().info?.route_short_name === '60C', `rows_read=${byLinea.response.headers.get('x-d1-rows-read')}`);
const notFound1 = await call('/info-trayecto?linea=60');
const notFound2 = await call('/info-trayecto?linea=60');
check('info-trayecto inexistente -> 404 cacheado', notFound1.response.status === 404 && status(notFound2) === 'HIT' && /max-age=3600/.test(notFound2.response.headers.get('cache-control')));
check('info-trayecto inválido -> 400', (await call('/info-trayecto?trip_id=%27%3B--')).response.status === 400);

// Trenes
await fetch(`${MOCK}/__reset`);
const arr1 = await call('/trenes/arribos/estacion/123?ramal=5&cantidad=6&paraApp=true');
const arr2 = await call('/trenes/arribos/estacion/123?paraApp=true&cantidad=6&ramal=5');
check('trenes arribos 200 + HIT con query reordenada', arr1.response.status === 200 && status(arr2) === 'HIT');
const forbidden = await call('/trenes/arribos/estacion/403');
check('trenes 403 se propaga (sin caché)', forbidden.response.status === 403 && forbidden.response.headers.get('cache-control') === 'no-store');
check('trenes stationId inválido -> 400', (await call('/trenes/arribos/estacion/abc')).response.status === 400);

// Trenes por línea (KV local train-lines/train-stations: ver scripts/train-*-redis.json).
await fetch(`${MOCK}/__reset`);
const lineaTren1 = await call('/trenes/arribosLinea?linea=MITRE2');
const lineaTren2 = await call('/trenes/arribosLinea?linea=MITRE2');
const lineaTrenJson = lineaTren1.response.status === 200 ? lineaTren1.json() : {};
const lineaTrenStations = Object.values(lineaTrenJson.stations || {});
check('arribosLinea MITRE2 200 con estaciones', lineaTren1.response.status === 200 && lineaTrenStations.length > 0 && lineaTrenStations.every(s => s.ok), `${lineaTrenStations.length} estaciones, ${lineaTren1.ms} ms`);
check('arribosLinea 2ª llamada HIT', status(lineaTren2) === 'HIT');
check('arribosLinea 1 llamada SOFSE por estación', Object.entries(await mockHits()).filter(([path]) => path.startsWith('/arribos/estacion/')).every(([, count]) => count === 1));
check('arribosLinea línea inexistente -> 404', (await call('/trenes/arribosLinea?linea=NOEXISTE')).response.status === 404);

// Alertas GTFS-RT decodificadas.
for (const path of ['/subtes/serviceAlertsJson', '/colectivos/serviceAlertsJson']) {
    const alerts = await call(path);
    const payload = alerts.response.status === 200 ? alerts.json() : {};
    check(`${path} JSON con alertas legibles`, Array.isArray(payload.alerts) && payload.alerts.length === 3 && payload.alerts.every(a => a.header_text && a.informed_entity.length > 0), payload.alerts?.map(a => a.cause).join(','));
}

// Errores del frontend.
const clientError = await call('/client-errors', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ message: 'smoke test', url: 'https://papamasro.github.io/transporte/?x=1' }) });
check('POST /client-errors -> 204', clientError.response.status === 204);
check('GET /client-errors -> 405', (await call('/client-errors')).response.status === 405);

const bici = await call('/obtener-bicisenda');
check('bicisenda 200', bici.response.status === 200 && bici.json().type === 'FeatureCollection', `${bici.body.length} B`);

// CORS y métodos
const preflight = await call('/colectivos/vehiclePositionsSimple', { method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'accept' } });
check('preflight 204 + Max-Age', preflight.response.status === 204 && preflight.response.headers.get('access-control-max-age') === '86400');
check('CORS origen permitido', bus2.response.headers.get('access-control-allow-origin') === APP_ORIGIN && /Origin/.test(bus2.response.headers.get('vary')));
check('CORS localhost:5500 permitido', (await call('/obtener-kv?clave=train-lines', { origin: 'http://localhost:5500' })).response.headers.get('access-control-allow-origin') === 'http://localhost:5500');
check('CORS origen ajeno -> 403', (await call('/subtes/forecastGTFS', { origin: 'https://otro-sitio.example' })).response.status === 403);
check('sin Origin (curl) -> 200', (await call('/subtes/forecastGTFS', { origin: null })).response.status === 200);
check('POST -> 405', (await call('/subtes/forecastGTFS', { method: 'POST' })).response.status === 405);
check('ruta desconocida -> 404', (await call('/admin')).response.status === 404);
check('HEAD bus sin body', (await call('/colectivos/vehiclePositionsSimple', { method: 'HEAD' })).response.status === 200);
const leaked = [bus1, trayecto, forbidden].some(r => r.text().includes('test-secret'));
check('no se filtran credenciales en respuestas', !leaked);

if (slow) {
    // ttl subte = 20 s, swr = 20 s: a los ~22 s se sirve STALE y se refresca en segundo plano.
    await call('/subtes/forecastGTFS?slow=1');
    await sleep(22_000);
    await fetch(`${MOCK}/__reset`);
    const stale = await call('/subtes/forecastGTFS?slow=1');
    await sleep(500);
    check('stale-while-revalidate: STALE inmediato + refresh en 2º plano', status(stale) === 'STALE' && stale.ms < 300 && (await mockHits())['/subtes/forecastGTFS'] === 1, `${stale.ms} ms`);
    const refreshed = await call('/subtes/forecastGTFS?slow=1');
    check('tras refresh vuelve a HIT', status(refreshed) === 'HIT');

    // Upstream caído con la entrada vencida (> ttl + swr) -> se sirve la copia vieja.
    await sleep(41_000);
    await setFail(true);
    const staleError = await call('/subtes/forecastGTFS?slow=1');
    check('stale-if-error: upstream 500 -> 200 con copia vieja', staleError.response.status === 200 && status(staleError) === 'STALE-ERROR');
    const coldError = await call('/subtes/forecastGTFS?nuevo=1');
    check('upstream 500 sin copia -> error no cacheado', coldError.response.status === 500 && coldError.response.headers.get('cache-control') === 'no-store');
    await setFail(false);
}

console.log(failures === 0 ? '\nTodo OK' : `\n${failures} fallas`);
process.exit(failures === 0 ? 0 : 1);
