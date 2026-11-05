if (!globalThis.markerState) {
    globalThis.markerState = {
        busRouteCache: new Map(),
        busRouteNoResultCache: new Map(),
        busLineSearchCache: new Map(),
        currentBusRouteKey: '',
        currentLineOverlayQuery: '',
        selectedBusVehicleKey: '',
        openBusPopupKey: '',
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

// El recorrido abierto al tocar un colectivo se oculta al cerrar su popup. Si hay una búsqueda de
// línea en curso el overlay lo maneja la búsqueda (queda hasta que se borre el texto).
function handleBusPopupClosed(vehicle) {
    const state = globalThis.markerState;
    const key = getVehicleUniqueKey(vehicle);
    if (key && state.openBusPopupKey === key) state.openBusPopupKey = '';
    if (!key || state.selectedBusVehicleKey !== key) return;
    if (normalizeText(getCommittedSearchQuery())) return;

    state.selectedBusVehicleKey = '';
    state.busRouteRequestToken += 1;
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

function getVehicleBearing(vehicle) {
    if (!vehicle) return null;
    // _derivedBearing: rumbo calculado entre snapshots (bus-animation.js) si el feed no trae bearing.
    const b = Number(
        vehicle?.bearing ??
        vehicle?.vehicle?.position?.bearing ??
        vehicle?._derivedBearing ??
        Number.NaN
    );
    return Number.isFinite(b) ? (b % 360 + 360) % 360 : null;
}

function getBusRouteConfig() {
    const cfg = globalThis.NETWORK_CONFIG || {};
    return {
        maxTripCandidates: Math.max(1, Number(cfg.busRouteMaxTripCandidates ?? 3)),
        maxFallbackVehicles: Math.max(1, Number(cfg.busRouteMaxFallbackVehicles ?? 3)),
        maxCallsPerSelection: Math.max(1, Number(cfg.busRouteMaxCallsPerSelection ?? 3)),
        noResultTtlMs: Math.max(0, Number(cfg.busRouteNoResultTtlMs ?? 30000)),
        cacheTtlMs: Math.max(0, Number(cfg.busRouteCacheTtlMs ?? 600000)),
        negativeCacheTtlMs: Math.max(0, Number(cfg.busRouteNegativeCacheTtlMs ?? 120000)),
        maxShapeDistanceMeters: Math.max(100, Number(cfg.busRouteMaxShapeDistanceMeters ?? 1500)),
        minShapePoints: Math.max(2, Number(cfg.busRouteMinShapePoints ?? 20)),
        retryMax: Math.max(1, Number(cfg.retryMax ?? 3)),
        retryDelayMs: Math.max(0, Number(cfg.retryDelayMs ?? 1000))
    };
}

// Distancia al segmento más cercano (no solo a los vértices: los shapes simplificados tienen
// tramos rectos largos). Proyección equirectangular local, suficiente a escala de ciudad.
function getMinDistanceToShapeMeters(shape, anchorCoordinates) {
    if (!Array.isArray(shape) || !anchorCoordinates) return Number.POSITIVE_INFINITY;
    const kx = 111320 * Math.cos(anchorCoordinates.lat * Math.PI / 180);
    const ky = 110540;
    let minDistance = Number.POSITIVE_INFINITY;
    let previous = null;

    shape.forEach(point => {
        const parsedPoint = parseLatLon(point);
        if (!parsedPoint) return;
        const x = (parsedPoint.lon - anchorCoordinates.lon) * kx;
        const y = (parsedPoint.lat - anchorCoordinates.lat) * ky;
        let distance = Math.hypot(x, y);
        if (previous) {
            const dx = x - previous[0];
            const dy = y - previous[1];
            const lengthSquared = dx * dx + dy * dy;
            if (lengthSquared > 0) {
                const t = Math.max(0, Math.min(1, -(previous[0] * dx + previous[1] * dy) / lengthSquared));
                distance = Math.hypot(previous[0] + t * dx, previous[1] + t * dy);
            }
        }
        if (distance < minDistance) minDistance = distance;
        previous = [x, y];
    });

    return minDistance;
}

// Los shapes estáticos vienen simplificados (Douglas-Peucker): pocos puntos no indican datos rotos.
function getMinShapePointsFor(routeData, cfg) {
    const source = routeData?.info?.source || routeData?.source;
    return source === 'static' || routeData?.info?.fromStatic ? 2 : cfg.minShapePoints;
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

// Entradas { value, expiresAt }; value === null es un resultado negativo (vacío o fallido).
function readTimedCache(cache, key) {
    const entry = cache.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
        cache.delete(key);
        return null;
    }
    return entry;
}

function writeTimedCache(cache, key, value, ttlMs, extra = {}) {
    if (cache.size >= 500) {
        const now = Date.now();
        cache.forEach((entry, entryKey) => {
            if (entry.expiresAt <= now) cache.delete(entryKey);
        });
    }
    cache.set(key, { ...extra, value, expiresAt: Date.now() + ttlMs });
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

    if (!compactQuery) return null;

    // Prefijo con límite ("60" -> "60A"); si el prefijo abarca varias líneas distintas no se elige ninguna.
    let partialMatch = null;
    let partialToken = '';
    for (const vehicle of vehicles) {
        const shortNameCompact = normalizeLineToken(getVehicleRouteShortNameForSearch(vehicle));
        if (!matchesLineToken(shortNameCompact, compactQuery)) continue;
        if (!partialMatch) {
            partialMatch = vehicle;
            partialToken = shortNameCompact;
        } else if (shortNameCompact !== partialToken) {
            return null;
        }
    }

    return partialMatch;
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
            .bindTooltip(escapeHtml(stop?.name || stop?.nombre || 'Parada'), {
                className: 'custom-tooltip',
                direction: 'top',
                offset: [0, -6],
                opacity: 0.95
            })
            .addTo(layers.busStops);
    });
}

// ─── Recorridos estáticos (data/routes/, generados con scripts/build-static-routes.py) ───
// Reemplazan a /buscar-linea e /info-trayecto (D1). Si los archivos no están publicados se usa el worker.
const staticRoutesState = {
    files: new Map(),
    inflight: new Map(),
    available: null,
    availablePromise: null
};

function isStaticBusRoutesEnabled() {
    return globalThis.APP_CONFIG?.FEATURES?.busStaticRoutes !== false;
}

function getStaticRoutesBaseUrl() {
    const configured = (globalThis.APP_CONFIG?.PATHS?.busStaticRoutes || './data/routes/').toString();
    return new URL(configured.endsWith('/') ? configured : `${configured}/`, document.baseURI);
}

// Mismo criterio que line_file_base del script: dígitos iniciales del token ("60A" -> "60").
function getStaticRouteFileBase(lineShortName) {
    const token = normalizeLineToken(lineShortName);
    const digits = token.match(/^\d+/);
    return digits ? digits[0] : token;
}

async function fetchStaticRouteResource(fileName, method = 'GET') {
    const timeoutMs = Math.max(1000, Number(globalThis.NETWORK_CONFIG?.requestTimeoutMs ?? 10000));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(new URL(fileName, getStaticRoutesBaseUrl()), {
            method,
            headers: { 'Accept': 'application/json' },
            signal: controller.signal
        });
        if (!response.ok) return { ok: false, status: response.status };
        return { ok: true, status: response.status, data: method === 'HEAD' ? null : await response.json() };
    } catch {
        return { ok: false, status: 0 };
    } finally {
        clearTimeout(timer);
    }
}

