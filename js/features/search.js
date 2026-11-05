// Búsqueda con sugerencias (combobox ARIA 1.2 con listbox agrupado). Las sugerencias salen de lo que
// ya está en memoria: colectivos en vivo, índice estático de recorridos (data/routes/index.json),
// datos estáticos de subte/trenes y estaciones de Ecobici. Esas fuentes se piden una sola vez al
// enfocar el campo: escribir nunca hace pedidos de red.
//
// El texto del campo filtra los marcadores en vivo (local). La búsqueda "confirmada" (Enter, elegir
// una sugerencia o abrir un link) es la única que pide el recorrido de una línea (red).

const SEARCH_MAX_RESULTS = 8;
const SEARCH_GROUP_MAX = 4;
const SEARCH_DEBOUNCE_MS = 120;
const SEARCH_STATIC_LINES_MAX = 3000;
const SEARCH_STATION_ZOOM = 16;
const SEARCH_GROUPS = [
    { type: 'bus', label: 'Colectivos' },
    { type: 'subte', label: 'Subte' },
    { type: 'train', label: 'Trenes' },
    { type: 'bike', label: 'Ecobici' }
];
// "línea 60", "subte a", "tren mitre": el prefijo no forma parte del nombre buscado.
const SEARCH_PREFIX_PATTERN = /^(?:linea|colectivo|bondi|subte|tren|estacion|ecobici)\s+/;

const searchState = {
    committed: '',
    entries: [],
    activeIndex: -1,
    debounceTimer: 0,
    preloadPromise: null,
    staticLines: null,
    liveText: ''
};

function getCommittedSearchQuery() {
    return searchState.committed;
}

function getSearchElements() {
    return {
        input: document.getElementById('search'),
        results: document.getElementById('search-results'),
        clear: document.getElementById('search-clear'),
        live: document.getElementById('search-live')
    };
}

// ─── Fuentes ─────────────────────────────────────────────────────────────────

async function loadSearchStaticLines() {
    if (searchState.staticLines || typeof areStaticRoutesAvailable !== 'function') return true;
    if (!(await areStaticRoutesAvailable())) return true;
    const result = await fetchStaticRouteResource('index.json');
    const lines = result.ok && result.data?.lines && typeof result.data.lines === 'object' ? result.data.lines : null;
    if (!lines) return false;
    searchState.staticLines = Object.keys(lines)
        .filter(label => label.length > 0 && label.length <= 12)
        .slice(0, SEARCH_STATIC_LINES_MAX);
    return true;
}

function preloadSearchSources() {
    if (searchState.preloadPromise) return searchState.preloadPromise;
    const tasks = [];
    if (isTransportTypeEnabled('bus')) tasks.push(loadSearchStaticLines());
    if (isTransportTypeEnabled('subte')) tasks.push(loadSubteStaticFromKV());
    if (isTransportTypeEnabled('train')) tasks.push(loadTrainStaticFromKV());
    if (isTransportTypeEnabled('bike') && isFeatureEnabled('bikeStations')) tasks.push(getBikeStationInfoMap().then(Boolean));
    const promise = Promise.all(tasks.map(task => Promise.resolve(task).catch(() => false)))
        .then(results => {
            // Si alguna fuente falló, el próximo foco la vuelve a pedir.
            if (results.includes(false)) searchState.preloadPromise = null;
            const { input } = getSearchElements();
            if (input && document.activeElement === input && input.value.trim()) updateSearchSuggestions();
        });
    searchState.preloadPromise = promise;
    return promise;
}

// ─── Coincidencias ───────────────────────────────────────────────────────────

function parseSearchQuery(value) {
    const text = normalizeText(value).trim().replaceAll(/\s+/g, ' ');
    const stripped = text.replace(SEARCH_PREFIX_PATTERN, '');
    return { text: stripped, token: normalizeLineToken(stripped) };
}

