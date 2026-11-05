// Estado compartible en la URL (history.replaceState, sin recargar):
//   ?@=lat,lng,zoom   centro visible y zoom del mapa
//   &capa=subte|tren|ecobici|ninguna   capa activa (colectivos es la de siempre y no se escribe)
//   &q=60  (o &linea=60)   búsqueda confirmada
//   &est=subte:LineaA:A1   estación con el popup abierto
// Todo lo que llega por URL es no confiable: se valida contra listas y rangos, y la búsqueda pasa por
// los mismos caminos que lo escrito a mano (que escapan al dibujar).

const URL_STATE_WRITE_DEBOUNCE_MS = 500;
const URL_STATE_QUERY_MAX = 40;
const URL_STATE_ZOOM_RANGE = [3, 19];
const URL_STATE_TYPE_ALIASES = {
    bus: 'bus', colectivo: 'bus', colectivos: 'bus',
    subte: 'subte',
    train: 'train', tren: 'train', trenes: 'train',
    bike: 'bike', bici: 'bike', ecobici: 'bike',
    none: 'none', ninguna: 'none'
};
const URL_STATE_TYPE_PARAMS = { subte: 'subte', train: 'tren', bike: 'ecobici', none: 'ninguna' };
const URL_STATE_STATION_TYPES = { subte: 'subte', tren: 'train', train: 'train', ecobici: 'bike', bike: 'bike' };
const URL_STATE_STATION_ID_PATTERN = /^[\p{L}\p{N} _.:,-]{1,64}$/u;

const urlState = {
    ready: false,
    writeTimer: 0,
    openStation: null,
    lastSearch: null
};

function parseShareView(value) {
    if (!value) return null;
    const parts = value.split(',').map(part => part.trim());
    if (parts.length < 2 || parts.length > 3 || parts.some(part => !/^-?\d{1,3}(?:\.\d+)?$/.test(part))) return null;
    const [lat, lng] = parts.map(Number);
    const zoom = parts.length === 3 ? Number(parts[2]) : 15;
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
    if (zoom < URL_STATE_ZOOM_RANGE[0] || zoom > URL_STATE_ZOOM_RANGE[1]) return null;
    return { lat, lng, zoom: Math.round(zoom * 10) / 10 };
}

function cleanShareQuery(value) {
    if (typeof value !== 'string') return '';
    return value.replaceAll(/[\u0000-\u001f\u007f]/g, '').replaceAll(/\s+/g, ' ').trim().slice(0, URL_STATE_QUERY_MAX);
}

function parseShareStation(value) {
    if (typeof value !== 'string') return null;
    const separator = value.indexOf(':');
    if (separator <= 0) return null;
    const type = URL_STATE_STATION_TYPES[value.slice(0, separator).toLowerCase()];
    const id = value.slice(separator + 1);
    if (!type || !URL_STATE_STATION_ID_PATTERN.test(id)) return null;
    return { type, id };
}

// Función pura (tests unitarios): ignora todo parámetro inválido o desconocido.
function parseShareParams(search) {
    let params;
    try {
        params = new URLSearchParams(search || '');
    } catch {
        return { view: null, type: null, query: '', station: null };
    }
    const type = URL_STATE_TYPE_ALIASES[(params.get('capa') || '').toLowerCase()] || null;
    return {
        view: parseShareView(params.get('@')),
        type,
        query: cleanShareQuery(params.get('q') ?? params.get('linea') ?? ''),
        station: parseShareStation(params.get('est'))
    };
}

function formatShareNumber(value, decimals) {
    return Number(value.toFixed(decimals)).toString();
}

// Función pura: '' si no hay nada que escribir.
function buildShareSearch(state) {
    const parts = [];
    const view = state?.view;
    if (view && Number.isFinite(view.lat) && Number.isFinite(view.lng) && Number.isFinite(view.zoom)) {
        parts.push(`@=${formatShareNumber(view.lat, 5)},${formatShareNumber(view.lng, 5)},${formatShareNumber(view.zoom, 1)}`);
    }
    if (state?.type && URL_STATE_TYPE_PARAMS[state.type]) parts.push(`capa=${URL_STATE_TYPE_PARAMS[state.type]}`);
    const query = cleanShareQuery(state?.query || '');
    if (query) parts.push(`q=${encodeURIComponent(query)}`);
    const station = state?.station;
    if (station && URL_STATE_TYPE_PARAMS[station.type] && URL_STATE_STATION_ID_PATTERN.test(station.id || '')) {
        parts.push(`est=${URL_STATE_TYPE_PARAMS[station.type]}:${encodeURIComponent(station.id)}`);
    }
    return parts.length > 0 ? `?${parts.join('&')}` : '';
}

// ─── Estado actual de la app ─────────────────────────────────────────────────

function getActiveShareType() {
    // Con cercanos abierto las capas principales están apagadas a propósito: no se comparte eso.
    if (globalThis.nearbyState?.active) return null;
    const active = Object.keys(activeTypes).filter(type => activeTypes[type]);
    if (active.length === 0) return 'none';
    return active[0] === 'bus' ? null : active[0];
}

