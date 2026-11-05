// Tests unitarios sin wrangler: importa index.js en Node con fetch/KV simulados.
// Uso: node test/unit.mjs
import { readFileSync } from 'node:fs';

let failures = 0;
const check = (name, condition, detail = '') => {
    if (!condition) failures += 1;
    console.log(`${condition ? 'OK  ' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`);
};

let moduleCounter = 0;
const freshWorker = async () => (await import(`../index.js?unit=${moduleCounter++}`)).default;
const ctx = { waitUntil() {} };
const ORIGIN = 'https://papamasro.github.io';
const baseEnv = { GCBA_CLIENT_ID: 'test-id', GCBA_CLIENT_SECRET: 'test-secret', ALLOWED_ORIGINS: `${ORIGIN},http://localhost:*` };
const call = (worker, path, init = {}, env = baseEnv) => worker.fetch(new Request(`https://w.test${path}`, {
    ...init,
    headers: { Origin: ORIGIN, ...(init.headers || {}) },
}), env, ctx);

// ─── Encoder protobuf mínimo para armar feeds de prueba ─────────────────────
const varint = value => {
    const out = [];
    let rest = BigInt(value);
    do {
        let byte = Number(rest & 0x7fn);
        rest >>= 7n;
        if (rest > 0n) byte |= 0x80;
        out.push(byte);
    } while (rest > 0n);
    return out;
};
const tag = (field, wire) => varint(field * 8 + wire);
const fieldVarint = (field, value) => [...tag(field, 0), ...varint(value)];
const fieldBytes = (field, bytes) => [...tag(field, 2), ...varint(bytes.length), ...bytes];
const fieldString = (field, text) => fieldBytes(field, [...new TextEncoder().encode(text)]);
const translated = translations => translations.flatMap(([text, language]) => fieldBytes(1, [
    ...fieldString(1, text), ...(language ? fieldString(2, language) : []),
]));

const LONG_ES = 'Por obras de renovación integral en la estación, los trenes no se detienen en Medrano. '
    + 'Se recomienda utilizar las estaciones Ángel Gallardo o Carlos Gardel. Disculpe las molestias ocasionadas.';
const LONG_EN = 'Due to renovation works, trains do not stop at Medrano station. Please use nearby stations instead of this one.';
const feedBytes = Uint8Array.from([
    ...fieldBytes(1, [...fieldString(1, '2.0'), ...fieldVarint(2, 0), ...fieldVarint(3, 1793750000)]),
    ...fieldBytes(2, [
        ...fieldString(1, 'Alert_LineaB'),
        ...fieldBytes(5, [
            ...fieldBytes(1, [...fieldVarint(1, 1793700000), ...fieldVarint(2, 1796300000)]),
            ...fieldBytes(5, [...fieldString(2, 'LineaB')]),
            ...fieldBytes(5, [...fieldString(2, 'LineaB'), ...fieldString(5, 'BMED'), ...fieldVarint(6, 1)]),
            ...fieldVarint(6, 10),
            ...fieldVarint(7, 1),
            ...fieldBytes(10, translated([['Medrano cerrada', 'en'], ['Estación Medrano cerrada', 'es']])),
            ...fieldBytes(11, translated([[LONG_EN, 'en'], [LONG_ES, 'es']])),
        ]),
    ]),
    ...fieldBytes(2, [
        ...fieldString(1, 'Alert_152'),
        ...fieldBytes(5, [
            ...fieldBytes(5, [...fieldString(1, '20'), ...fieldString(2, '835')]),
            ...fieldVarint(7, 4),
            ...fieldBytes(10, translated([['Desvío línea 152 por obras en Av. Mitre', null]])),
        ]),
    ]),
]);
// Lo que hace el upstream del GCBA: decodificar como UTF-8 con reemplazo y volver a codificar.
const corruptedBytes = new TextEncoder().encode(new TextDecoder().decode(feedBytes));

function mockGcbaFetch(bodyByPath, counter) {
    return async url => {
        const { pathname } = new URL(url);
        counter[pathname] = (counter[pathname] || 0) + 1;
        const body = bodyByPath[pathname];
        if (body === undefined) return new Response('no', { status: 404 });
        if (body instanceof Error) throw body;
        return new Response(body, { headers: { 'Content-Type': 'application/octet-stream; charset=UTF-8' } });
    };
}

