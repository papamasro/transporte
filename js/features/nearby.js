let isNearbyPanelOpen = false;
let nearbyRefreshRequestId = 0;
let nearbyNextGeolocationAttemptAt = 0;
const NEARBY_GEO_RETRY_COOLDOWN_MS = 5 * 60 * 1000;

if (!globalThis.nearbyState) {
    globalThis.nearbyState = {
        active: false,
        lastCenter: null,
        lastRadius: 1500,
        lastResults: null
    };
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
            const loc = await locateUser({ autoActivateNearby: false });
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

function renderNearbyMapOverlay(center, radiusMeters, results) {
    if (!layers?.nearbyRadius || !layers?.nearbyStops || !layers?.nearbyVehicles) return;

    layers.nearbyRadius.clearLayers();
    layers.nearbyStops.clearLayers();
    layers.nearbyVehicles.clearLayers();

    L.circle([center.lat, center.lon], {
        radius: radiusMeters,
        color: '#6366f1',
        weight: 2,
        fillColor: '#6366f1',
        fillOpacity: 0.08
    }).addTo(layers.nearbyRadius);

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
        L.circleMarker([stop.lat, stop.lon], {
            radius: 5,
            color: '#1d4ed8',
            fillColor: '#60a5fa',
            fillOpacity: 0.95,
            weight: 1
        })
            .bindTooltip(`${stop.name} · Líneas: ${stop.lines.join(', ')}`, {
                className: 'custom-tooltip',
                direction: 'top',
                offset: [0, -6],
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

function formatDistance(distance) {
    const rounded = Math.round(distance);
    return `${rounded} m`;
}

function renderNearbyDetails(results) {
    const container = document.getElementById('nearby-container');
    if (!container) return;

    const firstSubte = results.subteStations.slice(0, 5)
        .map(st => `<div class="text-[10px] font-medium text-slate-700">🚇 ${st.name} · ${formatDistance(st.distance)} · ${st.etaText}</div>`)
        .join('');

    const firstTrain = results.trainStations.slice(0, 5)
        .map(st => `<div class="text-[10px] font-medium text-slate-700">🚆 ${st.name} · ${formatDistance(st.distance)} · ${st.etaText}</div>`)
        .join('');

    const firstBusStops = results.busStops.slice(0, 6)
        .map(st => `<div class="text-[10px] font-medium text-slate-700">🚌 ${st.name} · ${formatDistance(st.distance)} · Líneas ${st.lines.slice(0, 3).join(', ')}</div>`)
        .join('');

    const firstBikes = results.bikeStations.slice(0, 6)
        .map(st => `<div class="text-[10px] font-medium text-slate-700">🚲 ${st.name} · ${formatDistance(st.distance)} · ${st.bikesAvailable} disponibles</div>`)
        .join('');

    const firstBuses = results.busVehicles.slice(0, 8)
        .map(item => {
            const headsign = item.vehicle?.trip_headsign || 'Sin destino';
            return `<div class="text-[10px] font-medium text-slate-700">🟣 Línea ${item.line} · ${formatDistance(item.distance)} · ${headsign}</div>`;
        })
        .join('');

    const foundItems = [firstSubte, firstTrain, firstBusStops, firstBikes, firstBuses]
        .filter(Boolean)
        .join('');

    container.innerHTML = foundItems
        ? `<div class="mt-1 space-y-1">${foundItems}</div>`
        : '<div class="text-[10px] text-slate-500">No se encontraron transportes dentro del radio.</div>';
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

function focusMapOnNearbyArea(center, radiusMeters) {
    if (!map?.fitBounds) return;

    const fallbackRadius = getNearbyFeatureConfig().defaultRadius;
    const baseRadius = Number.isFinite(Number(radiusMeters)) ? Number(radiusMeters) : fallbackRadius;
    const clampedRadius = Math.min(5000, Math.max(200, baseRadius));
    const focusRadius = clampedRadius * 1.08;
    const focusBounds = L.circle([center.lat, center.lon], { radius: focusRadius }).getBounds();

    map.fitBounds(focusBounds, {
        padding: [14, 14],
        maxZoom: 15.4,
        animate: true,
        duration: 0.35
    });
}

function applyNearbyResults(center, radiusMeters, results, silent) {
    storeNearbyResults(center, radiusMeters, results);
    renderNearbyMapOverlay(center, radiusMeters, results);
    renderNearbyDetails(results);

    if (!silent) {
        focusMapOnNearbyArea(center, radiusMeters);
    }
}

async function refreshNearbyTransport(options = {}) {
    const { silent = false, allowLocatePrompt = !silent } = options;
    const requestId = ++nearbyRefreshRequestId;
    initNearbyDefaultRadius();

    if (!silent) {
        if (typeof setStatus === 'function') setStatus('CARGANDO');
        setNearbyLoadingState();
    }

    try {
        const radiusMeters = parseNearbyRadiusInput();
        const [center] = await Promise.all([
            getNearbyCenterPosition({ allowLocatePrompt }),
            ensureNearbyStaticDataReady()
        ]);
        if (!center) throw new Error('Sin ubicación disponible');
        if (!isCurrentNearbyRefresh(requestId)) return;

        const results = {
            center,
            radiusMeters,
            subteStations: collectNearbySubteStations(center, radiusMeters),
            trainStations: collectNearbyTrainStations(center, radiusMeters),
            busVehicles: collectNearbyBusVehicles(center, radiusMeters),
            bikeStations: collectNearbyBikeStations(center, radiusMeters),
            busStops: []
        };

        applyNearbyResults(center, radiusMeters, results, silent);
        if (isCurrentNearbyRefresh(requestId) && typeof setStatus === 'function') setStatus('LIVE');

        const progressiveTasks = [
            (async () => {
                await ensureNearbyBikeDataReady();
                if (!isCurrentNearbyRefresh(requestId)) return;

                results.bikeStations = collectNearbyBikeStations(center, radiusMeters);
                applyNearbyResults(center, radiusMeters, results, true);
            })(),
            (async () => {
                await ensureNearbyBusDataReady();
                if (!isCurrentNearbyRefresh(requestId)) return;

                results.busVehicles = collectNearbyBusVehicles(center, radiusMeters);
                applyNearbyResults(center, radiusMeters, results, true);

                results.busStops = await collectNearbyBusStops(center, radiusMeters, results.busVehicles);
                if (!isCurrentNearbyRefresh(requestId)) return;

                applyNearbyResults(center, radiusMeters, results, true);
            })(),
            (async () => {
                const shouldRefreshSubteForecast = !Array.isArray(globalThis.cache.subteForecast) || globalThis.cache.subteForecast.length === 0;
                if (shouldRefreshSubteForecast) {
                    await refreshSubteNow({ force: true });
                    if (!isCurrentNearbyRefresh(requestId)) return;
                }

                results.subteStations = collectNearbySubteStations(center, radiusMeters);
                applyNearbyResults(center, radiusMeters, results, true);
            })(),
            (async () => {
                await enrichTrainEtas(results.trainStations);
                if (!isCurrentNearbyRefresh(requestId)) return;

                applyNearbyResults(center, radiusMeters, results, true);
            })()
        ];

        await Promise.allSettled(progressiveTasks);
    } catch (error) {
        if (!silent && isCurrentNearbyRefresh(requestId)) renderNearbyErrorState();
        if (isCurrentNearbyRefresh(requestId) && typeof setStatus === 'function') setStatus('ERROR');
        console.warn('Nearby transport error', error);
    }
}

function closeNearbyPanel() {
    nearbyRefreshRequestId += 1;
    isNearbyPanelOpen = false;
    if (typeof setDashboardActionActive === 'function') {
        setDashboardActionActive('nearby', false);
    }

    const panel = document.getElementById('nearby-panel');
    if (panel) panel.classList.remove('is-open');

    clearNearbyMapOverlay();
    globalThis.nearbyState.active = false;
    globalThis.nearbyState.lastResults = null;
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
    initNearbyDefaultRadius();
    await refreshNearbyTransport({ silent: silentRefresh });
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
