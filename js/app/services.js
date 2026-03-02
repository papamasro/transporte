async function fetchAPI(endpoint) {
    try {
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
    } catch {
        return { success: false, data: null };
    }
}

async function fetchWithRetry(endpoint, retryDelayMs = 1000) {
    while (true) {
        setStatus('CARGANDO');
        const res = await fetchAPI(endpoint);
        if (res.success) {
            setStatus('LIVE');
            return res.data;
        }

        setStatus('ERROR');
        console.warn(`Falló fetch a ${endpoint}, reintentando en ${retryDelayMs / 1000}s...`);
        await new Promise(resolve => setTimeout(resolve, retryDelayMs));
    }
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

async function loadTrainStaticFromKV() {
    const current = globalThis.cache.trainStatic;
    if (current?.lines && current?.stations) return true;

    if (globalThis.cache.trainStaticPromise) {
        return globalThis.cache.trainStaticPromise;
    }

    globalThis.cache.trainStaticPromise = (async () => {
        const [lines, stations] = await Promise.all([
            fetchKV(KV_KEYS.trainLines),
            fetchKV(KV_KEYS.trainStations)
        ]);

        if (!lines || !stations) return false;

        globalThis.cache.trainStatic = { lines, stations };
        return true;
    })();

    const loaded = await globalThis.cache.trainStaticPromise;
    globalThis.cache.trainStaticPromise = null;
    return loaded;
}

async function refreshSubteNow() {
    if (!activeTypes.subte) return;
    const subteRes = await fetchAPI("/subtes/forecastGTFS");
    if (!subteRes.success || !subteRes.data) return false;
    globalThis.cache.subteForecast = subteRes.data?.Entity || [];
    globalThis.cache.subteTimestamp = subteRes.data?.Header?.timestamp || Math.floor(Date.now() / 1000);
    buildSubteForecastIndex(subteRes.data);
    return true;
}

async function refreshBikeNow() {
    if (!activeTypes.bike) return;
    const [bikeInfoRes, bikeStatusRes] = await Promise.all([
        fetchAPI("/ecobici/gbfs/stationInformation"),
        fetchAPI("/ecobici/gbfs/stationStatus")
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