// Un HEAD a index.json por sesión: sin datos publicados no se pide un 404 por cada línea.
async function areStaticRoutesAvailable() {
    if (!isStaticBusRoutesEnabled()) return false;
    if (staticRoutesState.available !== null) return staticRoutesState.available;
    if (!staticRoutesState.availablePromise) {
        staticRoutesState.availablePromise = fetchStaticRouteResource('index.json', 'HEAD')
            .then(result => {
                // Error de red: se reintenta en la próxima selección.
                if (result.ok || result.status === 404) staticRoutesState.available = result.ok;
                return result.ok;
            })
            .finally(() => { staticRoutesState.availablePromise = null; });
    }
    return staticRoutesState.availablePromise;
}

function isStaticRouteFile(data) {
    return !!data && typeof data === 'object' && data.variants && typeof data.variants === 'object';
}

// null = archivo inexistente, inválido o caído (cache negativo corto).
async function loadStaticRouteFile(base) {
    if (!base || !(await areStaticRoutesAvailable())) return null;
    const cache = staticRoutesState.files;
    const cached = readTimedCache(cache, base);
    if (cached) return cached.value;
    if (staticRoutesState.inflight.has(base)) return staticRoutesState.inflight.get(base);

    const cfg = getBusRouteConfig();
    const request = fetchStaticRouteResource(`${encodeURIComponent(base)}.json`)
        .then(result => {
            const data = result.ok && isStaticRouteFile(result.data) ? result.data : null;
            writeTimedCache(cache, base, data, data ? cfg.cacheTtlMs : cfg.negativeCacheTtlMs);
            return data;
        })
        .finally(() => staticRoutesState.inflight.delete(base));
    staticRoutesState.inflight.set(base, request);
    return request;
}

