/**
 * Radar AMBA - backend (Cloudflare Worker). Archivo único, sin imports: sirve tanto para
 * `npx wrangler deploy` (ver wrangler.toml) como para pegar en el editor del dashboard.
 *
 * Bindings:
 * - MY_FEED   : D1 con el GTFS estático (routes, trips, shapes, stops, stop_times)
 * - MY_REDIS  : KV de solo lectura con datasets estáticos (train-lines, train-stations, ...)
 *
 * Secrets: GCBA_CLIENT_ID, GCBA_CLIENT_SECRET (apitransporte.buenosaires.gob.ar).
 *
 * Vars opcionales:
 * - ALLOWED_ORIGINS : orígenes CORS separados por coma ("http://localhost:*" admite cualquier
 *                     puerto). Vacío o "*" = cualquier origen.
 * - GTFS_VERSION    : cambiarlo invalida la caché interna de /buscar-linea e /info-trayecto.
 * - GCBA_BASE_URL, TRENES_BASE_URL, BICISENDA_URL : overrides de upstream (tests locales).
 *
 * Rutas propias además de los proxies: /colectivos|subtes/serviceAlertsJson (GTFS-RT decodificado),
 * /trenes/arribosLinea?linea=<id> (arribos SOFSE de todas las estaciones de una línea) y
 * POST /client-errors (errores JS del frontend -> console.log, visible en Workers Logs / `wrangler tail`).
 *
 * Capas de caché (de afuera hacia adentro):
 * 1. Workers Cache (`[cache] enabled = true` en wrangler.toml): en un HIT el Worker no se
 *    ejecuta (sin CPU, sin D1/KV/subrequests), pero el request igual cuenta en la cuota diaria.
 * 2. Memoria del isolate (LRU) + Cache API (por data center): stale-while-revalidate,
 *    stale-if-error y una sola llamada upstream en vuelo por clave.
 * KV no se usa como caché: el plan Free permite 1.000 escrituras/día.
 */

const DEFAULT_GCBA_BASE_URL = 'https://apitransporte.buenosaires.gob.ar';
const DEFAULT_TRENES_BASE_URL = 'https://ariedro.dev/api-trenes';
const DEFAULT_BICISENDA_URL = 'https://cdn.buenosaires.gob.ar/datosabiertos/datasets/transporte-y-obras-publicas/ciclovias/ciclovias.geojson';

const CACHE_SCHEMA = 'v1';
const MEMORY_LIMIT_BYTES = 48 * 1024 * 1024;
const FOLLOWER_WAIT_MS = 40_000;
const MAX_URL_LENGTH = 2048;
const D1_MAX_PARAMS = 90;

// Tiempos en segundos. ttl = fresco; swr = se sirve vencido mientras se refresca en segundo
// plano; sie = se sirve vencido si el upstream falla.
const POLICY = {
    bus: { ttl: 20, swr: 40, sie: 600, timeoutMs: 30_000 },
    realtime: { ttl: 20, swr: 20, sie: 300, timeoutMs: 10_000 },
    bikeStatus: { ttl: 30, swr: 30, sie: 600, timeoutMs: 10_000 },
    bikeInfo: { ttl: 3600, swr: 3600, sie: 86_400, timeoutMs: 10_000 },
    alerts: { ttl: 60, swr: 120, sie: 3600, timeoutMs: 10_000 },
    gcbaDefault: { ttl: 30, swr: 30, sie: 300, timeoutMs: 10_000 },
    trainArrivals: { ttl: 20, swr: 20, sie: 120, timeoutMs: 12_000 },
    trainLine: { ttl: 25, swr: 20, sie: 300 },
    trainStatic: { ttl: 86_400, swr: 86_400, sie: 604_800, timeoutMs: 12_000 },
    trainDefault: { ttl: 30, swr: 30, sie: 300, timeoutMs: 12_000 },
    staticKV: { ttl: 3600, swr: 86_400, sie: 604_800 },
    bikeRoutes: { ttl: 86_400, swr: 604_800, sie: 2_592_000, timeoutMs: 15_000 },
    gtfs: { ttl: 86_400, swr: 604_800, sie: 604_800, negativeTtl: 3600 },
};

const GCBA_ROUTES = {
    '/colectivos/vehiclePositionsSimple': { policy: POLICY.bus, validate: startsWithArray },
    '/subtes/forecastGTFS': { policy: POLICY.realtime, validate: looksLikeJson },
    '/ecobici/gbfs/stationStatus': { policy: POLICY.bikeStatus, validate: looksLikeJson },
    '/ecobici/gbfs/stationInformation': { policy: POLICY.bikeInfo, validate: looksLikeJson },
    '/colectivos/serviceAlerts': { policy: POLICY.alerts },
    '/subtes/serviceAlerts': { policy: POLICY.alerts },
};
const GCBA_PREFIXES = ['/colectivos/', '/subtes/', '/ecobici/'];
const BUS_POSITIONS_PATH = '/colectivos/vehiclePositionsSimple';
const ALLOWED_KV_KEYS = new Set(['subte-lines', 'subte-stations', 'train-lines', 'train-stations']);
const SECRET_PARAMS = new Set(['client_id', 'client_secret']);
const ALERTS_JSON_ROUTES = {
    '/colectivos/serviceAlertsJson': '/colectivos/serviceAlerts',
    '/subtes/serviceAlertsJson': '/subtes/serviceAlerts',
};
const TRAIN_LINE_ARRIVALS_PATH = '/trenes/arribosLinea';
// Free plan: 50 subrequests por invocación (estaciones + reintentos 403 + lecturas KV).
const TRAIN_LINE_MAX_STATIONS = 30;
const TRAIN_LINE_CONCURRENCY = 4;
const SOFSE_403_RETRY_MS = 1500;
const SOFSE_403_BREAKER = 3;
const CLIENT_ERRORS_PATH = '/client-errors';
const CLIENT_ERROR_MAX_BYTES = 4096;
const CLIENT_ERROR_RATE = { windowMs: 60_000, max: 10, maxTrackedIps: 5000 };

const memory = new Map();
let memoryBytes = 0;
const inflight = new Map();
const d1Features = { shapeRanges: null, stopRanges: null };
const parsedKv = new Map();
const clientErrorHits = new Map();
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const cors = resolveCors(request, env);

        if (request.method === 'OPTIONS') return preflightResponse(request, cors, url);
        if (!cors.allowed) return errorResponse(403, 'Origen no permitido', cors);
        if (url.pathname === CLIENT_ERRORS_PATH) return handleClientErrors(request, cors);
        if (request.method !== 'GET' && request.method !== 'HEAD') {
            return errorResponse(405, 'Método no permitido', cors, { Allow: 'GET, HEAD, OPTIONS' });
        }
        if (request.url.length > MAX_URL_LENGTH) return errorResponse(414, 'URL demasiado larga', cors);

        try {
            return await route(request, url, env, ctx, cors);
        } catch (error) {
            console.error('Error no controlado', url.pathname, sanitizeMessage(error, env));
            return errorResponse(500, 'Error interno', cors);
        }
    },
};

