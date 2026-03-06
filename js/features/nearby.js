let isNearbyPanelOpen = false;
let isNearbyPanelCompact = false;
let nearbyRefreshRequestId = 0;
let nearbyNextGeolocationAttemptAt = 0;
const NEARBY_GEO_RETRY_COOLDOWN_MS = 5 * 60 * 1000;

if (!globalThis.nearbyState) {
    globalThis.nearbyState = {
        active: false,
        lastCenter: null,
        lastRadius: 1500,
        lastResults: null,
        loading: false,
        loadingRequestId: 0
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
    layers?.nearbyRadius?.clearLayers?.();
    layers?.nearbyStops?.clearLayers?.();
    layers?.nearbyVehicles?.clearLayers?.();
}

function deactivateMainTransportFilters() {
    Object.keys(activeTypes || {}).forEach(type => {
        activeTypes[type] = false;
        if (typeof setTypeButtonState === 'function') setTypeButtonState(type, false);
    });
    if (typeof renderMarkers === 'function') renderMarkers();
}

function initNearbyDefaultRadius() {
    const input = document.getElementById('nearby-radius-input');
    if (!input) return;
    if (input.dataset.initialized === 'true') return;

    input.value = String(getNearbyFeatureConfig().defaultRadius);
    input.dataset.initialized = 'true';
}

function getNearbySortMode() {
    const select = document.getElementById('nearby-sort-select');
    return select?.value === 'eta' ? 'eta' : 'distance';
}

function initNearbySortControl() {
    const select = document.getElementById('nearby-sort-select');
    if (!select) return;

    if (select.dataset.initialized !== 'true') {
        select.value = 'distance';
        select.dataset.initialized = 'true';
        select.addEventListener('change', () => {
            const lastResults = globalThis.nearbyState?.lastResults;
            if (!lastResults) return;
            renderNearbyDetails(lastResults);
        });
        return;
    }

    if (select.value !== 'distance' && select.value !== 'eta') {
        select.value = 'distance';
    }
}

function parseNearbyRadiusInput() {
    const input = document.getElementById('nearby-radius-input');
    const fallback = getNearbyFeatureConfig().defaultRadius;
    if (!input) return fallback;

    const raw = Number(input.value || fallback);
    const radius = Number.isFinite(raw) ? Math.min(5000, Math.max(200, raw)) : fallback;
    input.value = String(radius);
    return radius;
}

function nearbyToRadians(value) {
    return (value * Math.PI) / 180;
}

function nearbyDistanceMeters(lat1, lon1, lat2, lon2) {
    const earthRadius = 6371000;
    const dLat = nearbyToRadians(lat2 - lat1);
    const dLon = nearbyToRadians(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2
        + Math.cos(nearbyToRadians(lat1)) * Math.cos(nearbyToRadians(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * earthRadius * Math.asin(Math.min(1, Math.sqrt(a)));
}

function getNearbyCenterFromMapFallback() {
    const center = map?.getCenter?.();
    if (!center) return null;
    const lat = Number(center.lat);
    const lon = Number(center.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    return { lat, lon };
}

async function getNearbyCenterPosition(options = {}) {
    const { allowLocatePrompt = true } = options;
    const cached = globalThis.cache?.userLocation;
    if (Number.isFinite(Number(cached?.lat)) && Number.isFinite(Number(cached?.lon))) {
        return { lat: Number(cached.lat), lon: Number(cached.lon), source: 'cache' };
    }

    const canAttemptLocate = allowLocatePrompt && Date.now() >= nearbyNextGeolocationAttemptAt;
    if (canAttemptLocate) {
        nearbyNextGeolocationAttemptAt = Date.now() + NEARBY_GEO_RETRY_COOLDOWN_MS;

        try {
            const loc = await locateUser({ autoActivateNearby: false, skipPromptIfCached: true });
            if (Number.isFinite(Number(loc?.lat)) && Number.isFinite(Number(loc?.lon))) {
                nearbyNextGeolocationAttemptAt = 0;
                return { lat: Number(loc.lat), lon: Number(loc.lon), source: 'gps' };
            }
        } catch {
            // fallback below
        }
    }

    const mapCenter = getNearbyCenterFromMapFallback();
    if (mapCenter) return { ...mapCenter, source: 'map' };
    return null;
}

function getSubteEtaInfo(station) {
    const referenceTs = globalThis.cache.subteTimestamp || Math.floor(Date.now() / 1000);
    const arrivals = getSubteStationForecast(station)
        .filter(r => r.arrivalTime > 0)
        .filter(r => r.arrivalTime >= (referenceTs - 60) && r.arrivalTime <= (referenceTs + 7200))
        .sort((a, b) => a.arrivalTime - b.arrivalTime)
        .slice(0, 2);

    if (arrivals.length === 0) {
        return { text: 'Sin ETA', hasData: false };
    }

    return {
        text: arrivals.map(item => `${item.routeShort}: ${formatEtaMinutes(item.arrivalTime, referenceTs)}`).join(' · '),
        hasData: true
    };
}

function collectNearbySubteStations(center, radiusMeters) {
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

            const distance = nearbyDistanceMeters(center.lat, center.lon, lat, lon);
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
                hasRealtimeData: etaInfo.hasData
            });
        });
    });

    items.sort((a, b) => a.distance - b.distance);
    return items;
}

