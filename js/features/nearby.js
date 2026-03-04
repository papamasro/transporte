let isNearbyPanelOpen = false;

if (!globalThis.nearbyState) {
    globalThis.nearbyState = {
        active: false,
        lastCenter: null,
        lastRadius: 1000,
        lastResults: null
    };
}

function getNearbyFeatureConfig() {
    const featureCfg = globalThis.APP_CONFIG?.FEATURES || {};
    const defaultRadius = Number(featureCfg.nearbyStopsRadiusMeters ?? 1000);
    const maxRouteFetch = Number(featureCfg.nearbyBusRouteFetchMax ?? 8);
    const maxTrainRealtime = Number(featureCfg.nearbyTrainRealtimeStations ?? 4);

    return {
        defaultRadius: Number.isFinite(defaultRadius) ? Math.min(5000, Math.max(200, defaultRadius)) : 1000,
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

async function getNearbyCenterPosition() {
    const cached = globalThis.cache?.userLocation;
    if (cached?.lat && cached?.lon && (Date.now() - (cached.timestamp || 0)) < 120000) {
        return { lat: Number(cached.lat), lon: Number(cached.lon), source: 'cache' };
    }

    try {
        const loc = await locateUser();
        if (loc?.lat && loc?.lon) return { lat: Number(loc.lat), lon: Number(loc.lon), source: 'gps' };
    } catch {
        // fallback below
    }

    const mapCenter = getNearbyCenterFromMapFallback();
    if (mapCenter) return { ...mapCenter, source: 'map' };
    return null;
}

function getSubteEtaText(station) {
    const referenceTs = globalThis.cache.subteTimestamp || Math.floor(Date.now() / 1000);
    const arrivals = getSubteStationForecast(station)
        .filter(r => r.arrivalTime > 0)
        .filter(r => r.arrivalTime >= (referenceTs - 60) && r.arrivalTime <= (referenceTs + 7200))
        .sort((a, b) => a.arrivalTime - b.arrivalTime)
        .slice(0, 2);

    if (arrivals.length === 0) return 'Sin ETA';
    return arrivals.map(item => `${item.routeShort}: ${formatEtaMinutes(item.arrivalTime, referenceTs)}`).join(' · ');
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

            items.push({
                ...payload,
                type: 'subte',
                distance,
                etaText: getSubteEtaText(payload)
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
                etaText: 'Consultando...'
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
    const requestBudget = { remaining: Math.max(cfg.maxRouteFetch, 1) * 2 };
    const stopMap = new Map();

    for (const route of selectedRoutes) {
        if (requestBudget.remaining <= 0) break;

        const routeInfo = await fetchRouteInfo(
            route.routeId,
            route.lineShortName,
            route.tripCandidates,
            route.direction,
            requestBudget,
            center
        );

        const routeStops = Array.isArray(routeInfo?.stops) ? routeInfo.stops : [];
        routeStops.forEach(stop => {
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
    }

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
        createMarker(
            station.lat,
            station.lon,
            station.name,
            station.color || '#9333ea',
            'subte',
            station
        ).addTo(layers.nearbyStops);
    });

    results.trainStations.forEach(station => {
        createMarker(
            station.lat,
            station.lon,
            station.name,
            station.color || '#0ea5e9',
            'train',
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

    const firstBuses = results.busVehicles.slice(0, 8)
        .map(item => {
            const headsign = item.vehicle?.trip_headsign || 'Sin destino';
            return `<div class="text-[10px] font-medium text-slate-700">🟣 Línea ${item.line} · ${formatDistance(item.distance)} · ${headsign}</div>`;
        })
        .join('');

    const foundItems = [firstSubte, firstTrain, firstBusStops, firstBuses]
        .filter(Boolean)
        .join('');

    container.innerHTML = foundItems
        ? `<div class="mt-1 space-y-1">${foundItems}</div>`
        : '<div class="text-[10px] text-slate-500">No se encontraron transportes dentro del radio.</div>';
}

async function enrichTrainEtas(trainStations) {
    const cfg = getNearbyFeatureConfig();
    const sample = trainStations.slice(0, cfg.maxTrainRealtime);

    for (const station of sample) {
        const arrivalsRes = await getTrainArrivalsForStation(station);
        if (!arrivalsRes?.success) {
            station.etaText = 'Sin ETA';
            continue;
        }

        const arrivals = arrivalsRes.data?.arrivals || [];
        const first = arrivals[0];
        station.etaText = first ? formatTrainEta(first.etaSeconds) : 'Sin ETA';
    }

    trainStations.slice(cfg.maxTrainRealtime).forEach(station => {
        station.etaText = 'Ver en tooltip';
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
    const busStops = await collectNearbyBusStops(center, radiusMeters, busVehicles);

    await enrichTrainEtas(trainStations);

    return {
        center,
        radiusMeters,
        subteStations,
        trainStations,
        busVehicles,
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
    const busData = await fetchWithRetry(busVehiclePositionsPath);
    if (Array.isArray(busData)) updateBusCache(busData);
}

async function ensureNearbyStaticAndRealtimeReady() {
    await ensureNearbyBusDataReady();

    if (!globalThis.cache.subteStatic?.lines || !globalThis.cache.subteStatic?.stations) {
        await loadSubteStaticFromKV();
    }

    if (!globalThis.cache.trainStatic?.lines || !globalThis.cache.trainStatic?.stations) {
        await loadTrainStaticFromKV();
    }

    if (Array.isArray(globalThis.cache.subteForecast) && globalThis.cache.subteForecast.length === 0) {
        await refreshSubteNow();
    }
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

function applyNearbyResults(center, radiusMeters, results, silent) {
    storeNearbyResults(center, radiusMeters, results);
    renderNearbyMapOverlay(center, radiusMeters, results);
    renderNearbyDetails(results);

    if (!silent) {
        map?.flyTo?.([center.lat, center.lon], Math.max(14, map.getZoom() || 14));
    }
}

async function refreshNearbyTransport(options = {}) {
    const { silent = false } = options;
    initNearbyDefaultRadius();

    if (!silent) {
        if (typeof setStatus === 'function') setStatus('CARGANDO');
        setNearbyLoadingState();
    }

    try {
        await ensureNearbyStaticAndRealtimeReady();

        const radiusMeters = parseNearbyRadiusInput();
        const center = await getNearbyCenterPosition();
        if (!center) throw new Error('Sin ubicación disponible');

        const results = await computeNearbyTransport(center, radiusMeters);
        applyNearbyResults(center, radiusMeters, results, silent);

        if (typeof setStatus === 'function') setStatus('LIVE');
    } catch (error) {
        if (!silent) renderNearbyErrorState();
        if (typeof setStatus === 'function') setStatus('ERROR');
        console.warn('Nearby transport error', error);
    }
}

async function toggleNearbyPanel() {
    isNearbyPanelOpen = !isNearbyPanelOpen;
    if (typeof setDashboardActionActive === 'function') {
        setDashboardActionActive('nearby', isNearbyPanelOpen);
    }

    const panel = document.getElementById('nearby-panel');
    if (!panel) return;

    if (isNearbyPanelOpen) {
        deactivateMainTransportFilters();
        panel.classList.add('is-open');
        initNearbyDefaultRadius();
        await refreshNearbyTransport();
        return;
    }

    panel.classList.remove('is-open');
    clearNearbyMapOverlay();
    globalThis.nearbyState.active = false;
    globalThis.nearbyState.lastResults = null;
}
