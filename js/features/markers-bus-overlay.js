if (!globalThis.markerState) {
    globalThis.markerState = {
        busRouteCache: new Map(),
        busLineSearchCache: new Map(),
        currentBusRouteKey: '',
        currentLineOverlayQuery: '',
        selectedBusVehicleKey: '',
        busRouteRequestToken: 0,
        busLineRequestToken: 0
    };
}

function clearBusRouteLayers() {
    layers.busRoute?.clearLayers();
    layers.busStops?.clearLayers();
    globalThis.markerState.currentBusRouteKey = '';
    globalThis.markerState.currentLineOverlayQuery = '';
}

function getVehicleRouteId(vehicle) {
    return (
        vehicle?.route_id ||
        vehicle?.vehicle?.trip?.route_id ||
        ''
    ).toString().trim();
}

function getVehicleTripId(vehicle) {
    return (
        vehicle?.trip_id ||
        vehicle?.vehicle?.trip?.trip_id ||
        vehicle?.tip_id ||
        ''
    ).toString().trim();
}

function getVehicleTripCandidates(vehicle) {
    const rawCandidates = [
        vehicle?.trip_id,
        vehicle?.vehicle?.trip?.trip_id,
        vehicle?.tip_id
    ];

    return Array.from(new Set(rawCandidates
        .map(value => (value || '').toString().trim())
        .filter(Boolean)));
}

function getVehicleUniqueKey(vehicle) {
    const id = (vehicle?.id || vehicle?.vehicle?.id || '').toString().trim();
    if (id) return `id:${id}`;

    const routeId = getVehicleRouteId(vehicle);
    const tripId = getVehicleTripId(vehicle);
    if (routeId || tripId) return `trip:${routeId}::${tripId}`;

    const lat = Number(vehicle?.latitude ?? vehicle?.vehicle?.position?.latitude ?? Number.NaN);
    const lon = Number(vehicle?.longitude ?? vehicle?.vehicle?.position?.longitude ?? Number.NaN);
    if (Number.isFinite(lat) && Number.isFinite(lon)) return `pos:${lat.toFixed(6)},${lon.toFixed(6)}`;

    return '';
}

function buildBusSearchText(vehicle) {
    const parts = [
        getBusDisplayLine(vehicle),
        vehicle?.route_short_name,
        vehicle?.trip_headsign,
        vehicle?.agency_name,
        vehicle?.route_id,
        getVehicleTripId(vehicle),
        vehicle?.id
    ];
    return normalizeText(parts.filter(Boolean).join(' '));
}

function getVehicleCoordinates(vehicle) {
    const lat = Number.parseFloat(vehicle?.latitude ?? vehicle?.vehicle?.position?.latitude ?? Number.NaN);
    const lon = Number.parseFloat(vehicle?.longitude ?? vehicle?.vehicle?.position?.longitude ?? Number.NaN);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    return { lat, lon };
}

function findVehicleByKey(vehicleKey, vehicles) {
    if (!vehicleKey || !Array.isArray(vehicles)) return null;
    return vehicles.find(vehicle => getVehicleUniqueKey(vehicle) === vehicleKey) || null;
}

function findVehicleForBusSearch(query, vehicles) {
    const normalizedQuery = normalizeText(query);
    if (!normalizedQuery || !Array.isArray(vehicles) || vehicles.length === 0) return null;

    const exactTripMatch = vehicles.find(vehicle => normalizeText(getVehicleTripId(vehicle)) === normalizedQuery);
    if (exactTripMatch) return exactTripMatch;

    const exactVehicleIdMatch = vehicles.find(vehicle => normalizeText(vehicle?.id || vehicle?.vehicle?.id || '') === normalizedQuery);
    if (exactVehicleIdMatch) return exactVehicleIdMatch;

    const exactMatch = vehicles.find(vehicle => {
        const line = normalizeText(getBusDisplayLine(vehicle));
        const shortName = normalizeText(vehicle?.route_short_name || '');
        const routeId = normalizeText(getVehicleRouteId(vehicle));
        const agencyName = normalizeText(vehicle?.agency_name || '');
        const headsign = normalizeText(vehicle?.trip_headsign || '');
        return (
            line === normalizedQuery
            || shortName === normalizedQuery
            || routeId === normalizedQuery
            || agencyName === normalizedQuery
            || headsign === normalizedQuery
        );
    });
    if (exactMatch) return exactMatch;

    return null;
}

