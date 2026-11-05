// Favoritos: líneas (colectivo, subte, tren) y estaciones/paradas (subte, tren, Ecobici, parada de
// colectivo) guardados en localStorage. Lo guardado se trata como dato no confiable: se valida al
// leer y al marcar, y todo se escapa al dibujar. Las estrellas (☆/★) se dibujan en popups,
// sugerencias y cercanos con buildFavoriteStarHtml(); un único listener resuelve el toque.

const FAVORITES_STORAGE_KEY = 'radaramba.favorites-v1';
const FAVORITES_VERSION = 1;
const FAVORITES_MAX = 30;
const FAVORITES_RENDER_THROTTLE_MS = 300;
const FAVORITE_TYPES_BY_KIND = { line: ['bus', 'subte', 'train'], station: ['subte', 'train', 'bike', 'stop'] };
const FAVORITE_ID_PATTERN = /^[\p{L}\p{N} _.:,-]{1,64}$/u;
const FAVORITE_DEFAULT_COLORS = { bus: '#4f46e5', subte: '#475569', train: '#0ea5e9', bike: '#10b981', stop: '#475569' };
const FAVORITE_ICON_BADGES = { bike: '🚲', stop: '🚏', train: '🚆' };
const FAVORITE_CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

const favoritesState = {
    items: [],
    keys: new Set(),
    editing: false,
    renderTimer: 0
};

function getFavoriteKey(item) {
    return `${item.kind}:${item.type}:${item.id}`;
}

function cleanFavoriteText(value, maxLength) {
    if (typeof value !== 'string' && typeof value !== 'number') return '';
    return String(value).replaceAll(FAVORITE_CONTROL_CHARS, '').trim().slice(0, maxLength);
}

function readFavoriteCoordinate(value, limit) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) && Math.abs(number) <= limit ? Math.round(number * 1e6) / 1e6 : null;
}

// null si no es un favorito válido. Solo se conservan campos conocidos.
function sanitizeFavorite(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const kind = raw.kind;
    if (!Object.hasOwn(FAVORITE_TYPES_BY_KIND, kind)) return null;
    const type = raw.type;
    if (!FAVORITE_TYPES_BY_KIND[kind].includes(type)) return null;
    const id = cleanFavoriteText(raw.id, 64);
    if (!FAVORITE_ID_PATTERN.test(id)) return null;
    const lat = readFavoriteCoordinate(raw.lat, 90);
    const lon = readFavoriteCoordinate(raw.lon, 180);
    if (type === 'stop' && (lat === null || lon === null)) return null;

    const item = {
        kind,
        type,
        id,
        label: cleanFavoriteText(raw.label, 80) || id,
        color: safeCssColor(raw.color, FAVORITE_DEFAULT_COLORS[type])
    };
    const line = cleanFavoriteText(raw.line, 40);
    if (line) item.line = line;
    if (lat !== null && lon !== null) {
        item.lat = lat;
        item.lon = lon;
    }
    return item;
}

function parseFavoritesPayload(payload) {
    const items = Array.isArray(payload?.items) && payload.v === FAVORITES_VERSION ? payload.items : [];
    const seen = new Set();
    const result = [];
    for (const raw of items) {
        const item = sanitizeFavorite(raw);
        if (!item) continue;
        const key = getFavoriteKey(item);
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(item);
        if (result.length >= FAVORITES_MAX) break;
    }
    return result;
}

function loadFavorites() {
    try {
        const raw = globalThis.localStorage?.getItem(FAVORITES_STORAGE_KEY);
        return raw ? parseFavoritesPayload(JSON.parse(raw)) : [];
    } catch {
        return [];
    }
}

function saveFavorites() {
    try {
        globalThis.localStorage?.setItem(FAVORITES_STORAGE_KEY, JSON.stringify({ v: FAVORITES_VERSION, items: favoritesState.items }));
        return true;
    } catch {
        return false;
    }
}

function setFavoriteItems(items) {
    favoritesState.items = items;
    favoritesState.keys = new Set(items.map(getFavoriteKey));
}

function isFavorite(target) {
    const item = sanitizeFavorite(target);
    return !!item && favoritesState.keys.has(getFavoriteKey(item));
}