async function route(request, url, env, ctx, cors) {
    const { pathname } = url;

    if (pathname === '/buscar-linea') return handleBuscarLinea(request, url, env, ctx, cors);
    if (pathname === '/info-trayecto') return handleInfoTrayecto(request, url, env, ctx, cors);
    if (pathname === '/obtener-kv') return handleObtenerKV(request, url, env, ctx, cors);
    if (pathname === '/obtener-bicisenda') return handleBicisenda(request, env, ctx, cors);
    if (pathname === '/colectivos/vehiclePositionsKV') return handleBusSnapshots(request, url, env, ctx, cors);
    if (ALERTS_JSON_ROUTES[pathname]) return handleAlertsJson(request, ALERTS_JSON_ROUTES[pathname], env, ctx, cors);
    if (pathname === TRAIN_LINE_ARRIVALS_PATH) return handleTrainLineArrivals(request, url, env, ctx, cors);
    if (pathname.startsWith('/trenes/')) return handleTrenes(request, url, env, ctx, cors);

    if (GCBA_PREFIXES.some(prefix => pathname.startsWith(prefix))) {
        return handleGcba(request, url, pathname, env, ctx, cors);
    }

    return errorResponse(404, 'Ruta no encontrada', cors);
}

// ─── Proxies upstream ───────────────────────────────────────────────────────

async function handleGcba(request, url, gcbaPath, env, ctx, cors) {
    if (!isSafePath(gcbaPath)) return errorResponse(400, 'Ruta inválida', cors);
    if (!env.GCBA_CLIENT_ID || !env.GCBA_CLIENT_SECRET) {
        return errorResponse(500, 'Faltan los secrets GCBA_CLIENT_ID / GCBA_CLIENT_SECRET en el worker.', cors);
    }

    const config = GCBA_ROUTES[gcbaPath] || { policy: POLICY.gcbaDefault };
    const query = publicQuery(url.searchParams);
    const key = `gcba:${gcbaPath}?${query}`;
    const isBus = gcbaPath === BUS_POSITIONS_PATH;

    return serveCached(request, ctx, cors, {
        key,
        policy: config.policy,
        load: async () => {
            const previous = isBus ? (memoryGet(key) || await readEntry(request, key)) : null;
            const entry = await fetchUpstream(buildGcbaUrl(gcbaPath, query, env), {
                accept: 'application/json',
                timeoutMs: config.policy.timeoutMs,
                validate: config.validate,
                env,
            });
            if (previous && previous.storedAt !== entry.storedAt) rememberBusPrevious(request, ctx, key, previous);
            return entry;
        },
    });
}

async function handleTrenes(request, url, env, ctx, cors) {
    const targetPath = url.pathname.slice('/trenes'.length);
    if (!isSafePath(targetPath)) return errorResponse(400, 'Ruta inválida', cors);

    let policy = POLICY.trainDefault;
    if (targetPath.startsWith('/arribos/estacion/')) {
        if (!/^\/arribos\/estacion\/\d{1,8}$/.test(targetPath)) return errorResponse(400, 'stationId inválido', cors);
        policy = POLICY.trainArrivals;
    } else if (targetPath.startsWith('/infraestructura/')) {
        policy = POLICY.trainStatic;
    }

    const query = publicQuery(url.searchParams);
    const base = (env.TRENES_BASE_URL || DEFAULT_TRENES_BASE_URL).replace(/\/+$/, '');
    const upstreamUrl = `${base}${targetPath}${query ? `?${query}` : ''}`;

    return serveCached(request, ctx, cors, {
        key: `trenes:${targetPath}?${query}`,
        policy,
        load: () => fetchUpstream(upstreamUrl, {
            accept: 'application/json',
            timeoutMs: policy.timeoutMs,
            validate: looksLikeJson,
            env,
        }),
    });
}

async function handleBicisenda(request, env, ctx, cors) {
    const policy = POLICY.bikeRoutes;
    return serveCached(request, ctx, cors, {
        key: 'bicisenda',
        policy,
        load: async () => {
            const entry = await fetchUpstream(env.BICISENDA_URL || DEFAULT_BICISENDA_URL, {
                accept: 'application/geo+json, application/json',
                timeoutMs: policy.timeoutMs,
                validate: looksLikeJson,
                env,
            });
            return { ...entry, contentType: 'application/json' };
        },
    });
}

async function handleObtenerKV(request, url, env, ctx, cors) {
    if (!env?.MY_REDIS || typeof env.MY_REDIS.get !== 'function') {
        return errorResponse(500, 'Falta el binding MY_REDIS en el worker.', cors);
    }

    const key = url.searchParams.get('clave') || url.searchParams.get('key');
    if (!key) return errorResponse(400, "Falta el parámetro 'clave'", cors);
    if (!ALLOWED_KV_KEYS.has(key)) return errorResponse(404, 'Clave no encontrada en la base de datos', cors);

    return serveCached(request, ctx, cors, staticKvSpec(env, key));
}

function staticKvSpec(env, key) {
    return {
        key: `kv:${key}`,
        policy: POLICY.staticKV,
        load: async () => {
            const text = await env.MY_REDIS.get(key, 'text');
            if (text === null) return jsonEntry({ error: 'Clave no encontrada en la base de datos' }, 404);
            JSON.parse(text);
            return { body: textEncoder.encode(text), status: 200, contentType: 'application/json', storedAt: Date.now() };
        },
    };
}

// Mismo caché que /obtener-kv; el JSON parseado se reutiliza mientras no cambie la entrada.
async function readStaticKvJson(request, ctx, env, key) {
    const { entry } = await getEntry(request, ctx, staticKvSpec(env, key));
    if (entry.status !== 200) return null;
    const memo = parsedKv.get(key);
    if (memo && memo.storedAt === entry.storedAt && memo.bytes === entry.body.byteLength) return memo.value;
    const value = JSON.parse(textDecoder.decode(entry.body));
    parsedKv.set(key, { storedAt: entry.storedAt, bytes: entry.body.byteLength, value });
    return value;
}

// Compatibilidad con la ruta WIP basada en KV ({ current, prev }), ahora sin escrituras a KV:
// el snapshot previo vive en memoria y en la Cache API.
async function handleBusSnapshots(request, url, env, ctx, cors) {
    const busResponse = await handleGcba(request, new URL(BUS_POSITIONS_PATH, url), BUS_POSITIONS_PATH, env, ctx, cors);
    if (!busResponse.ok || request.method === 'HEAD') return busResponse;

    const key = `gcba:${BUS_POSITIONS_PATH}?`;
    const current = memoryGet(key) || await readEntry(request, key);
    if (!current) return busResponse;
    const previous = memoryGet(`${key}#prev`) || await readEntry(request, `${key}#prev`);

    const parts = [`{"current":{"ts":${current.storedAt},"data":`, current.body, '},"prev":'];
    if (previous) parts.push(`{"ts":${previous.storedAt},"data":`, previous.body, '}');
    else parts.push('null');
    parts.push('}');

    const headers = new Headers(busResponse.headers);
    headers.delete('ETag');
    headers.set('Content-Type', 'application/json');
    return new Response(concatBytes(parts), { status: 200, headers });
}

function rememberBusPrevious(request, ctx, key, previous) {
    const prevKey = `${key}#prev`;
    memorySet(prevKey, previous);
    ctx.waitUntil(writeEntry(request, prevKey, previous, POLICY.bus.ttl + POLICY.bus.sie).catch(() => {}));
}

// ─── Trenes: arribos de toda una línea ──────────────────────────────────────
// Un request del frontend por línea activa y refresh. Cada estación reutiliza la misma entrada
// de caché que /trenes/arribos/estacion/<id> (ttl 20 s, stale-if-error 120 s).

