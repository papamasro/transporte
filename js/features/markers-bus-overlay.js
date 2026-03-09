if (!globalThis.markerState) {
    globalThis.markerState = {
        busRouteCache: new Map(),
        busRouteNoResultCache: new Map(),
        busLineSearchCache: new Map(),
        currentBusRouteKey: '',
        currentLineOverlayQuery: '',
        selectedBusVehicleKey: '',
        busRouteRequestToken: 0,
        busLineRequestToken: 0
    };
}

function getConfiguredPath(pathKey, fallback) {
    return (globalThis.APP_CONFIG?.PATHS?.[pathKey] || fallback || '').toString();
}

function clearBusRouteLayers() {
    layers.busRoute?.clearLayers();
    layers.busStops?.clearLayers();
    globalThis.markerState.currentBusRouteKey = '';
    globalThis.markerState.currentLineOverlayQuery = '';
}

function clearBusRouteOverlay() {
    clearBusRouteLayers();
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

function getVehicleRouteShortNameForSearch(vehicle) {
    return (
        vehicle?.route_short_name ||
        vehicle?.vehicle?.trip?.route_short_name ||
        ''
    ).toString().trim();
}

function buildBusSearchText(vehicle) {
    const parts = [
        getBusDisplayLine(vehicle),
        getVehicleShortName(vehicle),
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

function getBusRouteConfig() {
    const cfg = globalThis.NETWORK_CONFIG || {};
    return {
        maxTripCandidates: Math.max(1, Number(cfg.busRouteMaxTripCandidates ?? 3)),
        maxFallbackVehicles: Math.max(1, Number(cfg.busRouteMaxFallbackVehicles ?? 3)),
        maxCallsPerSelection: Math.max(1, Number(cfg.busRouteMaxCallsPerSelection ?? 3)),
        noResultTtlMs: Math.max(0, Number(cfg.busRouteNoResultTtlMs ?? 30000)),
        maxShapeDistanceMeters: Math.max(100, Number(cfg.busRouteMaxShapeDistanceMeters ?? 1500)),
        minShapePoints: Math.max(2, Number(cfg.busRouteMinShapePoints ?? 20)),
        retryMax: Math.max(1, Number(cfg.retryMax ?? 3)),
        retryDelayMs: Math.max(0, Number(cfg.retryDelayMs ?? 1000))
    };
}

function toRadians(value) {
    return (value * Math.PI) / 180;
}

function parseLatLon(point) {
    if (!point) return null;

    if (Array.isArray(point) && point.length >= 2) {
        const latFromArray = Number(point[0]);
        const lonFromArray = Number(point[1]);
        if (Number.isFinite(latFromArray) && Number.isFinite(lonFromArray)) {
            return { lat: latFromArray, lon: lonFromArray };
        }
    }

    const lat = Number(point?.lat ?? point?.latitude);
    const lon = Number(point?.lon ?? point?.lng ?? point?.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    return { lat, lon };
}

function haversineMeters(lat1, lon1, lat2, lon2) {
    const earthRadius = 6371000;
    const dLat = toRadians(lat2 - lat1);
    const dLon = toRadians(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2
        + Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * earthRadius * Math.asin(Math.min(1, Math.sqrt(a)));
}

function getMinDistanceToShapeMeters(shape, anchorCoordinates) {
    if (!Array.isArray(shape) || !anchorCoordinates) return Number.POSITIVE_INFINITY;
    let minDistance = Number.POSITIVE_INFINITY;

    shape.forEach(point => {
        const parsedPoint = parseLatLon(point);
        if (!parsedPoint) return;
        const distance = haversineMeters(
            anchorCoordinates.lat,
            anchorCoordinates.lon,
            parsedPoint.lat,
            parsedPoint.lon
        );
        if (distance < minDistance) minDistance = distance;
    });

    return minDistance;
}

function isBusRouteRecentlyMissed(routeKey) {
    const missCache = globalThis.markerState.busRouteNoResultCache;
    const ts = Number(missCache.get(routeKey) || 0);
    if (!ts) return false;

    const { noResultTtlMs } = getBusRouteConfig();
    if ((Date.now() - ts) <= noResultTtlMs) return true;

    missCache.delete(routeKey);
    return false;
}

function markBusRouteMiss(routeKey) {
    globalThis.markerState.busRouteNoResultCache.set(routeKey, Date.now());
}

function clearBusRouteMiss(routeKey) {
    globalThis.markerState.busRouteNoResultCache.delete(routeKey);
}

function findVehicleByKey(vehicleKey, vehicles) {
    if (!vehicleKey || !Array.isArray(vehicles)) return null;
    return vehicles.find(vehicle => getVehicleUniqueKey(vehicle) === vehicleKey) || null;
}

function getVehiclesBySameRoute(selectedVehicle, vehicles) {
    if (!selectedVehicle || !Array.isArray(vehicles) || vehicles.length === 0) return [];

    const selectedKey = getVehicleUniqueKey(selectedVehicle);
    const selectedRouteId = normalizeText(getVehicleRouteId(selectedVehicle));
    const selectedShortName = normalizeLineToken(getVehicleShortName(selectedVehicle));

    const selectedDirection = Number(selectedVehicle?.direction);

    const matches = vehicles.filter(vehicle => {
        const vehicleKey = getVehicleUniqueKey(vehicle);
        if (!vehicleKey || vehicleKey === selectedKey) return false;

        const sameShortName = selectedShortName
            && normalizeLineToken(getVehicleShortName(vehicle)) === selectedShortName;
        if (sameShortName) return true;

        const sameRouteId = selectedRouteId
            && normalizeText(getVehicleRouteId(vehicle)) === selectedRouteId;
        return !!sameRouteId;
    });

    return matches.sort((left, right) => {
        const leftDirection = Number(left?.direction);
        const rightDirection = Number(right?.direction);
        const leftSameDirection = Number.isFinite(selectedDirection) && leftDirection === selectedDirection ? 1 : 0;
        const rightSameDirection = Number.isFinite(selectedDirection) && rightDirection === selectedDirection ? 1 : 0;
        return rightSameDirection - leftSameDirection;
    });
}

function findVehicleForBusSearch(query, vehicles) {
    const normalizedQuery = normalizeText(query);
    if (!normalizedQuery || !Array.isArray(vehicles) || vehicles.length === 0) return null;

    const compactQuery = normalizeLineToken(query);

    const exactMatch = vehicles.find(vehicle => {
        const routeShortName = getVehicleRouteShortNameForSearch(vehicle);
        const shortName = normalizeText(routeShortName);
        const shortNameCompact = normalizeLineToken(routeShortName);
        return (
            shortName === normalizedQuery
            || (compactQuery && shortNameCompact === compactQuery)
        );
    });
    if (exactMatch) return exactMatch;

    const partialMatch = vehicles.find(vehicle => {
        const routeShortName = getVehicleRouteShortNameForSearch(vehicle);
        const shortName = normalizeText(routeShortName);
        const shortNameCompact = normalizeLineToken(routeShortName);
        return (
            shortName.includes(normalizedQuery)
            || (compactQuery && shortNameCompact.includes(compactQuery))
        );
    });
    if (partialMatch) return partialMatch;

    return null;
}

function getVehicleRouteContext(vehicle) {
    const routeId = getVehicleRouteId(vehicle);
    const lineShortName = (getVehicleShortName(vehicle) || routeId || '').toString().trim();
    const tripCandidates = getVehicleTripCandidates(vehicle);
    const direction = vehicle?.direction;

    return {
        routeId,
        lineShortName,
        tripCandidates,
        direction
    };
}

function buildSelectedRouteKey(selectedContext) {
    if (!selectedContext) return '';
    const routeId = (selectedContext.routeId || '').toString().trim();
    const lineShortName = (selectedContext.lineShortName || '').toString().trim();
    const tripKey = Array.isArray(selectedContext.tripCandidates)
        ? selectedContext.tripCandidates.map(value => (value || '').toString().trim()).filter(Boolean).join('|')
        : '';
    const direction = selectedContext.direction ?? '';
    return `${routeId}::${lineShortName}::${tripKey}::${direction}`;
}

function renderBusRouteInfo(routeInfo) {
    layers.busRoute?.clearLayers();
    layers.busStops?.clearLayers();

    const rawShape = Array.isArray(routeInfo?.shape) ? routeInfo.shape : [];
    const shapeCoords = rawShape
        .map(point => parseLatLon(point))
        .filter(Boolean)
        .map(point => [point.lat, point.lon]);

    if (shapeCoords.length >= 2) {
        L.polyline(shapeCoords, {
            color: '#2563eb',
            weight: 5,
            opacity: 0.85,
            lineCap: 'round',
            lineJoin: 'round'
        }).addTo(layers.busRoute);
    }

    const rawStops = Array.isArray(routeInfo?.stops) ? routeInfo.stops : [];
    rawStops.forEach(stop => {
        const parsedStop = parseLatLon(stop);
        if (!parsedStop) return;

        L.circleMarker([parsedStop.lat, parsedStop.lon], {
            radius: 4,
            color: '#1d4ed8',
            fillColor: '#60a5fa',
            fillOpacity: 0.95,
            weight: 1
        })
            .bindTooltip((stop?.name || stop?.nombre || 'Parada').toString(), {
                className: 'custom-tooltip',
                direction: 'top',
                offset: [0, -6],
                opacity: 0.95
            })
            .addTo(layers.busStops);
    });
}

async function fetchRouteInfo(routeId, lineShortName, tripCandidates, direction, requestBudget, anchorCoordinates) {
    const tripKey = Array.isArray(tripCandidates) ? tripCandidates.join('|') : '';
    const routeKey = `${routeId || ''}::${lineShortName || ''}::${tripKey}::${direction ?? ''}`;
    if (globalThis.markerState.busRouteCache.has(routeKey)) return globalThis.markerState.busRouteCache.get(routeKey);

    const queryCandidates = buildRouteQueryCandidates(routeId, lineShortName, tripCandidates);
    if (queryCandidates.length === 0) return null;

    const cfg = getBusRouteConfig();

    for (const candidate of queryCandidates) {
        if (requestBudget && requestBudget.remaining <= 0) break;
        const params = buildInfoTrayectoParams(candidate, direction);
        if (requestBudget) requestBudget.remaining -= 1;

        const infoTrayectoPath = getConfiguredPath('busInfoTrayecto', '/info-trayecto');
        const response = await fetchAPI(`${infoTrayectoPath}?${params.toString()}`, {
            retryMax: cfg.retryMax,
            retryDelayMs: cfg.retryDelayMs
        });
        if (!shouldAcceptRouteCandidate(response, candidate, anchorCoordinates)) continue;

        globalThis.markerState.busRouteCache.set(routeKey, response.data);
        return response.data;
    }

    return null;
}

function shouldAcceptRouteCandidate(response, candidate, anchorCoordinates) {
    if (!response?.success || !response?.data) return false;
    if (!hasRenderableRouteShape(response.data)) return false;

    const hasStrongTripHint = Boolean(candidate?.trip_id || candidate?.tip_id);
    if (hasStrongTripHint) return true;

    return hasValidRouteShape(response.data, anchorCoordinates);
}

function buildRouteQueryCandidates(routeId, lineShortName, tripCandidates) {
    const cfg = getBusRouteConfig();
    const candidates = [];
    const normalizedTripCandidates = Array.from(new Set((tripCandidates || [])
        .map(value => (value || '').toString().trim())
        .filter(Boolean))).slice(0, cfg.maxTripCandidates);

    normalizedTripCandidates.forEach(candidateTrip => {
        candidates.push({ trip_id: candidateTrip, tip_id: candidateTrip, linea: lineShortName || '' });
        if (candidateTrip.includes('-')) {
            candidates.push({ trip_id: candidateTrip.replaceAll('-', ''), linea: lineShortName || '' });
        }
    });

    if (candidates.length === 0) {
        if (lineShortName) candidates.push({ linea: lineShortName });
        else if (routeId) candidates.push({ linea: routeId });
    }

    return candidates;
}

function buildInfoTrayectoParams(candidate, direction) {
    const params = new URLSearchParams();
    if (candidate.trip_id) params.set('trip_id', candidate.trip_id);
    if (candidate.tip_id) params.set('tip_id', candidate.tip_id);
    if (candidate.linea) params.set('linea', candidate.linea);
    if (direction !== undefined && direction !== null) params.set('direction', direction);
    return params;
}

async function fetchLineSearchInfo(numero) {
    const normalizedNumero = normalizeText(numero);
    if (!normalizedNumero) return null;
    const compactNumero = normalizeLineToken(numero);
    const cacheKey = compactNumero || normalizedNumero;
    const cache = globalThis.markerState.busLineSearchCache;
    if (cache.has(cacheKey)) return cache.get(cacheKey);
    if (compactNumero && cache.has(normalizedNumero)) return cache.get(normalizedNumero);

    const searchLinePath = getConfiguredPath('busSearchLine', '/buscar-linea');
    const queryCandidates = Array.from(new Set([
        (numero || '').toString().trim(),
        compactNumero
    ].filter(Boolean)));

    for (const candidate of queryCandidates) {
        const response = await fetchAPI(`${searchLinePath}?numero=${encodeURIComponent(candidate)}`);
        if (!response.success || !response.data) continue;

        let normalizedData = null;
        if (Array.isArray(response.data)) {
            normalizedData = { recorridos: response.data };
        } else if (Array.isArray(response.data?.recorridos)) {
            normalizedData = response.data;
        }

        if (!normalizedData) continue;

        cache.set(cacheKey, normalizedData);
        cache.set(normalizedNumero, normalizedData);
        if (compactNumero) cache.set(compactNumero, normalizedData);
        return normalizedData;
    }

    return null;
}

function getShapePointsFromRecorrido(recorrido) {
    let shape = [];
    if (Array.isArray(recorrido?.shape)) {
        shape = recorrido.shape;
    } else if (Array.isArray(recorrido?.points)) {
        shape = recorrido.points;
    }

    return shape
        .map(point => parseLatLon(point))
        .filter(Boolean)
        .map(point => [point.lat, point.lon]);
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

function hasValidRouteShape(routeData, anchorCoordinates) {
    const cfg = getBusRouteConfig();
    const shape = Array.isArray(routeData?.shape) ? routeData.shape : [];
    const shapeSize = shape.length;
    if (shapeSize < cfg.minShapePoints) return false;

    if (!anchorCoordinates) return true;
    const minDistance = getMinDistanceToShapeMeters(shape, anchorCoordinates);
    if (!Number.isFinite(minDistance)) return false;

    return minDistance <= cfg.maxShapeDistanceMeters;
}

function hasRenderableRouteShape(routeData) {
    const shape = Array.isArray(routeData?.shape) ? routeData.shape : [];
    let validPoints = 0;
    for (const point of shape) {
        if (parseLatLon(point)) validPoints += 1;
        if (validPoints >= 2) return true;
    }
    return false;
}

function getRouteAnchorCoordinates(selectedVehicle) {
    return getVehicleCoordinates(selectedVehicle);
}

function normalizeHeadsign(value) {
    return normalizeText(value || '').replaceAll(/\s+/g, ' ').trim();
}

function shapeFromRecorrido(recorrido) {
    if (Array.isArray(recorrido?.shape)) return recorrido.shape;
    if (Array.isArray(recorrido?.points)) return recorrido.points;
    return [];
}

function scoreRecorridoForVehicle(recorrido, selectedVehicle, anchorCoordinates) {
    const shape = shapeFromRecorrido(recorrido);
    const cfg = getBusRouteConfig();
    if (shape.length < cfg.minShapePoints) return Number.POSITIVE_INFINITY;

    const distance = getMinDistanceToShapeMeters(shape, anchorCoordinates);
    if (!Number.isFinite(distance)) return Number.POSITIVE_INFINITY;

    const selectedHeadsign = normalizeHeadsign(selectedVehicle?.trip_headsign);
    const recorridoHeadsign = normalizeHeadsign(recorrido?.trip_headsign);

    let score = distance;
    if (selectedHeadsign && recorridoHeadsign) {
        if (selectedHeadsign === recorridoHeadsign) score -= 300;
        else if (selectedHeadsign.includes(recorridoHeadsign) || recorridoHeadsign.includes(selectedHeadsign)) score -= 120;
    }

    return score;
}

function pickBestRecorridoForVehicle(recorridos, selectedVehicle, anchorCoordinates) {
    let best = null;
    let bestScore = Number.POSITIVE_INFINITY;

    recorridos.forEach(recorrido => {
        const score = scoreRecorridoForVehicle(recorrido, selectedVehicle, anchorCoordinates);
        if (score < bestScore) {
            best = recorrido;
            bestScore = score;
        }
    });

    if (!best) return null;

    const shape = shapeFromRecorrido(best);
    const minDistance = getMinDistanceToShapeMeters(shape, anchorCoordinates);
    const cfg = getBusRouteConfig();
    if (Number.isFinite(minDistance) && minDistance > cfg.maxShapeDistanceMeters) return null;

    return {
        info: {
            route_short_name: best?.route_short_name || best?.routeShortName || best?.short_name || getVehicleShortName(selectedVehicle) || '',
            trip_headsign: best?.trip_headsign || selectedVehicle?.trip_headsign || '',
            source: 'buscar-linea'
        },
        shape,
        stops: []
    };
}

async function fetchRouteInfoFromLineSearch(selectedVehicle, requestBudget, anchorCoordinates) {
    if (!requestBudget || requestBudget.remaining <= 0) return null;

    const lineQuery = (getVehicleShortName(selectedVehicle) || selectedVehicle?.route_id || '').toString().trim();
    if (!lineQuery) return null;

    requestBudget.remaining -= 1;
    const lineInfo = await fetchLineSearchInfo(lineQuery);
    const recorridos = Array.isArray(lineInfo?.recorridos) ? lineInfo.recorridos : [];
    if (recorridos.length === 0) return null;

    return pickBestRecorridoForVehicle(recorridos, selectedVehicle, anchorCoordinates);
}

function canUseRouteForSelection(routeData, selectedVehicle) {
    const anchorCoordinates = getRouteAnchorCoordinates(selectedVehicle);
    return hasValidRouteShape(routeData, anchorCoordinates);
}

function getSelectedRouteState(selectedVehicle, selectedContext) {
    const anchorCoordinates = getRouteAnchorCoordinates(selectedVehicle);
    return {
        routeKey: buildSelectedRouteKey(selectedContext),
        anchorCoordinates
    };
}

function shouldSkipSelectedRoute(routeState) {
    const hasRenderedRoute = (layers.busRoute?.getLayers()?.length || 0) > 0;
    if (routeState.routeKey === globalThis.markerState.currentBusRouteKey && hasRenderedRoute) return true;
    if (isBusRouteRecentlyMissed(routeState.routeKey)) return true;
    return false;
}

function handleRouteNotFound(routeState) {
    markBusRouteMiss(routeState.routeKey);
    clearBusRouteLayers();
}

function handleRouteFound(routeInfo, routeState) {
    renderBusRouteInfo(routeInfo);
    clearBusRouteMiss(routeState.routeKey);
    globalThis.markerState.currentBusRouteKey = routeState.routeKey;
    globalThis.markerState.currentLineOverlayQuery = '';
}

function isRouteInfoUsable(routeInfo, selectedVehicle) {
    if (!routeInfo) return false;
    if (!hasRenderableRouteShape(routeInfo)) return false;

    const source = (routeInfo?.info?.source || '').toString().trim();
    if (source === 'buscar-linea') return canUseRouteForSelection(routeInfo, selectedVehicle);

    return true;
}

async function fetchPrimaryRouteInfo(selectedContext, requestBudget, anchorCoordinates) {
    return fetchRouteInfo(
        selectedContext.routeId,
        selectedContext.lineShortName,
        selectedContext.tripCandidates,
        selectedContext.direction,
        requestBudget,
        anchorCoordinates
    );
}

async function fetchFallbackRouteInfo(selectedVehicle, cfg, requestBudget, anchorCoordinates) {
    if (requestBudget.remaining <= 0) return null;

    const fallbackVehicles = getVehiclesBySameRoute(selectedVehicle, globalThis.cache.bus)
        .slice(0, cfg.maxFallbackVehicles);

    for (const fallbackVehicle of fallbackVehicles) {
        if (requestBudget.remaining <= 0) break;
        const fallbackContext = getVehicleRouteContext(fallbackVehicle);
        const routeInfo = await fetchRouteInfo(
            fallbackContext.routeId,
            fallbackContext.lineShortName,
            fallbackContext.tripCandidates,
            fallbackContext.direction,
            requestBudget,
            anchorCoordinates
        );
        if (routeInfo) return routeInfo;
    }

    return null;
}

async function resolveRouteInfoWithFallback(selectedVehicle, selectedContext, cfg, requestBudget, anchorCoordinates) {
    let routeInfo = await fetchPrimaryRouteInfo(selectedContext, requestBudget, anchorCoordinates);
    if (routeInfo) return routeInfo;

    routeInfo = await fetchFallbackRouteInfo(selectedVehicle, cfg, requestBudget, anchorCoordinates);
    if (routeInfo) return routeInfo;

    routeInfo = await fetchRouteInfoFromLineSearch(selectedVehicle, requestBudget, anchorCoordinates);
    return routeInfo;
}

async function updateSelectedBusOverlay(selectedVehicle) {
    const selectedContext = getVehicleRouteContext(selectedVehicle);
    const { routeId, lineShortName, tripCandidates } = selectedContext;

    if (!routeId && !lineShortName && tripCandidates.length === 0) {
        clearBusRouteLayers();
        return;
    }

    const routeState = getSelectedRouteState(selectedVehicle, selectedContext);
    if (shouldSkipSelectedRoute(routeState)) return;

    const requestToken = ++globalThis.markerState.busRouteRequestToken;
    try {
        const cfg = getBusRouteConfig();
        const requestBudget = { remaining: cfg.maxCallsPerSelection };
        const routeInfo = await resolveRouteInfoWithFallback(
            selectedVehicle,
            selectedContext,
            cfg,
            requestBudget,
            routeState.anchorCoordinates
        );

        if (requestToken !== globalThis.markerState.busRouteRequestToken) return;
        if (!isRouteInfoUsable(routeInfo, selectedVehicle)) {
            handleRouteNotFound(routeState);
            return;
        }

        handleRouteFound(routeInfo, routeState);
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
