function getNetworkRetryConfig(overrides = {}) {
    const cfg = globalThis.NETWORK_CONFIG || {};
    const retryMax = Number(overrides.retryMax ?? cfg.retryMax ?? 3);
    const retryDelayMs = Number(overrides.retryDelayMs ?? cfg.retryDelayMs ?? 1000);
    return {
        retryMax: Number.isFinite(retryMax) ? Math.max(1, retryMax) : 3,
        retryDelayMs: Number.isFinite(retryDelayMs) ? Math.max(0, retryDelayMs) : 1000
    };
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function getAppPath(pathKey, fallback) {
    const path = globalThis.APP_CONFIG?.PATHS?.[pathKey];
    return (path || fallback || '').toString();
}

function getEndpointPolicy(endpoint) {
    const cfg = globalThis.NETWORK_CONFIG || {};
    const policies = cfg.endpointPolicies || {};
    const paths = typeof APP_PATHS === 'object' && APP_PATHS ? APP_PATHS : (globalThis.APP_CONFIG?.PATHS || {});
    const pathname = (endpoint || '').toString().split('?')[0];
    const pathKey = Object.keys(policies).find(key => paths[key] && paths[key] === pathname);
    return (pathKey && policies[pathKey]) || {};
}

// options: { timeoutMs, retries } (retries = reintentos extra tras el primer intento).
// Compat: retryMax (intentos totales) y retryDelayMs siguen funcionando.
function resolveRequestPolicy(endpoint, options = {}) {
    const cfg = globalThis.NETWORK_CONFIG || {};
    const policy = getEndpointPolicy(endpoint);

    const timeoutMs = Number(options.timeoutMs ?? policy.timeoutMs ?? cfg.requestTimeoutMs ?? 10000);
    let attempts;
    if (options.retries !== undefined) attempts = Number(options.retries) + 1;
    else if (options.retryMax !== undefined) attempts = Number(options.retryMax);
    else if (policy.retries !== undefined) attempts = Number(policy.retries) + 1;
    else attempts = Number(cfg.requestRetries ?? 2) + 1;

    const { retryDelayMs } = getNetworkRetryConfig(options);
    return {
        timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 10000,
        attempts: Number.isFinite(attempts) ? Math.max(1, Math.floor(attempts)) : 3,
        retryDelayMs
    };
}

async function fetchAPISingleAttempt(endpoint, timeoutMs = 10000) {
    const url = `${BACKEND_URL}${endpoint}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetch(url, {
            method: 'GET',
            headers: { 'Accept': 'application/json' },
            signal: controller.signal
        });

        if (!response.ok) {
            return { success: false, data: null, status: response.status, retryable: response.status >= 500 };
        }

        const contentType = response.headers.get("content-type");
        if (!contentType?.includes("application/json")) {
            return { success: false, data: null, status: response.status, retryable: false };
        }

        const data = await response.json();
        return { success: !!data, data, status: response.status, retryable: false };
    } catch (error) {
        // Errores de red, timeout (AbortError) o cuerpo cortado a mitad de lectura.
        return { success: false, data: null, status: 0, retryable: true, timedOut: error?.name === 'AbortError' };
    } finally {
        clearTimeout(timer);
    }
}

const inflightApiRequests = new Map();

async function fetchAPIWithPolicy(endpoint, options) {
    const { timeoutMs, attempts, retryDelayMs } = resolveRequestPolicy(endpoint, options);
    let lastResult = { success: false, data: null };
    let attemptsMade = 0;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        attemptsMade = attempt;
        lastResult = await fetchAPISingleAttempt(endpoint, timeoutMs);
        if (lastResult.success) return lastResult;
        if (!lastResult.retryable) break;
        if (attempt < attempts) await delay(retryDelayMs);
    }

    const reason = lastResult.timedOut ? `timeout ${timeoutMs}ms` : `status ${lastResult.status ?? '?'}`;
    console.warn(`Falló fetch a ${endpoint} (${reason}, ${attemptsMade}/${attempts} intentos).`);
    return { success: false, data: null, status: lastResult.status ?? 0 };
}

// Si ya hay un request en vuelo para el mismo endpoint y la misma política se reutiliza la misma promesa.
function fetchAPI(endpoint, options = {}) {
    const { timeoutMs, attempts, retryDelayMs } = resolveRequestPolicy(endpoint, options);
    const key = `${endpoint}|${timeoutMs}|${attempts}|${retryDelayMs}`;
    const existing = inflightApiRequests.get(key);
    if (existing) return existing;

    const request = fetchAPIWithPolicy(endpoint, options)
        .finally(() => {
            if (inflightApiRequests.get(key) === request) inflightApiRequests.delete(key);
        });
    inflightApiRequests.set(key, request);
    return request;
}

async function fetchWithRetry(endpoint, options = {}) {
    const res = await fetchAPI(endpoint, options);
    return res.success ? res.data : null;
}

function normalizeKVPayload(payload) {
    let value = payload;

    if (value && typeof value === 'object') {
        if ('value' in value) value = value.value;
        else if ('data' in value) value = value.data;
        else if ('result' in value) value = value.result;
    }

    if (typeof value === 'string') {
        try {
            return JSON.parse(value);
        } catch {
            return null;
        }
    }

    return value;
}

async function fetchKV(clave) {
    const response = await fetchAPI(`${KV_ENDPOINT}?clave=${encodeURIComponent(clave)}`);
    if (!response.success) return null;
    return normalizeKVPayload(response.data);
}

async function loadSubteStaticFromKV() {
    const current = globalThis.cache.subteStatic;
    if (current?.lines && current?.stations) return true;

    if (globalThis.cache.subteStaticPromise) {
        return globalThis.cache.subteStaticPromise;
    }

    globalThis.cache.subteStaticPromise = (async () => {
        const [lines, stations] = await Promise.all([
            fetchKV(KV_KEYS.subteLines),
            fetchKV(KV_KEYS.subteStations)
        ]);

        if (!lines || !stations) return false;

        globalThis.cache.subteStatic = { lines, stations };
        return true;
    })();

    const loaded = await globalThis.cache.subteStaticPromise;
    globalThis.cache.subteStaticPromise = null;
    return loaded;
}

function getNestedArray(payload) {
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload?.results)) return payload.results;
    if (Array.isArray(payload?.data)) return payload.data;
    return [];
}

function toFiniteNumber(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function normalizeTrainStaticData(rawLines, rawStations) {
    const linesSource = rawLines?.lines || {};
    const stationsSource = rawStations?.stations || {};
    const lines = {};
    const stations = {};

    Object.entries(stationsSource).forEach(([stationId, stationValue]) => {
        if (!stationValue || typeof stationValue !== 'object') return;
        const lat = toFiniteNumber(stationValue.lat);
        const lon = toFiniteNumber(stationValue.lon);
        if (lat === null || lon === null) return;

        const sofseStationId = toFiniteNumber(stationValue.sofseStationId);

        stations[stationId] = {
            ...stationValue,
            id: stationId,
            lat,
            lon,
            sofseStationId
        };
    });

    Object.entries(linesSource).forEach(([lineId, lineValue]) => {
        if (!lineValue || typeof lineValue !== 'object') return;

        const stationIds = (lineValue.stationIds || [])
            .map(id => id?.toString?.())
            .filter(id => !!id && !!stations[id]);

        lines[lineId] = {
            ...lineValue,
            id: lineId,
            stations: stationIds
        };
    });

    return { lines, stations };
}

function isSofse403Like(value) {
    return /\b403\b|forbidden|acceso denegado/i.test(String(value || ''));
}

async function readSofsePayload(response) {
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
        const text = await response.text();
        return { isJson: false, text, data: null };
    }

    try {
        const data = await response.json();
        return { isJson: true, text: '', data };
    } catch {
        return { isJson: false, text: '', data: null };
    }
}

function shouldRetrySofseRequest(response, payload, error) {
    if (response?.status === 403) return true;
    if (error && isSofse403Like(error?.message || '')) return true;
    if (!payload) return false;
    if (!payload.isJson && isSofse403Like(payload.text)) return true;
    if (!response?.ok && isSofse403Like(JSON.stringify(payload.data || {}))) return true;
    return false;
}

async function fetchSofseSingleAttempt(url, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, {
            method: 'GET',
            headers: { 'Accept': 'application/json' },
            signal: controller.signal
        });
        // El timeout sigue activo mientras se lee el body (un body colgado también aborta).
        const payload = await readSofsePayload(response);
        return { response, payload, error: null };
    } catch (error) {
        return { response: null, payload: null, error };
    } finally {
        clearTimeout(timer);
    }
}

async function fetchSofseAPI(pathname, query = {}) {
    const cfg = globalThis.NETWORK_CONFIG || {};
    const MAX_RETRIES = Math.max(1, Number(cfg.retryMax ?? 3));
    const RETRY_403_DELAY_MS = Math.max(0, Number(cfg.sofse403DelayMs ?? 2800));
    const RETRY_OTHER_DELAY_MS = Math.max(0, Number(cfg.retryDelayMs ?? 1000));
    const TIMEOUT_MS = Math.max(1000, Number(cfg.sofseRequestTimeoutMs ?? 12000));
    const url = new URL(`${SOFSE_API_BASE}${pathname}`);
    Object.entries(query).forEach(([key, value]) => {
        if (value === null || value === undefined || value === '') return;
        url.searchParams.set(key, String(value));
    });

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
        const { response, payload, error } = await fetchSofseSingleAttempt(url.toString(), TIMEOUT_MS);

        let failure = null;
        let retryDelayMs = RETRY_OTHER_DELAY_MS;
        if (error) {
            if (shouldRetrySofseRequest(null, null, error)) {
                failure = 'Excepción 403';
                retryDelayMs = RETRY_403_DELAY_MS;
            } else {
                failure = error?.name === 'AbortError'
                    ? `timeout ${TIMEOUT_MS}ms`
                    : `Excepción: ${error?.message || 'error desconocido'}`;
            }
        } else if (shouldRetrySofseRequest(response, payload, null)) {
            failure = 'Error tipo 403';
            if (response?.status === 403) retryDelayMs = RETRY_403_DELAY_MS;
        } else if (!response.ok) {
            failure = `HTTP ${response.status}`;
        } else if (!payload.isJson) {
            failure = 'Respuesta no JSON';
        } else {
            return { success: true, data: payload.data };
        }

        if (attempt >= MAX_RETRIES) {
            console.warn(`[SOFSE] ${failure} en ${pathname}. Sin más reintentos (${attempt}/${MAX_RETRIES}).`);
            break;
        }
        console.warn(`[SOFSE] ${failure} en ${pathname}. Reintento ${attempt}/${MAX_RETRIES}...`);
        await delay(retryDelayMs);
    }

    return { success: false, data: null };
}

// SOFSE devuelve horarios ISO a veces sin offset: se interpretan como hora de Buenos Aires (UTC-3, sin DST).
function parseSofseIsoToEpochSeconds(iso) {
    if (iso === null || iso === undefined || iso === '') return null;
    let raw = String(iso).trim();
    const isLocalDateTime = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(raw);
    if (isLocalDateTime) raw = `${raw.replace(' ', 'T')}-03:00`;
    const ms = new Date(raw).getTime();
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

function normalizeStationNameForMatch(name) {
    let normalized = normalizeText(name || '')
        .replaceAll('.', ' ')
        .replaceAll('-', ' ')
        .replaceAll('/', ' ')
        .replaceAll(/\s+/g, ' ')
        .trim();

    const replacements = [
        [/\bs y kosteki\b/g, 'santillan y kosteki'],
        [/\br escalada\b/g, 'remedios de escalada'],
        [/\bl zamora\b/g, 'lomas de zamora'],
        [/\bh yrigoyen\b/g, 'hipolito yrigoyen'],
        [/\ba korn\b/g, 'alejandro korn'],
        [/\bj\s*l\s*suarez\b/g, 'jose leon suarez'],
        [/\bs\s*a\s*de\s*padua\b/g, 'san antonio de padua'],
        [/\ba\s*ferrari\b/g, 'agustin ferrari'],
        [/\bl\s*m\s*drago\b/g, 'doctor luis maria drago'],
        [/\bfco\b/g, 'francisco'],
        [/\bing\b/g, 'ingeniero'],
        [/\bgral\b/g, 'general'],
        [/\bcnel\b/g, 'coronel'],
        [/\bdr\b/g, 'doctor'],
        [/\bviad\b/g, 'viaducto'],
        [/\bprov\b/g, 'provincial']
    ];

    replacements.forEach(([pattern, value]) => {
        normalized = normalized.replaceAll(pattern, value);
    });

    const aliases = {
        'plaza c': 'constitucion',
        's y kosteki': 'dario santillan y maximiliano kosteki',
        'santillan y kosteki': 'dario santillan y maximiliano kosteki',
        'l zamora': 'lomas de zamora',
        'r escalada': 'remedios de escalada',
        'h yrigoyen': 'hipolito yrigoyen',
        'jose leon suarez': 'jose leon suarez',
        'a korn': 'alejandro korn',
        'j l suarez': 'jose leon suarez',
        's a de padua': 'san antonio de padua',
        'a ferrari': 'agustin ferrari'
    };

    return aliases[normalized] || normalized;
}

function canonicalStationKey(name) {
    const normalized = normalizeStationNameForMatch(name)
        .replaceAll('estacion', ' ')
        .replaceAll('apeadero', ' ')
        .replaceAll('cabina', ' ')
        .replaceAll('oeste', ' ')
        .replaceAll('provincial', ' ')
        .replaceAll('viaducto', ' ')
        .replaceAll(/\s+/g, ' ')
        .trim();

    const tokens = normalized
        .split(' ')
        .filter(Boolean)
        .filter(token => token.length > 1 || token === 'c' || token === 'r');

    return tokens.join(' ').trim();
}

function stationNameSimilarity(leftName, rightName) {
    const left = canonicalStationKey(leftName);
    const right = canonicalStationKey(rightName);
    if (!left || !right) return 0;
    if (left === right) return 1;
    if (left.includes(right) || right.includes(left)) return 0.93;

    const leftTokens = new Set(left.split(' '));
    const rightTokens = new Set(right.split(' '));
    const common = [...leftTokens].filter(token => rightTokens.has(token)).length;
    const base = Math.max(leftTokens.size, rightTokens.size);
    return base > 0 ? (common / base) : 0;
}

function resolveSofseStationId(localStation) {
    const directId = toFiniteNumber(localStation?.sofseStationId);
    if (directId) {
        return {
            id: directId,
            ramalId: toFiniteNumber(localStation?.sofseRamalId)
        };
    }

    return null;
}

function normalizeSofseStationRef(value) {
    const stationId = toFiniteNumber(value?.id || value?.stationId || value?.sofseStationId || value);
    if (!stationId) return null;

    const ramalId = toFiniteNumber(
        value?.ramalId
        || value?.idRamal
        || value?.ramal?.id
        || value?.ramal?.idRamal
    );

    return {
        id: stationId,
        ramalId: ramalId || null
    };
}

function getStationLineHint(localStation) {
    return normalizeText(localStation?.lineName || localStation?.lineShort || localStation?.lineId || '');
}

function scoreSofseStationCandidate(localStation, remoteStation) {
    const localName = localStation?.name || '';
    const remoteName = remoteStation?.nombre || remoteStation?.name || '';
    const nameScore = stationNameSimilarity(localName, remoteName);

    const lineHint = getStationLineHint(localStation);
    const ramalName = normalizeText(remoteStation?.ramal?.nombre || remoteStation?.nombre_ramal || '');
    const gerenciaName = normalizeText(remoteStation?.gerencia?.nombre || remoteStation?.nombre_gerencia || '');
    const lineScore = lineHint && (ramalName.includes(lineHint) || gerenciaName.includes(lineHint)) ? 0.2 : 0;

    return nameScore + lineScore;
}

async function resolveSofseStationIdFromAPI(localStation) {
    const stationName = localStation?.name;
    if (!stationName) return null;

    const stationKey = localStation.id || localStation.stationId || stationName;
    const nameKey = canonicalStationKey(stationName);
    const byStationKey = normalizeSofseStationRef(globalThis.cache.trainSofseResolveByStationKey?.[stationKey]);
    if (byStationKey) return byStationKey;

    const byName = normalizeSofseStationRef(globalThis.cache.trainSofseResolveByName?.[nameKey]);
    if (byName) {
        globalThis.cache.trainSofseResolveByStationKey[stationKey] = byName;
        return byName;
    }

    const failedCache = globalThis.cache.trainSofseResolveFailedByStationKey
        || (globalThis.cache.trainSofseResolveFailedByStationKey = {});
    const failedKeys = [`station:${stationKey}`, `name:${nameKey}`];
    const now = Date.now();
    if (failedKeys.some(key => Number(failedCache[key]) > now)) return null;

    if (globalThis.cache.trainSofseResolvePromiseByStationKey?.[stationKey]) {
        return globalThis.cache.trainSofseResolvePromiseByStationKey[stationKey];
    }

    const rememberFailure = () => {
        const ttlMs = Math.max(0, Number(globalThis.NETWORK_CONFIG?.sofseStationNegativeCacheTtlMs ?? 600000));
        const expiresAt = Date.now() + ttlMs;
        failedKeys.forEach(key => { failedCache[key] = expiresAt; });
        return null;
    };

    globalThis.cache.trainSofseResolvePromiseByStationKey[stationKey] = (async () => {
        const searchPath = getAppPath('sofseStations', '/infraestructura/estaciones');
        const searchRes = await fetchSofseAPI(searchPath, { nombre: stationName });
        if (!searchRes.success) return rememberFailure();

        const candidates = getNestedArray(searchRes.data)
            .map(item => ({
                ...item,
                id: toFiniteNumber(item?.id || item?.idEstacion || item?.id_estacion),
                ramalId: toFiniteNumber(item?.ramal?.id || item?.idRamal || item?.id_ramal)
            }))
            .filter(item => !!item.id);

        if (!candidates.length) return rememberFailure();

        const scored = candidates
            .map(item => ({
                stationRef: {
                    id: item.id,
                    ramalId: item.ramalId || null
                },
                score: scoreSofseStationCandidate(localStation, item)
            }))
            .sort((left, right) => right.score - left.score);

        const winner = scored[0];
        if (!winner || winner.score < 0.55) return rememberFailure();

        globalThis.cache.trainSofseResolveByStationKey[stationKey] = winner.stationRef;
        globalThis.cache.trainSofseResolveByName[nameKey] = winner.stationRef;
        return winner.stationRef;
    })();

    const resolvedId = await globalThis.cache.trainSofseResolvePromiseByStationKey[stationKey];
    delete globalThis.cache.trainSofseResolvePromiseByStationKey[stationKey];
    return resolvedId;
}

async function loadTrainStaticFromKV() {
    const current = globalThis.cache.trainStatic;
    if (current?.lines && current?.stations && Object.keys(current.lines).length > 0) return true;

    if (globalThis.cache.trainStaticPromise) {
        return globalThis.cache.trainStaticPromise;
    }

    globalThis.cache.trainStaticPromise = (async () => {
        const [lines, stations] = await Promise.all([
            fetchKV(KV_KEYS.trainLines),
            fetchKV(KV_KEYS.trainStations)
        ]);

        if (!lines || !stations) return false;

        const normalized = normalizeTrainStaticData(lines, stations);
        if (Object.keys(normalized.lines).length === 0 || Object.keys(normalized.stations).length === 0) {
            console.warn('[Tren] Datos estáticos vacíos o inválidos en KV.');
            return false;
        }

        globalThis.cache.trainStatic = normalized;
        return true;
    })();

    const loaded = await globalThis.cache.trainStaticPromise;
    globalThis.cache.trainStaticPromise = null;
    return loaded;
}

function normalizeSofseArribosPayload(payload) {
    const rawResults = getNestedArray(payload);
    const timestamp = toFiniteNumber(payload?.timestamp) || Math.floor(Date.now() / 1000);

    const arrivals = rawResults
        .map(item => {
            const arribo = item?.arribo || {};
            const servicio = item?.servicio || {};
            const segundosRaw = toFiniteNumber(arribo?.segundos);
            const llegadaProgramadaIso = arribo?.llegada?.programada || servicio?.desde?.estacion?.llegada?.programada || null;
            const salidaProgramadaIso = arribo?.salida?.programada || servicio?.desde?.estacion?.salida?.programada || null;
            const llegadaProgramadaTs = parseSofseIsoToEpochSeconds(llegadaProgramadaIso);
            const salidaProgramadaTs = parseSofseIsoToEpochSeconds(salidaProgramadaIso);

            let estimatedArrivalTs = null;
            if (segundosRaw === null) {
                estimatedArrivalTs = llegadaProgramadaTs || salidaProgramadaTs || null;
            } else {
                estimatedArrivalTs = timestamp + segundosRaw;
            }

            let etaSeconds = null;
            if (segundosRaw === null) {
                if (estimatedArrivalTs) {
                    etaSeconds = Math.max(0, estimatedArrivalTs - Math.floor(Date.now() / 1000));
                }
            } else {
                etaSeconds = Math.max(0, segundosRaw);
            }

            return {
                etaSeconds,
                estimatedArrivalTs,
                plataforma: arribo?.anden?.nombre || servicio?.desde?.estacion?.anden?.nombre || '-',
                destino: servicio?.hasta?.estacion?.nombre || servicio?.ramal?.cabeceraFinal?.nombre || servicio?.ramal?.nombre || 'Sin destino',
                ramal: servicio?.ramal?.nombre || '-',
                gerencia: servicio?.gerencia?.nombre || '-',
                estado: servicio?.desde?.estado?.nombre || arribo?.salida?.enAnden || null,
                numero: servicio?.numero || null
            };
        })
        .filter(item => item.etaSeconds !== null || item.estimatedArrivalTs)
        .sort((a, b) => (a.etaSeconds ?? Number.MAX_SAFE_INTEGER) - (b.etaSeconds ?? Number.MAX_SAFE_INTEGER));

    return { timestamp, arrivals };
}

function trainLineHasRealtime(lineId) {
    const excluded = globalThis.APP_CONFIG?.FEATURES?.trainLinesWithoutRealtime || [];
    return !lineId || !excluded.includes(lineId);
}

// options.maxAgeMs: acepta una copia más vieja que el TTL (refresh silencioso de cercanos).
async function getTrainArrivalsForStation(stationData, options = {}) {
    if (!stationData || typeof stationData !== 'object') {
        return { success: false, reason: 'invalid-station' };
    }
    if (!isFeatureEnabled('trainRealtime')) return { success: false, reason: 'disabled' };
    if (!trainLineHasRealtime(stationData.lineId)) return { success: false, reason: 'line-without-realtime' };

    const stationKey = stationData.id || stationData.stationId || stationData.name;
    const cacheItem = globalThis.cache.trainArrivalsByStation[stationKey];
    const maxAgeMs = Number(options.maxAgeMs);
    const fetchedAt = Number(cacheItem?.fetchedAt || 0);
    const acceptOlder = Number.isFinite(maxAgeMs) && fetchedAt > 0 && (Date.now() - fetchedAt) < maxAgeMs;
    if (cacheItem && (cacheItem.expiresAt > Date.now() || acceptOlder)) {
        return { success: true, data: cacheItem.data, cached: true };
    }

    let sofseStationRef = resolveSofseStationId(stationData);
    if (!sofseStationRef) {
        sofseStationRef = await resolveSofseStationIdFromAPI(stationData);
    }

    if (!sofseStationRef?.id) {
        return { success: false, reason: 'station-not-mapped' };
    }

    stationData.sofseStationId = sofseStationRef.id;
    stationData.sofseRamalId = sofseStationRef.ramalId || null;

    const arrivalsBasePath = getAppPath('sofseArrivalsByStation', '/arribos/estacion').replace(/\/+$/, '');
    const arrivalsRes = await fetchSofseAPI(`${arrivalsBasePath}/${sofseStationRef.id}`, {
        ramal: sofseStationRef.ramalId,
        cantidad: 6,
        paraApp: true
    });

    if (!arrivalsRes.success || !arrivalsRes.data) {
        return { success: false, reason: 'arrivals-fetch-failed' };
    }

    const normalized = normalizeSofseArribosPayload(arrivalsRes.data);
    const result = {
        ...normalized,
        stationId: sofseStationRef.id,
        ramalId: sofseStationRef.ramalId || null
    };

    const nowSweep = Date.now();
    const cacheObj = globalThis.cache.trainArrivalsByStation;
    const cacheKeys = Object.keys(cacheObj);
    if (cacheKeys.length > 50) {
        cacheKeys.forEach(k => {
            if (cacheObj[k]?.expiresAt < nowSweep) {
                delete cacheObj[k];
            }
        });
    }

    globalThis.cache.trainArrivalsByStation[stationKey] = {
        data: result,
        fetchedAt: Date.now(),
        expiresAt: Date.now() + TRAIN_ARRIVALS_TTL_MS
    };

    return { success: true, data: result, cached: false };
}

// Trenes en vivo: /trenes/arribosLinea devuelve los arribos de todas las estaciones de una línea
// (un request por línea en vista y refresh; el worker cachea). Si el worker todavía no tiene la
// ruta (404) se sigue como antes: arribos por estación al abrir tooltips o en cercanos.
const trainLiveState = { unsupported: false };

function getTrainLinesInView(trainStatic, maxLines) {
    if (!map || maxLines <= 0) return [];
    const bounds = map.getBounds().pad(0.1);
    return Object.entries(trainStatic.lines || {})
        .filter(([lineId]) => trainLineHasRealtime(lineId))
        .map(([lineId, line]) => ({
            lineId,
            inView: (line.stations || []).filter(stationId => {
                const station = trainStatic.stations?.[stationId];
                return station && bounds.contains([station.lat, station.lon]);
            }).length
        }))
        .filter(item => item.inView > 0)
        .sort((left, right) => right.inView - left.inView)
        .slice(0, maxLines)
        .map(item => item.lineId);
}

function storeTrainLineArrivals(payload) {
    const expiresAt = Date.now() + TRAIN_ARRIVALS_TTL_MS;
    let stored = 0;
    Object.entries(payload?.stations || {}).forEach(([stationKey, station]) => {
        if (!station?.ok || !station.data) return;
        globalThis.cache.trainArrivalsByStation[stationKey] = {
            data: {
                ...normalizeSofseArribosPayload(station.data),
                stationId: toFiniteNumber(station.sofseStationId),
                ramalId: toFiniteNumber(station.ramalId)
            },
            fetchedAt: Date.now(),
            expiresAt
        };
        stored += 1;
    });
    return stored;
}

// true = llegaron arribos nuevos; null = nada que pedir, ruta no desplegada o falla (no es un error de la app).
async function refreshTrainLiveNow() {
    if (!activeTypes.train || trainLiveState.unsupported || !isFeatureEnabled('trainRealtime')) return null;
    const trainStatic = globalThis.cache.trainStatic;
    if (!trainStatic?.lines || !trainStatic?.stations) return null;

    const maxLines = Math.max(0, Number(globalThis.APP_CONFIG?.FEATURES?.trainLiveMaxLines ?? 4));
    const lineIds = getTrainLinesInView(trainStatic, maxLines);
    if (lineIds.length === 0) return null;

    const linePath = getAppPath('trainLineArrivals', '/trenes/arribosLinea');
    const responses = await Promise.all(lineIds.map(lineId => fetchAPI(`${linePath}?linea=${encodeURIComponent(lineId)}`)));
    if (!responses.some(res => res.success) && responses.some(res => res.status === 404)) {
        trainLiveState.unsupported = true;
        return null;
    }
    if (!activeTypes.train) return null;

    const stored = responses.reduce((total, res) => total + (res.success ? storeTrainLineArrivals(res.data) : 0), 0);
    return stored > 0 ? true : null;
}

// null = pronóstico apagado por flag (subteRealtime): no se pide y no es un error.
async function refreshSubteNow(options = {}) {
    const { force = false } = options;
    if (!isFeatureEnabled('subteRealtime')) return null;
    if (!force && !activeTypes.subte) return false;
    const subteForecastPath = getAppPath('subteForecast', '/subtes/forecastGTFS');
    const subteRes = await fetchAPI(subteForecastPath);
    if (!subteRes.success || !subteRes.data) return false;
    // Si el tipo se desactivó mientras se esperaba la respuesta no se escribe el cache (no es un error).
    if (!force && !activeTypes.subte) return true;
    globalThis.cache.subteForecast = subteRes.data?.Entity || [];
    globalThis.cache.subteTimestamp = subteRes.data?.Header?.timestamp || Math.floor(Date.now() / 1000);
    globalThis.cache.subteFetchedAt = Date.now();
    buildSubteForecastIndex(subteRes.data);
    return true;
}



async function refreshBikeRoutesNow() {
    if (!isFeatureEnabled('bikeRoutes')) return null;
    if (globalThis.cache.bikeRoutes) return true;
    if (globalThis.cache.bikeRoutesPromise) return globalThis.cache.bikeRoutesPromise;

    const bikeRoutesPath = getAppPath('bikeRoutes', '/obtener-bicisenda');
    const sourceUrl = `${BACKEND_URL}${bikeRoutesPath}`;

    globalThis.cache.bikeRoutesPromise = (async () => {
        const { timeoutMs } = resolveRequestPolicy(bikeRoutesPath);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await fetch(sourceUrl, {
                headers: { 'Accept': 'application/geo+json, application/json' },
                signal: controller.signal
            });
            if (!response.ok) return false;
            const payload = await response.json();
            if (!payload || payload.type !== 'FeatureCollection' || !Array.isArray(payload.features)) return false;

            globalThis.cache.bikeRoutes = payload;
            return true;
        } catch {
            return false;
        } finally {
            clearTimeout(timer);
            globalThis.cache.bikeRoutesPromise = null;
        }
    })();

    return globalThis.cache.bikeRoutesPromise;
}
// stationInformation (nombre/ubicación) casi no cambia: se cachea con TTL largo y en cada refresh
// solo se pide stationStatus. Si falla la renovación se sigue usando la copia anterior.
const bikeStationInfoCache = { infoMap: null, fetchedAt: 0 };

async function getBikeStationInfoMap() {
    const ttlMs = Math.max(0, Number(globalThis.APP_CONFIG?.TIMEOUTS?.bikeStationInfoTtlMs ?? 3600000));
    const cached = bikeStationInfoCache.infoMap;
    if (cached && (Date.now() - bikeStationInfoCache.fetchedAt) < ttlMs) return cached;

    const bikeInfoPath = getAppPath('bikeStationInformation', '/ecobici/gbfs/stationInformation');
    const bikeInfoRes = await fetchAPI(bikeInfoPath);
    const stations = bikeInfoRes.success ? bikeInfoRes.data?.data?.stations : null;
    if (!Array.isArray(stations)) return cached;

    const infoMap = {};
    stations.forEach(s => { infoMap[s.station_id] = s; });
    bikeStationInfoCache.infoMap = infoMap;
    bikeStationInfoCache.fetchedAt = Date.now();
    return infoMap;
}

async function refreshBikeNow(options = {}) {
    const { force = false } = options;
    if (!isFeatureEnabled('bikeStations')) return null;
    if (!force && !activeTypes.bike) return true;
    const bikeStatusPath = getAppPath('bikeStationStatus', '/ecobici/gbfs/stationStatus');
    const [infoMap, bikeStatusRes] = await Promise.all([
        getBikeStationInfoMap(),
        fetchAPI(bikeStatusPath)
    ]);

    if (!infoMap || !bikeStatusRes.success) return false;
    if (!force && !activeTypes.bike) return false;

    const bikeStatus = bikeStatusRes.data;
    globalThis.cache.bike = (bikeStatus.data?.stations || [])
        .filter(s => infoMap[s.station_id])
        .map(s => ({ ...infoMap[s.station_id], ...s }));
    globalThis.cache.bikeFetchedAt = Date.now();
    return true;
}