async function fetchRouteInfo(routeId, tipId, direction) {
    if (!routeId) return null;
    const routeKey = `${routeId}::${tipId || ''}`;
    if (globalThis.markerState.busRouteCache.has(routeKey)) return globalThis.markerState.busRouteCache.get(routeKey);

    const params = new URLSearchParams({ route_id: routeId });
    if (tipId) params.set('tip_id', tipId);
    if (direction !== undefined && direction !== null) params.set('direction', direction);

    const response = await fetchAPI(`/info-trayecto?${params.toString()}`);
    if (!response.success || !response.data) return null;

    const shapeSize = Array.isArray(response.data?.shape) ? response.data.shape.length : 0;
    if (shapeSize < 2) return null;

    globalThis.markerState.busRouteCache.set(routeKey, response.data);
    return response.data;
}

async function fetchLineSearchInfo(numero) {
    const normalizedNumero = normalizeText(numero);
    if (!normalizedNumero) return null;
    if (globalThis.markerState.busLineSearchCache.has(normalizedNumero)) return globalThis.markerState.busLineSearchCache.get(normalizedNumero);

    const response = await fetchAPI(`/buscar-linea?numero=${encodeURIComponent(numero)}`);
    if (!response.success || !response.data) return null;

    globalThis.markerState.busLineSearchCache.set(normalizedNumero, response.data);
    return response.data;
}

function getShapePointsFromRecorrido(recorrido) {
    let shape = [];
    if (Array.isArray(recorrido?.shape)) {
        shape = recorrido.shape;
    } else if (Array.isArray(recorrido?.points)) {
        shape = recorrido.points;
    }

    return shape
        .map(point => [Number(point.lat), Number(point.lon)])
        .filter(([lat, lon]) => Number.isFinite(lat) && Number.isFinite(lon));
}

function renderLineSearchOverlay(lineSearchData) {
    layers.busRoute?.clearLayers();
    layers.busStops?.clearLayers();

    const recorridos = Array.isArray(lineSearchData?.recorridos) ? lineSearchData.recorridos : [];
    recorridos.forEach((recorrido, index) => {
        const coords = getShapePointsFromRecorrido(recorrido);
        if (coords.length < 2) return;

        const hue = (index * 67) % 360;
        L.polyline(coords, {
            color: `hsl(${hue}, 85%, 48%)`,
            weight: 4,
            opacity: 0.78,
            lineCap: 'round',
            lineJoin: 'round'
        }).addTo(layers.busRoute);
    });
}