function getCurrentShareState() {
    const center = typeof getVisibleViewCenter === 'function' ? getVisibleViewCenter() : map?.getCenter();
    return {
        view: center && map ? { lat: center.lat, lng: center.lng, zoom: map.getZoom() } : null,
        type: getActiveShareType(),
        query: document.getElementById('search')?.value || '',
        station: urlState.openStation
    };
}

function writeUrlStateNow() {
    clearTimeout(urlState.writeTimer);
    urlState.writeTimer = 0;
    if (!urlState.ready || !globalThis.history?.replaceState) return;
    const search = buildShareSearch(getCurrentShareState());
    if (search === urlState.lastSearch && search === globalThis.location.search) return;
    urlState.lastSearch = search;
    try {
        history.replaceState(history.state, '', `${globalThis.location.pathname}${search}${globalThis.location.hash}`);
    } catch {}
}

function scheduleUrlStateWrite() {
    if (!urlState.ready) return;
    clearTimeout(urlState.writeTimer);
    urlState.writeTimer = setTimeout(writeUrlStateNow, URL_STATE_WRITE_DEBOUNCE_MS);
}

const URL_STATE_STATION_STORES = () => [
    ['subte', markerStores.subteStations],
    ['train', markerStores.trainStations],
    ['bike', markerStores.bike]
];

function findStationKeyForMarker(marker) {
    for (const [type, store] of URL_STATE_STATION_STORES()) {
        for (const [id, candidate] of store) {
            if (candidate === marker) return { type, id };
        }
    }
    return null;
}

function handleUrlStatePopupOpen(event) {
    urlState.openStation = findStationKeyForMarker(event.popup?._source);
    scheduleUrlStateWrite();
}

function handleUrlStatePopupClose(event) {
    const closed = findStationKeyForMarker(event.popup?._source);
    if (closed && urlState.openStation && closed.type === urlState.openStation.type && closed.id === urlState.openStation.id) {
        urlState.openStation = null;
    }
    scheduleUrlStateWrite();
}

// ─── Compartir ───────────────────────────────────────────────────────────────

async function copyTextToClipboard(text) {
    try {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch {}
    try {
        const area = document.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', '');
        area.className = 'clipboard-buffer';
        document.body.append(area);
        area.select();
        const copied = document.execCommand('copy');
        area.remove();
        return copied;
    } catch {
        return false;
    }
}

async function shareCurrentView() {
    writeUrlStateNow();
    const url = globalThis.location.href;
    const shareData = { title: 'Radar AMBA', text: 'Mirá el transporte en vivo en Radar AMBA', url };
    if (typeof navigator.share === 'function' && (typeof navigator.canShare !== 'function' || navigator.canShare(shareData))) {
        try {
            await navigator.share(shareData);
            return;
        } catch (error) {
            // Cerrar la hoja de compartir no es un error; cualquier otro fallo cae a copiar el link.
            if (error?.name === 'AbortError') return;
        }
    }
    if (await copyTextToClipboard(url)) showToast('Link copiado', { id: 'share', tone: 'success' });
    else showToast('No pudimos copiar el link', { id: 'share', tone: 'error' });
}

// ─── Arranque ────────────────────────────────────────────────────────────────

async function openSharedStation(station) {
    try {
        await openSearchTarget({ kind: 'station', type: station.type, id: station.id });
    } catch {}
}

// Se llama una vez desde bootstrap.init(), con el mapa creado y antes del primer refresh.
// Devuelve hasContext: el link trae una vista o estación (no se pide ni se centra en la ubicación).
function initUrlState() {
    const parsed = parseShareParams(globalThis.location.search);
    if (parsed.view && map) {
        const zoom = Math.min(parsed.view.zoom, map.getMaxZoom?.() || URL_STATE_ZOOM_RANGE[1]);
        map.setView(getVisibleMapCenter([parsed.view.lat, parsed.view.lng], zoom), zoom, { animate: false });
    }
    if (parsed.type && parsed.type !== 'bus' && !parsed.station) {
        // toggleType es exclusivo: activar otra capa apaga colectivos; "ninguna" apaga colectivos.
        const typeToToggle = parsed.type === 'none' ? 'bus' : parsed.type;
        if (isTransportTypeEnabled(typeToToggle)) toggleType(typeToToggle);
    }
    if (parsed.query && !parsed.station) applySearchQueryFromUrl(parsed.query);
    if (parsed.station) openSharedStation(parsed.station);

    map.on('moveend', scheduleUrlStateWrite);
    map.on('popupopen', handleUrlStatePopupOpen);
    map.on('popupclose', handleUrlStatePopupClose);
    // Capas, cercanos, búsqueda: cualquier toque en la hoja puede cambiar el estado; se compara antes de escribir.
    document.getElementById('app-sheet')?.addEventListener('click', scheduleUrlStateWrite);
    urlState.ready = true;
    urlState.lastSearch = globalThis.location.search;
    return { hasContext: !!(parsed.view || parsed.station), parsed };
}

globalThis.initUrlState = initUrlState;
globalThis.scheduleUrlStateWrite = scheduleUrlStateWrite;
globalThis.shareCurrentView = shareCurrentView;
globalThis.parseShareParams = parseShareParams;
globalThis.buildShareSearch = buildShareSearch;