// Sin acentos, por prefijo de nombre, de palabra o subcadena (mínimo 2 letras).
function scoreSearchName(name, text) {
    if (!text || text.length < 2) return 0;
    const normalized = normalizeText(name);
    if (normalized === text) return 100;
    if (normalized.startsWith(text)) return 80;
    if (normalized.split(/[^a-z0-9]+/).some(word => word.startsWith(text))) return 60;
    return normalized.includes(text) ? 40 : 0;
}

function scoreSearchLine(lineToken, token) {
    if (!token || !lineToken) return 0;
    if (lineToken === token) return 100;
    return matchesLineToken(lineToken, token) ? 70 : 0;
}

function collectBusLineEntries(query) {
    if (!isTransportTypeEnabled('bus') || !query.token) return [];
    const lines = new Map();
    (Array.isArray(globalThis.cache?.bus) ? globalThis.cache.bus : []).forEach(vehicle => {
        const label = getBusDisplayLine(vehicle);
        const token = normalizeLineToken(label);
        if (!token) return;
        const entry = lines.get(token) || { label, live: 0 };
        entry.live += 1;
        lines.set(token, entry);
    });
    (searchState.staticLines || []).forEach(label => {
        const token = normalizeLineToken(label);
        if (token && !lines.has(token)) lines.set(token, { label, live: 0 });
    });

    let matches = [...lines].map(([token, entry]) => ({ token, entry, score: scoreSearchLine(token, query.token) }))
        .filter(item => item.score > 0);
    // "6" no matchea "60" por token: con números se cae a prefijo simple solo si no hubo nada.
    if (matches.length === 0 && /^\d+$/.test(query.token)) {
        matches = [...lines].filter(([token]) => token.startsWith(query.token))
            .map(([token, entry]) => ({ token, entry, score: 30 }));
    }
    return matches.map(({ token, entry, score }) => ({
        kind: 'line',
        type: 'bus',
        id: token,
        label: entry.label,
        badge: entry.label,
        color: getColor('bus', entry.label),
        meta: entry.live > 0 ? `${entry.live} en vivo` : 'Colectivo',
        score: score + Math.min(entry.live, 9) / 10
    }));
}

