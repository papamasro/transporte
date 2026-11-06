let isNearbyPanelOpen = false;
let nearbyRadiusMeters = null;
let nearbySortMode = 'distance';
let nearbySummaryText = '';
// Secciones que el usuario abrió/cerró a mano (clave -> abierta); el resto se abre si tiene resultados.
const nearbySectionOpen = new Map();
let nearbyRefreshRequestId = 0;
let nearbyNextGeolocationAttemptAt = 0;
let nearbySavedActiveTypes = null;
let nearbyPrunePending = false;
let nearbyRenderedBikeRoutes = null;
let nearbyAutoTooltipMarker = null;
const NEARBY_GEO_RETRY_COOLDOWN_MS = 5 * 60 * 1000;
// Los datos de cercanos se reutilizan mientras no venza el intervalo de polling de cada fuente.
const NEARBY_SUBTE_FORECAST_MAX_AGE_MS = Math.max(1000, Number(globalThis.APP_CONFIG?.POLLING?.subteIntervalMs ?? 60000));
const NEARBY_BIKE_MAX_AGE_MS = Math.max(1000, Number(globalThis.APP_CONFIG?.POLLING?.bikeIntervalMs ?? 60000));
const NEARBY_TRAIN_ETA_MAX_AGE_MS = Math.max(1000, Number(globalThis.APP_CONFIG?.POLLING?.trainIntervalMs ?? 60000));
const NEARBY_BUS_CACHE_MAX_AGE_MS = Math.max(0, Number(globalThis.APP_CONFIG?.FEATURES?.nearbyBusCacheMaxAgeMs ?? 45000));

if (!globalThis.nearbyLiveBusMarkers) {
    globalThis.nearbyLiveBusMarkers = new Map();
}

if (!globalThis.nearbyStopMarkers) {
    globalThis.nearbyStopMarkers = new Map();
}

if (!globalThis.nearbyState) {
    globalThis.nearbyState = {
        active: false,
        lastCenter: null,
        lastRadius: 1500,
        lastResults: null,
        loading: false,
        loadingRequestId: 0,
        areaCenter: null
    };
}

if (typeof globalThis.nearbyState.loading !== 'boolean') {
    globalThis.nearbyState.loading = false;
}

if (!Number.isFinite(Number(globalThis.nearbyState.loadingRequestId))) {
    globalThis.nearbyState.loadingRequestId = 0;
}

function getNearbyFeatureConfig() {
    const featureCfg = globalThis.APP_CONFIG?.FEATURES || {};
    const defaultRadius = Number(featureCfg.nearbyStopsRadiusMeters ?? 1500);
    const maxRouteFetch = Number(featureCfg.nearbyBusRouteFetchMax ?? 8);
    const maxTrainRealtime = Number(featureCfg.nearbyTrainRealtimeStations ?? 4);

    return {
        defaultRadius: Number.isFinite(defaultRadius) ? Math.min(5000, Math.max(200, defaultRadius)) : 1500,
        maxRouteFetch: Number.isFinite(maxRouteFetch) ? Math.min(20, Math.max(1, maxRouteFetch)) : 8,
        maxTrainRealtime: Number.isFinite(maxTrainRealtime) ? Math.min(10, Math.max(1, maxTrainRealtime)) : 4
    };
}

function clearNearbyMapOverlay() {
    layers?.nearbyCircle?.clearLayers?.();
    layers?.nearbyRadius?.clearLayers?.();
    layers?.nearbyStops?.clearLayers?.();
    layers?.nearbyVehicles?.clearLayers?.();
    globalThis.nearbyLiveBusMarkers?.clear?.();
    globalThis.nearbyStopMarkers?.clear?.();
    nearbyRenderedBikeRoutes = null;
    nearbyAutoTooltipMarker = null;
    nearbyPrunePending = false;
}

function deactivateMainTransportFilters() {
    if (!nearbySavedActiveTypes) nearbySavedActiveTypes = { ...activeTypes };
    Object.keys(activeTypes || {}).forEach(type => {
        activeTypes[type] = false;
        if (typeof setTypeButtonState === 'function') setTypeButtonState(type, false);
    });
    if (typeof renderMarkers === 'function') renderMarkers({ force: true });
}

async function restoreMainTransportFilters(savedTypes) {
    const typesToRestore = Object.keys(savedTypes || {})
        .filter(type => savedTypes[type] && Object.hasOwn(activeTypes, type));
    if (typesToRestore.length === 0) return;

    typesToRestore.forEach(type => {
        activeTypes[type] = true;
        if (typeof setTypeButtonState === 'function') setTypeButtonState(type, true);
    });
    if (typeof renderMarkers === 'function') renderMarkers({ force: true });

    if (typeof activateType !== 'function') return;
    const results = await Promise.all(typesToRestore.map(type => activateType(type).catch(() => false)));
    if (isNearbyPanelOpen) return;
    // Un toggleType posterior cambió los tipos: el estado final lo define ese toggle.
    if (typesToRestore.some(type => !activeTypes[type])) return;

    if (typeof renderMarkers === 'function') renderMarkers();
    setNearbyStatusValue(results.every(Boolean) ? 'LIVE' : 'ERROR');
}

function clampNearbyRadius(value) {
    return Math.min(5000, Math.max(200, Math.round(Number(value))));
}

function getNearbyRadius() {
    if (!Number.isFinite(nearbyRadiusMeters)) nearbyRadiusMeters = getNearbyFeatureConfig().defaultRadius;
    return nearbyRadiusMeters;
}

// Opciones de FEATURES.nearbyRadiusOptions + el radio inicial configurado + uno custom (setNearbyRadius).
function getNearbyRadiusOptions() {
    const raw = globalThis.APP_CONFIG?.FEATURES?.nearbyRadiusOptions;
    const values = (Array.isArray(raw) && raw.length > 0 ? raw : [500, 1000, 2000])
        .map(clampNearbyRadius)
        .filter(Number.isFinite);
    values.push(getNearbyFeatureConfig().defaultRadius, getNearbyRadius());
    return [...new Set(values)].sort((a, b) => a - b);
}

function formatNearbyRadiusLabel(meters) {
    if (meters < 1000) return `${meters} m`;
    const km = meters / 1000;
    return `${Number.isInteger(km) ? km : km.toFixed(1).replace('.', ',')} km`;
}

function renderNearbyRadiusChips() {
    const group = document.getElementById('nearby-radius-group');
    if (!group) return;
    const options = getNearbyRadiusOptions();
    const signature = options.join(',');
    if (group.dataset.options !== signature) {
        group.dataset.options = signature;
        group.innerHTML = options
            .map(value => `<button type="button" role="radio" class="chip" data-radius="${value}">${formatNearbyRadiusLabel(value)}</button>`)
            .join('');
    }
    const current = getNearbyRadius();
    setRadioGroupValue(group, option => Number(option.dataset.radius) === current);
}

function getNearbySortMode() {
    return nearbySortMode === 'eta' ? 'eta' : 'distance';
}

// Cambiar el radio vuelve a buscar en el mismo centro (sin botón "Buscar").
function setNearbyRadius(value) {
    const radius = clampNearbyRadius(value);
    if (!Number.isFinite(radius)) return;
    const changed = radius !== getNearbyRadius();
    nearbyRadiusMeters = radius;
    renderNearbyRadiusChips();
    if (changed && isNearbyPanelOpen) {
        refreshNearbyTransport({ keepAreaCenter: true, allowLocatePrompt: false }).catch(() => {});
    }
}

// El orden no necesita pedir datos: reordena los últimos resultados.
function setNearbySortMode(mode) {
    nearbySortMode = mode === 'eta' ? 'eta' : 'distance';
    setRadioGroupValue(document.getElementById('nearby-sort-group'), option => option.dataset.sort === nearbySortMode);
    const lastResults = globalThis.nearbyState?.lastResults;
    if (lastResults) renderNearbyDetails(lastResults);
}

function handleNearbyContainerClick(event) {
    const summary = event.target.closest('.nearby-section > summary');
    if (summary) {
        const details = summary.parentElement;
        nearbySectionOpen.set(details.dataset.section, !details.open);
        return;
    }
    const action = event.target.closest('[data-nearby-action]');
    if (!action) return;
    if (action.dataset.nearbyAction === 'expand') {
        setNearbyRadius(Number(action.dataset.radius));
    } else if (action.dataset.nearbyAction === 'locate') {
        // Acción explícita: se reintenta el GPS aunque esté en el período de espera.
        nearbyNextGeolocationAttemptAt = 0;
        refreshNearbyTransport({}).catch(() => {});
    } else if (action.dataset.nearbyAction === 'retry') {
        refreshNearbyTransport({ keepAreaCenter: true }).catch(() => {});
    }
}