function collectNearbyTrainStations(center, radiusMeters) {
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

            const distance = nearbyDistanceMeters(center.lat, center.lon, lat, lon);
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
                hasRealtimeData: false
            });
        });
    });

    items.sort((a, b) => a.distance - b.distance);
    return items;
}

function collectNearbyBusVehicles(center, radiusMeters) {
    const buses = Array.isArray(globalThis.cache.bus) ? globalThis.cache.bus : [];
    const items = [];

    buses.forEach(vehicle => {
        const coords = getVehicleCoordinates(vehicle);
        if (!coords) return;

        const distance = nearbyDistanceMeters(center.lat, center.lon, coords.lat, coords.lon);
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

function collectNearbyBikeStations(center, radiusMeters) {
    const bikes = Array.isArray(globalThis.cache.bike) ? globalThis.cache.bike : [];
    const items = [];

    bikes.forEach(station => {
        const available = Number(station?.num_bikes_available || 0);
        if (!Number.isFinite(available) || available <= 0) return;

        const lat = Number(station?.lat);
        const lon = Number(station?.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;

        const distance = nearbyDistanceMeters(center.lat, center.lon, lat, lon);
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

function parseNearbyLatLon(point) {
    if (!point) return null;

    if (Array.isArray(point) && point.length >= 2) {
        const lat = Number(point[0]);
        const lon = Number(point[1]);
        if (Number.isFinite(lat) && Number.isFinite(lon)) return { lat, lon };
    }

    const lat = Number(point.lat ?? point.latitude);
    const lon = Number(point.lon ?? point.lng ?? point.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

    return { lat, lon };
}

async function collectNearbyBusStops(center, radiusMeters, nearbyVehicles) {
    const cfg = getNearbyFeatureConfig();
    const routeMap = new Map();
    const routeFetchQueue = [];

    nearbyVehicles.forEach(item => {
        const vehicle = item.vehicle;
        const routeId = getVehicleRouteId(vehicle);
        const lineShortName = (vehicle?.route_short_name || routeId || '').toString().trim();
        const direction = vehicle?.direction;
        const tripCandidates = getVehicleTripCandidates(vehicle);
        const key = `${routeId}::${lineShortName}::${direction ?? ''}`;
        if (!lineShortName && !routeId) return;
        if (routeMap.has(key)) return;

        routeMap.set(key, true);
        routeFetchQueue.push({ routeId, lineShortName, tripCandidates, direction });
    });

    const selectedRoutes = routeFetchQueue.slice(0, cfg.maxRouteFetch);
    const stopMap = new Map();

    const routeResults = await Promise.all(selectedRoutes.map(async route => {
        const routeRequestBudget = { remaining: 2 };
        const routeInfo = await fetchRouteInfo(
            route.routeId,
            route.lineShortName,
            route.tripCandidates,
            route.direction,
            routeRequestBudget,
            center
        );

        return {
            route,
            stops: Array.isArray(routeInfo?.stops) ? routeInfo.stops : []
        };
    }));

    routeResults.forEach(({ route, stops }) => {
        stops.forEach(stop => {
            const parsed = parseNearbyLatLon(stop);
            if (!parsed) return;

            const distance = nearbyDistanceMeters(center.lat, center.lon, parsed.lat, parsed.lon);
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

function renderNearbyMapOverlay(center, radiusMeters, results, options = {}) {
    const { showRadiusCircle = true } = options;
    if (!layers?.nearbyRadius || !layers?.nearbyStops || !layers?.nearbyVehicles) return;

    layers.nearbyRadius.clearLayers();
    layers.nearbyStops.clearLayers();
    layers.nearbyVehicles.clearLayers();

    if (showRadiusCircle) renderNearbyRadiusCircle(center, radiusMeters);

    results.subteStations.forEach(station => {
        const marker = createMarker(
            station.lat,
            station.lon,
            station.name,
            station.color || '#9333ea',
            'subte',
            station
        ).addTo(layers.nearbyStops);

        if (station.hasRealtimeData) marker.openTooltip();
    });

    results.trainStations.forEach(station => {
        const marker = createMarker(
            station.lat,
            station.lon,
            station.name,
            station.color || '#0ea5e9',
            'train',
            station
        ).addTo(layers.nearbyStops);

        if (station.hasRealtimeData) marker.openTooltip();
    });

    results.bikeStations.forEach(station => {
        const markerColor = station.bikesAvailable <= 2 ? '#f59e0b' : '#10b981';
        const label = `🚲 ${station.bikesAvailable}`;

        createMarker(
            station.lat,
            station.lon,
            label,
            markerColor,
            'bike',
            station
        ).addTo(layers.nearbyStops);
    });

    results.busStops.forEach(stop => {
        const stopLines = Array.isArray(stop.lines) ? stop.lines.join(', ') : '-';

        L.marker([stop.lat, stop.lon], {
            icon: L.divIcon({
                className: 'nearby-bus-stop-icon-wrapper',
                html: '<div class="nearby-bus-stop-icon" title="Parada de bondi">🚏</div>',
                iconSize: [26, 26],
                iconAnchor: [13, 13]
            })
        })
            .bindTooltip(`${stop.name} · Líneas: ${stopLines}`, {
                className: 'custom-tooltip',
                direction: 'top',
                offset: [0, -8],
                opacity: 0.95
            })
            .addTo(layers.nearbyStops);
    });

    results.busVehicles.forEach(item => {
        const label = item.line || '-';
        createMarker(item.lat, item.lon, label, getColor('bus', label), 'bus', item.vehicle)
            .addTo(layers.nearbyVehicles);
    });
}

function renderNearbyRadiusCircle(center, radiusMeters) {
    if (!layers?.nearbyRadius) return;

    layers.nearbyRadius.clearLayers();
    L.circle([center.lat, center.lon], {
        radius: radiusMeters,
        color: '#6366f1',
        weight: 2,
        fillColor: '#6366f1',
        fillOpacity: 0.08
    }).addTo(layers.nearbyRadius);
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
    if (/arrib|ya|ahora|inmediat/.test(normalized)) return 0;

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

function escapeNearbyHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

function buildNearbyItemHtml(item) {
    const itemTitle = escapeNearbyHtml(item?.title || '-');
    const itemMeta = item?.meta ? `<div class="nearby-item-meta">${escapeNearbyHtml(item.meta)}</div>` : '';

    return `
        <article class="nearby-item">
            <div class="nearby-item-title">${itemTitle}</div>
            ${itemMeta}
        </article>
    `;
}

function buildNearbySectionHtml(section) {
    const itemsHtml = section.items.length > 0
        ? section.items.map(item => buildNearbyItemHtml(item)).join('')
        : '<div class="nearby-empty">Sin resultados en este radio.</div>';

    return `
        <section class="nearby-section ${section.sectionClass}">
            <div class="nearby-section-header">
                <span class="nearby-section-title">${section.icon} ${section.title}</span>
                <span class="nearby-section-count">${section.total}</span>
            </div>
            <div class="nearby-section-list">${itemsHtml}</div>
        </section>
    `;
}

function renderNearbyDetails(results) {
    const container = document.getElementById('nearby-container');
    if (!container) return;

    const sortMode = getNearbySortMode();
    const sortedSubteStations = sortNearbyItems(results.subteStations, sortMode, item => getEtaMinutes(item?.etaText));
    const sortedTrainStations = sortNearbyItems(results.trainStations, sortMode, item => getEtaMinutes(item?.etaText));
    const sortedBusVehicles = sortNearbyItems(results.busVehicles, 'distance');
    const sortedBusStops = sortNearbyItems(results.busStops, 'distance');
    const sortedBikeStations = sortNearbyItems(results.bikeStations, 'distance');

    const busVehicleItems = sortedBusVehicles.slice(0, 5).map(item => ({
        title: `Linea ${item.line || '-'}`,
        meta: `${formatDistance(item.distance)} · ${item.vehicle?.trip_headsign || 'Sin destino'}`
    }));

    const busStopItems = sortedBusStops.slice(0, 4).map(st => {
        const stopLines = Array.isArray(st.lines)
            ? st.lines.slice(0, 3).join(', ')
            : '-';

        return {
            title: `Parada ${st.name || 'Sin nombre'}`,
            meta: `${formatDistance(st.distance)} · Lineas ${stopLines}`
        };
    });

    const bondiItems = [...busVehicleItems, ...busStopItems];

    const sections = [
        {
            icon: '🚆',
            title: 'Trenes',
            sectionClass: 'nearby-section-train',
            total: sortedTrainStations.length,
            items: sortedTrainStations.slice(0, 5).map(st => {
                const lineSuffix = st.lineShort ? ` · ${st.lineShort}` : '';
                return {
                    title: st.name || 'Estacion',
                    meta: `${formatDistance(st.distance)} · ${st.etaText || 'Sin ETA'}${lineSuffix}`
                };
            })
        },
        {
            icon: '🚌',
            title: 'Bondis',
            sectionClass: 'nearby-section-bus',
            total: sortedBusVehicles.length + sortedBusStops.length,
            items: bondiItems
        },
        {
            icon: '🚇',
            title: 'Subte',
            sectionClass: 'nearby-section-subte',
            total: sortedSubteStations.length,
            items: sortedSubteStations.slice(0, 5).map(st => {
                const lineSuffix = st.lineShort ? ` · ${st.lineShort}` : '';
                return {
                    title: st.name || 'Estacion',
                    meta: `${formatDistance(st.distance)} · ${st.etaText || 'Sin ETA'}${lineSuffix}`
                };
            })
        },
        {
            icon: '🚲',
            title: 'Ecobici',
            sectionClass: 'nearby-section-bike',
            total: sortedBikeStations.length,
            items: sortedBikeStations.slice(0, 6).map(st => ({
                title: st.name || 'Estacion',
                meta: `${formatDistance(st.distance)} · ${Math.max(0, Number(st.bikesAvailable || 0))} disponibles`
            }))
        }
    ];

    const totalMatches = sections.reduce((acc, section) => acc + section.total, 0);
    const renderedMatches = sections.reduce((acc, section) => acc + section.items.length, 0);
    const radiusLabel = formatDistance(results.radiusMeters || globalThis.nearbyState?.lastRadius || getNearbyFeatureConfig().defaultRadius);
    const sortLabel = sortMode === 'eta' ? 'ETA mas proximo' : 'distancia';

    const summaryText = totalMatches > 0
        ? `${totalMatches} hallazgos dentro de ${radiusLabel}. Mostrando ${renderedMatches}. Orden: ${sortLabel}.`
        : `Sin resultados dentro de ${radiusLabel}. Orden: ${sortLabel}.`;

    const sectionsHtml = sections.map(section => buildNearbySectionHtml(section)).join('');

    container.innerHTML = `
        <div class="nearby-summary">${summaryText}</div>
        <div class="nearby-sections">${sectionsHtml}</div>
    `;
}

async function enrichTrainEtas(trainStations) {
    const cfg = getNearbyFeatureConfig();
    const sample = trainStations.slice(0, cfg.maxTrainRealtime);

    await Promise.all(sample.map(async station => {
        const arrivalsRes = await getTrainArrivalsForStation(station);
        if (!arrivalsRes?.success) {
            station.etaText = 'Sin ETA';
            station.hasRealtimeData = false;
            return;
        }

        const arrivals = arrivalsRes.data?.arrivals || [];
        const first = arrivals[0];
        station.etaText = first ? formatTrainEta(first.etaSeconds) : 'Sin ETA';
        station.hasRealtimeData = !!first;
    }));

    trainStations.slice(cfg.maxTrainRealtime).forEach(station => {
        station.etaText = 'Sin ETA';
        station.hasRealtimeData = false;
    });
}

async function computeNearbyTransport(center, radiusMeters) {
    await Promise.all([
        loadSubteStaticFromKV(),
        loadTrainStaticFromKV()
    ]);

    const subteStations = collectNearbySubteStations(center, radiusMeters);
    const trainStations = collectNearbyTrainStations(center, radiusMeters);
    const busVehicles = collectNearbyBusVehicles(center, radiusMeters);
    const bikeStations = collectNearbyBikeStations(center, radiusMeters);
    const busStops = await collectNearbyBusStops(center, radiusMeters, busVehicles);

    await enrichTrainEtas(trainStations);

    return {
        center,
        radiusMeters,
        subteStations,
        trainStations,
        busVehicles,
        bikeStations,
        busStops
    };
}

function setNearbyLoadingState() {
    const container = document.getElementById('nearby-container');
    if (!container) return;

    container.innerHTML = `
        <div class="text-[10px] text-slate-500 text-center py-4 flex flex-col items-center gap-1">
            <i data-lucide="loader-2" class="w-4 h-4 animate-spin text-indigo-500"></i>
            Buscando transportes cercanos...
        </div>`;
    lucide.createIcons();
}

async function ensureNearbyBusDataReady() {
    if (Array.isArray(globalThis.cache.bus) && globalThis.cache.bus.length > 0) return;

    const busVehiclePositionsPath = globalThis.APP_CONFIG?.PATHS?.busVehiclePositions || '/colectivos/vehiclePositionsSimple';
    const busRes = await fetchAPI(busVehiclePositionsPath);
    if (busRes?.success && Array.isArray(busRes.data)) {
        updateBusCache(busRes.data);
        return;
    }

    if (!Array.isArray(globalThis.cache.bus)) globalThis.cache.bus = [];
}

async function ensureNearbyBikeDataReady() {
    const refreshed = await refreshBikeNow({ force: true });
    if (refreshed) return;
    if (!Array.isArray(globalThis.cache.bike)) globalThis.cache.bike = [];
}

async function ensureNearbyStaticDataReady() {
    const pendingLoads = [];
    if (!globalThis.cache.subteStatic?.lines || !globalThis.cache.subteStatic?.stations) {
        pendingLoads.push(loadSubteStaticFromKV());
    }

    if (!globalThis.cache.trainStatic?.lines || !globalThis.cache.trainStatic?.stations) {
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
    container.innerHTML = '<div class="text-[10px] text-red-500 font-bold text-center py-2">No se pudo obtener ubicación o datos cercanos.</div>';
}

function storeNearbyResults(center, radiusMeters, results) {
    globalThis.nearbyState.active = true;
    globalThis.nearbyState.lastCenter = center;
    globalThis.nearbyState.lastRadius = radiusMeters;
    globalThis.nearbyState.lastResults = results;
}

function shouldOpenNearbyCompactByDefault() {
    return globalThis.matchMedia?.('(max-width: 767px)')?.matches === true;
}

function setNearbyPanelCompact(shouldCompact) {
    const panel = document.getElementById('nearby-panel');
    if (!panel) return;

    const compact = !!shouldCompact;
    isNearbyPanelCompact = compact;
    panel.classList.toggle('is-compact', compact);

    const chevron = document.getElementById('nearby-panel-chevron');
    if (chevron?.style) {
        chevron.style.transform = compact ? 'rotate(180deg)' : 'rotate(0deg)';
    }
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
        map.flyTo([center.lat, center.lon], targetZoom, {
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
        animate: true,
        duration: 1.65,
        easeLinearity: 0.14
    });
}

function applyNearbyResults(center, radiusMeters, results, silent, overlayOptions = {}) {
    storeNearbyResults(center, radiusMeters, results);
    renderNearbyMapOverlay(center, radiusMeters, results, overlayOptions);
    renderNearbyDetails(results);

    if (!silent) {
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

    const radiusMeters = parseNearbyRadiusInput();
    const [center] = await Promise.all([
        getNearbyCenterPosition({ allowLocatePrompt }),
        ensureNearbyStaticDataReady()
    ]);

    if (!center) throw new Error('Sin ubicación disponible');
    if (!isCurrentNearbyRefresh(requestId)) return null;

    const shouldDelayRadiusCircle = !silent;

    return buildNearbyProgressiveContext(
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
    const shouldRefreshSubteForecast = !Array.isArray(globalThis.cache.subteForecast) || globalThis.cache.subteForecast.length === 0;
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
    await enrichTrainEtas(context.results.trainStations);
    if (!isCurrentNearbyRefresh(context.requestId)) return;

    renderNearbyProgressiveUpdate(context);
}

async function refreshNearbyTransport(options = {}) {
    const { silent = false, allowLocatePrompt = !silent } = options;
    const requestId = ++nearbyRefreshRequestId;
    initNearbyDefaultRadius();
    initNearbySortControl();

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
        endNearbyRefreshStatus(requestId, 'LIVE');
    } catch (error) {
        endNearbyRefreshStatus(requestId, 'ERROR');
        handleNearbyRefreshError(requestId, silent, error);
    }
}

function closeNearbyPanel() {
    nearbyRefreshRequestId += 1;
    isNearbyPanelOpen = false;
    isNearbyPanelCompact = false;
    if (typeof setDashboardActionActive === 'function') {
        setDashboardActionActive('nearby', false);
    }

    const panel = document.getElementById('nearby-panel');
    if (panel) {
        panel.classList.remove('is-open', 'is-compact');
    }

    clearNearbyMapOverlay();
    globalThis.nearbyState.active = false;
    globalThis.nearbyState.lastResults = null;
    globalThis.nearbyState.loading = false;
    globalThis.nearbyState.loadingRequestId = 0;
}

async function openNearbyPanel(options = {}) {
    const { silentRefresh = false } = options;

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
    setNearbyPanelCompact(shouldOpenNearbyCompactByDefault());
    initNearbyDefaultRadius();
    initNearbySortControl();
    await refreshNearbyTransport({ silent: silentRefresh });
}

function toggleNearbyPanelCompact() {
    if (!isNearbyPanelOpen) return;
    setNearbyPanelCompact(!isNearbyPanelCompact);
}

async function toggleNearbyPanel() {
    if (isNearbyPanelOpen) {
        closeNearbyPanel();
        return;
    }

    await openNearbyPanel();
}

async function activateNearbyFromLocation() {
    if (!isNearbyPanelOpen) {
        await openNearbyPanel();
        return;
    }

    await refreshNearbyTransport({ allowLocatePrompt: false });
}