function makeSubteStationEntry(routeId, line, stopId, station) {
    const lat = Number(station?.lat);
    const lon = Number(station?.lon);
    if (!station || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    return {
        kind: 'station',
        type: 'subte',
        id: `${routeId}:${stopId}`,
        label: (station.name || 'Estación').toString(),
        badge: (line.short || '?').toString(),
        color: line.color,
        line: (line.short || '').toString(),
        meta: `Subte · Línea ${line.short || ''}`.trim(),
        lat,
        lon
    };
}

function collectSubteEntries(query) {
    const subteStatic = globalThis.cache?.subteStatic;
    if (!isTransportTypeEnabled('subte') || !subteStatic?.lines) return [];
    const entries = [];
    Object.entries(subteStatic.lines).forEach(([routeId, line]) => {
        const lineScore = Math.max(
            scoreSearchLine(normalizeLineToken(line.short), query.token),
            scoreSearchLine(normalizeLineToken(routeId), query.token)
        );
        if (lineScore > 0) {
            entries.push({
                kind: 'line', type: 'subte', id: routeId, label: `Línea ${line.short}`, badge: line.short,
                color: line.color, meta: 'Subte', score: lineScore + 5
            });
        }
        (line.stations || []).forEach(stopId => {
            const station = subteStatic.stations?.[stopId];
            const score = station ? scoreSearchName(station.name, query.text) : 0;
            if (score === 0) return;
            const entry = makeSubteStationEntry(routeId, line, stopId, station);
            if (entry) entries.push({ ...entry, score });
        });
    });
    return entries;
}

function getTrainLineLabel(line, lineId) {
    return (line.name || (line.short ? `Línea ${line.short}` : lineId)).toString();
}

function makeTrainStationEntry(lineId, line, stopId, station) {
    const lat = Number(station?.lat);
    const lon = Number(station?.lon);
    if (!station || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    const short = (line.short || '').toString();
    return {
        kind: 'station',
        type: 'train',
        id: `${lineId}:${station.id || stopId}`,
        label: (station.name || 'Estación').toString(),
        badge: short.length <= 3 && short ? short : '🚆',
        color: line.color || '#0ea5e9',
        line: short || getTrainLineLabel(line, lineId),
        meta: `Tren · ${getTrainLineLabel(line, lineId)}`,
        lat,
        lon
    };
}

function collectTrainEntries(query) {
    const trainStatic = globalThis.cache?.trainStatic;
    if (!isTransportTypeEnabled('train') || !trainStatic?.lines) return [];
    const entries = [];
    Object.entries(trainStatic.lines).forEach(([lineId, line]) => {
        const label = getTrainLineLabel(line, lineId);
        const lineScore = Math.max(
            scoreSearchLine(normalizeLineToken(lineId), query.token),
            scoreSearchLine(normalizeLineToken(line.short || ''), query.token),
            scoreSearchName(line.short || '', query.text),
            scoreSearchName(label, query.text)
        );
        if (lineScore > 0) {
            const short = (line.short || '').toString();
            entries.push({
                kind: 'line', type: 'train', id: lineId, label, badge: short.length <= 3 && short ? short : '🚆',
                color: line.color || '#0ea5e9', meta: 'Tren', score: lineScore + 5
            });
        }
        (line.stations || []).forEach(stopId => {
            const station = trainStatic.stations?.[stopId];
            const score = station ? scoreSearchName(station.name, query.text) : 0;
            if (score === 0) return;
            const entry = makeTrainStationEntry(lineId, line, stopId, station);
            if (entry) entries.push({ ...entry, score });
        });
    });
    return entries;
}

function getBikeStationSource() {
    const live = Array.isArray(globalThis.cache?.bike) && globalThis.cache.bike.length > 0 ? globalThis.cache.bike : null;
    if (live) return live;
    const infoMap = typeof bikeStationInfoCache === 'object' ? bikeStationInfoCache.infoMap : null;
    return infoMap ? Object.values(infoMap) : [];
}

function makeBikeStationEntry(station) {
    const lat = Number(station?.lat);
    const lon = Number(station?.lon);
    const id = (station?.station_id ?? '').toString();
    if (!id || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    return {
        kind: 'station', type: 'bike', id, label: (station.name || 'Estación Ecobici').toString(),
        badge: '🚲', color: '#10b981', meta: 'Ecobici', lat, lon
    };
}

function collectBikeEntries(query) {
    if (!isTransportTypeEnabled('bike') || !isFeatureEnabled('bikeStations')) return [];
    const entries = [];
    getBikeStationSource().forEach(station => {
        const score = scoreSearchName(station.name, query.text);
        if (score === 0) return;
        const entry = makeBikeStationEntry(station);
        if (entry) entries.push({ ...entry, score });
    });
    return entries;
}

const compareSearchEntries = (a, b) => (b.score - a.score) || (a.label.length - b.label.length) || a.label.localeCompare(b.label, 'es');

// Hasta SEARCH_GROUP_MAX por grupo; si sobra lugar se completa con los siguientes de cada grupo.
function buildSearchSuggestions(value) {
    const query = parseSearchQuery(value);
    if (!query.text) return [];
    const byType = {
        bus: collectBusLineEntries(query),
        subte: collectSubteEntries(query),
        train: collectTrainEntries(query),
        bike: collectBikeEntries(query)
    };
    Object.values(byType).forEach(list => list.sort(compareSearchEntries));
    const taken = Object.fromEntries(SEARCH_GROUPS.map(group => [group.type, Math.min(SEARCH_GROUP_MAX, byType[group.type].length)]));
    let total = Object.values(taken).reduce((sum, count) => sum + count, 0);
    for (const group of SEARCH_GROUPS) {
        while (total < SEARCH_MAX_RESULTS && taken[group.type] < byType[group.type].length) {
            taken[group.type] += 1;
            total += 1;
        }
    }
    while (total > SEARCH_MAX_RESULTS) {
        const largest = SEARCH_GROUPS.reduce((best, group) => (taken[group.type] > taken[best.type] ? group : best), SEARCH_GROUPS[0]);
        taken[largest.type] -= 1;
        total -= 1;
    }
    return SEARCH_GROUPS.flatMap(group => byType[group.type].slice(0, taken[group.type]));
}

// ─── Listbox ─────────────────────────────────────────────────────────────────

function buildSearchOptionHtml(entry, index) {
    const color = safeCssColor(entry.color, '#475569');
    const badgeText = (entry.badge || '?').toString();
    const isIcon = /\p{Extended_Pictographic}/u.test(badgeText);
    const star = typeof buildFavoriteStarHtml === 'function' ? buildFavoriteStarHtml(entry, { decorative: true }) : '';
    return `
        <div role="option" id="search-option-${index}" class="search-option" aria-selected="false" data-search-index="${index}">
            <span class="line-badge${isIcon ? ' is-icon' : ''}" style="background:${color}" aria-hidden="true">${escapeHtml(badgeText.slice(0, 4))}</span>
            <span class="search-option-text">
                <span class="search-option-title">${escapeHtml(entry.label)}</span>
                <span class="search-option-meta">${escapeHtml(entry.meta || '')}</span>
            </span>
            ${star}
        </div>`;
}

function renderSearchSuggestions(entries, value) {
    const { input, results } = getSearchElements();
    if (!input || !results) return;
    searchState.entries = entries;
    searchState.activeIndex = -1;
    input.removeAttribute('aria-activedescendant');

    if (!value.trim()) {
        closeSearchSuggestions();
        return;
    }

    if (entries.length === 0) {
        results.innerHTML = `<div class="search-empty" role="presentation">Sin sugerencias. Apretá Enter para buscar «${escapeHtml(value.trim().slice(0, 40))}».</div>`;
    } else {
        let index = 0;
        results.innerHTML = SEARCH_GROUPS.map(group => {
            const groupEntries = entries.filter(entry => entry.type === group.type);
            if (groupEntries.length === 0) return '';
            const options = groupEntries.map(entry => buildSearchOptionHtml(entry, index++)).join('');
            return `<div role="group" aria-labelledby="search-group-${group.type}" class="search-group">
                <div role="presentation" id="search-group-${group.type}" class="search-group-label">${group.label}</div>
                ${options}
            </div>`;
        }).join('');
    }
    results.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    fitSearchResultsToViewport();
    announceSearchCount(entries.length);
}

function announceSearchCount(count) {
    const { live } = getSearchElements();
    if (!live) return;
    let text = 'Sin sugerencias';
    if (count === 1) text = '1 sugerencia';
    else if (count > 1) text = `${count} sugerencias`;
    if (searchState.liveText === text) return;
    searchState.liveText = text;
    live.textContent = text;
}

// Con el teclado en pantalla abierto la lista no puede pasar por debajo de la parte visible.
function fitSearchResultsToViewport() {
    const { input, results } = getSearchElements();
    if (!input || !results || results.hidden) return;
    const viewport = globalThis.visualViewport;
    const viewportBottom = viewport ? viewport.offsetTop + viewport.height : globalThis.innerHeight;
    const available = viewportBottom - input.getBoundingClientRect().bottom - 16;
    results.style.maxHeight = `${Math.round(Math.max(150, Math.min(360, available)))}px`;
}

function closeSearchSuggestions() {
    const { input, results } = getSearchElements();
    clearTimeout(searchState.debounceTimer);
    searchState.entries = [];
    searchState.activeIndex = -1;
    searchState.liveText = '';
    if (results) {
        results.hidden = true;
        results.innerHTML = '';
    }
    if (input) {
        input.setAttribute('aria-expanded', 'false');
        input.removeAttribute('aria-activedescendant');
    }
}

function isSearchOpen() {
    return getSearchElements().results?.hidden === false;
}

function setSearchActiveIndex(index) {
    const { input, results } = getSearchElements();
    if (!input || !results) return;
    const count = searchState.entries.length;
    if (count === 0) return;
    const next = ((index % count) + count) % count;
    searchState.activeIndex = next;
    results.querySelectorAll('[role="option"]').forEach(option => {
        const selected = Number(option.dataset.searchIndex) === next;
        option.setAttribute('aria-selected', String(selected));
        if (selected) option.scrollIntoView({ block: 'nearest' });
    });
    input.setAttribute('aria-activedescendant', `search-option-${next}`);
}

function updateSearchSuggestions() {
    const { input } = getSearchElements();
    if (!input) return;
    renderSearchSuggestions(buildSearchSuggestions(input.value), input.value);
}

function scheduleSearchSuggestions() {
    clearTimeout(searchState.debounceTimer);
    searchState.debounceTimer = setTimeout(updateSearchSuggestions, SEARCH_DEBOUNCE_MS);
}

function syncSearchClearButton() {
    const { input, clear } = getSearchElements();
    if (clear && input) clear.hidden = input.value.length === 0;
}

// ─── Selección ───────────────────────────────────────────────────────────────

function collapseSheetToMap() {
    if (typeof isSheetMode === 'function' && isSheetMode()) setSheetState('peek');
}

// Activa el tipo de transporte (exclusivo) si hace falta y espera a que carguen sus datos (también
// si ya estaba activo pero su carga sigue en curso: los loaders comparten el pedido en vuelo).
async function ensureSearchTypeActive(type) {
    if (!Object.hasOwn(activeTypes, type) || !isTransportTypeEnabled(type)) return false;
    if (!activeTypes[type]) await toggleType(type);
    if (!activeTypes[type]) return false;
    if (type === 'subte') await loadSubteStaticFromKV();
    else if (type === 'train') await loadTrainStaticFromKV();
    else if (type === 'bike' && !(globalThis.cache.bike?.length > 0)) await refreshBikeNow();
    return !!activeTypes[type];
}

function setSearchValue(value, { commit = false } = {}) {
    const { input } = getSearchElements();
    if (!input) return;
    input.value = value;
    searchState.committed = commit ? value.trim() : '';
    syncSearchClearButton();
}

function fitMapToPoints(points) {
    if (!map || points.length < 2) return;
    const insets = typeof getMapObscuredInsets === 'function' ? getMapObscuredInsets() : { top: 0, bottom: 0 };
    map.fitBounds(L.latLngBounds(points), {
        paddingTopLeft: [32, 32 + (insets.top || 0)],
        paddingBottomRight: [32, 32 + (insets.bottom || 0)],
        maxZoom: 15,
        animate: !prefersReducedMotion()
    });
}

function getStaticLinePoints(type, id) {
    const source = type === 'subte' ? globalThis.cache?.subteStatic : globalThis.cache?.trainStatic;
    const line = source?.lines?.[id];
    return (line?.stations || [])
        .map(stopId => source.stations?.[stopId])
        .filter(station => Number.isFinite(Number(station?.lat)) && Number.isFinite(Number(station?.lon)))
        .map(station => [Number(station.lat), Number(station.lon)]);
}

async function selectSearchLine(entry) {
    if (entry.type === 'bus') {
        setSearchValue(entry.label, { commit: true });
        collapseSheetToMap();
        await ensureSearchTypeActive('bus');
        renderMarkers({ force: true });
        return;
    }
    const source = entry.type === 'subte' ? globalThis.cache?.subteStatic : globalThis.cache?.trainStatic;
    const line = source?.lines?.[entry.id];
    const label = entry.type === 'subte' && line ? `Línea ${line.short}` : entry.label;
    // Subte y trenes filtran en el mapa pero no tienen recorrido por red: no se confirma la búsqueda.
    setSearchValue(label);
    collapseSheetToMap();
    if (!(await ensureSearchTypeActive(entry.type))) return;
    renderMarkers({ force: true });
    fitMapToPoints(getStaticLinePoints(entry.type, entry.id));
}

// Busca la estación en los datos cargados (para links y favoritos guardados con datos viejos).
function findSearchStationEntry(type, id) {
    const key = (id ?? '').toString();
    if (type === 'bike') {
        const station = getBikeStationSource().find(item => (item.station_id ?? '').toString() === key);
        return station ? makeBikeStationEntry(station) : null;
    }
    const separator = key.indexOf(':');
    if (separator <= 0) return null;
    const lineId = key.slice(0, separator);
    const stationId = key.slice(separator + 1);
    if (type === 'subte') {
        const subteStatic = globalThis.cache?.subteStatic;
        const line = subteStatic?.lines?.[lineId];
        if (!line || !(line.stations || []).includes(stationId)) return null;
        return makeSubteStationEntry(lineId, line, stationId, subteStatic.stations?.[stationId]);
    }
    if (type === 'train') {
        const trainStatic = globalThis.cache?.trainStatic;
        const line = trainStatic?.lines?.[lineId];
        const stopId = (line?.stations || []).find(candidate => ((trainStatic.stations?.[candidate]?.id || candidate).toString() === stationId));
        return stopId ? makeTrainStationEntry(lineId, line, stopId, trainStatic.stations[stopId]) : null;
    }
    return null;
}

function getStationMarkerStore(type) {
    if (type === 'subte') return markerStores.subteStations;
    if (type === 'train') return markerStores.trainStations;
    if (type === 'bike') return markerStores.bike;
    return null;
}

// Resuelve al terminar el movimiento (o enseguida si el mapa ya está ahí).
function moveMapAndWait(latLng, zoom) {
    return new Promise(resolve => {
        const target = L.latLng(latLng);
        if (map.getZoom() === zoom && map.getCenter().distanceTo(target) < 1) {
            resolve();
            return;
        }
        let timer = 0;
        const finish = () => {
            clearTimeout(timer);
            map.off('moveend', finish);
            resolve();
        };
        timer = setTimeout(finish, 2500);
        map.on('moveend', finish);
        moveMapTo(map, target, zoom, { animate: true, duration: 0.8 });
    });
}

async function focusSearchStation(entry) {
    const lat = Number(entry.lat);
    const lon = Number(entry.lon);
    if (entry.type === 'stop') {
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
        collapseSheetToMap();
        const zoom = Math.max(map.getZoom(), 17);
        moveMapTo(map, getVisibleMapCenter([lat, lon], zoom), zoom, { animate: true, duration: 0.8 });
        return true;
    }
    setSearchValue('');
    collapseSheetToMap();
    if (!(await ensureSearchTypeActive(entry.type))) return false;
    const current = findSearchStationEntry(entry.type, entry.id)
        || (Number.isFinite(lat) && Number.isFinite(lon) ? entry : null);
    if (!current) {
        showToast('No encontramos esa estación', { tone: 'error' });
        return false;
    }
    const zoom = Math.max(Math.round(map.getZoom()), SEARCH_STATION_ZOOM);
    await moveMapAndWait(getVisibleMapCenter([current.lat, current.lon], zoom), zoom);
    renderMarkers({ force: true });
    const marker = getStationMarkerStore(entry.type)?.get(current.id);
    if (!marker) return false;
    marker.closeTooltip?.();
    marker.openPopup();
    return true;
}

// Punto de entrada común para sugerencias, favoritos y links compartidos.
async function openSearchTarget(entry) {
    if (!entry || !map) return false;
    closeSearchSuggestions();
    const result = entry.kind === 'line' ? await selectSearchLine(entry) : await focusSearchStation(entry);
    if (typeof scheduleUrlStateWrite === 'function') scheduleUrlStateWrite();
    return result;
}

function commitSearchText() {
    const { input } = getSearchElements();
    if (!input) return;
    const value = input.value.trim();
    closeSearchSuggestions();
    searchState.committed = value;
    if (value) collapseSheetToMap();
    renderMarkers({ force: true });
    if (typeof scheduleUrlStateWrite === 'function') scheduleUrlStateWrite();
}

function clearSearch({ focus = true } = {}) {
    const { input } = getSearchElements();
    closeSearchSuggestions();
    setSearchValue('');
    renderMarkers({ force: true });
    if (typeof scheduleUrlStateWrite === 'function') scheduleUrlStateWrite();
    if (focus) input?.focus({ preventScroll: true });
}

// ─── Eventos ─────────────────────────────────────────────────────────────────

function handleSearchKeydown(event) {
    if (event.isComposing) return;
    const open = isSearchOpen();
    const count = searchState.entries.length;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (!open) {
            updateSearchSuggestions();
            if (searchState.entries.length > 0) setSearchActiveIndex(event.key === 'ArrowDown' ? 0 : -1);
            return;
        }
        if (count === 0) return;
        const step = event.key === 'ArrowDown' ? 1 : -1;
        setSearchActiveIndex(searchState.activeIndex < 0 && step < 0 ? count - 1 : searchState.activeIndex + step);
        return;
    }
    if (event.key === 'Enter') {
        event.preventDefault();
        const entry = open && searchState.activeIndex >= 0 ? searchState.entries[searchState.activeIndex] : null;
        if (entry) openSearchTarget(entry);
        else commitSearchText();
        return;
    }
    if (event.key === 'Escape') {
        if (open) {
            event.preventDefault();
            event.stopPropagation();
            closeSearchSuggestions();
        } else if (event.target.value) {
            event.preventDefault();
            event.stopPropagation();
            clearSearch();
        }
    }
}

function handleSearchInput() {
    const { input } = getSearchElements();
    if (!input) return;
    // Editar el texto deja de mostrar el recorrido confirmado hasta el próximo Enter o selección.
    if (searchState.committed && normalizeText(input.value).trim() !== normalizeText(searchState.committed)) {
        searchState.committed = '';
    }
    syncSearchClearButton();
    if (typeof isSheetMode === 'function' && isSheetMode() && getSheetState() !== 'full') setSheetState('full', { silent: true });
    if (!input.value.trim()) {
        closeSearchSuggestions();
    } else {
        scheduleSearchSuggestions();
    }
    if (typeof scheduleUrlStateWrite === 'function') scheduleUrlStateWrite();
}

function handleSearchFocus() {
    const { input } = getSearchElements();
    preloadSearchSources();
    if (typeof isSheetMode === 'function' && isSheetMode() && getSheetState() !== 'full') setSheetState('full', { silent: true });
    if (input?.value.trim()) updateSearchSuggestions();
}

function handleSearchResultsClick(event) {
    const option = event.target.closest('[role="option"]');
    if (!option) return;
    const entry = searchState.entries[Number(option.dataset.searchIndex)];
    if (entry) openSearchTarget(entry);
}

function handleSearchResultsPointerMove(event) {
    const option = event.target.closest('[role="option"]');
    if (!option) return;
    const index = Number(option.dataset.searchIndex);
    if (index !== searchState.activeIndex) setSearchActiveIndex(index);
}

function initSearch() {
    const { input, results, clear } = getSearchElements();
    if (!input || !results) return;
    input.addEventListener('input', handleSearchInput);
    input.addEventListener('keydown', handleSearchKeydown);
    input.addEventListener('focus', handleSearchFocus);
    input.addEventListener('blur', () => closeSearchSuggestions());
    // Tocar una opción no debe sacar el foco del campo (si no, el blur cierra la lista antes del click).
    results.addEventListener('mousedown', event => event.preventDefault());
    results.addEventListener('click', handleSearchResultsClick);
    results.addEventListener('pointermove', handleSearchResultsPointerMove);
    clear?.addEventListener('click', () => clearSearch());
    globalThis.visualViewport?.addEventListener('resize', fitSearchResultsToViewport);
    syncSearchClearButton();
}

// Para url-state.js: aplica una búsqueda de un link como si se hubiera confirmado con Enter.
function applySearchQueryFromUrl(value) {
    setSearchValue(value, { commit: true });
}

globalThis.getCommittedSearchQuery = getCommittedSearchQuery;
globalThis.initSearch = initSearch;
globalThis.openSearchTarget = openSearchTarget;
globalThis.findSearchStationEntry = findSearchStationEntry;
globalThis.applySearchQueryFromUrl = applySearchQueryFromUrl;
globalThis.buildSearchSuggestions = buildSearchSuggestions;
globalThis.parseSearchQuery = parseSearchQuery;