function renderBusRouteInfo(routeInfo) {
    layers.busRoute?.clearLayers();
    layers.busStops?.clearLayers();

    const shapeCoords = (routeInfo?.shape || [])
        .map(point => [Number(point.lat), Number(point.lon)])
        .filter(([lat, lon]) => Number.isFinite(lat) && Number.isFinite(lon));

    if (shapeCoords.length >= 2) {
        L.polyline(shapeCoords, {
            color: '#ef4444',
            weight: 5,
            opacity: 0.9,
            lineCap: 'round',
            lineJoin: 'round'
        }).addTo(layers.busRoute);
    }

    (routeInfo?.stops || []).forEach(stop => {
        const lat = Number(stop.lat);
        const lon = Number(stop.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;

        const marker = L.marker([lat, lon], {
            icon: L.divIcon({
                className: '',
                html: '<div style="font-size:16px; line-height:1; filter: drop-shadow(0 1px 2px rgba(0,0,0,0.35));">🚏</div>',
                iconSize: [18, 18],
                iconAnchor: [9, 9]
            })
        });

        marker.bindTooltip(`
            <div class="glass p-2 rounded-xl shadow-lg border border-white/50 min-w-[170px]">
                <div class="text-[8px] font-black text-rose-600 uppercase tracking-wide">Parada ${stop.stop_sequence || '-'}</div>
                <div class="text-[10px] font-bold text-slate-700 leading-tight mt-0.5">${stop.stop_name || 'Parada sin nombre'}</div>
            </div>
        `, {
            className: 'custom-tooltip',
            direction: 'top',
            offset: [0, -8],
            opacity: 1
        });

        marker.addTo(layers.busStops);
    });
}

async function updateSelectedBusOverlay(selectedVehicle) {
    const routeId = selectedVehicle?.route_id;
    const tipId = selectedVehicle?.tip_id;
    const direction = selectedVehicle?.direction;

    if (!routeId || !tipId) {
        clearBusRouteLayers();
        return;
    }

    const routeKey = `${routeId}::${tipId}`;
    if (routeKey === globalThis.markerState.currentBusRouteKey && (layers.busRoute?.getLayers()?.length || 0) > 0) return;

    const requestToken = ++globalThis.markerState.busRouteRequestToken;
    try {
        const routeInfo = await fetchRouteInfo(routeId, tipId, direction);
        if (requestToken !== globalThis.markerState.busRouteRequestToken) return;
        if (!routeInfo) {
            clearBusRouteLayers();
            return;
        }

        renderBusRouteInfo(routeInfo);
        globalThis.markerState.currentBusRouteKey = `${routeId}::${tipId}`;
        globalThis.markerState.currentLineOverlayQuery = '';
    } catch {
        if (requestToken !== globalThis.markerState.busRouteRequestToken) return;
        clearBusRouteLayers();
    }
}

async function updateLineSearchOverlay(rawQuery) {
    const query = normalizeText(rawQuery);
    if (!query) {
        clearBusRouteLayers();
        return;
    }

    if (query === globalThis.markerState.currentLineOverlayQuery && (layers.busRoute?.getLayers()?.length || 0) > 0) return;

    const requestToken = ++globalThis.markerState.busLineRequestToken;
    try {
        const lineInfo = await fetchLineSearchInfo(rawQuery);
        if (requestToken !== globalThis.markerState.busLineRequestToken) return;
        if (!lineInfo || !Array.isArray(lineInfo.recorridos) || lineInfo.recorridos.length === 0) {
            clearBusRouteLayers();
            return;
        }

        renderLineSearchOverlay(lineInfo);
        globalThis.markerState.currentLineOverlayQuery = query;
        globalThis.markerState.currentBusRouteKey = '';
    } catch {
        if (requestToken !== globalThis.markerState.busLineRequestToken) return;
        clearBusRouteLayers();
    }
}

async function updateBusRouteOverlay(filterQuery) {
    if (!activeTypes.bus) {
        globalThis.markerState.selectedBusVehicleKey = '';
        clearBusRouteLayers();
        return;
    }

    const normalizedQuery = normalizeText(filterQuery);
    if (normalizedQuery) {
        const searchedVehicle = findVehicleForBusSearch(filterQuery, globalThis.cache.bus);
        if (searchedVehicle) {
            globalThis.markerState.selectedBusVehicleKey = getVehicleUniqueKey(searchedVehicle);
            await updateSelectedBusOverlay(searchedVehicle);
            return;
        }

        globalThis.markerState.selectedBusVehicleKey = '';
        await updateLineSearchOverlay(filterQuery);
        return;
    }

    const selectedVehicle = findVehicleByKey(globalThis.markerState.selectedBusVehicleKey, globalThis.cache.bus);
    if (selectedVehicle) {
        await updateSelectedBusOverlay(selectedVehicle);
        return;
    }

    globalThis.markerState.selectedBusVehicleKey = '';
    await updateLineSearchOverlay(filterQuery);
}