async function handleTrainLineArrivals(request, url, env, ctx, cors) {
    if (!env?.MY_REDIS || typeof env.MY_REDIS.get !== 'function') {
        return errorResponse(500, 'Falta el binding MY_REDIS en el worker.', cors);
    }
    const lineId = (url.searchParams.get('linea') || '').trim();
    if (!lineId) return errorResponse(400, "Falta el parámetro 'linea'", cors);
    if (!/^[\p{L}\p{N} ._-]{1,40}$/u.test(lineId)) return errorResponse(400, 'Línea inválida', cors);

    return serveCached(request, ctx, cors, {
        key: `trenes:linea:${lineId}`,
        policy: POLICY.trainLine,
        load: () => loadTrainLineArrivals(request, env, ctx, lineId),
    });
}

async function loadTrainLineArrivals(request, env, ctx, lineId) {
    const [linesData, stationsData] = await Promise.all([
        readStaticKvJson(request, ctx, env, 'train-lines'),
        readStaticKvJson(request, ctx, env, 'train-stations'),
    ]);
    const line = linesData?.lines?.[lineId];
    if (!line) return jsonEntry({ error: 'Línea no encontrada' }, 404);

    const stations = stationsData?.stations || {};
    const refs = (Array.isArray(line.stationIds) ? line.stationIds : [])
        .map(id => String(id))
        .map(id => ({ id, sofseStationId: Number(stations[id]?.sofseStationId), ramalId: Number(stations[id]?.sofseRamalId) || null }))
        .filter(ref => Number.isInteger(ref.sofseStationId) && ref.sofseStationId > 0)
        .slice(0, TRAIN_LINE_MAX_STATIONS);

    const breaker = { forbidden: 0 };
    const results = await mapWithConcurrency(refs, TRAIN_LINE_CONCURRENCY, async ref => {
        const base = { sofseStationId: ref.sofseStationId, ramalId: ref.ramalId };
        if (breaker.forbidden >= SOFSE_403_BREAKER) return [ref.id, { ...base, ok: false, status: 403, skipped: true }];
        try {
            const entry = await loadStationArrivals(request, ctx, env, ref, breaker);
            if (entry.status !== 200) return [ref.id, { ...base, ok: false, status: entry.status }];
            return [ref.id, { ...base, ok: true, data: slimSofseArrivals(JSON.parse(textDecoder.decode(entry.body))) }];
        } catch (error) {
            return [ref.id, { ...base, ok: false, status: Number(error?.status) || 502 }];
        }
    });

    const okCount = results.filter(([, result]) => result.ok).length;
    if (refs.length > 0 && okCount === 0) {
        // Sin ninguna estación: error para que serveCached sirva la copia anterior (stale-if-error).
        throw new UpstreamError(breaker.forbidden > 0 ? 403 : 502, 'SOFSE no respondió para ninguna estación de la línea');
    }
    return jsonEntry({
        linea: lineId,
        timestamp: Math.floor(Date.now() / 1000),
        partial: okCount < refs.length,
        stations: Object.fromEntries(results),
    });
}

// SOFSE corta con 403 intermitentes: un reintento con espera por estación y, tras varios 403
// en la misma carga, no se piden las estaciones restantes.
async function loadStationArrivals(request, ctx, env, ref, breaker) {
    const params = new URLSearchParams({ cantidad: '6', paraApp: 'true' });
    if (ref.ramalId) params.set('ramal', String(ref.ramalId));
    const query = publicQuery(params);
    const targetPath = `/arribos/estacion/${ref.sofseStationId}`;
    const base = (env.TRENES_BASE_URL || DEFAULT_TRENES_BASE_URL).replace(/\/+$/, '');
    const spec = {
        key: `trenes:${targetPath}?${query}`,
        policy: POLICY.trainArrivals,
        load: () => fetchUpstream(`${base}${targetPath}?${query}`, {
            accept: 'application/json',
            timeoutMs: POLICY.trainArrivals.timeoutMs,
            validate: looksLikeJson,
            env,
        }),
    };

    for (let attempt = 0; ; attempt += 1) {
        try {
            return (await getEntry(request, ctx, spec)).entry;
        } catch (error) {
            if (error?.status !== 403) throw error;
            breaker.forbidden += 1;
            if (attempt >= 1 || breaker.forbidden >= SOFSE_403_BREAKER) throw error;
            await sleep(SOFSE_403_RETRY_MS);
        }
    }
}

// Solo los campos que usa el frontend (normalizeSofseArribosPayload), con la misma estructura.
const SOFSE_ARRIVAL_PATHS = [
    'arribo.segundos', 'arribo.llegada.programada', 'arribo.salida.programada', 'arribo.salida.enAnden',
    'arribo.anden.nombre', 'servicio.numero', 'servicio.desde.estacion.llegada.programada',
    'servicio.desde.estacion.salida.programada', 'servicio.desde.estacion.anden.nombre',
    'servicio.desde.estado.nombre', 'servicio.hasta.estacion.nombre', 'servicio.ramal.nombre',
    'servicio.ramal.cabeceraFinal.nombre', 'servicio.gerencia.nombre',
].map(path => path.split('.'));

function slimSofseArrivals(payload) {
    let results = [];
    if (Array.isArray(payload)) results = payload;
    else if (Array.isArray(payload?.results)) results = payload.results;
    else if (Array.isArray(payload?.data)) results = payload.data;
    return {
        timestamp: Number(payload?.timestamp) || Math.floor(Date.now() / 1000),
        results: results.slice(0, 10).map(item => pickPaths(item, SOFSE_ARRIVAL_PATHS)),
    };
}

function pickPaths(source, paths) {
    const output = {};
    for (const keys of paths) {
        let value = source;
        for (const key of keys) value = value?.[key];
        if (value === undefined || value === null || typeof value === 'object') continue;
        let target = output;
        for (const key of keys.slice(0, -1)) target = target[key] ??= {};
        target[keys.at(-1)] = value;
    }
    return output;
}