function decodeStaticPolyline(encoded) {
    const points = [];
    const text = (encoded || '').toString();
    let index = 0;
    let lat = 0;
    let lon = 0;
    while (index < text.length) {
        const deltas = [0, 0];
        for (let axis = 0; axis < 2; axis += 1) {
            let result = 0;
            let shift = 0;
            let byte;
            do {
                byte = text.charCodeAt(index++) - 63;
                result |= (byte & 0x1f) << shift;
                shift += 5;
            } while (byte >= 0x20 && index < text.length);
            deltas[axis] = (result & 1) ? ~(result >> 1) : (result >> 1);
        }
        lat += deltas[0];
        lon += deltas[1];
        points.push({ lat: lat / 1e5, lon: lon / 1e5 });
    }
    return points;
}

// Adapta una variante estática a lo que devolvía el worker: 'trayecto' = /info-trayecto
// ({ info, shape, stops }); 'recorrido' = un elemento de /buscar-linea ({ ..., shape }).
function adaptStaticRouteVariant(file, variantId, mode) {
    const variant = file?.variants?.[variantId];
    if (!variant) return null;
    if (!variant._decodedShape) variant._decodedShape = decodeStaticPolyline(variant.shape);

    const base = {
        route_id: variant.route_id,
        route_short_name: variant.short || '',
        shape_id: variantId,
        trip_id: variant.trip_id || '',
        trip_headsign: variant.headsign || '',
        direction_id: variant.direction
    };
    if (mode === 'recorrido') return { ...base, source: 'static', shape: variant._decodedShape };

    const stops = (Array.isArray(variant.stops) ? variant.stops : [])
        .map((stopId, index) => {
            const stop = file.stops?.[stopId];
            if (!Array.isArray(stop)) return null;
            return { stop_id: stopId, stop_name: stop[0], name: stop[0], lat: stop[1], lon: stop[2], stop_sequence: index };
        })
        .filter(Boolean);

    return {
        info: { ...base, agency_name: file.agencies?.[variant.agency_id] || '', source: 'static' },
        shape: variant._decodedShape,
        stops
    };
}

// Join con el tiempo real: route_id de vehiclePositionsSimple = route_id del GTFS (un route_id
// por ramal y sentido). Si la línea del archivo no coincide (feed de otra versión) se descarta
// y se elige por línea + sentido + cercanía. La distancia al ancla se valida siempre.
function pickStaticVariantForVehicle(file, routeId, lineShortName, direction, anchorCoordinates) {
    const lineToken = normalizeLineToken(lineShortName);
    const directionKey = direction === undefined || direction === null || direction === '' ? '' : String(direction);
    const entry = routeId ? file.routes?.[String(routeId)] : null;

    if (entry && (!lineToken || normalizeLineToken(entry.short) === lineToken)) {
        const dirs = entry.dirs || {};
        const dirValues = Object.values(dirs);
        const variantId = (directionKey && dirs[directionKey]) || (dirValues.length === 1 ? dirValues[0] : null);
        const routeInfo = variantId ? adaptStaticRouteVariant(file, variantId, 'trayecto') : null;
        if (routeInfo && hasValidRouteShape(routeInfo, anchorCoordinates)) {
            return { routeInfo, strong: true, match: 'route_id' };
        }
    }

    if (!lineToken) return { routeInfo: null, rejectedOnlyByDistance: false };
    let best = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    let sawCandidate = false;
    Object.entries(file.variants || {}).forEach(([variantId, variant]) => {
        if (normalizeLineToken(variant.short) !== lineToken) return;
        if (directionKey && String(variant.direction) !== directionKey) return;
        const routeInfo = adaptStaticRouteVariant(file, variantId, 'trayecto');
        if (!routeInfo || routeInfo.shape.length < 2) return;
        sawCandidate = true;
        const distance = anchorCoordinates ? getMinDistanceToShapeMeters(routeInfo.shape, anchorCoordinates) : 0;
        if (distance < bestDistance) {
            best = routeInfo;
            bestDistance = distance;
        }
    });

    if (best && hasValidRouteShape(best, anchorCoordinates)) return { routeInfo: best, strong: false, match: 'line' };
    return { routeInfo: null, rejectedOnlyByDistance: sawCandidate };
}