// ─── Alertas ─────────────────────────────────────────────────────────────────
{
    const worker = await freshWorker();
    const hits = {};
    globalThis.fetch = mockGcbaFetch({ '/subtes/serviceAlerts': feedBytes, '/colectivos/serviceAlerts': corruptedBytes }, hits);

    const clean = await (await call(worker, '/subtes/serviceAlertsJson')).json();
    const [lineaB, linea152] = clean.alerts;
    check('alertas protobuf sano: 2 alertas, sin corrupción', clean.alerts.length === 2 && clean.corrupted_input === false);
    check('alertas: header_text/description_text en español', lineaB.header_text === 'Estación Medrano cerrada' && lineaB.description_text === LONG_ES);
    check('alertas: cause/effect', lineaB.cause === 'CONSTRUCTION' && lineaB.effect === 'NO_SERVICE' && linea152.effect === 'DETOUR');
    check('alertas: informed_entity', JSON.stringify(lineaB.informed_entity) === JSON.stringify([{ route_id: 'LineaB' }, { route_id: 'LineaB', stop_id: 'BMED', direction_id: 1 }])
        && linea152.informed_entity[0].agency_id === '20' && linea152.informed_entity[0].route_id === '835');
    check('alertas: active_period exacto', lineaB.active_period[0].start === 1793700000 && lineaB.active_period[0].end === 1796300000);
    check('alertas: header timestamp', clean.header.timestamp === 1793750000 && clean.header.gtfs_realtime_version === '2.0');
    check('alertas: traducción sin idioma', linea152.header_text === 'Desvío línea 152 por obras en Av. Mitre');

    check('feed corrupto de prueba tiene EF BF BD', corruptedBytes.length > feedBytes.length);
    const broken = await (await call(worker, '/colectivos/serviceAlertsJson')).json();
    check('alertas protobuf corrupto: mismos textos', broken.alerts.length === 2
        && broken.alerts[0].description_text === LONG_ES && broken.alerts[0].header_text === 'Estación Medrano cerrada'
        && broken.alerts[1].header_text === linea152.header_text, JSON.stringify(broken.alerts.map(a => a.description_text?.length)));
    check('alertas corrupto: marca corrupted_input y periodo incompleto', broken.corrupted_input === true
        && broken.alerts[0].active_period[0].incomplete === true && !('start' in broken.alerts[0].active_period[0]));
    check('alertas corrupto: entidades y enums intactos', JSON.stringify(broken.alerts[0].informed_entity) === JSON.stringify(lineaB.informed_entity) && broken.alerts[0].cause === 'CONSTRUCTION');

    const second = await call(worker, '/subtes/serviceAlertsJson');
    check('alertas JSON 2ª llamada HIT sin upstream', second.headers.get('x-worker-cache') === 'HIT' && hits['/subtes/serviceAlerts'] === 1);
    check('alertas JSON Cache-Control 60 s', /max-age=60\b/.test(second.headers.get('cache-control')));
    const raw = await call(worker, '/subtes/serviceAlerts');
    check('proxy crudo comparte la entrada del feed (HIT)', raw.headers.get('x-worker-cache') === 'HIT' && hits['/subtes/serviceAlerts'] === 1);

    const fixture = readFileSync(new URL('./fixtures/alerts.bin', import.meta.url));
    const fixtureWorker = await freshWorker();
    globalThis.fetch = mockGcbaFetch({ '/subtes/serviceAlerts': fixture }, {});
    const real = await (await call(fixtureWorker, '/subtes/serviceAlertsJson')).json();
    check('fixture real (subte): 3 alertas legibles', real.alerts.length === 3 && real.alerts.every(a => /obras de renovación integral\.$/.test(a.description_text)),
        real.alerts.map(a => a.informed_entity[0]?.route_id).join(','));

    const failingWorker = await freshWorker();
    globalThis.fetch = mockGcbaFetch({ '/subtes/serviceAlerts': new Error('red caída') }, {});
    const failed = await call(failingWorker, '/subtes/serviceAlertsJson');
    check('alertas upstream caído sin copia -> 502 no-store', failed.status === 502 && failed.headers.get('cache-control') === 'no-store');
    globalThis.fetch = mockGcbaFetch({ '/subtes/serviceAlerts': Uint8Array.from([0xff, 0x00, 0x13]) }, {});
    const garbage = await call(failingWorker, '/subtes/serviceAlertsJson');
    check('alertas basura -> 502', garbage.status === 502);
    check('alertas sin secrets -> 500', (await call(failingWorker, '/subtes/serviceAlertsJson', {}, { ALLOWED_ORIGINS: '*' })).status === 500);
}