async function mapWithConcurrency(items, limit, mapper) {
    const results = new Array(items.length);
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            const index = next++;
            results[index] = await mapper(items[index]);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Service Alerts GTFS-RT -> JSON ──────────────────────────────────────────
// El feed crudo comparte la entrada de caché del proxy (/colectivos|subtes/serviceAlerts).

async function handleAlertsJson(request, sourcePath, env, ctx, cors) {
    if (!env.GCBA_CLIENT_ID || !env.GCBA_CLIENT_SECRET) {
        return errorResponse(500, 'Faltan los secrets GCBA_CLIENT_ID / GCBA_CLIENT_SECRET en el worker.', cors);
    }
    const policy = POLICY.alerts;
    return serveCached(request, ctx, cors, {
        key: `alerts-json:${sourcePath}`,
        policy,
        load: async () => {
            const { entry } = await getEntry(request, ctx, {
                key: `gcba:${sourcePath}?`,
                policy,
                load: () => fetchUpstream(buildGcbaUrl(sourcePath, '', env), {
                    accept: 'application/x-protobuf, application/octet-stream',
                    timeoutMs: policy.timeoutMs,
                    env,
                }),
            });
            let feed;
            try {
                feed = decodeServiceAlerts(entry.body);
            } catch {
                throw new UpstreamError(502, 'Feed de alertas inválido');
            }
            return jsonEntry({
                source: sourcePath.split('/')[1],
                fetched_at: Math.floor(entry.storedAt / 1000),
                ...feed,
            });
        },
    });
}

const GTFS_RT_CAUSES = [null, 'UNKNOWN_CAUSE', 'OTHER_CAUSE', 'TECHNICAL_PROBLEM', 'STRIKE', 'DEMONSTRATION',
    'ACCIDENT', 'HOLIDAY', 'WEATHER', 'MAINTENANCE', 'CONSTRUCTION', 'POLICE_ACTIVITY', 'MEDICAL_EMERGENCY'];
const GTFS_RT_EFFECTS = [null, 'NO_SERVICE', 'REDUCED_SERVICE', 'SIGNIFICANT_DELAYS', 'DETOUR', 'ADDITIONAL_SERVICE',
    'MODIFIED_SERVICE', 'OTHER_EFFECT', 'UNKNOWN_EFFECT', 'STOP_MOVED', 'NO_EFFECT', 'ACCESSIBILITY_ISSUE'];

// Subconjunto de gtfs-realtime.proto necesario para alertas. [nombre, wire type, tipo, repeated]
const PB_SCHEMA = {
    FeedMessage: { 1: ['header', 2, 'FeedHeader'], 2: ['entity', 2, 'FeedEntity', true] },
    FeedHeader: { 1: ['gtfs_realtime_version', 2, 'string'], 2: ['incrementality', 0, 'varint'], 3: ['timestamp', 0, 'varint'] },
    FeedEntity: { 1: ['id', 2, 'string'], 2: ['is_deleted', 0, 'varint'], 3: ['trip_update', 2, 'skip'], 4: ['vehicle', 2, 'skip'], 5: ['alert', 2, 'Alert'] },
    Alert: {
        1: ['active_period', 2, 'TimeRange', true], 5: ['informed_entity', 2, 'EntitySelector', true],
        6: ['cause', 0, 'varint'], 7: ['effect', 0, 'varint'], 8: ['url', 2, 'TranslatedString'],
        10: ['header_text', 2, 'TranslatedString'], 11: ['description_text', 2, 'TranslatedString'],
        12: ['tts_header_text', 2, 'TranslatedString'], 13: ['tts_description_text', 2, 'TranslatedString'],
        14: ['severity_level', 0, 'varint'],
    },
    TimeRange: { 1: ['start', 0, 'varint'], 2: ['end', 0, 'varint'] },
    EntitySelector: {
        1: ['agency_id', 2, 'string'], 2: ['route_id', 2, 'string'], 3: ['route_type', 0, 'varint'],
        4: ['trip', 2, 'TripDescriptor'], 5: ['stop_id', 2, 'string'], 6: ['direction_id', 0, 'varint'],
    },
    TripDescriptor: {
        1: ['trip_id', 2, 'string'], 2: ['start_time', 2, 'string'], 3: ['start_date', 2, 'string'],
        4: ['schedule_relationship', 0, 'varint'], 5: ['route_id', 2, 'string'], 6: ['direction_id', 0, 'varint'],
    },
    TranslatedString: { 1: ['translation', 2, 'Translation', true] },
    Translation: { 1: ['text', 2, 'string'], 2: ['language', 2, 'string'] },
};

// El upstream del GCBA sirve el protobuf como texto ("octet-stream; charset=UTF-8"): cada byte
// que no forma UTF-8 válido llega reemplazado por U+FFFD (EF BF BD). Los textos y los varints
// chicos (tags, enums, largos < 128) quedan intactos; largos >= 128 y timestamps no. El decoder
// trata EF BF BD dentro de un varint como un byte desconocido y, si un largo quedó corrupto,
// parsea el mensaje hasta el primer tag que no le corresponde (o, para strings, prueba los largos
// posibles hasta encontrar un límite plausible). Con un protobuf sano es un decoder normal.
function decodeServiceAlerts(bytes) {
    const state = { bytes, corrupted: false };
    let feed = pbParseMessage(state, 'FeedMessage', 0, bytes.length, true, []);
    if (feed) {
        feed = feed.msg;
    } else {
        state.corrupted = true;
        feed = { entity: [] };
        let pos = 0;
        while (pos < bytes.length) {
            const partial = pbParseMessage(state, 'FeedMessage', pos, bytes.length, false, []);
            if (partial && partial.next > pos) {
                feed.header ??= partial.msg.header;
                feed.entity.push(...(partial.msg.entity || []));
                pos = partial.next;
                continue;
            }
            const nextEntity = bytes.indexOf(0x12, pos + 1);
            if (nextEntity < 0) break;
            pos = nextEntity;
        }
    }
    if (!feed.header && !(feed.entity || []).length) throw new Error('protobuf vacío o ilegible');

    const alerts = (feed.entity || [])
        .filter(entity => entity.alert && !entity.is_deleted)
        .map(entity => normalizeAlert(entity))
        .filter(alert => alert.header_text || alert.description_text);
    return {
        header: {
            gtfs_realtime_version: feed.header?.gtfs_realtime_version ?? null,
            timestamp: feed.header?.timestamp ?? null,
        },
        corrupted_input: state.corrupted,
        alerts,
    };
}

function normalizeAlert(entity) {
    const alert = entity.alert;
    const compact = object => Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined && value !== null));
    return {
        id: entity.id ?? null,
        cause: GTFS_RT_CAUSES[alert.cause] || (alert.cause ? String(alert.cause) : 'UNKNOWN_CAUSE'),
        effect: GTFS_RT_EFFECTS[alert.effect] || (alert.effect ? String(alert.effect) : 'UNKNOWN_EFFECT'),
        header_text: pickTranslation(alert.header_text),
        description_text: pickTranslation(alert.description_text),
        url: pickTranslation(alert.url),
        informed_entity: (alert.informed_entity || []).map(item => compact({
            agency_id: item.agency_id,
            route_id: item.route_id ?? item.trip?.route_id,
            route_type: item.route_type,
            stop_id: item.stop_id,
            direction_id: item.direction_id,
            trip_id: item.trip?.trip_id,
        })),
        // Un timestamp corrupto (ver decodeServiceAlerts) no se puede recuperar: queda null.
        active_period: (alert.active_period || []).map(period => compact({
            start: period.start ?? null,
            end: period.end ?? null,
            incomplete: period.__corrupted ? true : undefined,
        })),
    };
}

function pickTranslation(translatedString) {
    const translations = (translatedString?.translation || []).filter(item => typeof item.text === 'string' && item.text.trim());
    if (translations.length === 0) return null;
    const spanish = translations.find(item => /^es\b/i.test(item.language || ''));
    const neutral = translations.find(item => !item.language);
    return (spanish || neutral || translations[0]).text.trim();
}

function pbIsReplacementAt(bytes, index) {
    return bytes[index] === 0xef && bytes[index + 1] === 0xbf && bytes[index + 2] === 0xbd;
}

// { lo, hi, value (null si hay bytes desconocidos), corrupted, next } o null si no termina.
function pbReadVarint(bytes, pos, limit) {
    let lo = 0;
    let hi = 0;
    let factor = 1;
    let corrupted = false;
    let index = pos;
    while (index < limit) {
        if (index + 2 < limit && pbIsReplacementAt(bytes, index)) {
            corrupted = true;
            hi += 127 * factor;
            factor *= 128;
            index += 3;
        } else {
            const byte = bytes[index++];
            lo += (byte & 0x7f) * factor;
            hi += (byte & 0x7f) * factor;
            if (byte < 0x80) return { lo, hi, value: corrupted ? null : lo, corrupted, next: index };
            factor *= 128;
        }
        if (factor > 2 ** 70) return null;
    }
    return null;
}

function pbSkipField(bytes, pos, limit, wire) {
    if (wire === 0) return pbReadVarint(bytes, pos, limit)?.next ?? null;
    if (wire === 1) return pos + 8 <= limit ? pos + 8 : null;
    if (wire === 5) return pos + 4 <= limit ? pos + 4 : null;
    if (wire !== 2) return null;
    const length = pbReadVarint(bytes, pos, limit);
    if (!length || length.corrupted || length.next + length.value > limit) return null;
    return length.next + length.value;
}