function initNearbyControls() {
    renderNearbyRadiusChips();
    setupRadioGroupKeyboard(document.getElementById('nearby-radius-group'), option => setNearbyRadius(Number(option.dataset.radius)));
    const sortGroup = document.getElementById('nearby-sort-group');
    setupRadioGroupKeyboard(sortGroup, option => setNearbySortMode(option.dataset.sort));
    setRadioGroupValue(sortGroup, option => option.dataset.sort === getNearbySortMode());

    const container = document.getElementById('nearby-container');
    if (container && container.dataset.ready !== 'true') {
        container.dataset.ready = 'true';
        container.addEventListener('click', handleNearbyContainerClick);
    }
}

function getNearbyCenterFromMapFallback() {
    const center = typeof getVisibleViewCenter === 'function' ? getVisibleViewCenter() : map?.getCenter?.();
    if (!center) return null;
    const lat = Number(center.lat);
    const lon = Number(center.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    return { lat, lon };
}

function toNearbyCenter(location) {
    const lat = Number(location?.lat);
    const lon = Number(location?.lon);
    if (!location || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    return { lat, lon };
}

function isNearbyLocationFresh(location) {
    return typeof isLocationCacheFresh !== 'function' || isLocationCacheFresh(location);
}

// source: 'area' (Buscar en esta zona), 'cache' (ubicación fresca), 'gps', 'stale' (ubicación vieja), 'map'.
async function getNearbyCenterPosition(options = {}) {
    const { allowLocatePrompt = true } = options;

    const areaCenter = toNearbyCenter(globalThis.nearbyState?.areaCenter);
    if (areaCenter) return { ...areaCenter, source: 'area' };

    const known = typeof getKnownUserLocation === 'function' ? getKnownUserLocation() : globalThis.cache?.userLocation;
    const knownCenter = toNearbyCenter(known);
    if (knownCenter && isNearbyLocationFresh(known)) return { ...knownCenter, source: 'cache' };

    const geolocationEnabled = isFeatureEnabled('geolocation');
    const canAttemptLocate = geolocationEnabled && allowLocatePrompt && Date.now() >= nearbyNextGeolocationAttemptAt;
    if (canAttemptLocate) {
        nearbyNextGeolocationAttemptAt = Date.now() + NEARBY_GEO_RETRY_COOLDOWN_MS;

        try {
            // Si el GPS falla, locateUser restaura la ubicación conocida (con su timestamp viejo).
            const loc = toNearbyCenter(await locateUser({ autoActivateNearby: false, refreshNearby: false }));
            if (loc) {
                const current = globalThis.cache?.userLocation;
                if (isNearbyLocationFresh(current)) {
                    nearbyNextGeolocationAttemptAt = 0;
                    return { ...loc, source: 'gps' };
                }
                return { ...loc, source: 'stale', timestamp: Number(current?.timestamp) || null };
            }
        } catch {
            // fallback below
        }
    }

    if (knownCenter) return { ...knownCenter, source: 'stale', timestamp: Number(known.timestamp) || null };

    const mapCenter = getNearbyCenterFromMapFallback();
    if (mapCenter) return { ...mapCenter, source: 'map' };
    return null;
}

function getSubteEtaInfo(station) {
    const referenceTs = Math.floor(Date.now() / 1000);
    const arrivals = getSubteStationForecast(station)
        .filter(r => r.arrivalTime > 0)
        .filter(r => r.arrivalTime >= (referenceTs - 60) && r.arrivalTime <= (referenceTs + 7200))
        .sort((a, b) => a.arrivalTime - b.arrivalTime)
        .slice(0, 2);

    if (arrivals.length === 0) {
        return { text: 'Sin ETA', hasData: false, etaMinutes: null };
    }

    return {
        text: arrivals.map(item => `${item.routeShort}: ${formatEtaMinutes(item.arrivalTime, referenceTs)}`).join(' · '),
        hasData: true,
        etaMinutes: Math.max(0, Math.round((arrivals[0].arrivalTime - referenceTs) / 60))
    };
}

function collectNearbySubteStations(center, radiusMeters) {
    if (!isNearbySliceEnabled('subte')) return [];

    const subteLines = globalThis.cache.subteStatic?.lines || {};
    const subteStations = globalThis.cache.subteStatic?.stations || {};
    const items = [];

    Object.entries(subteLines).forEach(([routeId, line]) => {
        (line.stations || []).forEach(stopId => {
            const station = subteStations[stopId];
            if (!station) return;

            const lat = Number(station.lat);
            const lon = Number(station.lon);
            if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;

            const distance = haversineMeters(center.lat, center.lon, lat, lon);
            if (distance > radiusMeters) return;

            const payload = {
                id: stopId,
                ...station,
                routeId,
                lineShort: line.short,
                color: line.color
            };
            const etaInfo = getSubteEtaInfo(payload);

            items.push({
                ...payload,
                type: 'subte',
                distance,
                etaText: etaInfo.text,
                etaMinutes: etaInfo.etaMinutes,
                hasRealtimeData: etaInfo.hasData
            });
        });
    });

    items.sort((a, b) => a.distance - b.distance);
    return items;
}

function collectNearbyTrainStations(center, radiusMeters) {
    if (!isNearbySliceEnabled('train')) return [];

    const trainStatic = globalThis.cache.trainStatic || {};
    const trainLines = trainStatic.lines || {};
    const trainStations = trainStatic.stations || {};
    const items = [];

    Object.entries(trainLines).forEach(([lineId, line]) => {
        (line.stations || []).forEach(stopId => {
            const station = trainStations[stopId];
            if (!station) return;

            const lat = Number(station.lat);
            const lon = Number(station.lon);
            if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;

            const distance = haversineMeters(center.lat, center.lon, lat, lon);
            if (distance > radiusMeters) return;

            items.push({
                ...station,
                id: station.id || stopId,
                lineId,
                lineShort: station.lineShort || line.short,
                lineName: station.lineName || line.name,
                color: line.color || '#0ea5e9',
                type: 'train',
                distance,
                etaText: 'Sin ETA',
                etaMinutes: null,
                hasRealtimeData: false
            });
        });
    });

    items.sort((a, b) => a.distance - b.distance);
    return items;
}

function collectNearbyBusVehicles(center, radiusMeters) {
    if (!isNearbySliceEnabled('busVehicles')) return [];

    const buses = Array.isArray(globalThis.cache.bus) ? globalThis.cache.bus : [];
    const items = [];

    buses.forEach(vehicle => {
        const coords = getVehicleCoordinates(vehicle);
        if (!coords) return;

        const distance = haversineMeters(center.lat, center.lon, coords.lat, coords.lon);
        if (distance > radiusMeters) return;

        items.push({
            vehicle,
            lat: coords.lat,
            lon: coords.lon,
            distance,
            line: getBusDisplayLine(vehicle)
        });
    });

    items.sort((a, b) => a.distance - b.distance);
    return items;
}

// Bounding box (en grados) que contiene el círculo de búsqueda.
function getNearbyRadiusBounds(center, radiusMeters) {
    const latDelta = radiusMeters / 111320;
    const lonDelta = radiusMeters / (111320 * Math.max(0.01, Math.cos(toRadians(center.lat))));
    return {
        minLat: center.lat - latDelta,
        maxLat: center.lat + latDelta,
        minLon: center.lon - lonDelta,
        maxLon: center.lon + lonDelta
    };
}

function isPointWithinNearbyRadius(center, radiusMeters, lat, lon, bounds) {
    if (bounds && (lat < bounds.minLat || lat > bounds.maxLat || lon < bounds.minLon || lon > bounds.maxLon)) return false;
    return haversineMeters(center.lat, center.lon, lat, lon) <= radiusMeters;
}

// El GeoJSON de bicisendas es estático: el bbox de cada feature se calcula una sola vez.
const nearbyBikeFeatureBounds = new WeakMap();

function getBikeFeatureBounds(feature) {
    if (nearbyBikeFeatureBounds.has(feature)) return nearbyBikeFeatureBounds.get(feature);

    const geometry = feature?.geometry;
    const lines = geometry?.type === 'MultiLineString' ? geometry.coordinates : [geometry?.coordinates];
    const bounds = { minLat: Infinity, maxLat: -Infinity, minLon: Infinity, maxLon: -Infinity };
    (lines || []).forEach(line => {
        if (!Array.isArray(line)) return;
        line.forEach(pair => {
            if (!Array.isArray(pair) || pair.length < 2) return;
            const lon = Number(pair[0]);
            const lat = Number(pair[1]);
            if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
            if (lat < bounds.minLat) bounds.minLat = lat;
            if (lat > bounds.maxLat) bounds.maxLat = lat;
            if (lon < bounds.minLon) bounds.minLon = lon;
            if (lon > bounds.maxLon) bounds.maxLon = lon;
        });
    });

    const result = Number.isFinite(bounds.minLat) ? bounds : null;
    nearbyBikeFeatureBounds.set(feature, result);
    return result;
}

function nearbyBoundsIntersect(a, b) {
    return a.minLat <= b.maxLat && a.maxLat >= b.minLat && a.minLon <= b.maxLon && a.maxLon >= b.minLon;
}

function clipBikeRoutesByNearbyRadius(center, radiusMeters) {
    if (!isNearbySliceEnabled('bikeRoutes')) return null;
    const source = globalThis.cache?.bikeRoutes;
    if (!source || !Array.isArray(source.features) || source.features.length === 0) return null;

    const clippedFeatures = [];
    const radiusBounds = getNearbyRadiusBounds(center, radiusMeters);

    source.features.forEach(feature => {
        const geometry = feature?.geometry;
        const coords = geometry?.coordinates;
        if (!geometry || !Array.isArray(coords)) return;

        const featureBounds = feature && typeof feature === 'object' ? getBikeFeatureBounds(feature) : null;
        if (!featureBounds || !nearbyBoundsIntersect(featureBounds, radiusBounds)) return;

        const pushSegments = (segments) => {
            segments.forEach(segment => {
                if (!Array.isArray(segment) || segment.length < 2) return;
                clippedFeatures.push({
                    type: 'Feature',
                    properties: feature?.properties || {},
                    geometry: {
                        type: 'LineString',
                        coordinates: segment
                    }
                });
            });
        };

        const collectLineSegments = (lineCoords) => {
            const segments = [];
            let current = [];

            lineCoords.forEach(pair => {
                if (!Array.isArray(pair) || pair.length < 2) return;
                const lon = Number(pair[0]);
                const lat = Number(pair[1]);
                if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;

                const inside = isPointWithinNearbyRadius(center, radiusMeters, lat, lon, radiusBounds);
                if (inside) {
                    current.push([lon, lat]);
                } else if (current.length >= 2) {
                    segments.push(current);
                    current = [];
                } else {
                    current = [];
                }
            });

            if (current.length >= 2) segments.push(current);
            return segments;
        };

        if (geometry.type === 'LineString') {
            pushSegments(collectLineSegments(coords));
            return;
        }

        if (geometry.type === 'MultiLineString') {
            coords.forEach(line => pushSegments(collectLineSegments(line)));
        }
    });

    return {
        type: 'FeatureCollection',
        features: clippedFeatures
    };
}

function collectNearbyBikeStations(center, radiusMeters) {
    if (!isNearbySliceEnabled('bikeStations')) return [];

    const bikes = Array.isArray(globalThis.cache.bike) ? globalThis.cache.bike : [];
    const items = [];

    bikes.forEach(station => {
        const available = Number(station?.num_bikes_available || 0);
        if (!Number.isFinite(available) || available <= 0) return;

        const lat = Number(station?.lat);
        const lon = Number(station?.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;

        const distance = haversineMeters(center.lat, center.lon, lat, lon);
        if (distance > radiusMeters) return;

        items.push({
            ...station,
            lat,
            lon,
            distance,
            bikesAvailable: available,
            type: 'bike'
        });
    });

    items.sort((a, b) => a.distance - b.distance);
    return items;
}

function normalizeNearbyStopKey(stop) {
    const lat = Number(stop.lat);
    const lon = Number(stop.lon);
    const name = normalizeText(stop.name || stop.nombre || 'parada');
    return `${lat.toFixed(5)}|${lon.toFixed(5)}|${name}`;
}

const NEARBY_BUS_STOPS_CONCURRENCY = 3;
// Rutas sin paradas (fallo o vacío) no se vuelven a pedir en cada refresh de cercanos.
const nearbyBusStopsMissUntil = new Map();

function getNearbyBusStopsMissTtlMs() {
    return Math.max(0, Number(globalThis.NETWORK_CONFIG?.busRouteNegativeCacheTtlMs ?? 120000));
}

function isNearbyBusRouteMissed(key) {
    const until = nearbyBusStopsMissUntil.get(key);
    if (!until) return false;
    if (until > Date.now()) return true;
    nearbyBusStopsMissUntil.delete(key);
    return false;
}

async function mapWithConcurrency(items, limit, mapper) {
    const results = new Array(items.length);
    let nextIndex = 0;
    const worker = async () => {
        while (nextIndex < items.length) {
            const index = nextIndex++;
            results[index] = await mapper(items[index]);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
}

async function collectNearbyBusStops(center, radiusMeters, nearbyVehicles) {
    if (!isNearbySliceEnabled('busStops')) return [];

    const cfg = getNearbyFeatureConfig();
    const routeMap = new Map();
    const routeFetchQueue = [];

    nearbyVehicles.forEach(item => {
        const vehicle = item.vehicle;
        const routeId = getVehicleRouteId(vehicle);
        const lineShortName = (getVehicleShortName(vehicle) || routeId || '').toString().trim();
        const direction = vehicle?.direction;
        const tripCandidates = getVehicleTripCandidates(vehicle);
        const key = `${routeId}::${lineShortName}::${direction ?? ''}`;
        if (!lineShortName && !routeId) return;
        if (routeMap.has(key)) return;
        if (isNearbyBusRouteMissed(key)) return;

        routeMap.set(key, true);
        routeFetchQueue.push({ key, routeId, lineShortName, tripCandidates, direction });
    });

    const selectedRoutes = routeFetchQueue.slice(0, cfg.maxRouteFetch);
    const stopMap = new Map();

    const routeResults = await mapWithConcurrency(selectedRoutes, NEARBY_BUS_STOPS_CONCURRENCY, async route => {
        const routeRequestBudget = { remaining: 2 };
        let routeInfo = null;
        try {
            routeInfo = await fetchRouteInfo(
                route.routeId,
                route.lineShortName,
                route.tripCandidates,
                route.direction,
                routeRequestBudget,
                center
            );
        } catch {
            routeInfo = null;
        }

        const stops = Array.isArray(routeInfo?.stops) ? routeInfo.stops : [];
        if (stops.length === 0) nearbyBusStopsMissUntil.set(route.key, Date.now() + getNearbyBusStopsMissTtlMs());
        return { route, stops };
    });

    routeResults.forEach(({ route, stops }) => {
        stops.forEach(stop => {
            const parsed = parseLatLon(stop);
            if (!parsed) return;

            const distance = haversineMeters(center.lat, center.lon, parsed.lat, parsed.lon);
            if (distance > radiusMeters) return;

            const normalizedStop = {
                name: (stop?.name || stop?.nombre || 'Parada').toString(),
                lat: parsed.lat,
                lon: parsed.lon,
                distance,
                lines: [route.lineShortName || route.routeId || '-']
            };

            const key = normalizeNearbyStopKey(normalizedStop);
            const existing = stopMap.get(key);
            if (!existing) {
                stopMap.set(key, normalizedStop);
                return;
            }

            existing.lines = Array.from(new Set([...existing.lines, ...normalizedStop.lines]));
            if (normalizedStop.distance < existing.distance) {
                existing.distance = normalizedStop.distance;
            }
        });
    });

    return Array.from(stopMap.values()).sort((a, b) => a.distance - b.distance);
}

function isNearbyLayerOverlayOpen(layer) {
    return !!(layer?.isPopupOpen?.() || isLayerTooltipOpen(layer));
}

// Quita los layers que ya no están en `seenKeys`, salvo el que tenga popup/tooltip abierto
// (se poda al cerrarse, ver handleNearbyPopupClose).
function pruneNearbyKeyedLayers(layerGroup, store, seenKeys) {
    store.forEach((layer, key) => {
        if (seenKeys.has(key)) return;
        if (layerGroup.hasLayer(layer) && isNearbyLayerOverlayOpen(layer)) {
            nearbyPrunePending = true;
            return;
        }
        layerGroup.removeLayer(layer);
        store.delete(key);
    });
}

function updateNearbyLiveBusMarkers(busVehicles) {
    if (!layers?.nearbyVehicles) return;

    const store = globalThis.nearbyLiveBusMarkers;
    const currentKeys = new Set();

    (busVehicles || []).forEach(item => {
        const label = item.line || '-';
        const key = getVehicleUniqueKey(item.vehicle)
            || `nokey:${Number(item.lat).toFixed(5)},${Number(item.lon).toFixed(5)}|${label}`;
        if (currentKeys.has(key)) return;
        currentKeys.add(key);

        const color = getColor('bus', label);
        let marker = store.get(key);
        if (marker) {
            // Posición animada (bus-animation.js), icono si cambió rumbo/línea y popup/tooltip abiertos.
            updateMarker(marker, item.lat, item.lon, label, color, item.vehicle, { animate: true });
        } else {
            marker = createMarker(item.lat, item.lon, label, color, 'bus', item.vehicle, { iconClassName: 'nearby-live-bus-icon' });
            store.set(key, marker);
        }
        if (!layers.nearbyVehicles.hasLayer(marker)) marker.addTo(layers.nearbyVehicles);
    });

    // Remover marcadores de vehículos que ya no están en el radio
    pruneNearbyKeyedLayers(layers.nearbyVehicles, store, currentKeys);
}

function renderNearbyBikeRoutes(bikeRoutes) {
    if (nearbyRenderedBikeRoutes === bikeRoutes && layers.nearbyRadius.getLayers().length > 0) return;

    layers.nearbyRadius.clearLayers();
    nearbyRenderedBikeRoutes = bikeRoutes || null;
    if (!bikeRoutes?.features?.length) return;

    L.geoJSON(bikeRoutes, {
        style: () => ({
            color: '#22c55e',
            weight: 3,
            opacity: 0.85,
            lineCap: 'round',
            lineJoin: 'round'
        })
    }).addTo(layers.nearbyRadius);
}

function renderNearbyMapOverlay(center, radiusMeters, results, options = {}) {
    const { showRadiusCircle = true } = options;
    if (!layers?.nearbyRadius || !layers?.nearbyStops || !layers?.nearbyVehicles) return;

    nearbyPrunePending = false;

    if (showRadiusCircle) renderNearbyRadiusCircle(center, radiusMeters);
    else getNearbyCircleLayer()?.clearLayers();

    renderNearbyBikeRoutes(results.bikeRoutes);
    renderNearbyStopsLayer(results);
    updateNearbyLiveBusMarkers(results.busVehicles);
}

function handleNearbyPopupClose() {
    if (!nearbyPrunePending) return;
    setTimeout(() => {
        if (!nearbyPrunePending) return;
        nearbyPrunePending = false;
        const lastResults = globalThis.nearbyState?.lastResults;
        if (!globalThis.nearbyState?.active || !lastResults || !layers?.nearbyStops) return;
        renderNearbyStopsLayer(lastResults);
        updateNearbyLiveBusMarkers(lastResults.busVehicles);
    }, 100);
}

function upsertNearbyStationMarker(store, seenKeys, key, station, label, color, type) {
    if (seenKeys.has(key)) return null;
    seenKeys.add(key);

    let marker = store.get(key);
    if (marker) {
        updateMarker(marker, station.lat, station.lon, label, color, station);
    } else {
        marker = createMarker(station.lat, station.lon, label, color, type, station);
        store.set(key, marker);
    }
    if (!layers.nearbyStops.hasLayer(marker)) layers.nearbyStops.addLayer(marker);
    return marker;
}

function upsertNearbyApproachRing(store, seenKeys, key, station, fallbackColor) {
    const color = safeCssColor(station.color, fallbackColor);
    seenKeys.add(key);

    let ring = store.get(key);
    if (ring && ring._transitSignature !== color) {
        layers.nearbyStops.removeLayer(ring);
        ring = null;
    }
    if (!ring) {
        ring = L.marker([station.lat, station.lon], {
            icon: L.divIcon({
                className: '',
                html: `<div class="train-approach-ring" style="border-color:${color}"></div>`,
                iconSize: [60, 60],
                iconAnchor: [30, 30]
            }),
            interactive: false,
            zIndexOffset: -50
        });
        ring._transitSignature = color;
        store.set(key, ring);
    }
    if (!layers.nearbyStops.hasLayer(ring)) layers.nearbyStops.addLayer(ring);
}

function buildNearbyBusStopTooltip(stop) {
    const stopLines = Array.isArray(stop?.lines) ? stop.lines.join(', ') : '-';
    return `${escapeHtml(stop?.name)} · Líneas: ${escapeHtml(stopLines)}`;
}

function upsertNearbyBusStopMarker(store, seenKeys, stop) {
    const key = `stop:${normalizeNearbyStopKey(stop)}`;
    if (seenKeys.has(key)) return;
    seenKeys.add(key);

    let marker = store.get(key);
    if (marker) {
        marker._nearbyStop = stop;
        if (isLayerTooltipOpen(marker)) marker.getTooltip().update();
    } else {
        marker = L.marker([stop.lat, stop.lon], {
            icon: L.divIcon({
                className: 'nearby-bus-stop-icon-wrapper',
                html: '<div class="nearby-bus-stop-icon" title="Parada de bondi">🚏</div>',
                iconSize: [26, 26],
                iconAnchor: [13, 13]
            })
        });
        marker._nearbyStop = stop;
        marker.bindTooltip(layer => buildNearbyBusStopTooltip(layer._nearbyStop), {
            className: 'custom-tooltip',
            direction: 'top',
            offset: [0, -8],
            opacity: 0.95
        });
        store.set(key, marker);
    }
    if (!layers.nearbyStops.hasLayer(marker)) layers.nearbyStops.addLayer(marker);
}

function isTouchPrimaryDevice() {
    return globalThis.matchMedia?.('(hover: none), (pointer: coarse)')?.matches === true;
}

// Abre como máximo un tooltip automático (la estación con ETA más cercana) y solo cuando cambia;
// en dispositivos táctiles ninguno, porque taparía el mapa.
function syncNearbyAutoTooltip(marker) {
    const target = isTouchPrimaryDevice() ? null : marker;
    if (target === nearbyAutoTooltipMarker) return;

    const previous = nearbyAutoTooltipMarker;
    if (previous && isLayerTooltipOpen(previous)) previous.closeTooltip();
    nearbyAutoTooltipMarker = target;
    if (target && !isLayerTooltipOpen(target)) target.openTooltip();
}

function renderNearbyStopsLayer(results) {
    const store = globalThis.nearbyStopMarkers;
    const seenKeys = new Set();
    let autoTooltipCandidate = null;
    const considerAutoTooltip = (marker, station) => {
        if (!station.hasRealtimeData) return;
        const distance = Number(station.distance);
        if (!Number.isFinite(distance)) return;
        if (!autoTooltipCandidate || distance < autoTooltipCandidate.distance) {
            autoTooltipCandidate = { marker, distance };
        }
    };

    (results.subteStations || []).forEach(station => {
        const key = `subte:${station.routeId || ''}:${station.id}`;
        const marker = upsertNearbyStationMarker(store, seenKeys, key, station, station.name, station.color || '#9333ea', 'subte');
        if (!marker) return;

        considerAutoTooltip(marker, station);

        // Pulso visual cuando el subte llega en ≤2 min
        const subteEtaMin = getNearbyItemEtaMinutes(station);
        if (Number.isFinite(subteEtaMin) && subteEtaMin <= 2) {
            upsertNearbyApproachRing(store, seenKeys, `ring:${key}`, station, '#9333ea');
        }
    });

    (results.trainStations || []).forEach(station => {
        const key = `train:${station.lineId || ''}:${station.id}`;
        const marker = upsertNearbyStationMarker(store, seenKeys, key, station, station.name, station.color || '#0ea5e9', 'train');
        if (!marker) return;

        considerAutoTooltip(marker, station);

        // Pulso visual cuando el tren llega en ≤3 min
        const trainEtaMin = getNearbyItemEtaMinutes(station);
        if (Number.isFinite(trainEtaMin) && trainEtaMin <= 3) {
            upsertNearbyApproachRing(store, seenKeys, `ring:${key}`, station, '#0ea5e9');
        }
    });

    // collectNearbyBikeStations solo devuelve estaciones con bicis disponibles.
    (results.bikeStations || []).forEach(station => {
        const key = `bike:${station.station_id ?? `${station.lat},${station.lon}`}`;
        upsertNearbyStationMarker(store, seenKeys, key, station, `🚲 ${station.bikesAvailable}`, '#10b981', 'bike');
    });

    (results.busStops || []).forEach(stop => upsertNearbyBusStopMarker(store, seenKeys, stop));

    syncNearbyAutoTooltip(autoTooltipCandidate?.marker || null);
    pruneNearbyKeyedLayers(layers.nearbyStops, store, seenKeys);
}

function getNearbyCircleLayer() {
    if (!layers) return null;
    if (!layers.nearbyCircle && map) layers.nearbyCircle = L.layerGroup().addTo(map);
    return layers.nearbyCircle;
}

// El círculo vive en su propia capa: redibujarlo no borra las bicisendas de nearbyRadius.
function renderNearbyRadiusCircle(center, radiusMeters) {
    const circleLayer = getNearbyCircleLayer();
    if (!circleLayer) return;

    const existing = circleLayer.getLayers()[0];
    if (existing) {
        existing.setLatLng([center.lat, center.lon]);
        existing.setRadius(radiusMeters);
        return;
    }

    L.circle([center.lat, center.lon], {
        radius: radiusMeters,
        color: '#6366f1',
        weight: 2,
        fillColor: '#6366f1',
        fillOpacity: 0.08
    }).addTo(circleLayer);
}

function formatDistance(distance) {
    const numeric = Number(distance);
    if (!Number.isFinite(numeric)) return '--';

    if (numeric >= 1000) {
        const km = numeric / 1000;
        const decimals = km >= 10 ? 0 : 1;
        return `${km.toFixed(decimals)} km`;
    }

    return `${Math.round(numeric)} m`;
}

function getEtaMinutes(etaText) {
    const raw = String(etaText || '').trim();
    if (!raw) return Number.POSITIVE_INFINITY;

    const normalized = normalizeText(raw);
    if (/(^|[^a-z])(arrib\w*|ya|ahora|inmediat\w*|proximo)($|[^a-z])/.test(normalized)) return 0;

    const minutesMatch = normalized.match(/(\d+(?:[.,]\d+)?)\s*(min|m|minuto|minutos)\b/);
    if (minutesMatch) {
        return Number(minutesMatch[1].replace(',', '.'));
    }

    const secondsMatch = normalized.match(/(\d+(?:[.,]\d+)?)\s*(s|seg|segundo|segundos)\b/);
    if (secondsMatch) {
        return Number(secondsMatch[1].replace(',', '.')) / 60;
    }

    return Number.POSITIVE_INFINITY;
}

function getNearbyItemEtaMinutes(item) {
    const etaMinutes = item?.etaMinutes;
    if (etaMinutes !== null && etaMinutes !== undefined && Number.isFinite(Number(etaMinutes))) {
        return Number(etaMinutes);
    }
    return getEtaMinutes(item?.etaText);
}

function sortNearbyItems(items, sortMode, getEtaValue) {
    const source = Array.isArray(items) ? items : [];
    const sorted = [...source];

    sorted.sort((a, b) => {
        const distanceA = Number(a?.distance);
        const distanceB = Number(b?.distance);
        const safeDistanceA = Number.isFinite(distanceA) ? distanceA : Number.POSITIVE_INFINITY;
        const safeDistanceB = Number.isFinite(distanceB) ? distanceB : Number.POSITIVE_INFINITY;

        if (sortMode === 'eta' && typeof getEtaValue === 'function') {
            const etaA = Number(getEtaValue(a));
            const etaB = Number(getEtaValue(b));
            const safeEtaA = Number.isFinite(etaA) ? etaA : Number.POSITIVE_INFINITY;
            const safeEtaB = Number.isFinite(etaB) ? etaB : Number.POSITIVE_INFINITY;

            if (safeEtaA !== safeEtaB) {
                return safeEtaA - safeEtaB;
            }
        }

        return safeDistanceA - safeDistanceB;
    });

    return sorted;
}

function formatNearbyEta(minutes) {
    if (!Number.isFinite(minutes)) return '';
    if (minutes <= 0) return 'Próximo';
    return `${Math.round(minutes)} min`;
}

// item: { badge, badgeColor?, badgeIcon?, title, meta?, value?, valueTone?, distance?, fav? }. Todo dato de API se escapa.
function buildNearbyItemHtml(item) {
    const star = item.fav && typeof buildFavoriteStarHtml === 'function' ? buildFavoriteStarHtml(item.fav) : '';
    const badgeStyle = item.badgeColor ? ` style="background:${safeCssColor(item.badgeColor)}"` : '';
    let badgeClass = item.badgeIcon ? 'line-badge is-icon' : 'line-badge';
    if (item.badgeIcon && !item.badgeColor) badgeClass += ' is-neutral';
    const badgeA11y = item.badgeIcon ? ' aria-hidden="true"' : '';
    const meta = item.meta ? `<span class="nearby-item-meta">${escapeHtml(item.meta)}</span>` : '';
    const value = item.value
        ? `<span class="nearby-item-value${item.valueTone ? ` is-${item.valueTone}` : ''}">${escapeHtml(item.value)}</span>`
        : '<span class="nearby-item-value is-muted">Sin ETA</span>';
    const distance = item.distance ? `<span class="nearby-item-distance">${escapeHtml(item.distance)}</span>` : '';
    return `
        <li class="nearby-item">
            <span class="${badgeClass}"${badgeStyle}${badgeA11y}>${escapeHtml(item.badge)}</span>
            <span class="nearby-item-main">
                <span class="nearby-item-title">${escapeHtml(item.title || '-')}</span>
                ${meta}
            </span>
            <span class="nearby-item-side">${value}${distance}</span>
            ${star}
        </li>`;
}

function isNearbySectionOpen(section) {
    return nearbySectionOpen.has(section.key) ? nearbySectionOpen.get(section.key) : section.items.length > 0;
}

function buildNearbySectionHtml(section) {
    const listHtml = section.items.length > 0
        ? `<ul class="nearby-list">${section.items.map(item => buildNearbyItemHtml(item)).join('')}</ul>`
        : '<p class="nearby-empty">Nada en este radio.</p>';
    const hidden = section.total - section.items.length;
    const moreHtml = hidden > 0 ? `<p class="nearby-more">y ${hidden} más en el mapa</p>` : '';

    return `
        <details class="nearby-section nearby-section-${section.key}" data-section="${section.key}"${isNearbySectionOpen(section) ? ' open' : ''}>
            <summary class="nearby-section-header">
                <span class="nearby-section-title"><span aria-hidden="true">${section.icon}</span> ${section.title}</span>
                <span class="nearby-section-count">${section.total}<span class="sr-only"> resultados</span></span>
            </summary>
            ${listHtml}
            ${moreHtml}
        </details>`;
}

function buildNearbyLocationHintHtml(center) {
    const source = center?.source;
    let text = '';
    let actionLabel = '';
    if (source === 'area') {
        text = 'Mostrando la zona elegida en el mapa.';
        actionLabel = 'Usar mi ubicación';
    } else if (source === 'map') {
        text = 'Sin tu ubicación: mostramos el centro del mapa.';
        actionLabel = 'Usar mi ubicación';
    } else if (source === 'stale') {
        const timestamp = Number(center.timestamp);
        const ageMinutes = Number.isFinite(timestamp) && timestamp > 0
            ? Math.max(1, Math.round((Date.now() - timestamp) / 60000))
            : null;
        const ageText = ageMinutes === null ? '' : ` (hace ${ageMinutes >= 120 ? `${Math.round(ageMinutes / 60)} h` : `${ageMinutes} min`})`;
        text = `Ubicación aproximada${ageText}.`;
        actionLabel = 'Actualizar';
    }
    if (!text) return '';
    const action = isFeatureEnabled('geolocation')
        ? `<button type="button" class="chip chip-small" data-nearby-action="locate">${actionLabel}</button>`
        : '';
    return `<div class="nearby-location-hint"><span>${text}</span>${action}</div>`;
}

function buildNearbyEmptyHtml(radiusMeters) {
    const nextRadius = getNearbyRadiusOptions().find(value => value > radiusMeters);
    const expand = nextRadius
        ? `<button type="button" class="chip" data-nearby-action="expand" data-radius="${nextRadius}">Ampliar a ${formatNearbyRadiusLabel(nextRadius)}</button>`
        : '';
    return `
        <div class="nearby-empty-state">
            <p class="nearby-empty-title">No encontramos nada a menos de ${formatNearbyRadiusLabel(radiusMeters)}.</p>
            <p class="nearby-empty-text">Probá con un radio más grande o buscá en otra zona del mapa.</p>
            ${expand}
        </div>`;
}

function buildNearbySkeletonHtml(rows = 4) {
    const row = '<div class="skeleton-row"><span class="skeleton-badge"></span><span class="skeleton-lines"><span></span><span></span></span><span class="skeleton-side"></span></div>';
    return `<div class="skeleton-list" aria-hidden="true">${row.repeat(rows)}</div>`;
}

function buildNearbySections(results, sortMode) {
    const sortedSubteStations = sortNearbyItems(results.subteStations, sortMode, getNearbyItemEtaMinutes);
    const sortedTrainStations = sortNearbyItems(results.trainStations, sortMode, getNearbyItemEtaMinutes);
    const sortedBusVehicles = sortNearbyItems(results.busVehicles, 'distance');
    const sortedBusStops = sortNearbyItems(results.busStops, 'distance');
    const sortedBikeStations = sortNearbyItems(results.bikeStations, 'distance');
    const etaTone = minutes => (Number.isFinite(minutes) && minutes <= 2 ? 'soon' : '');
    const favTarget = (type, data) => (typeof getStationFavoriteTarget === 'function' ? getStationFavoriteTarget(type, data) : null);
    const stationItem = (station, fallbackColor, meta) => {
        const etaMinutes = getNearbyItemEtaMinutes(station);
        return {
            badge: station.lineShort || '?',
            badgeColor: station.color || fallbackColor,
            title: station.name || 'Estación',
            meta,
            value: formatNearbyEta(etaMinutes),
            valueTone: etaTone(etaMinutes),
            distance: formatDistance(station.distance),
            fav: favTarget(station.type, station)
        };
    };

    const sections = [];
    if (isNearbySliceEnabled('busVehicles') || isNearbySliceEnabled('busStops')) {
        const vehicleItems = sortedBusVehicles.slice(0, 5).map(item => ({
            badge: item.line || '?',
            badgeColor: getColor('bus', item.line),
            title: item.vehicle?.trip_headsign ? `Hacia ${item.vehicle.trip_headsign}` : 'Sin destino',
            meta: 'En circulación',
            value: formatDistance(item.distance),
            valueTone: 'distance',
            fav: typeof getBusLineFavoriteTarget === 'function' ? getBusLineFavoriteTarget(item.line) : null
        }));
        const stopItems = sortedBusStops.slice(0, 4).map(stop => ({
            badge: '🚏',
            badgeIcon: true,
            title: stop.name || 'Parada',
            meta: Array.isArray(stop.lines) && stop.lines.length > 0 ? `Líneas ${stop.lines.slice(0, 4).join(', ')}` : 'Parada',
            value: formatDistance(stop.distance),
            valueTone: 'distance',
            fav: favTarget('stop', stop)
        }));
        sections.push({
            key: 'bus',
            icon: '🚌',
            title: 'Colectivos',
            total: sortedBusVehicles.length + sortedBusStops.length,
            items: [...vehicleItems, ...stopItems]
        });
    }

    if (isNearbySliceEnabled('subte')) {
        sections.push({
            key: 'subte',
            icon: '🚇',
            title: 'Subte',
            total: sortedSubteStations.length,
            items: sortedSubteStations.slice(0, 5).map(st => stationItem(st, '#9333ea', st.lineShort ? `Línea ${st.lineShort}` : 'Subte'))
        });
    }

    if (isNearbySliceEnabled('train')) {
        sections.push({
            key: 'train',
            icon: '🚆',
            title: 'Trenes',
            total: sortedTrainStations.length,
            items: sortedTrainStations.slice(0, 5).map(st => stationItem(st, '#0ea5e9', st.lineName || (st.lineShort ? `Línea ${st.lineShort}` : 'Tren')))
        });
    }

    if (isNearbySliceEnabled('bike')) {
        sections.push({
            key: 'bike',
            icon: '🚲',
            title: 'Ecobici',
            total: sortedBikeStations.length,
            items: sortedBikeStations.slice(0, 6).map(st => {
                const bikes = Math.max(0, Number(st.bikesAvailable || 0));
                return {
                    badge: '🚲',
                    badgeIcon: true,
                    badgeColor: '#10b981',
                    title: st.name || 'Estación',
                    value: `${bikes} ${bikes === 1 ? 'bici' : 'bicis'}`,
                    valueTone: 'bike',
                    distance: formatDistance(st.distance),
                    fav: favTarget('bike', st)
                };
            })
        });
    }
    return sections;
}

// Re-render completo del contenedor (son pocas filas); se conserva el foco en la sección enfocada.
function renderNearbyDetails(results) {
    const container = document.getElementById('nearby-container');
    if (!container) return;

    const sortMode = getNearbySortMode();
    const sections = buildNearbySections(results, sortMode);
    if (sections.length === 0) {
        container.innerHTML = '<p class="nearby-empty">No hay funcionalidades de cercanos habilitadas.</p>';
        return;
    }

    const totalMatches = sections.reduce((acc, section) => acc + section.total, 0);
    const radiusMeters = Number(results.radiusMeters) || getNearbyRadius();
    const radiusLabel = formatNearbyRadiusLabel(radiusMeters);
    const isLoading = !!globalThis.nearbyState?.loading;
    nearbySummaryText = totalMatches > 0
        ? `${totalMatches} ${totalMatches === 1 ? 'resultado' : 'resultados'} a menos de ${radiusLabel}`
        : `Sin resultados a menos de ${radiusLabel}`;
    if (isNearbyPanelOpen && typeof setMapStatusNearbyCount === 'function') setMapStatusNearbyCount(totalMatches, { loading: isLoading });

    const focusedSection = document.activeElement?.closest?.('#nearby-container .nearby-section > summary')
        ? document.activeElement.parentElement.dataset.section
        : null;

    let bodyHtml;
    if (totalMatches === 0) {
        bodyHtml = isLoading ? buildNearbySkeletonHtml(3) : buildNearbyEmptyHtml(radiusMeters);
    } else {
        const sortLabel = sortMode === 'eta' ? 'por llegada' : 'por distancia';
        bodyHtml = `
            <p class="nearby-summary">${nearbySummaryText} · ${sortLabel}</p>
            <div class="nearby-sections">${sections.map(section => buildNearbySectionHtml(section)).join('')}</div>`;
    }

    container.innerHTML = `${buildNearbyLocationHintHtml(results.center)}${bodyHtml}`;
    if (focusedSection) container.querySelector(`[data-section="${focusedSection}"] > summary`)?.focus({ preventScroll: true });
}

async function enrichTrainEtas(trainStations, options = {}) {
    if (!Array.isArray(trainStations) || trainStations.length === 0) return;

    if (!isFeatureEnabled('trainRealtime')) {
        trainStations.forEach(station => {
            station.etaText = 'Sin ETA';
            station.hasRealtimeData = false;
        });
        return;
    }

    const cfg = getNearbyFeatureConfig();
    trainStations.filter(station => !trainLineHasRealtime(station.lineId)).forEach(station => {
        station.etaText = 'Sin horarios en vivo';
        station.etaMinutes = null;
        station.hasRealtimeData = false;
    });
    const withRealtime = trainStations.filter(station => trainLineHasRealtime(station.lineId));
    const sample = withRealtime.slice(0, cfg.maxTrainRealtime);

    await Promise.all(sample.map(async station => {
        const arrivalsRes = await getTrainArrivalsForStation(station, options);
        if (!arrivalsRes?.success) {
            station.etaText = 'Sin ETA';
            station.etaMinutes = null;
            station.hasRealtimeData = false;
            return;
        }

        const arrivals = arrivalsRes.data?.arrivals || [];
        const first = arrivals[0];
        const hasEtaSeconds = first?.etaSeconds !== null && first?.etaSeconds !== undefined;
        station.etaText = first ? formatTrainEta(first.etaSeconds) : 'Sin ETA';
        station.etaMinutes = hasEtaSeconds ? Math.max(0, Math.round(Number(first.etaSeconds) / 60)) : null;
        station.hasRealtimeData = !!first;
    }));

    withRealtime.slice(cfg.maxTrainRealtime).forEach(station => {
        station.etaText = 'Sin ETA';
        station.etaMinutes = null;
        station.hasRealtimeData = false;
    });
}

function setNearbyLoadingState() {
    const container = document.getElementById('nearby-container');
    if (!container) return;
    container.setAttribute('aria-busy', 'true');
    container.innerHTML = buildNearbySkeletonHtml(4);
    setNearbyLiveText('Buscando transportes cercanos…');
}

function setNearbyLiveText(text) {
    const live = document.getElementById('nearby-live');
    if (live && live.textContent !== text) live.textContent = text;
}

async function ensureNearbyBusDataReady() {
    if (!isNearbySliceEnabled('busVehicles')) return;

    const busCacheAgeMs = Date.now() - Number(globalThis.cache.busFetchedAt || 0);
    if (Array.isArray(globalThis.cache.bus) && busCacheAgeMs < NEARBY_BUS_CACHE_MAX_AGE_MS) return;

    const snapshot = await fetchBusSnapshot();
    if (snapshot) {
        updateBusCache(snapshot);
        return;
    }

    if (!Array.isArray(globalThis.cache.bus)) globalThis.cache.bus = [];
}

async function ensureNearbyBikeDataReady() {
    if (!isNearbySliceEnabled('bike')) return;

    const bikeAgeMs = Date.now() - Number(globalThis.cache.bikeFetchedAt || 0);
    const stationsStale = isNearbySliceEnabled('bikeStations') && bikeAgeMs >= NEARBY_BIKE_MAX_AGE_MS;
    const [stationsOk] = await Promise.all([
        stationsStale ? refreshBikeNow({ force: true }) : true,
        isNearbySliceEnabled('bikeRoutes') ? refreshBikeRoutesNow() : null
    ]);

    if (!stationsOk && !Array.isArray(globalThis.cache.bike)) globalThis.cache.bike = [];
}

async function ensureNearbyStaticDataReady() {
    const pendingLoads = [];
    if (isNearbySliceEnabled('subte')
        && (!globalThis.cache.subteStatic?.lines || !globalThis.cache.subteStatic?.stations)) {
        pendingLoads.push(loadSubteStaticFromKV());
    }

    if (isNearbySliceEnabled('train')
        && (!globalThis.cache.trainStatic?.lines || !globalThis.cache.trainStatic?.stations)) {
        pendingLoads.push(loadTrainStaticFromKV());
    }

    if (pendingLoads.length > 0) await Promise.all(pendingLoads);
}

function isCurrentNearbyRefresh(requestId) {
    return requestId === nearbyRefreshRequestId;
}

function renderNearbyErrorState() {
    const container = document.getElementById('nearby-container');
    if (!container) return;
    container.innerHTML = `
        <div class="nearby-empty-state is-error">
            <p class="nearby-empty-title">No pudimos cargar lo cercano</p>
            <p class="nearby-empty-text">No se pudo obtener ubicación o datos cercanos.</p>
            <button type="button" class="chip" data-nearby-action="retry">Reintentar</button>
        </div>`;
}

function storeNearbyResults(center, radiusMeters, results) {
    globalThis.nearbyState.active = true;
    globalThis.nearbyState.lastCenter = center;
    globalThis.nearbyState.lastRadius = radiusMeters;
    globalThis.nearbyState.lastResults = results;
}

function focusMapOnNearbyArea(center, radiusMeters) {
    const fallbackRadius = getNearbyFeatureConfig().defaultRadius;
    const baseRadius = Number.isFinite(Number(radiusMeters)) ? Number(radiusMeters) : fallbackRadius;
    const clampedRadius = Math.min(5000, Math.max(200, baseRadius));

    // Acerca mas para usar el radio como referencia visual y cortar parte del circulo.
    let targetZoom = 15.3;
    if (clampedRadius <= 3000) targetZoom = 15.6;
    if (clampedRadius <= 2000) targetZoom = 15.9;
    if (clampedRadius <= 1200) targetZoom = 16.2;
    if (clampedRadius <= 700) targetZoom = 16.5;

    if (map?.flyTo) {
        moveMapTo(map, getVisibleMapCenter([center.lat, center.lon], targetZoom), targetZoom, {
            animate: true,
            duration: 1.75,
            easeLinearity: 0.14,
            noMoveStart: true
        });
        return;
    }

    if (!map?.fitBounds) return;
    const fallbackBounds = L.circle([center.lat, center.lon], { radius: clampedRadius * 0.44 }).getBounds();
    map.fitBounds(fallbackBounds, {
        padding: [12, 12],
        maxZoom: targetZoom,
        animate: !prefersReducedMotion(),
        duration: 1.65,
        easeLinearity: 0.14
    });
}

function applyNearbyResults(center, radiusMeters, results, silent, overlayOptions = {}) {
    storeNearbyResults(center, radiusMeters, results);
    renderNearbyMapOverlay(center, radiusMeters, results, overlayOptions);
    renderNearbyDetails(results);

    if (!silent && center?.source !== 'area') {
        focusMapOnNearbyArea(center, radiusMeters);
    }
}

function getNearbyOverlayOptions(shouldDelayRadiusCircle) {
    return { showRadiusCircle: !shouldDelayRadiusCircle };
}

function setNearbyStatusValue(state) {
    if (typeof setStatus === 'function') setStatus(state);
}

function beginNearbyRefreshStatus(requestId, silent) {
    if (silent) return;

    if (!globalThis.nearbyState) return;

    globalThis.nearbyState.loading = true;
    globalThis.nearbyState.loadingRequestId = requestId;
    setNearbyStatusValue('CARGANDO');
    setNearbyLoadingState();
}

function endNearbyRefreshStatus(requestId, state) {
    if (!globalThis.nearbyState) return;
    if (Number(globalThis.nearbyState.loadingRequestId) !== Number(requestId)) return;

    globalThis.nearbyState.loading = false;
    globalThis.nearbyState.loadingRequestId = 0;
    setNearbyStatusValue(state);
    document.getElementById('nearby-container')?.removeAttribute('aria-busy');
    if (state === 'ERROR') {
        setNearbyLiveText('No se pudieron cargar los transportes cercanos.');
        return;
    }
    // El último render pudo ser el esqueleto (sin resultados mientras cargaba): se vuelve a dibujar.
    const lastResults = globalThis.nearbyState.lastResults;
    if (isNearbyPanelOpen && lastResults) renderNearbyDetails(lastResults);
    setNearbyLiveText(nearbySummaryText);
}

function waitForNearbyMapStabilization(timeoutMs = 3200) {
    return new Promise(resolve => {
        if (!map?.once) {
            resolve();
            return;
        }

        let settled = false;
        const done = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve();
        };

        const timer = setTimeout(done, Math.max(2600, timeoutMs));

        // Espera al proximo tick para ignorar moveend sincronos de animaciones previas.
        setTimeout(() => {
            if (settled || !map?.once) return;
            map.once('moveend', done);
        }, 0);
    });
}

function buildNearbyProgressiveContext(
    requestId,
    center,
    radiusMeters,
    previousResults = {},
    options = {}
) {
    const {
        shouldDelayRadiusCircle = false,
        shouldReuseBusStops = false,
        shouldReuseBusVehicles = false,
        shouldReuseSubteStations = false,
        shouldReuseTrainStations = false
    } = options;

    const previousBusStops = Array.isArray(previousResults.busStops) ? previousResults.busStops : [];
    const previousBusVehicles = Array.isArray(previousResults.busVehicles) ? previousResults.busVehicles : [];
    const previousSubteStations = Array.isArray(previousResults.subteStations) ? previousResults.subteStations : [];
    const previousTrainStations = Array.isArray(previousResults.trainStations) ? previousResults.trainStations : [];

    const collectedSubteStations = collectNearbySubteStations(center, radiusMeters);
    const collectedTrainStations = collectNearbyTrainStations(center, radiusMeters);
    const collectedBusVehicles = collectNearbyBusVehicles(center, radiusMeters);

    const stableSubteStations = (shouldReuseSubteStations && collectedSubteStations.length === 0)
        ? previousSubteStations
        : collectedSubteStations;

    const stableTrainStations = (shouldReuseTrainStations && collectedTrainStations.length === 0)
        ? previousTrainStations
        : collectedTrainStations;

    const stableBusVehicles = (shouldReuseBusVehicles && collectedBusVehicles.length === 0)
        ? previousBusVehicles
        : collectedBusVehicles;

    const results = {
        center,
        radiusMeters,
        subteStations: stableSubteStations,
        trainStations: stableTrainStations,
        busVehicles: stableBusVehicles,
        bikeStations: collectNearbyBikeStations(center, radiusMeters),
        bikeRoutes: clipBikeRoutesByNearbyRadius(center, radiusMeters),
        busStops: shouldReuseBusStops ? previousBusStops : []
    };

    return {
        requestId,
        center,
        radiusMeters,
        results,
        shouldDelayRadiusCircle,
        radiusCircleRevealed: !shouldDelayRadiusCircle,
        shouldReuseBusStops,
        shouldReuseBusVehicles,
        shouldReuseSubteStations,
        shouldReuseTrainStations
    };
}

function renderNearbyInitialState(context, silent) {
    applyNearbyResults(
        context.center,
        context.radiusMeters,
        context.results,
        silent,
        getNearbyOverlayOptions(context.shouldDelayRadiusCircle)
    );
}

function revealNearbyRadiusCircle(context) {
    if (context.radiusCircleRevealed) return;
    if (!isCurrentNearbyRefresh(context.requestId)) return;

    context.shouldDelayRadiusCircle = false;
    context.radiusCircleRevealed = true;

    // Reveal liviano: dibuja solo el circulo y evita rerender completo del panel.
    renderNearbyRadiusCircle(context.center, context.radiusMeters);
}

async function synchronizeNearbyRadiusCircle(context) {
    if (!context.shouldDelayRadiusCircle) return;

    await waitForNearbyMapStabilization();
    revealNearbyRadiusCircle(context);
}

function handleNearbyRefreshError(requestId, silent, error) {
    if (!isCurrentNearbyRefresh(requestId)) return;
    if (!silent) renderNearbyErrorState();
    setNearbyStatusValue('ERROR');
    console.warn('Nearby transport error', error);
}

async function resolveNearbyRefreshContext(requestId, allowLocatePrompt, previousResults = {}, options = {}) {
    const {
        silent = false,
        shouldReuseBusStops = false,
        shouldReuseBusVehicles = false,
        shouldReuseSubteStations = false,
        shouldReuseTrainStations = false
    } = options;

    const radiusMeters = getNearbyRadius();
    const [center] = await Promise.all([
        getNearbyCenterPosition({ allowLocatePrompt }),
        ensureNearbyStaticDataReady()
    ]);

    if (!center) throw new Error('Sin ubicación disponible');
    if (!isCurrentNearbyRefresh(requestId)) return null;

    // "Buscar en esta zona" no mueve el mapa y con movimiento reducido el salto es instantáneo:
    // en ambos casos no hay animación que esperar para dibujar el círculo.
    const shouldDelayRadiusCircle = !silent && center.source !== 'area' && !prefersReducedMotion();

    const context = buildNearbyProgressiveContext(
        requestId,
        center,
        radiusMeters,
        previousResults,
        {
            shouldDelayRadiusCircle,
            shouldReuseBusStops,
            shouldReuseBusVehicles,
            shouldReuseSubteStations,
            shouldReuseTrainStations
        }
    );
    context.silent = silent;
    return context;
}

async function runNearbyProgressiveTasks(context) {
    const progressiveTasks = [
        runNearbyBikeProgressiveTask(context),
        runNearbyBusProgressiveTask(context),
        runNearbySubteProgressiveTask(context),
        runNearbyTrainProgressiveTask(context)
    ];

    await Promise.allSettled(progressiveTasks);
}

function renderNearbyProgressiveUpdate(context) {
    const { center, radiusMeters, results, shouldDelayRadiusCircle } = context;
    applyNearbyResults(center, radiusMeters, results, true, getNearbyOverlayOptions(shouldDelayRadiusCircle));
}

async function runNearbyBikeProgressiveTask(context) {
    await ensureNearbyBikeDataReady();
    if (!isCurrentNearbyRefresh(context.requestId)) return;

    context.results.bikeStations = collectNearbyBikeStations(context.center, context.radiusMeters);
    // En la primera apertura las bicisendas recién se descargan acá (el contexto se armó sin ellas).
    if (!context.results.bikeRoutes?.features?.length) {
        context.results.bikeRoutes = clipBikeRoutesByNearbyRadius(context.center, context.radiusMeters);
    }
    renderNearbyProgressiveUpdate(context);
}

async function runNearbyBusProgressiveTask(context) {
    await ensureNearbyBusDataReady();
    if (!isCurrentNearbyRefresh(context.requestId)) return;

    const refreshedBusVehicles = collectNearbyBusVehicles(context.center, context.radiusMeters);
    if (refreshedBusVehicles.length > 0 || !context.shouldReuseBusVehicles) {
        context.results.busVehicles = refreshedBusVehicles;
    }
    renderNearbyProgressiveUpdate(context);

    if (!context.shouldReuseBusStops) {
        const refreshedBusStops = await collectNearbyBusStops(
            context.center,
            context.radiusMeters,
            context.results.busVehicles
        );
        if (!isCurrentNearbyRefresh(context.requestId)) return;
        if (Array.isArray(refreshedBusStops) && refreshedBusStops.length > 0) {
            context.results.busStops = refreshedBusStops;
        }
    }

    renderNearbyProgressiveUpdate(context);
}

async function runNearbySubteProgressiveTask(context) {
    if (!isNearbySliceEnabled('subte')) return;

    const subteForecastAgeMs = Date.now() - Number(globalThis.cache.subteFetchedAt || 0);
    const shouldRefreshSubteForecast = !Array.isArray(globalThis.cache.subteForecast)
        || globalThis.cache.subteForecast.length === 0
        || subteForecastAgeMs > NEARBY_SUBTE_FORECAST_MAX_AGE_MS;
    if (shouldRefreshSubteForecast) {
        await refreshSubteNow({ force: true });
        if (!isCurrentNearbyRefresh(context.requestId)) return;
    }

    const refreshedSubteStations = collectNearbySubteStations(context.center, context.radiusMeters);
    if (refreshedSubteStations.length > 0 || !context.shouldReuseSubteStations) {
        context.results.subteStations = refreshedSubteStations;
    }
    renderNearbyProgressiveUpdate(context);
}

async function runNearbyTrainProgressiveTask(context) {
    // Refresh silencioso: los arribos se renuevan al ritmo de POLLING.trainIntervalMs, no en cada ciclo.
    const options = context.silent ? { maxAgeMs: NEARBY_TRAIN_ETA_MAX_AGE_MS } : {};
    await enrichTrainEtas(context.results.trainStations, options);
    if (!isCurrentNearbyRefresh(context.requestId)) return;

    renderNearbyProgressiveUpdate(context);
}

async function refreshNearbyTransport(options = {}) {
    if (!isFeatureEnabled('nearbyPanel')) return;

    const { silent = false, allowLocatePrompt = !silent, keepAreaCenter = false } = options;
    const requestId = ++nearbyRefreshRequestId;
    // Una búsqueda explícita vuelve a centrar en el usuario; los refresh silenciosos mantienen la zona.
    if (!silent && !keepAreaCenter) globalThis.nearbyState.areaCenter = null;
    initNearbyControls();

    const previousResults = {
        busStops: Array.isArray(globalThis.nearbyState?.lastResults?.busStops)
            ? [...globalThis.nearbyState.lastResults.busStops]
            : [],
        busVehicles: Array.isArray(globalThis.nearbyState?.lastResults?.busVehicles)
            ? [...globalThis.nearbyState.lastResults.busVehicles]
            : [],
        subteStations: Array.isArray(globalThis.nearbyState?.lastResults?.subteStations)
            ? [...globalThis.nearbyState.lastResults.subteStations]
            : [],
        trainStations: Array.isArray(globalThis.nearbyState?.lastResults?.trainStations)
            ? [...globalThis.nearbyState.lastResults.trainStations]
            : []
    };

    const shouldReuseBusStops = silent && previousResults.busStops.length > 0;
    const shouldReuseBusVehicles = silent && previousResults.busVehicles.length > 0;
    const shouldReuseSubteStations = silent && previousResults.subteStations.length > 0;
    const shouldReuseTrainStations = silent && previousResults.trainStations.length > 0;

    beginNearbyRefreshStatus(requestId, silent);

    let finalStatus = 'LIVE';
    try {
        const progressiveContext = await resolveNearbyRefreshContext(
            requestId,
            allowLocatePrompt,
            previousResults,
            {
                silent,
                shouldReuseBusStops,
                shouldReuseBusVehicles,
                shouldReuseSubteStations,
                shouldReuseTrainStations
            }
        );
        if (!progressiveContext) return;

        renderNearbyInitialState(progressiveContext, silent);
        const circleSyncPromise = synchronizeNearbyRadiusCircle(progressiveContext);
        await runNearbyProgressiveTasks(progressiveContext);
        await circleSyncPromise;
        revealNearbyRadiusCircle(progressiveContext);
    } catch (error) {
        if (isCurrentNearbyRefresh(requestId)) finalStatus = 'ERROR';
        handleNearbyRefreshError(requestId, silent, error);
    } finally {
        endNearbyRefreshStatus(requestId, finalStatus);
        reportNearbyRefreshResult(requestId, silent, finalStatus);
    }
}

// Un refresh visible que falla ya muestra el error (con Reintentar) en la vista; uno silencioso,
// con resultados viejos en pantalla, lo avisa arriba de la hoja.
function reportNearbyRefreshResult(requestId, silent, finalStatus) {
    if (!isCurrentNearbyRefresh(requestId) || typeof reportSourceResult !== 'function') return;
    if (finalStatus !== 'ERROR') {
        globalThis.nearbyState.updatedAt = Date.now();
        reportSourceResult('nearby', true);
    } else if (silent) {
        reportSourceResult('nearby', false);
    }
}

function closeNearbyPanel(options = {}) {
    const { restoreFilters = true } = options;
    const wasOpen = isNearbyPanelOpen;
    nearbyRefreshRequestId += 1;
    isNearbyPanelOpen = false;
    if (typeof setDashboardActionActive === 'function') {
        setDashboardActionActive('nearby', false);
    }

    const panel = document.getElementById('nearby-panel');
    if (panel) {
        panel.classList.remove('is-open');
    }

    clearNearbyMapOverlay();
    globalThis.nearbyState.active = false;
    globalThis.nearbyState.lastResults = null;
    globalThis.nearbyState.areaCenter = null;
    globalThis.nearbyState.loading = false;
    globalThis.nearbyState.loadingRequestId = 0;
    if (typeof setMapStatusNearbyCount === 'function') setMapStatusNearbyCount(null);
    if (typeof clearSourceError === 'function') clearSourceError('nearby');

    const savedTypes = nearbySavedActiveTypes;
    nearbySavedActiveTypes = null;
    if (!wasOpen) return;

    setNearbyStatusValue('LIVE');
    if (restoreFilters && savedTypes) {
        restoreMainTransportFilters(savedTypes).catch(() => {});
    }
}

async function openNearbyPanel(options = {}) {
    if (!isFeatureEnabled('nearbyPanel')) return;

    const { silentRefresh = false, keepAreaCenter = false } = options;

    const alertsPanel = document.getElementById('alerts-panel');
    const isAlertsOpen = alertsPanel?.classList?.contains('is-open');
    if (isAlertsOpen && typeof toggleAlertPanel === 'function') {
        await toggleAlertPanel();
    }

    isNearbyPanelOpen = true;
    if (typeof setDashboardActionActive === 'function') {
        setDashboardActionActive('nearby', true);
    }

    const panel = document.getElementById('nearby-panel');
    if (!panel) return;

    deactivateMainTransportFilters();
    panel.classList.add('is-open');
    if (typeof setMapStatusNearbyCount === 'function') setMapStatusNearbyCount(0, { loading: true });
    initNearbyControls();
    await refreshNearbyTransport({ silent: silentRefresh, keepAreaCenter });
}

async function searchNearbyInMapArea() {
    if (!isFeatureEnabled('nearbyPanel')) return;
    const center = getNearbyCenterFromMapFallback();
    if (!center) return;

    globalThis.nearbyState.areaCenter = center;
    if (!isNearbyPanelOpen) {
        await openNearbyPanel({ keepAreaCenter: true });
        return;
    }
    await refreshNearbyTransport({ allowLocatePrompt: false, keepAreaCenter: true });
}

async function toggleNearbyPanel() {
    if (!isFeatureEnabled('nearbyPanel')) return;

    if (isNearbyPanelOpen) {
        closeNearbyPanel();
        return;
    }

    await openNearbyPanel();
}

async function activateNearbyFromLocation() {
    if (!isFeatureEnabled('nearbyPanel')) return;

    if (!isNearbyPanelOpen) {
        await openNearbyPanel();
        return;
    }

    await refreshNearbyTransport({ allowLocatePrompt: false });
}