// ─── Trenes por línea ────────────────────────────────────────────────────────
{
    const lines = { lines: { MITRE2: { name: 'Mitre', stationIds: ['TR-1', 'TR-2', 'TR-3', 'TR-4'] }, VACIA: { stationIds: ['TR-9'] } } };
    const stations = { stations: {
        'TR-1': { sofseStationId: 101, sofseRamalId: 5 },
        'TR-2': { sofseStationId: 102, sofseRamalId: 5 },
        'TR-3': { sofseStationId: 403 },
        'TR-4': { sofseStationId: null },
        'TR-9': { sofseStationId: null },
    } };
    const kv = { get: async key => ({ 'train-lines': JSON.stringify(lines), 'train-stations': JSON.stringify(stations) }[key] ?? null) };
    const env = { ...baseEnv, MY_REDIS: kv, TRENES_BASE_URL: 'http://sofse.test' };
    const hits = {};
    let failAll = false;
    globalThis.fetch = async url => {
        const parsed = new URL(url);
        const key = `${parsed.pathname}?${parsed.searchParams}`;
        hits[key] = (hits[key] || 0) + 1;
        if (failAll) return new Response('caído', { status: 500 });
        if (parsed.pathname.endsWith('/403')) return new Response('<h1>403</h1>', { status: 403, headers: { 'Content-Type': 'text/html' } });
        const payload = { timestamp: 1793750000, results: [{
            arribo: { segundos: 90, anden: { nombre: '2' }, extra: 'x'.repeat(500) },
            servicio: { numero: 'A1', hasta: { estacion: { nombre: 'Tigre' } }, ramal: { nombre: 'Retiro - Tigre', geo: [1, 2, 3] } },
        }] };
        return new Response(JSON.stringify(payload), { headers: { 'Content-Type': 'application/json' } });
    };

    const worker = await freshWorker();
    const started = Date.now();
    const first = await call(worker, '/trenes/arribosLinea?linea=MITRE2', {}, env);
    const body = await first.json();
    check('arribosLinea 200 + MISS', first.status === 200 && first.headers.get('x-worker-cache') === 'MISS');
    check('arribosLinea solo estaciones con sofseStationId', Object.keys(body.stations).join(',') === 'TR-1,TR-2,TR-3' && body.partial === true);
    check('arribosLinea payload recortado con la misma estructura', body.stations['TR-1'].ok && body.stations['TR-1'].data.results[0].arribo.segundos === 90
        && body.stations['TR-1'].data.results[0].servicio.hasta.estacion.nombre === 'Tigre' && !('extra' in body.stations['TR-1'].data.results[0].arribo)
        && !('geo' in body.stations['TR-1'].data.results[0].servicio.ramal));
    check('arribosLinea 403: 1 reintento y estado 403', body.stations['TR-3'].ok === false && body.stations['TR-3'].status === 403
        && hits['/arribos/estacion/403?cantidad=6&paraApp=true'] === 2 && Date.now() - started >= 1400);
    check('arribosLinea usa ramal y query ordenada', hits['/arribos/estacion/101?cantidad=6&paraApp=true&ramal=5'] === 1);

    const second = await call(worker, '/trenes/arribosLinea?linea=MITRE2', {}, env);
    check('arribosLinea 2ª llamada HIT', second.headers.get('x-worker-cache') === 'HIT' && hits['/arribos/estacion/101?cantidad=6&paraApp=true&ramal=5'] === 1);
    const station = await call(worker, '/trenes/arribos/estacion/101?ramal=5&cantidad=6&paraApp=true', {}, env);
    check('arribos por estación comparte la caché de la línea', station.headers.get('x-worker-cache') === 'HIT');

    check('arribosLinea línea inexistente -> 404', (await call(worker, '/trenes/arribosLinea?linea=NOEXISTE', {}, env)).status === 404);
    check('arribosLinea sin linea -> 400', (await call(worker, '/trenes/arribosLinea', {}, env)).status === 400);
    check('arribosLinea linea inválida -> 400', (await call(worker, '/trenes/arribosLinea?linea=%3Cscript%3E', {}, env)).status === 400);
    const empty = await (await call(worker, '/trenes/arribosLinea?linea=VACIA', {}, env)).json();
    check('arribosLinea línea sin estaciones SOFSE -> 200 vacío', Object.keys(empty.stations).length === 0);
    check('arribosLinea sin MY_REDIS -> 500', (await call(worker, '/trenes/arribosLinea?linea=MITRE2', {}, baseEnv)).status === 500);

    // Breaker: muchas estaciones con 403 -> se dejan de pedir.
    const many = { lines: { ROCA: { stationIds: Array.from({ length: 8 }, (_, i) => `R-${i}`) } } };
    const manyStations = { stations: Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`R-${i}`, { sofseStationId: 403 }])) };
    const breakerEnv = { ...env, MY_REDIS: { get: async key => ({ 'train-lines': JSON.stringify(many), 'train-stations': JSON.stringify(manyStations) }[key] ?? null) } };
    const breakerWorker = await freshWorker();
    Object.keys(hits).forEach(key => delete hits[key]);
    const blocked = await call(breakerWorker, '/trenes/arribosLinea?linea=ROCA', {}, breakerEnv);
    check('arribosLinea todo 403 -> error sin caché', blocked.status === 403 && blocked.headers.get('cache-control') === 'no-store');
    check('arribosLinea breaker corta los pedidos', (hits['/arribos/estacion/403?cantidad=6&paraApp=true'] || 0) <= SOFSE_BREAKER_MAX_CALLS(), String(hits['/arribos/estacion/403?cantidad=6&paraApp=true']));

    // Upstream caído: a +50 s cada estación sirve su copia (stale-if-error 120 s); a +200 s ya no,
    // y se sirve el agregado anterior (stale-if-error de la línea, 300 s).
    const realNow = Date.now;
    failAll = true;
    Date.now = () => realNow() + 50_000;
    const stationStale = await call(worker, '/trenes/arribosLinea?linea=MITRE2', {}, env);
    const stationStaleBody = await stationStale.json();
    Date.now = () => realNow() + 200_000;
    const stale = await call(worker, '/trenes/arribosLinea?linea=MITRE2', {}, env);
    Date.now = realNow;
    failAll = false;
    check('arribosLinea upstream caído: estaciones con copia vieja', stationStale.status === 200 && stationStaleBody.stations['TR-1'].ok === true);
    check('arribosLinea stale-if-error del agregado', stale.status === 200 && stale.headers.get('x-worker-cache') === 'STALE-ERROR');
}