function pbSetField(msg, spec, value) {
    const [name, , , repeated] = spec;
    if (repeated) (msg[name] ??= []).push(value);
    else msg[name] = value;
}

// strict: el mensaje ocupa exactamente [start, limit) (largo declarado sano).
// No strict: termina en el primer tag que no pertenece al tipo o en un campo singular repetido.
function pbParseMessage(state, type, start, limit, strict, ancestors) {
    const { bytes } = state;
    const schema = PB_SCHEMA[type];
    const msg = {};
    let pos = start;

    while (pos < limit) {
        const tag = pbReadVarint(bytes, pos, limit);
        if (!tag || tag.corrupted) {
            if (strict) return null;
            break;
        }
        const field = Math.floor(tag.value / 8);
        const wire = tag.value % 8;
        const spec = schema[field];

        if (!spec || spec[1] !== wire) {
            if (!strict) break;
            const skipped = pbSkipField(bytes, tag.next, limit, wire);
            if (skipped === null) return null;
            pos = skipped;
            continue;
        }
        if (!strict && !spec[3] && msg[spec[0]] !== undefined) break;

        const fieldResult = pbParseField(state, type, spec, tag.next, limit, msg, ancestors);
        if (!fieldResult) {
            if (strict) return null;
            break;
        }
        pbSetField(msg, spec, fieldResult.value);
        pos = fieldResult.next;
    }

    if (strict && pos !== limit) return null;
    return { msg, next: pos };
}

function pbParseField(state, type, spec, pos, limit, msg, ancestors) {
    const { bytes } = state;
    const [, wire, fieldType] = spec;

    if (wire === 0) {
        const varint = pbReadVarint(bytes, pos, limit);
        if (!varint) return null;
        if (varint.corrupted) {
            state.corrupted = true;
            msg.__corrupted = true;
        }
        return { value: varint.value, next: varint.next };
    }

    const length = pbReadVarint(bytes, pos, limit);
    if (!length) return null;
    const contentStart = length.next;
    if (length.corrupted) state.corrupted = true;

    if (fieldType === 'string' || fieldType === 'skip') {
        let end = null;
        if (!length.corrupted) {
            end = contentStart + length.value <= limit ? contentStart + length.value : null;
        } else if (fieldType === 'string') {
            end = pbResolveStringEnd(bytes, contentStart, limit, length, [type, ...ancestors], msg, spec);
        }
        if (end === null) return null;
        const value = fieldType === 'string' ? textDecoder.decode(bytes.subarray(contentStart, end)) : null;
        return { value, next: end };
    }

    if (!length.corrupted && contentStart + length.value <= limit) {
        const exact = pbParseMessage(state, fieldType, contentStart, contentStart + length.value, true, [type, ...ancestors]);
        if (exact) return { value: exact.msg, next: exact.next };
        state.corrupted = true;
    }
    const open = pbParseMessage(state, fieldType, contentStart, limit, false, [type, ...ancestors]);
    return open && open.next > contentStart ? { value: open.msg, next: open.next } : null;
}

const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

function pbIsValidUtf8(bytes, start, end) {
    try {
        strictUtf8.decode(bytes.subarray(start, end));
        return true;
    } catch {
        return false;
    }
}

// Largo corrupto de un string: entre los largos posibles se elige el primero que deja un UTF-8
// válido seguido de un tag plausible (primero del mismo mensaje, después de los ancestros).
function pbResolveStringEnd(bytes, start, limit, length, types, msg, spec) {
    const maxLength = Math.min(length.hi, limit - start);
    for (const scope of [types.slice(0, 1), types]) {
        for (let size = length.lo; size <= maxLength; size += 1) {
            const end = start + size;
            if (!pbIsValidUtf8(bytes, start, end)) continue;
            if (end === limit || pbIsPlausibleTag(bytes, end, limit, scope, msg, spec)) return end;
        }
    }
    return null;
}

function pbIsPlausibleTag(bytes, pos, limit, types, msg, currentSpec) {
    const tag = pbReadVarint(bytes, pos, limit);
    if (!tag || tag.corrupted) return false;
    const field = Math.floor(tag.value / 8);
    const wire = tag.value % 8;
    return types.some((type, depth) => {
        const spec = PB_SCHEMA[type][field];
        if (!spec || spec[1] !== wire) return false;
        if (depth === 0 && !spec[3] && (spec === currentSpec || msg[spec[0]] !== undefined)) return false;
        const value = pbReadVarint(bytes, tag.next, limit);
        if (!value) return false;
        return wire !== 2 || value.corrupted || value.next + value.value <= limit;
    });
}

// ─── Errores del frontend ────────────────────────────────────────────────────
// Sin KV/D1: se loguean como JSON (Workers Logs / `wrangler tail`). Rate limit en memoria del
// isolate (aproximado: cada isolate cuenta por separado), suficiente contra loops de errores.

async function handleClientErrors(request, cors) {
    if (request.method !== 'POST') {
        return errorResponse(405, 'Método no permitido', cors, { Allow: 'POST, OPTIONS' });
    }
    const ip = request.headers.get('CF-Connecting-IP') || 'local';
    if (!clientErrorAllowed(ip, Date.now())) return errorResponse(429, 'Demasiados reportes', cors, { 'Retry-After': '60' });

    const text = await readLimitedText(request, CLIENT_ERROR_MAX_BYTES);
    if (text === null) return errorResponse(413, 'Reporte demasiado grande', cors);
    let payload;
    try {
        payload = JSON.parse(text);
    } catch {
        return errorResponse(400, 'JSON inválido', cors);
    }
    const report = sanitizeClientError(payload);
    if (!report) return errorResponse(400, 'Reporte inválido', cors);

    console.log(JSON.stringify({ event: 'client-error', ...report, country: request.cf?.country || null }));
    const headers = new Headers(cors.headers);
    headers.set('Cache-Control', 'no-store');
    return new Response(null, { status: 204, headers });
}

function clientErrorAllowed(ip, now) {
    let hits = clientErrorHits.get(ip);
    if (!hits || now - hits.start >= CLIENT_ERROR_RATE.windowMs) {
        if (clientErrorHits.size >= CLIENT_ERROR_RATE.maxTrackedIps) clientErrorHits.clear();
        hits = { start: now, count: 0 };
        clientErrorHits.set(ip, hits);
    }
    hits.count += 1;
    return hits.count <= CLIENT_ERROR_RATE.max;
}

async function readLimitedText(request, maxBytes) {
    const declared = Number(request.headers.get('Content-Length'));
    if (Number.isFinite(declared) && declared > maxBytes) return null;
    if (!request.body) return '';
    const reader = request.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
            reader.cancel().catch(() => {});
            return null;
        }
        chunks.push(value);
    }
    return textDecoder.decode(concatBytes(chunks));
}