// { handled: false } = no hay datos estáticos para esta línea (se usa el worker).
async function fetchStaticRouteInfo(routeId, lineShortName, direction, anchorCoordinates) {
    const file = await loadStaticRouteFile(getStaticRouteFileBase(lineShortName || ''));
    if (!file) return { handled: false };
    return { handled: true, ...pickStaticVariantForVehicle(file, routeId, lineShortName, direction, anchorCoordinates) };
}

async function fetchStaticLineSearchInfo(numero, compactNumero) {
    const file = await loadStaticRouteFile(getStaticRouteFileBase(numero));
    if (!file) return { handled: false };
    const recorridos = Object.keys(file.variants)
        .map(variantId => adaptStaticRouteVariant(file, variantId, 'recorrido'))
        .filter(Boolean);
    const selected = selectRecorridosForLine(recorridos, compactNumero);
    return { handled: true, data: selected.length > 0 ? { recorridos: selected, source: 'static' } : null };
}

async function fetchRouteInfo(routeId, lineShortName, tripCandidates, direction, requestBudget, anchorCoordinates) {
    if (!isFeatureEnabled('busRouteOverlay')) return null;

    const tripKey = Array.isArray(tripCandidates) ? tripCandidates.join('|') : '';
    const routeKey = `${routeId || ''}::${lineShortName || ''}::${tripKey}::${direction ?? ''}`;
    const routeCache = globalThis.markerState.busRouteCache;
    const cached = readTimedCache(routeCache, routeKey);
    if (cached) {
        if (!cached.value) return null;
        // Sin trip_id el recorrido se aceptó por cercanía a otro vehículo: se revalida con este ancla.
        if (cached.strong || hasValidRouteShape(cached.value, anchorCoordinates)) return cached.value;
        return null;
    }

    const cfg = getBusRouteConfig();
    const staticResult = await fetchStaticRouteInfo(routeId, lineShortName, direction, anchorCoordinates);
    if (staticResult.handled) {
        if (staticResult.routeInfo) {
            writeTimedCache(routeCache, routeKey, staticResult.routeInfo, cfg.cacheTtlMs, { strong: staticResult.strong });
            return staticResult.routeInfo;
        }
        if (!staticResult.rejectedOnlyByDistance) writeTimedCache(routeCache, routeKey, null, cfg.negativeCacheTtlMs);
        return null;
    }

    const queryCandidates = buildRouteQueryCandidates(routeId, lineShortName, tripCandidates);
    if (queryCandidates.length === 0) return null;

    let triedAllCandidates = true;
    let rejectedOnlyByDistance = false;

    for (const candidate of queryCandidates) {
        if (requestBudget && requestBudget.remaining <= 0) {
            triedAllCandidates = false;
            break;
        }
        const params = buildInfoTrayectoParams(candidate, direction);
        if (requestBudget) requestBudget.remaining -= 1;

        const infoTrayectoPath = getConfiguredPath('busInfoTrayecto', '/info-trayecto');
        const response = await fetchAPI(`${infoTrayectoPath}?${params.toString()}`, {
            retryMax: cfg.retryMax,
            retryDelayMs: cfg.retryDelayMs
        });
        if (shouldAcceptRouteCandidate(response, candidate, anchorCoordinates)) {
            const strong = Boolean(candidate?.trip_id || candidate?.tip_id);
            writeTimedCache(routeCache, routeKey, response.data, cfg.cacheTtlMs, { strong });
            return response.data;
        }

        if (response?.success && hasRenderableRouteShape(response.data) && hasValidRouteShape(response.data, null)) {
            rejectedOnlyByDistance = true;
        }
    }

    // Vacío/fallido para todos los candidatos: negativo corto. Si se descartó solo por distancia
    // al ancla, otro vehículo de la misma línea puede servirlo, así que no se cachea.
    if (triedAllCandidates && !rejectedOnlyByDistance) {
        writeTimedCache(routeCache, routeKey, null, cfg.negativeCacheTtlMs);
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
    if (!isFeatureEnabled('busLineSearchOverlay')) return null;

    const normalizedNumero = normalizeText(numero);
    if (!normalizedNumero) return null;
    const compactNumero = normalizeLineToken(numero);
    const cacheKey = compactNumero || normalizedNumero;
    const cache = globalThis.markerState.busLineSearchCache;
    const cached = readTimedCache(cache, cacheKey);
    if (cached) return cached.value;

    const cfg = getBusRouteConfig();
    const staticResult = await fetchStaticLineSearchInfo(numero, compactNumero);
    if (staticResult.handled) {
        writeTimedCache(cache, cacheKey, staticResult.data, staticResult.data ? cfg.cacheTtlMs : cfg.negativeCacheTtlMs);
        return staticResult.data;
    }

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

        const recorridos = selectRecorridosForLine(normalizedData.recorridos, compactNumero);
        if (recorridos.length === 0) continue;

        const lineData = { ...normalizedData, recorridos };
        writeTimedCache(cache, cacheKey, lineData, cfg.cacheTtlMs);
        return lineData;
    }

    writeTimedCache(cache, cacheKey, null, cfg.negativeCacheTtlMs);
    return null;
}