function SOFSE_BREAKER_MAX_CALLS() {
    // 4 en paralelo: cada uno 1 intento + a lo sumo 1 reintento antes de que el breaker (3) corte.
    return 6;
}

// ─── /client-errors ──────────────────────────────────────────────────────────
{
    const worker = await freshWorker();
    const logs = [];
    const realLog = console.log;
    const post = (body, headers = {}) => call(worker, '/client-errors', {
        method: 'POST',
        body: typeof body === 'string' ? body : JSON.stringify(body),
        headers: { 'Content-Type': 'text/plain;charset=UTF-8', 'CF-Connecting-IP': '203.0.113.7', ...headers },
    });
    console.log = line => logs.push(line);
    const ok = await post({
        message: 'TypeError: x is undefined', kind: 'error', source: 'https://papamasro.github.io/transporte/js/app/ui.js?v=3#a',
        line: 10, col: 5, stack: 'at f (https://papamasro.github.io/transporte/js/app/ui.js?v=3:10:5)', url: 'https://papamasro.github.io/transporte/?lat=-34.6&lon=-58.4',
        ua: 'UA', appVersion: 'v4', ts: 1793750000000, extra: 'ignored',
    });
    const big = await post({ message: 'x'.repeat(5000) });
    const invalid = await post('no es json');
    const noMessage = await post({ source: 'a.js' });
    console.log = realLog;

    const logged = logs.map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
    check('client-errors válido -> 204 + CORS', ok.status === 204 && ok.headers.get('access-control-allow-origin') === ORIGIN);
    check('client-errors loguea JSON estructurado', logged.length === 1 && logged[0].event === 'client-error' && logged[0].message === 'TypeError: x is undefined' && logged[0].line === 10);
    check('client-errors quita query strings', logged[0]?.url === 'https://papamasro.github.io/transporte/' && !logged[0]?.source.includes('?') && !logged[0]?.stack.includes('?v='));
    check('client-errors no loguea IP ni campos extra', !JSON.stringify(logged[0]).includes('203.0.113.7') && !('extra' in (logged[0] || {})));
    check('client-errors > 4 KB -> 413', big.status === 413);
    check('client-errors JSON inválido -> 400', invalid.status === 400 && noMessage.status === 400);
    check('client-errors GET -> 405', (await call(worker, '/client-errors')).status === 405);
    const preflight = await call(worker, '/client-errors', { method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'POST' } });
    check('client-errors preflight permite POST', preflight.status === 204 && preflight.headers.get('access-control-allow-methods') === 'POST, OPTIONS');
    check('POST en otras rutas sigue -> 405', (await call(worker, '/subtes/forecastGTFS', { method: 'POST' })).status === 405);
    check('client-errors origen ajeno -> 403', (await call(worker, '/client-errors', { method: 'POST', body: '{"message":"x"}', headers: { Origin: 'https://otro.example' } })).status === 403);

    console.log = () => {};
    const statuses = [];
    for (let i = 0; i < 12; i += 1) statuses.push((await post({ message: `e${i}` }, { 'CF-Connecting-IP': '198.51.100.1' })).status);
    const otherIp = await post({ message: 'otra ip' }, { 'CF-Connecting-IP': '198.51.100.2' });
    console.log = realLog;
    check('client-errors rate limit por IP (10/min)', statuses.filter(s => s === 204).length === 10 && statuses.at(-1) === 429 && otherIp.status === 204, statuses.join(','));
}

console.log(failures === 0 ? '\nTodo OK' : `\n${failures} fallas`);
process.exit(failures === 0 ? 0 : 1);