function sanitizeClientError(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    const text = (value, max) => (typeof value === 'string' ? value.replaceAll(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').slice(0, max) : null);
    const integer = value => (Number.isInteger(value) && value >= 0 && value < 1e7 ? value : null);
    const stripQuery = value => (value ? value.replaceAll(/[?#][^\s)'"]*/g, '') : value);
    const message = text(payload.message, 500);
    if (!message) return null;
    return {
        message,
        kind: text(payload.kind, 30),
        source: stripQuery(text(payload.source, 300)),
        line: integer(payload.line),
        col: integer(payload.col),
        stack: stripQuery(text(payload.stack, 1500)),
        url: stripQuery(text(payload.url, 300)),
        ua: text(payload.ua, 300),
        appVersion: text(payload.appVersion, 40),
        ts: Number.isFinite(payload.ts) ? Math.trunc(payload.ts) : null,
    };
}

// ─── GTFS (D1) ───────────────────────────────────────────────────────────────

async function handleBuscarLinea(request, url, env, ctx, cors) {
    const db = getDb(env);
    if (!db) return errorResponse(500, 'Falta el binding MY_FEED en el worker.', cors);

    const linea = (url.searchParams.get('numero') || url.searchParams.get('linea') || '').trim();
    if (!linea) return textResponse(400, 'Falta linea', cors);
    if (!isValidLineName(linea)) return errorResponse(400, 'Línea inválida', cors);

    return serveCached(request, ctx, cors, {
        key: `gtfs:${gtfsVersion(env)}:linea:${linea.toLowerCase()}`,
        policy: POLICY.gtfs,
        load: () => loadBuscarLinea(db, linea),
    });
}

async function loadBuscarLinea(db, linea) {
    const stats = { rowsRead: 0 };
    const pattern = `${escapeLike(linea)}%`;
    const { results } = await runD1(stats, db.prepare(`
        SELECT r.route_id, r.route_short_name, t.trip_id, t.shape_id, t.trip_headsign
        FROM routes r
        JOIN trips t ON t.route_id = r.route_id
        WHERE r.route_short_name LIKE ?1 ESCAPE '\\'
        GROUP BY t.shape_id
    `).bind(pattern));

    // Mismo criterio que el frontend (matchesLineToken): "60" incluye "60A" pero no "600".
    const queryToken = normalizeLineToken(linea);
    const ramales = (results || []).filter(row => matchesLineToken(normalizeLineToken(row.route_short_name), queryToken));
    const shapes = await loadShapes(db, stats, ramales.map(row => row.shape_id));

    const recorridos = ramales.map(row => ({
        ...row,
        trip_headsign: fixMojibake(row.trip_headsign),
        shape: shapes.get(String(row.shape_id)) || [],
    }));
    return jsonEntry({ recorridos }, 200, stats);
}

async function handleInfoTrayecto(request, url, env, ctx, cors) {
    const db = getDb(env);
    if (!db) return errorResponse(500, 'Falta el binding MY_FEED en el worker.', cors);

    const rawTripId = (url.searchParams.get('trip_id') || url.searchParams.get('tip_id') || '').trim();
    const linea = (url.searchParams.get('linea') || '').trim();
    const directionRaw = url.searchParams.get('direction');
    const direction = directionRaw === null || directionRaw === '' ? null : Number(directionRaw);

    if (!rawTripId && !linea) return textResponse(400, 'Faltan datos', cors);
    if (rawTripId && !/^[\w\-.:]{1,64}$/.test(rawTripId)) return errorResponse(400, 'trip_id inválido', cors);
    if (linea && !isValidLineName(linea)) return errorResponse(400, 'Línea inválida', cors);
    if (direction !== null && !Number.isInteger(direction)) return errorResponse(400, 'direction inválida', cors);

    const version = gtfsVersion(env);
    const key = `gtfs:${version}:trayecto:${rawTripId}|${linea}|${direction ?? ''}`;

    return serveCached(request, ctx, cors, {
        key,
        policy: POLICY.gtfs,
        load: async () => {
            const stats = { rowsRead: 0 };
            const routeData = await resolveTrayectoRoute(db, stats, { rawTripId, linea, direction });
            if (!routeData) return jsonEntry({ error: 'No encontrado' }, 404, stats);

            // Distintos vehículos/URLs que resuelven al mismo trip comparten shape y paradas.
            const tripEntry = await getEntry(request, ctx, {
                key: `gtfs:${version}:trip:${routeData.trip_id}`,
                policy: POLICY.gtfs,
                load: () => loadTripDetail(db, routeData),
            });
            return { ...tripEntry.entry, storedAt: Date.now(), rowsRead: stats.rowsRead + (tripEntry.entry.rowsRead || 0) };
        },
    });
}

async function resolveTrayectoRoute(db, stats, { rawTripId, linea, direction }) {
    const directionParam = Number.isInteger(direction) ? direction : null;
    const lineaParam = linea || null;

    if (rawTripId) {
        const cleanId = rawTripId.replaceAll('-', '');
        const route = await runD1First(stats, db.prepare(`
            SELECT t.trip_id, t.shape_id, r.route_short_name, t.trip_headsign, t.direction_id
            FROM trips t
            JOIN routes r ON r.route_id = t.route_id
            WHERE t.trip_id IN (?1, ?2)
            ORDER BY (r.route_short_name = ?3) DESC, (t.direction_id = ?4) DESC
            LIMIT 1
        `).bind(rawTripId, cleanId, lineaParam, directionParam));
        if (route) return route;
    }

    if (!lineaParam) return null;
    return runD1First(stats, db.prepare(`
        SELECT t.trip_id, t.shape_id, r.route_short_name, t.trip_headsign, t.direction_id
        FROM routes r
        JOIN trips t ON t.route_id = r.route_id
        WHERE r.route_short_name = ?1
        ORDER BY (t.direction_id = ?2) DESC
        LIMIT 1
    `).bind(lineaParam, directionParam));
}

async function loadTripDetail(db, routeData) {
    const stats = { rowsRead: 0 };
    const [shapes, stops] = await Promise.all([
        loadShapes(db, stats, [routeData.shape_id]),
        loadStops(db, stats, routeData.trip_id),
    ]);
    return jsonEntry({
        info: { ...routeData, trip_headsign: fixMojibake(routeData.trip_headsign) },
        shape: shapes.get(String(routeData.shape_id)) || [],
        stops,
    }, 200, stats);
}

// shape_ranges / trip_stop_ranges (migración 0002) guardan el rango de rowid de cada shape/trip:
// permiten leer solo esas filas sin crear índices sobre tablas de millones de filas.
async function loadShapes(db, stats, shapeIds) {
    const ids = [...new Set(shapeIds.filter(id => id !== null && id !== undefined).map(String))];
    const byShape = new Map(ids.map(id => [id, []]));
    if (ids.length === 0) return byShape;

    for (let i = 0; i < ids.length; i += D1_MAX_PARAMS) {
        const chunk = ids.slice(i, i + D1_MAX_PARAMS);
        const placeholders = chunk.map((_, index) => `?${index + 1}`).join(', ');
        const rows = await withRangeFallback('shapeRanges', () => runD1(stats, db.prepare(`
            SELECT s.shape_id, s.shape_pt_lat AS lat, s.shape_pt_lon AS lon
            FROM shape_ranges g
            JOIN shapes s ON s.rowid BETWEEN g.lo AND g.hi AND s.shape_id = g.shape_id
            WHERE g.shape_id IN (${placeholders})
            ORDER BY s.shape_id, s.shape_pt_sequence
        `).bind(...chunk)), () => runD1(stats, db.prepare(`
            SELECT shape_id, shape_pt_lat AS lat, shape_pt_lon AS lon
            FROM shapes
            WHERE shape_id IN (${placeholders})
            ORDER BY shape_id, shape_pt_sequence
        `).bind(...chunk)));

        for (const row of rows.results || []) {
            byShape.get(String(row.shape_id))?.push({ lat: row.lat, lon: row.lon });
        }
    }
    return byShape;
}

async function loadStops(db, stats, tripId) {
    const rows = await withRangeFallback('stopRanges', () => runD1(stats, db.prepare(`
        SELECT s.stop_name, s.stop_lat AS lat, s.stop_lon AS lon, st.stop_sequence
        FROM trip_stop_ranges g
        JOIN stop_times st ON st.rowid BETWEEN g.lo AND g.hi AND st.trip_id = g.trip_id
        JOIN stops s ON s.stop_id = st.stop_id
        WHERE g.trip_id = ?1
        ORDER BY st.stop_sequence
    `).bind(tripId)), () => runD1(stats, db.prepare(`
        SELECT s.stop_name, s.stop_lat AS lat, s.stop_lon AS lon, st.stop_sequence
        FROM stop_times st
        JOIN stops s ON s.stop_id = st.stop_id
        WHERE st.trip_id = ?1
        ORDER BY st.stop_sequence
    `).bind(tripId)));

    return (rows.results || []).map(row => {
        const name = fixMojibake(row.stop_name);
        return { stop_name: name, name, lat: row.lat, lon: row.lon, stop_sequence: row.stop_sequence };
    });
}

async function withRangeFallback(feature, rangedQuery, plainQuery) {
    if (d1Features[feature] !== false) {
        try {
            const result = await rangedQuery();
            d1Features[feature] = true;
            return result;
        } catch (error) {
            if (!/no such table|no such column/i.test(String(error?.message || error))) throw error;
            d1Features[feature] = false;
        }
    }
    return plainQuery();
}

async function runD1(stats, statement) {
    const result = await statement.all();
    stats.rowsRead += Number(result?.meta?.rows_read) || 0;
    return result;
}

async function runD1First(stats, statement) {
    const { results } = await runD1(stats, statement);
    return results?.[0] || null;
}

function getDb(env) {
    return env?.MY_FEED && typeof env.MY_FEED.prepare === 'function' ? env.MY_FEED : null;
}

function gtfsVersion(env) {
    return String(env?.GTFS_VERSION || '1');
}

// ─── Motor de caché ──────────────────────────────────────────────────────────

async function serveCached(request, ctx, cors, spec) {
    let result;
    try {
        result = await getEntry(request, ctx, spec);
    } catch (error) {
        return upstreamErrorResponse(error, cors);
    }
    return entryResponse(request, result, spec.policy, cors);
}

async function getEntry(request, ctx, spec) {
    const { key, policy } = spec;
    const now = Date.now();
    let entry = memoryGet(key);
    if (!entry) {
        entry = await readEntry(request, key);
        if (entry) memorySet(key, entry);
    }

    const ttl = entryTtl(entry, policy);
    const ageSec = entry ? Math.max(0, (now - entry.storedAt) / 1000) : Infinity;
    if (entry && ageSec < ttl) return { entry, cacheStatus: 'HIT', ageSec };

    if (entry && ageSec < ttl + policy.swr) {
        refresh(request, ctx, spec).catch(() => {});
        return { entry, cacheStatus: 'STALE', ageSec };
    }

    try {
        const fresh = await refresh(request, ctx, spec);
        return { entry: fresh, cacheStatus: 'MISS', ageSec: 0 };
    } catch (error) {
        if (entry && ageSec < ttl + policy.sie) return { entry, cacheStatus: 'STALE-ERROR', ageSec };
        throw error;
    }
}

// Una sola carga en vuelo por clave dentro del isolate. Los demás requests esperan con timeout
// propio: si el request que originó la carga se cancela, no quedan colgados.
function refresh(request, ctx, spec) {
    const { key, policy } = spec;
    let pending = inflight.get(key);
    if (!pending) {
        pending = (async () => {
            const entry = await spec.load();
            if (entry.status === 200 || entry.status === 404) {
                memorySet(key, entry);
                ctx.waitUntil(writeEntry(request, key, entry, entryTtl(entry, policy) + policy.sie).catch(() => {}));
            }
            return entry;
        })().finally(() => inflight.delete(key));
        inflight.set(key, pending);
        ctx.waitUntil(pending.catch(() => {}));
        return pending;
    }
    return withTimeout(pending, FOLLOWER_WAIT_MS);
}

function entryTtl(entry, policy) {
    if (entry && entry.status !== 200 && policy.negativeTtl) return policy.negativeTtl;
    return policy.ttl;
}

function memoryGet(key) {
    const entry = memory.get(key);
    if (!entry) return null;
    memory.delete(key);
    memory.set(key, entry);
    return entry;
}

function memorySet(key, entry) {
    const previous = memory.get(key);
    if (previous) {
        memoryBytes -= previous.body.byteLength;
        memory.delete(key);
    }
    memory.set(key, entry);
    memoryBytes += entry.body.byteLength;
    while (memoryBytes > MEMORY_LIMIT_BYTES && memory.size > 1) {
        const [oldestKey, oldest] = memory.entries().next().value;
        memory.delete(oldestKey);
        memoryBytes -= oldest.body.byteLength;
    }
}

function cacheKeyUrl(request, key) {
    const origin = new URL(request.url).origin;
    return `${origin}/__cache/${CACHE_SCHEMA}/${encodeURIComponent(key)}`;
}

function cacheApi() {
    return typeof caches !== 'undefined' && caches.default ? caches.default : null;
}

async function readEntry(request, key) {
    const cache = cacheApi();
    if (!cache) return null;
    try {
        const cached = await cache.match(cacheKeyUrl(request, key));
        if (!cached) return null;
        return {
            body: new Uint8Array(await cached.arrayBuffer()),
            status: Number(cached.headers.get('X-Entry-Status')) || 200,
            contentType: cached.headers.get('Content-Type') || 'application/json',
            storedAt: Number(cached.headers.get('X-Stored-At')) || 0,
        };
    } catch {
        return null;
    }
}

async function writeEntry(request, key, entry, keepSeconds) {
    const cache = cacheApi();
    if (!cache) return;
    await cache.put(cacheKeyUrl(request, key), new Response(entry.body, {
        headers: {
            'Content-Type': entry.contentType,
            'Cache-Control': `public, max-age=${Math.ceil(keepSeconds)}`,
            'X-Stored-At': String(entry.storedAt),
            'X-Entry-Status': String(entry.status),
        },
    }));
}

async function fetchUpstream(url, { accept, timeoutMs, validate, env }) {
    let response;
    try {
        response = await fetch(url, {
            headers: { Accept: accept, 'User-Agent': 'transporte-be (Cloudflare Worker)' },
            signal: AbortSignal.timeout(timeoutMs),
        });
    } catch (error) {
        const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
        throw new UpstreamError(timedOut ? 504 : 502, timedOut ? `Timeout del upstream (${timeoutMs} ms)` : `Error de red con el upstream: ${sanitizeMessage(error, env)}`);
    }

    const contentType = response.headers.get('Content-Type') || accept;
    const body = new Uint8Array(await response.arrayBuffer());
    if (!response.ok) {
        throw new UpstreamError(response.status, `Upstream respondió ${response.status}`, { body: body.slice(0, 4096), contentType });
    }
    if (validate && !validate(body)) throw new UpstreamError(502, 'Respuesta inválida del upstream');
    return { body, status: 200, contentType, storedAt: Date.now() };
}

class UpstreamError extends Error {
    constructor(status, message, passthrough = null) {
        super(message);
        this.status = status;
        this.passthrough = passthrough;
    }
}

function withTimeout(promise, ms) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new UpstreamError(504, 'Timeout esperando la carga en curso')), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ─── Respuestas ──────────────────────────────────────────────────────────────

function entryResponse(request, { entry, cacheStatus, ageSec }, policy, cors) {
    const headers = new Headers(cors.headers);
    headers.set('Content-Type', entry.contentType);
    headers.set('X-Worker-Cache', cacheStatus);

    const ttl = entryTtl(entry, policy);
    if (cacheStatus === 'HIT' || cacheStatus === 'MISS') {
        headers.set('Cache-Control', `public, max-age=${ttl}, stale-while-revalidate=${policy.swr}, stale-if-error=${policy.sie}`);
        headers.set('Age', String(Math.floor(ageSec)));
    } else {
        headers.set('Cache-Control', `public, max-age=5, stale-while-revalidate=${policy.swr}, stale-if-error=${policy.sie}`);
    }
    if (entry.rowsRead !== undefined && cacheStatus === 'MISS') headers.set('X-D1-Rows-Read', String(entry.rowsRead));

    const etag = `W/"${entry.storedAt.toString(36)}-${entry.body.byteLength.toString(36)}"`;
    headers.set('ETag', etag);
    if (entry.status === 200 && request.headers.get('If-None-Match') === etag) {
        return new Response(null, { status: 304, headers });
    }

    const body = request.method === 'HEAD' ? null : entry.body;
    return new Response(body, { status: entry.status, headers });
}

function upstreamErrorResponse(error, cors) {
    if (error instanceof UpstreamError) {
        if (error.passthrough) {
            const headers = new Headers(cors.headers);
            headers.set('Content-Type', error.passthrough.contentType);
            headers.set('Cache-Control', 'no-store');
            return new Response(error.passthrough.body, { status: error.status, headers });
        }
        return errorResponse(error.status, error.message, cors);
    }
    const message = String(error?.message || error);
    if (/D1_|exceeded|limit/i.test(message)) return errorResponse(503, 'Base GTFS no disponible temporalmente', cors);
    console.error('Error cargando datos', message.slice(0, 300));
    return errorResponse(500, 'Error interno', cors);
}

function jsonEntry(payload, status = 200, stats = null) {
    return {
        body: textEncoder.encode(JSON.stringify(payload)),
        status,
        contentType: 'application/json',
        storedAt: Date.now(),
        rowsRead: stats ? stats.rowsRead : undefined,
    };
}

function errorResponse(status, message, cors, extraHeaders = {}) {
    const headers = new Headers(cors?.headers || {});
    headers.set('Content-Type', 'application/json');
    headers.set('Cache-Control', 'no-store');
    Object.entries(extraHeaders).forEach(([name, value]) => headers.set(name, value));
    return new Response(JSON.stringify({ error: message }), { status, headers });
}

function textResponse(status, message, cors) {
    const headers = new Headers(cors.headers);
    headers.set('Content-Type', 'text/plain; charset=utf-8');
    headers.set('Cache-Control', 'no-store');
    return new Response(message, { status, headers });
}

// ─── CORS ────────────────────────────────────────────────────────────────────

function resolveCors(request, env) {
    const origin = request.headers.get('Origin');
    const allowList = String(env?.ALLOWED_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean);
    const allowAll = allowList.length === 0 || allowList.includes('*');

    if (allowAll) {
        return { allowed: true, headers: { 'Access-Control-Allow-Origin': '*' } };
    }
    if (!origin) {
        return { allowed: true, headers: { Vary: 'Origin' } };
    }
    if (allowList.some(pattern => originMatches(origin, pattern))) {
        return { allowed: true, headers: { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } };
    }
    return { allowed: false, headers: { Vary: 'Origin' } };
}

function originMatches(origin, pattern) {
    if (pattern === origin) return true;
    if (!pattern.endsWith(':*')) return false;
    const base = pattern.slice(0, -2);
    return origin === base || (origin.startsWith(`${base}:`) && /^\d{1,5}$/.test(origin.slice(base.length + 1)));
}

function preflightResponse(request, cors, url) {
    const headers = new Headers(cors.headers);
    if (!cors.allowed) {
        headers.set('Cache-Control', 'no-store');
        return new Response(null, { status: 403, headers });
    }
    headers.set('Access-Control-Allow-Methods', url.pathname === CLIENT_ERRORS_PATH ? 'POST, OPTIONS' : 'GET, HEAD, OPTIONS');
    headers.set('Access-Control-Allow-Headers', request.headers.get('Access-Control-Request-Headers') || 'Accept, Content-Type');
    headers.set('Access-Control-Max-Age', '86400');
    return new Response(null, { status: 204, headers });
}

// ─── Utilidades ──────────────────────────────────────────────────────────────

function buildGcbaUrl(pathname, query, env) {
    const base = (env.GCBA_BASE_URL || DEFAULT_GCBA_BASE_URL).replace(/\/+$/, '');
    const params = new URLSearchParams(query);
    params.set('client_id', env.GCBA_CLIENT_ID);
    params.set('client_secret', env.GCBA_CLIENT_SECRET);
    return `${base}${pathname}?${params.toString()}`;
}

// Query sin credenciales y con orden estable (clave de caché determinística).
function publicQuery(searchParams) {
    const pairs = [];
    searchParams.forEach((value, name) => {
        if (!SECRET_PARAMS.has(name.toLowerCase())) pairs.push([name, value]);
    });
    pairs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return new URLSearchParams(pairs).toString();
}

function isSafePath(pathname) {
    return /^\/[\w\-./]{0,200}$/.test(pathname) && !pathname.includes('..') && !pathname.includes('//');
}

function isValidLineName(value) {
    return /^[\p{L}\p{N} ._-]{1,24}$/u.test(value);
}

function escapeLike(value) {
    return value.replaceAll(/[\\%_]/g, char => `\\${char}`);
}

function normalizeLineToken(value) {
    return String(value || '')
        .normalize('NFD')
        .replaceAll(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replaceAll(/[^a-z0-9]+/g, '');
}

function matchesLineToken(lineToken, filterToken) {
    if (!filterToken) return true;
    if (!lineToken) return false;
    if (lineToken === filterToken) return true;
    if (!lineToken.startsWith(filterToken)) return false;
    const isDigit = char => char >= '0' && char <= '9';
    return isDigit(filterToken.at(-1)) !== isDigit(lineToken[filterToken.length]);
}

// Textos UTF-8 que se cargaron como Latin-1 ("EstaciÃ³n" → "Estación").
function fixMojibake(value) {
    if (typeof value !== 'string' || !/[ÃÂ]/.test(value)) return value;
    const bytes = new Uint8Array(value.length);
    for (let i = 0; i < value.length; i += 1) {
        const code = value.codePointAt(i);
        if (code > 255) return value;
        bytes[i] = code;
    }
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
        return value;
    }
}

function firstNonSpaceByte(body) {
    for (const byte of body) {
        if (byte !== 0x20 && byte !== 0x0a && byte !== 0x0d && byte !== 0x09 && byte !== 0xef && byte !== 0xbb && byte !== 0xbf) return byte;
    }
    return -1;
}

function startsWithArray(body) {
    return firstNonSpaceByte(body) === 0x5b;
}

function looksLikeJson(body) {
    const first = firstNonSpaceByte(body);
    return first === 0x5b || first === 0x7b;
}

function concatBytes(parts) {
    const chunks = parts.map(part => (typeof part === 'string' ? textEncoder.encode(part) : part));
    const output = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
    let offset = 0;
    for (const chunk of chunks) {
        output.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return output;
}

function sanitizeMessage(error, env) {
    let message = String(error?.message || error || 'error desconocido');
    for (const secret of [env?.GCBA_CLIENT_ID, env?.GCBA_CLIENT_SECRET]) {
        if (secret) message = message.replaceAll(secret, '***');
    }
    return message.replaceAll(/client_(id|secret)=[^&\s]+/gi, 'client_$1=***').slice(0, 300);
}
