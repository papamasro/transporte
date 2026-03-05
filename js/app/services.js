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

async function fetchAPISingleAttempt(endpoint) {
    const url = `${BACKEND_URL}${endpoint}`;
    const response = await fetch(url, {
        method: 'GET',
        headers: { 'Accept': 'application/json' }
    });

    if (!response.ok) return { success: false, data: null };

    const contentType = response.headers.get("content-type");
    if (!contentType?.includes("application/json")) {
        return { success: false, data: null };
    }

    const data = await response.json();
    return { success: !!data, data };
}

async function fetchAPI(endpoint, overrides = {}) {
    const { retryMax, retryDelayMs } = getNetworkRetryConfig(overrides);

    for (let attempt = 1; attempt <= retryMax; attempt += 1) {
        try {
            const result = await fetchAPISingleAttempt(endpoint);
            if (result.success) return result;
        } catch {
            // retry below
        }

        if (attempt < retryMax) await delay(retryDelayMs);
    }

    return { success: false, data: null };
}

async function fetchWithRetry(endpoint, overrides = {}) {
    const { retryMax, retryDelayMs } = getNetworkRetryConfig(overrides);
    setStatus('CARGANDO');

    const res = await fetchAPI(endpoint, { retryMax, retryDelayMs });
    if (res.success) {
        setStatus('LIVE');
        return res.data;
    }

    setStatus('ERROR');
    console.warn(`Falló fetch a ${endpoint} tras ${retryMax} intentos (delay ${retryDelayMs}ms).`);
    return null;
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

async function fetchSofseAPI(pathname, query = {}) {
    const cfg = globalThis.NETWORK_CONFIG || {};
    const MAX_RETRIES = Math.max(1, Number(cfg.retryMax ?? 3));
    const RETRY_403_DELAY_MS = Math.max(0, Number(cfg.sofse403DelayMs ?? 2800));
    const RETRY_OTHER_DELAY_MS = Math.max(0, Number(cfg.retryDelayMs ?? 1000));
    const url = new URL(`${SOFSE_API_BASE}${pathname}`);
    Object.entries(query).forEach(([key, value]) => {
        if (value === null || value === undefined || value === '') return;
        url.searchParams.set(key, String(value));
    });

    let attempts = 0;
    while (attempts < MAX_RETRIES) {
        attempts += 1;
        try {
            const response = await fetch(url.toString(), {
                method: 'GET',
                headers: { 'Accept': 'application/json' }
            });

            const payload = await readSofsePayload(response);

            if (shouldRetrySofseRequest(response, payload, null)) {
                await delay(response?.status === 403 ? RETRY_403_DELAY_MS : RETRY_OTHER_DELAY_MS);
                console.warn(`[SOFSE] Error tipo 403 en ${pathname}. Reintento ${attempts}/${MAX_RETRIES}...`);
                continue;
            }

            if (!response.ok) {
                await delay(RETRY_OTHER_DELAY_MS);
                console.warn(`[SOFSE] HTTP ${response.status} en ${pathname}. Reintento ${attempts}/${MAX_RETRIES}...`);
                continue;
            }

            if (!payload.isJson) {
                await delay(RETRY_OTHER_DELAY_MS);
                console.warn(`[SOFSE] Respuesta no JSON en ${pathname}. Reintento ${attempts}/${MAX_RETRIES}...`);
                continue;
            }

            return { success: true, data: payload.data };
        } catch (error) {
            if (shouldRetrySofseRequest(null, null, error)) {
                await delay(RETRY_403_DELAY_MS);
                console.warn(`[SOFSE] Excepción 403 (${pathname}). Reintento ${attempts}/${MAX_RETRIES}...`);
                continue;
            }
            const msg = error?.message || 'error desconocido';
            await delay(RETRY_OTHER_DELAY_MS);
            console.warn(`[SOFSE] Excepción en ${pathname}: ${msg}. Reintento ${attempts}/${MAX_RETRIES}...`);
            continue;
        }
    }

    return { success: false, data: null };
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

    if (globalThis.cache.trainSofseResolvePromiseByStationKey?.[stationKey]) {
        return globalThis.cache.trainSofseResolvePromiseByStationKey[stationKey];
    }

    globalThis.cache.trainSofseResolvePromiseByStationKey[stationKey] = (async () => {
        const searchPath = getAppPath('sofseStations', '/infraestructura/estaciones');
        const searchRes = await fetchSofseAPI(searchPath, { nombre: stationName });
        if (!searchRes.success) return null;

        const candidates = getNestedArray(searchRes.data)
            .map(item => ({
                ...item,
                id: toFiniteNumber(item?.id || item?.idEstacion || item?.id_estacion),
                ramalId: toFiniteNumber(item?.ramal?.id || item?.idRamal || item?.id_ramal)
            }))
            .filter(item => !!item.id);

        if (!candidates.length) return null;

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
        if (!winner || winner.score < 0.55) return null;

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
        if (!normalized) return false;

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
            const llegadaProgramadaTs = llegadaProgramadaIso ? Math.floor(new Date(llegadaProgramadaIso).getTime() / 1000) : null;
            const salidaProgramadaTs = salidaProgramadaIso ? Math.floor(new Date(salidaProgramadaIso).getTime() / 1000) : null;

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

async function getTrainArrivalsForStation(stationData) {
    if (!stationData || typeof stationData !== 'object') {
        return { success: false, reason: 'invalid-station' };
    }

    const stationKey = stationData.id || stationData.stationId || stationData.name;
    const cacheItem = globalThis.cache.trainArrivalsByStation[stationKey];
    if (cacheItem && cacheItem.expiresAt > Date.now()) {
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

    globalThis.cache.trainArrivalsByStation[stationKey] = {
        data: result,
        expiresAt: Date.now() + TRAIN_ARRIVALS_TTL_MS
    };

    return { success: true, data: result, cached: false };
}

async function refreshSubteNow(options = {}) {
    const { force = false } = options;
    if (!force && !activeTypes.subte) return false;
    const subteForecastPath = getAppPath('subteForecast', '/subtes/forecastGTFS');
    const subteRes = await fetchAPI(subteForecastPath);
    if (!subteRes.success || !subteRes.data) return false;
    globalThis.cache.subteForecast = subteRes.data?.Entity || [];
    globalThis.cache.subteTimestamp = subteRes.data?.Header?.timestamp || Math.floor(Date.now() / 1000);
    buildSubteForecastIndex(subteRes.data);
    return true;
}

async function refreshBikeNow(options = {}) {
    const { force = false } = options;
    if (!force && !activeTypes.bike) return false;
    const bikeInfoPath = getAppPath('bikeStationInformation', '/ecobici/gbfs/stationInformation');
    const bikeStatusPath = getAppPath('bikeStationStatus', '/ecobici/gbfs/stationStatus');
    const [bikeInfoRes, bikeStatusRes] = await Promise.all([
        fetchAPI(bikeInfoPath),
        fetchAPI(bikeStatusPath)
    ]);

    if (!bikeInfoRes.success || !bikeStatusRes.success) return false;

    const bikeInfo = bikeInfoRes.data;
    const bikeStatus = bikeStatusRes.data;
    const infoMap = {};
    (bikeInfo.data?.stations || []).forEach(s => infoMap[s.station_id] = s);
    globalThis.cache.bike = (bikeStatus.data?.stations || [])
        .filter(s => infoMap[s.station_id])
        .map(s => ({ ...infoMap[s.station_id], ...s }));
    return true;
}