function getRecorridoShortName(recorrido) {
    return (recorrido?.route_short_name || recorrido?.routeShortName || recorrido?.short_name || '').toString();
}

// /buscar-linea usa LIKE 'N%' (60 -> 60, 60A, 600...): exacta primero; si no, prefijo con límite.
function selectRecorridosForLine(recorridos, queryToken) {
    const source = Array.isArray(recorridos) ? recorridos : [];
    if (!queryToken) return source;

    const tokenized = source.map(recorrido => ({ recorrido, token: normalizeLineToken(getRecorridoShortName(recorrido)) }));
    if (!tokenized.some(item => item.token)) return source;

    const exact = tokenized.filter(item => item.token === queryToken);
    const selected = exact.length > 0
        ? exact
        : tokenized.filter(item => matchesLineToken(item.token, queryToken));
    return selected.map(item => item.recorrido);
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
    const renderedStopKeys = new Set();

    recorridos.forEach((recorrido, index) => {
        const coords = getShapePointsFromRecorrido(recorrido);
        if (coords.length < 2) return;

        const hue = (index * 67) % 360;
        const color = `hsl(${hue}, 85%, 48%)`;

        L.polyline(coords, {
            color: color,
            weight: 4,
            opacity: 0.78,
            lineCap: 'round',
            lineJoin: 'round'
        }).addTo(layers.busRoute);

        const stops = Array.isArray(recorrido?.stops) 
            ? recorrido.stops 
            : (Array.isArray(recorrido?.paradas) ? recorrido.paradas : []);

        stops.forEach(stop => {
            const parsedStop = parseLatLon(stop);
            if (!parsedStop) return;

            const stopKey = `${parsedStop.lat.toFixed(5)},${parsedStop.lon.toFixed(5)}`;
            if (renderedStopKeys.has(stopKey)) return;
            renderedStopKeys.add(stopKey);

            L.circleMarker([parsedStop.lat, parsedStop.lon], {
                radius: 4,
                color: '#1d4ed8',
                fillColor: '#60a5fa',
                fillOpacity: 0.95,
                weight: 1
            })
                .bindTooltip(escapeHtml(stop?.name || stop?.nombre || 'Parada'), {
                    className: 'custom-tooltip',
                    direction: 'top',
                    offset: [0, -6],
                    opacity: 0.95
                })
                .addTo(layers.busStops);
        });
    });
}