// ─── Objetivos (lo que se guarda al tocar ☆) ─────────────────────────────────

function getBusLineFavoriteTarget(line) {
    const label = cleanFavoriteText(line, 20);
    const id = normalizeLineToken(label);
    if (!id) return null;
    return { kind: 'line', type: 'bus', id, label, line: label, color: getColor('bus', label) };
}

// data: estación tal como la usan marcadores y cercanos.
function getStationFavoriteTarget(type, data) {
    if (!data) return null;
    if (type === 'subte') {
        if (!data.routeId || !data.id) return null;
        return {
            kind: 'station', type, id: `${data.routeId}:${data.id}`, label: data.name, line: data.lineShort,
            color: data.color || globalThis.cache?.subteStatic?.lines?.[data.routeId]?.color, lat: data.lat, lon: data.lon
        };
    }
    if (type === 'train') {
        if (!data.lineId || !data.id) return null;
        return {
            kind: 'station', type, id: `${data.lineId}:${data.id}`, label: data.name, line: data.lineShort || data.lineName,
            color: data.color, lat: data.lat, lon: data.lon
        };
    }
    if (type === 'bike') {
        if (data.station_id === undefined || data.station_id === null) return null;
        return { kind: 'station', type, id: String(data.station_id), label: data.name, color: '#10b981', lat: data.lat, lon: data.lon };
    }
    if (type === 'stop') {
        const lat = Number(data.lat);
        const lon = Number(data.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
        const lines = Array.isArray(data.lines) ? data.lines.slice(0, 6).join(', ') : '';
        return { kind: 'station', type, id: `${lat.toFixed(5)},${lon.toFixed(5)}`, label: data.name || 'Parada', line: lines, lat, lon };
    }
    return null;
}

// Sugerencias de búsqueda: la línea de subte/tren guarda su sigla para el distintivo.
function toFavoriteTarget(entry) {
    if (!entry) return null;
    return {
        kind: entry.kind,
        type: entry.type,
        id: entry.id,
        label: entry.label,
        color: entry.color,
        line: entry.line || (entry.kind === 'line' ? entry.badge : ''),
        lat: entry.lat,
        lon: entry.lon
    };
}

// options.decorative: dentro de una opción del listbox (no puede haber un botón anidado en
// role="option"): se usa solo con puntero.
function buildFavoriteStarHtml(target, options = {}) {
    const item = sanitizeFavorite(toFavoriteTarget(target));
    if (!item) return '';
    const pressed = favoritesState.keys.has(getFavoriteKey(item));
    const attrs = [
        ['data-fav-kind', item.kind],
        ['data-fav-type', item.type],
        ['data-fav-id', item.id],
        ['data-fav-label', item.label],
        ['data-fav-color', item.color],
        ['data-fav-line', item.line || ''],
        ['data-fav-lat', item.lat ?? ''],
        ['data-fav-lon', item.lon ?? '']
    ].map(([name, value]) => `${name}="${escapeHtml(value)}"`).join(' ');
    const svg = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"><path d="M12 2.8l2.8 5.7 6.3.9-4.6 4.4 1.1 6.2L12 17.1 6.4 20l1.1-6.2L2.9 9.4l6.3-.9z"/></svg>';
    if (options.decorative) {
        return `<span class="fav-star" data-fav-toggle ${attrs} data-fav-pressed="${pressed}" aria-hidden="true">${svg}</span>`;
    }
    const label = escapeHtml(`Favorito: ${item.label}`);
    return `<button type="button" class="fav-star" data-fav-toggle ${attrs} aria-pressed="${pressed}" aria-label="${label}" title="${pressed ? 'Quitar de favoritos' : 'Guardar en favoritos'}">${svg}</button>`;
}

function readFavoriteFromElement(element) {
    const data = element.dataset;
    return sanitizeFavorite({
        kind: data.favKind,
        type: data.favType,
        id: data.favId,
        label: data.favLabel,
        color: data.favColor,
        line: data.favLine,
        lat: data.favLat,
        lon: data.favLon
    });
}

function syncFavoriteStars() {
    document.querySelectorAll('[data-fav-toggle]').forEach(element => {
        const item = readFavoriteFromElement(element);
        if (!item) return;
        const pressed = String(favoritesState.keys.has(getFavoriteKey(item)));
        if (element.tagName === 'BUTTON') {
            element.setAttribute('aria-pressed', pressed);
            element.title = pressed === 'true' ? 'Quitar de favoritos' : 'Guardar en favoritos';
        } else {
            element.dataset.favPressed = pressed;
        }
    });
}

function toggleFavorite(target) {
    const item = sanitizeFavorite(target);
    if (!item) return false;
    const key = getFavoriteKey(item);
    if (favoritesState.keys.has(key)) {
        setFavoriteItems(favoritesState.items.filter(existing => getFavoriteKey(existing) !== key));
        saveFavorites();
        showToast(`Quitaste ${item.label} de favoritos`, { id: 'favorites' });
    } else {
        if (favoritesState.items.length >= FAVORITES_MAX) {
            showToast(`Podés guardar hasta ${FAVORITES_MAX} favoritos. Quitá alguno para sumar otro.`, { id: 'favorites', tone: 'error' });
            return false;
        }
        setFavoriteItems([...favoritesState.items, item]);
        if (!saveFavorites()) showToast('No pudimos guardar el favorito en este navegador', { id: 'favorites', tone: 'error' });
        else showToast(`Guardaste ${item.label} en favoritos`, { id: 'favorites', tone: 'success' });
    }
    syncFavoriteStars();
    renderFavorites();
    return true;
}

function removeFavorite(key) {
    const item = favoritesState.items.find(existing => getFavoriteKey(existing) === key);
    if (item) toggleFavorite(item);
}

// ─── Info en vivo de cada favorito ───────────────────────────────────────────

function formatFavoriteDistance(meters) {
    if (typeof formatDistance === 'function') return formatDistance(meters);
    return meters >= 1000 ? `${(meters / 1000).toFixed(1)} km` : `${Math.round(meters)} m`;
}

function getBusLineFavoriteInfo(item) {
    const busContext = !!activeTypes.bus || !!globalThis.nearbyState?.active;
    const vehicles = Array.isArray(globalThis.cache?.bus) ? globalThis.cache.bus : [];
    if (!busContext || vehicles.length === 0) return 'Tocá para verla en el mapa';
    const positions = [];
    vehicles.forEach(vehicle => {
        if (!matchesLineToken(normalizeLineToken(getBusDisplayLine(vehicle)), item.id)) return;
        const coords = getVehicleCoordinates(vehicle);
        if (coords) positions.push(coords);
    });
    if (positions.length === 0) return 'Sin colectivos en vivo ahora';
    const bounds = map?.getBounds?.();
    const inView = bounds ? positions.filter(point => bounds.contains([point.lat, point.lon])).length : 0;
    if (inView > 0) return `${inView} en vista`;
    const userLocation = globalThis.cache?.userLocation;
    const reference = userLocation ? { lat: userLocation.lat, lon: userLocation.lon } : (() => {
        const center = typeof getVisibleViewCenter === 'function' ? getVisibleViewCenter() : map?.getCenter?.();
        return center ? { lat: center.lat, lon: center.lng } : null;
    })();
    if (!reference) return `${positions.length} en vivo`;
    const nearest = Math.min(...positions.map(point => haversineMeters(reference.lat, reference.lon, point.lat, point.lon)));
    return `El más cercano, a ${formatFavoriteDistance(nearest)}${userLocation ? ' de vos' : ''}`;
}

function getSubteStationFavoriteInfo(item) {
    if (!globalThis.cache?.subteFetchedAt) return 'Tocá para ver llegadas';
    const separator = item.id.indexOf(':');
    const routeId = item.id.slice(0, separator);
    const stopId = item.id.slice(separator + 1);
    const station = globalThis.cache.subteStatic?.stations?.[stopId];
    if (!station) return 'Tocá para ver llegadas';
    const nowTs = Math.floor(Date.now() / 1000);
    const next = getSubteStationForecast({ id: stopId, name: station.name, routeId })
        .find(row => row.arrivalTime >= nowTs - 60 && row.arrivalTime <= nowTs + 7200);
    return next ? `Próximo: ${formatEtaMinutes(next.arrivalTime, nowTs).toLowerCase()}` : 'Sin pronóstico ahora';
}

function getTrainStationFavoriteInfo(item) {
    const stationId = item.id.slice(item.id.indexOf(':') + 1);
    const arrivals = globalThis.cache?.trainArrivalsByStation?.[stationId]?.data?.arrivals;
    if (!Array.isArray(arrivals) || arrivals.length === 0) return 'Tocá para ver arribos';
    const nowTs = Math.floor(Date.now() / 1000);
    const etas = arrivals.map(arrival => {
        const estimated = Number(arrival.estimatedArrivalTs);
        return Number.isFinite(estimated) && estimated > 0 ? estimated - nowTs : Number(arrival.etaSeconds);
    }).filter(eta => Number.isFinite(eta) && eta >= -30);
    if (etas.length === 0) return 'Sin arribos reportados';
    const minutes = Math.max(0, Math.round(Math.min(...etas) / 60));
    return minutes === 0 ? 'Próximo: llegando' : `Próximo: en ${minutes} min`;
}

function getBikeStationFavoriteInfo(item) {
    const station = (globalThis.cache?.bike || []).find(entry => String(entry.station_id) === item.id);
    if (!station) return 'Tocá para ver bicis disponibles';
    const bikes = Number(station.num_bikes_available) || 0;
    const docks = Number(station.num_docks_available) || 0;
    return `${bikes} ${bikes === 1 ? 'bici' : 'bicis'} · ${docks} ${docks === 1 ? 'lugar' : 'lugares'}`;
}

function getFavoriteInfo(item) {
    if (item.kind === 'line') {
        if (item.type === 'bus') return getBusLineFavoriteInfo(item);
        return item.type === 'subte' ? 'Subte · ver línea' : 'Tren · ver línea';
    }
    if (item.type === 'subte') return getSubteStationFavoriteInfo(item);
    if (item.type === 'train') return getTrainStationFavoriteInfo(item);
    if (item.type === 'bike') return getBikeStationFavoriteInfo(item);
    return item.line ? `Parada · ${item.line}` : 'Parada de colectivo';
}

function getFavoriteBadge(item) {
    if (item.kind === 'line') {
        const text = item.line || item.label;
        return item.type === 'train' && text.length > 3 ? FAVORITE_ICON_BADGES.train : text.slice(0, 4);
    }
    if (item.type === 'subte' && item.line) return item.line.slice(0, 3);
    return FAVORITE_ICON_BADGES[item.type] || '★';
}

// ─── Sección "Favoritos" (diff por clave) ────────────────────────────────────

function buildFavoriteElement(item, key) {
    const li = document.createElement('li');
    li.className = 'favorite-item';
    li.dataset.favKey = key;
    const badge = getFavoriteBadge(item);
    const isIcon = /\p{Extended_Pictographic}/u.test(badge);
    li.innerHTML = `
        <button type="button" class="favorite-open" data-fav-open>
            <span class="line-badge${isIcon ? ' is-icon' : ''}" style="background:${safeCssColor(item.color, '#475569')}" aria-hidden="true">${escapeHtml(badge)}</span>
            <span class="favorite-text">
                <span class="favorite-title">${escapeHtml(item.label)}</span>
                <span class="favorite-info"></span>
            </span>
        </button>
        <button type="button" class="favorite-remove" data-fav-remove aria-label="${escapeHtml(`Quitar ${item.label} de favoritos`)}" title="Quitar de favoritos">×</button>`;
    return li;
}

function renderFavorites() {
    clearTimeout(favoritesState.renderTimer);
    favoritesState.renderTimer = 0;
    const slot = document.getElementById('favorites-slot');
    const list = document.getElementById('favorites-list');
    const empty = document.getElementById('favorites-empty');
    const edit = document.getElementById('favorites-edit');
    if (!slot || !list) return;

    const items = favoritesState.items;
    if (items.length === 0 && favoritesState.editing) setFavoritesEditing(false);
    slot.hidden = false;
    if (empty) empty.hidden = items.length > 0;
    list.hidden = items.length === 0;
    if (edit) edit.hidden = items.length === 0;
    slot.classList.toggle('is-editing', favoritesState.editing);

    const wantedKeys = new Set(items.map(getFavoriteKey));
    list.querySelectorAll('.favorite-item').forEach(element => {
        if (!wantedKeys.has(element.dataset.favKey)) element.remove();
    });
    items.forEach((item, index) => {
        const key = getFavoriteKey(item);
        let element = [...list.children].find(child => child.dataset.favKey === key);
        if (!element) element = buildFavoriteElement(item, key);
        if (list.children[index] !== element) list.insertBefore(element, list.children[index] || null);
        const info = element.querySelector('.favorite-info');
        const text = getFavoriteInfo(item);
        if (info && info.textContent !== text) info.textContent = text;
        const open = element.querySelector('[data-fav-open]');
        if (open) open.setAttribute('aria-label', `${item.label}. ${text}`);
        const remove = element.querySelector('[data-fav-remove]');
        if (remove) remove.hidden = !favoritesState.editing;
    });
}

// Se llama desde cada renderMarkers (datos nuevos o mapa movido): agrupa en un render cada 300 ms.
function scheduleFavoritesRender() {
    if (favoritesState.renderTimer || favoritesState.items.length === 0) return;
    favoritesState.renderTimer = setTimeout(renderFavorites, FAVORITES_RENDER_THROTTLE_MS);
}

function setFavoritesEditing(editing) {
    favoritesState.editing = !!editing;
    const edit = document.getElementById('favorites-edit');
    if (edit) {
        edit.setAttribute('aria-pressed', String(favoritesState.editing));
        edit.textContent = favoritesState.editing ? 'Listo' : 'Editar';
    }
}

function handleFavoritesListClick(event) {
    const item = event.target.closest('.favorite-item');
    if (!item) return;
    const key = item.dataset.favKey;
    if (event.target.closest('[data-fav-remove]')) {
        // El foco pasa al siguiente (o anterior) para no perderse al quitar el elemento.
        const sibling = item.nextElementSibling || item.previousElementSibling;
        removeFavorite(key);
        const target = sibling?.querySelector('[data-fav-remove]') || document.getElementById('favorites-edit');
        // Sin favoritos el botón Editar se oculta: el foco vuelve al título de la sección.
        (target && !target.hidden ? target : document.getElementById('favorites-title'))?.focus({ preventScroll: true });
        return;
    }
    if (event.target.closest('[data-fav-open]')) {
        const favorite = favoritesState.items.find(existing => getFavoriteKey(existing) === key);
        if (favorite) openSearchTarget(favorite);
    }
}

// Captura: el toque en ☆ no abre la sugerencia, el ítem de cercanos ni hace click en el mapa.
function handleFavoriteStarClick(event) {
    const star = event.target.closest?.('[data-fav-toggle]');
    if (!star) return;
    event.preventDefault();
    event.stopPropagation();
    const item = readFavoriteFromElement(star);
    if (item) toggleFavorite(item);
}

function initFavorites() {
    setFavoriteItems(loadFavorites());
    document.addEventListener('click', handleFavoriteStarClick, true);
    document.getElementById('favorites-list')?.addEventListener('click', handleFavoritesListClick);
    document.getElementById('favorites-edit')?.addEventListener('click', () => {
        setFavoritesEditing(!favoritesState.editing);
        renderFavorites();
    });
    // Otra pestaña cambió los favoritos.
    globalThis.addEventListener('storage', event => {
        if (event.key !== FAVORITES_STORAGE_KEY) return;
        setFavoriteItems(loadFavorites());
        syncFavoriteStars();
        renderFavorites();
    });
    renderFavorites();
}

globalThis.initFavorites = initFavorites;
globalThis.buildFavoriteStarHtml = buildFavoriteStarHtml;
globalThis.getStationFavoriteTarget = getStationFavoriteTarget;
globalThis.getBusLineFavoriteTarget = getBusLineFavoriteTarget;
globalThis.scheduleFavoritesRender = scheduleFavoritesRender;
globalThis.toggleFavorite = toggleFavorite;
globalThis.isFavorite = isFavorite;
globalThis.sanitizeFavorite = sanitizeFavorite;
globalThis.parseFavoritesPayload = parseFavoritesPayload;