function hasValidRouteShape(routeData, anchorCoordinates) {
    const cfg = getBusRouteConfig();
    const shape = Array.isArray(routeData?.shape) ? routeData.shape : [];
    const shapeSize = shape.length;
    if (shapeSize < getMinShapePointsFor(routeData, cfg)) return false;

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

function scoreRecorridoForVehicle(recorrido, selectedVehicle, anchorCoordinates, cfg) {
    const unscored = { score: Number.POSITIVE_INFINITY, distance: Number.POSITIVE_INFINITY };
    const shape = shapeFromRecorrido(recorrido);
    if (shape.length < getMinShapePointsFor(recorrido, cfg)) return unscored;

    const distance = getMinDistanceToShapeMeters(shape, anchorCoordinates);
    if (!Number.isFinite(distance)) return unscored;

    const selectedHeadsign = normalizeHeadsign(selectedVehicle?.trip_headsign);
    const recorridoHeadsign = normalizeHeadsign(recorrido?.trip_headsign);

    let score = distance;
    if (selectedHeadsign && recorridoHeadsign) {
        if (selectedHeadsign === recorridoHeadsign) score -= 300;
        else if (selectedHeadsign.includes(recorridoHeadsign) || recorridoHeadsign.includes(selectedHeadsign)) score -= 120;
    }

    return { score, distance };
}

function pickBestRecorridoForVehicle(recorridos, selectedVehicle, anchorCoordinates) {
    const cfg = getBusRouteConfig();
    let best = null;
    let bestScore = Number.POSITIVE_INFINITY;
    let bestDistance = Number.POSITIVE_INFINITY;

    recorridos.forEach(recorrido => {
        const { score, distance } = scoreRecorridoForVehicle(recorrido, selectedVehicle, anchorCoordinates, cfg);
        if (score < bestScore) {
            best = recorrido;
            bestScore = score;
            bestDistance = distance;
        }
    });

    if (!best || bestDistance > cfg.maxShapeDistanceMeters) return null;
    const shape = shapeFromRecorrido(best);

    return {
        info: {
            route_short_name: best?.route_short_name || best?.routeShortName || best?.short_name || getVehicleShortName(selectedVehicle) || '',
            trip_headsign: best?.trip_headsign || selectedVehicle?.trip_headsign || '',
            source: 'buscar-linea',
            fromStatic: best?.source === 'static'
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
    if (!isFeatureEnabled('busRouteOverlay')) {
        clearBusRouteLayers();
        return;
    }

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
    if (!isFeatureEnabled('busLineSearchOverlay')) {
        clearBusRouteLayers();
        return;
    }

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
    const routeOverlayEnabled = isFeatureEnabled('busRouteOverlay');
    const lineSearchEnabled = isFeatureEnabled('busLineSearchOverlay');

    const busContextActive = activeTypes.bus || !!globalThis.nearbyState?.active;

    if (!busContextActive || (!routeOverlayEnabled && !lineSearchEnabled)) {
        globalThis.markerState.selectedBusVehicleKey = '';
        clearBusRouteLayers();
        return;
    }

    const normalizedQuery = normalizeText(filterQuery);
    if (normalizedQuery) {
        const searchedVehicle = routeOverlayEnabled
            ? findVehicleForBusSearch(filterQuery, globalThis.cache.bus)
            : null;
        if (searchedVehicle) {
            globalThis.markerState.selectedBusVehicleKey = getVehicleUniqueKey(searchedVehicle);
            await updateSelectedBusOverlay(searchedVehicle);
            return;
        }

        globalThis.markerState.selectedBusVehicleKey = '';
        if (!lineSearchEnabled) {
            clearBusRouteLayers();
            return;
        }
        await updateLineSearchOverlay(filterQuery);
        return;
    }

    // Sin búsqueda, el recorrido de un colectivo solo se muestra mientras su popup está abierto.
    const selectedKey = globalThis.markerState.selectedBusVehicleKey;
    const selectedVehicle = selectedKey && selectedKey === globalThis.markerState.openBusPopupKey
        ? findVehicleByKey(selectedKey, globalThis.cache.bus)
        : null;
    if (selectedVehicle && routeOverlayEnabled) {
        await updateSelectedBusOverlay(selectedVehicle);
        return;
    }

    globalThis.markerState.selectedBusVehicleKey = '';
    if (!lineSearchEnabled) {
        clearBusRouteLayers();
        return;
    }
    await updateLineSearchOverlay(filterQuery);
}
