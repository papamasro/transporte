// Render incremental: un Map<clave, layer> por capa; se reutilizan instancias entre renders.
const markerStores = {
    bus: new Map(),
    busClusters: new Map(),
    bike: new Map(),
    subteLines: new Map(),
    subteStations: new Map(),
    trainLines: new Map(),
    trainStations: new Map(),
    trainVehicles: new Map()
};

const bikeRoutesRenderState = { source: null, layer: null };

const markerRenderState = {
    debounceTimer: null,
    debounceForce: false,
    pending: false,
    busHiddenByZoom: false
};

function isLayerOverlayOpen(layer) {
    return !!(layer?.isPopupOpen?.() || isLayerTooltipOpen(layer));
}

// options.animate: posición animada por bus-animation.js (solo la capa principal de colectivos).
// Un marker que vuelve al mapa (estaba dentro de una burbuja) se ubica directo, sin animar desde la
// posición vieja.
function upsertKeyedMarker(layerGroup, store, key, lat, lon, label, color, type, data, options = {}) {
    let marker = store.get(key);
    if (marker) {
        const animate = !!options.animate && layerGroup.hasLayer(marker);
        updateMarker(marker, lat, lon, label, color, data, { ...options, animate });
    } else {
        marker = createMarker(lat, lon, label, color, type, data);
        store.set(key, marker);
        if (options.animate) busAnimPlaceNewMarker(marker, key, lat, lon);
    }
    if (!layerGroup.hasLayer(marker)) layerGroup.addLayer(marker);
    return marker;
}

// El layer con popup/tooltip abierto nunca se quita mientras siga abierto: se poda al cerrarse.
function pruneKeyedLayers(layerGroup, store, seenKeys) {
    store.forEach((layer, key) => {
        if (seenKeys.has(key)) return;
        if (layerGroup?.hasLayer(layer) && isLayerOverlayOpen(layer)) {
            markerRenderState.pending = true;
            return;
        }
        layerGroup?.removeLayer(layer);
        store.delete(key);
    });
}

function upsertKeyedPolyline(layerGroup, store, key, coords, style) {
    const signature = `${style.color}|${coords.length}|${coords[0]}|${coords.at(-1)}`;
    let polyline = store.get(key);
    if (polyline && polyline._transitSignature !== signature) {
        layerGroup.removeLayer(polyline);
        polyline = null;
    }
    if (!polyline) {
        polyline = L.polyline(coords, style);
        polyline._transitSignature = signature;
        store.set(key, polyline);
    }
    if (!layerGroup.hasLayer(polyline)) layerGroup.addLayer(polyline);
}

function matchesBusLineFilter(vehicle, filterToken) {
    return matchesLineToken(normalizeLineToken(getVehicleRouteShortNameForSearch(vehicle)), filterToken);
}

// Sin búsqueda, debajo de POLLING.busMinZoom no se dibujan colectivos (y bootstrap no los pide).
function getBusMinZoom() {
    const value = Number(globalThis.APP_CONFIG?.POLLING?.busMinZoom);
    return Number.isFinite(value) ? value : 0;
}

function isBusZoomTooLow(filter) {
    return !filter && !!map && map.getZoom() < getBusMinZoom();
}

function getBusClusterConfig() {
    const cfg = globalThis.APP_CONFIG?.BUS_CLUSTER || {};
    const num = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
    return {
        enabled: cfg.enabled !== false,
        chipsFromZoom: num(cfg.chipsFromZoom, 15),
        cellSizePx: Math.max(16, num(cfg.cellSizePx, 64)),
        minClusterSize: Math.max(2, num(cfg.minClusterSize, 2)),
        filterCellSizePx: Math.max(16, num(cfg.filterCellSizePx, 44)),
        filterMinClusterSize: Math.max(2, num(cfg.filterMinClusterSize, 8)),
        chipAreaPx: Math.max(0, num(cfg.chipAreaPx, 2000)),
        denseMaxZoom: num(cfg.denseMaxZoom, 17)
    };
}

// Tope de chips para el tamaño del mapa: por encima, aunque el zoom alcance se sigue agrupando.
// count incluye el margen de renderMarkers (bounds.pad(0.1)): el área se agranda igual.
function isBusChipDensityTooHigh(cfg, count, zoom) {
    if (!cfg.chipAreaPx || zoom >= cfg.denseMaxZoom) return false;
    const size = map.getSize();
    return count > Math.floor((size.x * 1.2 * size.y * 1.2) / cfg.chipAreaPx);
}

// null = todos los colectivos como chip (zoom suficiente o agrupado apagado).
function getBusClusterGrid(filter, zoom, count) {
    const cfg = getBusClusterConfig();
    if (!cfg.enabled) return null;
    if (zoom >= cfg.chipsFromZoom && !isBusChipDensityTooHigh(cfg, count, zoom)) return null;
    const maxZoom = Math.max(cfg.chipsFromZoom, Math.min(cfg.denseMaxZoom, Math.floor(zoom) + 2));
    return filter
        ? { cellSizePx: cfg.filterCellSizePx, minSize: cfg.filterMinClusterSize, maxZoom }
        : { cellSizePx: cfg.cellSizePx, minSize: cfg.minClusterSize, maxZoom };
}

function getBusClusterLayer() {
    if (!layers.busClusters && map) layers.busClusters = L.layerGroup().addTo(map);
    return layers.busClusters;
}

function getBusClusterSize(count) {
    if (count < 10) return 30;
    if (count < 50) return 36;
    if (count < 200) return 42;
    return 50;
}

function formatBusClusterCount(count) {
    if (count < 1000) return String(count);
    return `${(count / 1000).toFixed(count >= 10000 ? 0 : 1).replace('.', ',')}k`;
}

function buildBusClusterIcon(count) {
    const size = getBusClusterSize(count);
    return L.divIcon({
        className: 'bus-cluster-icon',
        html: `<div class="bus-cluster" style="width:${size}px;height:${size}px">${formatBusClusterCount(count)}</div>`,
        iconSize: [size, size],
        iconAnchor: [size / 2, size / 2]
    });
}

// El icono se recrea al cambiar el total: role/aria-label van en cada elemento nuevo.
function applyBusClusterA11y(marker) {
    const element = marker.getElement();
    if (!element) return;
    element.setAttribute('role', 'button');
    element.setAttribute('aria-label', `${marker._clusterCount} colectivos. Acercar el mapa`);
}

function zoomToBusCluster(marker) {
    const bounds = marker._clusterBounds;
    if (!map || !bounds?.isValid()) return;
    const insets = typeof getMapObscuredInsets === 'function' ? getMapObscuredInsets() : { top: 0, bottom: 0 };
    const maxZoom = Math.max(marker._clusterMaxZoom || 15, Math.floor(map.getZoom()) + 1);
    map.fitBounds(bounds, {
        paddingTopLeft: [48, 48 + (insets.top || 0)],
        paddingBottomRight: [48, 48 + (insets.bottom || 0)],
        maxZoom,
        animate: !prefersReducedMotion()
    });
}

function upsertBusClusterMarker(key, members, maxZoom) {
    const store = markerStores.busClusters;
    let latSum = 0;
    let lonSum = 0;
    const latLngs = members.map(item => {
        latSum += item.lat;
        lonSum += item.lon;
        return [item.lat, item.lon];
    });
    const lat = latSum / members.length;
    const lon = lonSum / members.length;
    const count = members.length;

    let marker = store.get(key);
    if (marker) {
        const current = marker.getLatLng();
        if (current.lat !== lat || current.lng !== lon) marker.setLatLng([lat, lon]);
        if (marker._clusterCount !== count) {
            marker._clusterCount = count;
            marker.setIcon(buildBusClusterIcon(count));
            applyBusClusterA11y(marker);
        }
    } else {
        marker = L.marker([lat, lon], { icon: buildBusClusterIcon(count), title: `${count} colectivos`, riseOnHover: true });
        marker._clusterCount = count;
        marker.on('add', () => applyBusClusterA11y(marker));
        marker.on('click', event => {
            L.DomEvent.stopPropagation(event);
            zoomToBusCluster(marker);
        });
        store.set(key, marker);
    }
    marker._clusterBounds = L.latLngBounds(latLngs);
    marker._clusterMaxZoom = maxZoom;
    const layer = getBusClusterLayer();
    if (layer && !layer.hasLayer(marker)) layer.addLayer(marker);
}

// Grilla en píxeles del mundo (map.project): las celdas no cambian al desplazar el mapa, solo con el
// zoom, así que en cada refresh se reutilizan las mismas burbujas (sin parpadeo). El colectivo con
// popup/tooltip abierto o seleccionado nunca se agrupa. Devuelve los que van como chip individual.
function clusterBusItems(items, grid, seenClusterKeys) {
    const store = markerStores.bus;
    const zoom = map.getZoom();
    const zoomKey = Math.round(zoom * 100);
    const pinnedKeys = new Set([globalThis.markerState?.openBusPopupKey, globalThis.markerState?.selectedBusVehicleKey].filter(Boolean));
    const cells = new Map();
    const individual = [];

    for (const item of items) {
        const existing = store.get(item.key);
        if (pinnedKeys.has(item.key) || (existing && layers.bus.hasLayer(existing) && isLayerOverlayOpen(existing))) {
            individual.push(item);
            continue;
        }
        const point = map.project([item.lat, item.lon], zoom);
        const cellKey = `${zoomKey}:${Math.floor(point.x / grid.cellSizePx)}:${Math.floor(point.y / grid.cellSizePx)}`;
        const cell = cells.get(cellKey);
        if (cell) cell.push(item);
        else cells.set(cellKey, [item]);
    }

    cells.forEach((members, cellKey) => {
        if (members.length < grid.minSize) {
            individual.push(...members);
            return;
        }
        seenClusterKeys.add(cellKey);
        upsertBusClusterMarker(cellKey, members, grid.maxZoom);
        members.forEach(item => {
            const marker = store.get(item.key);
            if (!marker || !layers.bus.hasLayer(marker)) return;
            layers.bus.removeLayer(marker);
            busAnimForget(marker);
        });
    });

    return individual;
}

function renderBusLayer(filter, bounds) {
    const store = markerStores.bus;
    const seenKeys = new Set();
    const seenClusterKeys = new Set();
    let visibleCount = 0;
    markerRenderState.busHiddenByZoom = false;

    if (activeTypes.bus && isTransportTypeEnabled('bus') && isBusZoomTooLow(filter)) {
        markerRenderState.busHiddenByZoom = true;
    } else if (activeTypes.bus && isTransportTypeEnabled('bus')) {
        const filterToken = filter ? normalizeLineToken(filter) : '';
        const vehicles = Array.isArray(globalThis.cache.bus) ? globalThis.cache.bus : [];
        const items = [];

        for (let index = 0; index < vehicles.length; index++) {
            const vehicle = vehicles[index];
            if (filter && (!filterToken || !matchesBusLineFilter(vehicle, filterToken))) continue;

            const coords = getVehicleCoordinates(vehicle);
            if (!coords) continue;
            if (!filter && !bounds.contains([coords.lat, coords.lon])) continue;

            const key = getVehicleUniqueKey(vehicle) || `idx:${index}`;
            if (seenKeys.has(key)) continue;
            seenKeys.add(key);
            items.push({ key, vehicle, lat: coords.lat, lon: coords.lon });
        }

        visibleCount = items.length;
        const grid = getBusClusterGrid(filter, map.getZoom(), items.length);
        const individual = grid ? clusterBusItems(items, grid, seenClusterKeys) : items;
        for (const item of individual) {
            const line = getBusDisplayLine(item.vehicle);
            upsertKeyedMarker(layers.bus, store, item.key, item.lat, item.lon, line, getColor('bus', line), 'bus', item.vehicle, { animate: true });
        }
    }

    pruneKeyedLayers(layers.bus, store, seenKeys);
    pruneKeyedLayers(layers.busClusters, markerStores.busClusters, seenClusterKeys);
    return visibleCount;
}

function renderBikeRoutesLayer() {
    const featureEnabled = isTransportTypeEnabled('bike') && isFeatureEnabled('bikeRoutes');
    const bikeRoutes = (featureEnabled && activeTypes.bike) ? globalThis.cache.bikeRoutes : null;
    const state = bikeRoutesRenderState;

    if (!bikeRoutes?.features?.length) {
        layers.bikeRoutes.clearLayers();
        state.source = null;
        state.layer = null;
        return;
    }

    // El GeoJSON es estático: solo se reconstruye si cambia la fuente o se limpió la capa.
    if (state.source === bikeRoutes && state.layer && layers.bikeRoutes.hasLayer(state.layer)) return;

    layers.bikeRoutes.clearLayers();
    state.source = bikeRoutes;
    state.layer = L.geoJSON(bikeRoutes, {
        style: () => ({
            color: '#22c55e',
            weight: 2.5,
            opacity: 0.6,
            lineCap: 'round',
            lineJoin: 'round'
        })
    }).addTo(layers.bikeRoutes);
}

function renderBikeLayer(filter, bounds) {
    const store = markerStores.bike;
    const seenKeys = new Set();
    let visibleCount = 0;
    const stationsEnabled = isTransportTypeEnabled('bike') && isFeatureEnabled('bikeStations');

    if (stationsEnabled && activeTypes.bike) {
        globalThis.cache.bike.forEach(s => {
            if (filter && !normalizeText(s.name).includes(filter)) return;
            const lat = Number.parseFloat(s.lat);
            const lon = Number.parseFloat(s.lon);
            if (Number.isNaN(lat) || Number.isNaN(lon) || !bounds.contains([lat, lon])) return;

            const key = (s.station_id ?? `${lat},${lon}`).toString();
            if (seenKeys.has(key)) return;
            seenKeys.add(key);

            const bikesCount = s.num_bikes_available;
            const markerColor = bikesCount === 0 ? '#ef4444' : '#10b981';
            const labelText = bikesCount === 0 ? 'Sin 🚲' : `🚲 ${bikesCount}`;

            upsertKeyedMarker(layers.bike, store, key, lat, lon, labelText, markerColor, 'bike', s);
            visibleCount++;
        });
    }

    pruneKeyedLayers(layers.bike, store, seenKeys);
    return visibleCount;
}

function renderSubteLayer(filter, bounds) {
    const stationStore = markerStores.subteStations;
    const lineStore = markerStores.subteLines;
    const seenStationKeys = new Set();
    const seenLineKeys = new Set();
    let visibleCount = 0;
    if (isTransportTypeEnabled('subte') && activeTypes.subte) {
        const subteLines = globalThis.cache.subteStatic?.lines || {};
        const subteStations = globalThis.cache.subteStatic?.stations || {};
        const filterToken = filter ? normalizeLineToken(filter) : '';

        Object.entries(subteLines).forEach(([routeId, line]) => {
            const routeFilterMatch = !filter || (!!filterToken && (
                matchesLineToken(normalizeLineToken(routeId), filterToken)
                || matchesLineToken(normalizeLineToken(line.short), filterToken)
            ));

            const stationItems = line.stations
                .map(stopId => {
                    const station = subteStations[stopId];
                    if (!station) return null;
                    return { id: stopId, ...station, lineShort: line.short, routeId };
                })
                .filter(Boolean);

            const hasStationMatch = stationItems.some(s => normalizeText(s.name).includes(filter));
            if (!routeFilterMatch && !hasStationMatch) return;

            const polyCoords = stationItems.map(s => [s.lat, s.lon]);
            if (polyCoords.length >= 2) {
                seenLineKeys.add(routeId);
                upsertKeyedPolyline(layers.subteLines, lineStore, routeId, polyCoords, {
                    color: line.color,
                    weight: 5,
                    opacity: 0.8,
                    lineCap: 'round',
                    lineJoin: 'round'
                });
            }

            stationItems.forEach(station => {
                if (!bounds.contains([station.lat, station.lon])) return;
                const key = `${routeId}:${station.id}`;
                if (seenStationKeys.has(key)) return;
                seenStationKeys.add(key);

                upsertKeyedMarker(layers.subteStations, stationStore, key, station.lat, station.lon, station.name, line.color, 'subte', station);
                visibleCount++;
            });
        });
    }

    pruneKeyedLayers(layers.subteLines, lineStore, seenLineKeys);
    pruneKeyedLayers(layers.subteStations, stationStore, seenStationKeys);
    return visibleCount;
}

function buildLiveTrainIcon(color, etaText) {
    return L.divIcon({
        className: 'train-vehicle-marker',
        html: `
            <div class="train-moving-badge animate-pulse" style="border: 2px solid ${safeCssColor(color, '#0284c7')};">
                🚆 <span class="font-black text-[9px] text-white">${escapeHtml(etaText)}</span>
            </div>
        `,
        iconSize: [52, 24],
        iconAnchor: [26, 12]
    });
}

function buildLiveTrainTooltip(info) {
    return `
        <div class="tooltip-dark p-2.5 rounded-xl shadow-lg min-w-[160px]">
            <div class="text-[10px] font-black text-white flex items-center gap-1.5">
                <span>🚆 Tren ${escapeHtml(info.lineLabel)}</span>
            </div>
            <div class="text-[9px] text-cyan-400 font-bold mt-0.5">Destino: ${escapeHtml(info.destino || 'Sin destino')}</div>
            <div class="text-[8px] text-slate-300 mt-1">Hacia: ${escapeHtml(info.stationName)} (${escapeHtml(info.etaText)})</div>
            <div class="text-[7px] text-slate-400 mt-0.5">Andén: ${escapeHtml(info.plataforma || '-')}</div>
        </div>
    `;
}

function upsertLiveTrainMarker(key, lat, lon, info) {
    const store = markerStores.trainVehicles;
    const signature = `${info.color}|${info.etaText}`;
    let marker = store.get(key);

    if (marker) {
        marker._liveTrain = info;
        const current = marker.getLatLng();
        if (current.lat !== lat || current.lng !== lon) marker.setLatLng([lat, lon]);
        if (marker._transitSignature !== signature) {
            marker._transitSignature = signature;
            marker.setIcon(buildLiveTrainIcon(info.color, info.etaText));
        }
        if (isLayerTooltipOpen(marker)) marker.getTooltip().update();
    } else {
        marker = L.marker([lat, lon], { icon: buildLiveTrainIcon(info.color, info.etaText) });
        marker._liveTrain = info;
        marker._transitSignature = signature;
        marker.bindTooltip(layer => buildLiveTrainTooltip(layer._liveTrain), { className: 'custom-tooltip', direction: 'top', offset: [0, -12] });
        store.set(key, marker);
    }

    if (!layers.trainVehicles.hasLayer(marker)) layers.trainVehicles.addLayer(marker);
}

function renderTrainVehicles(trainLines, trainStations, bounds, seenKeys) {
    if (!layers.trainVehicles) return 0;
    let visibleCount = 0;

    // Render de formaciones de trenes visuales en base a arribos reportados
    const arrivalsByStation = globalThis.cache.trainArrivalsByStation || {};
    const claimedKeys = new Set();
    const nowTs = Math.floor(Date.now() / 1000);

    Object.entries(trainLines).forEach(([lineId, line]) => {
        const stationItems = (line.stations || [])
            .map(stopId => {
                const station = trainStations[stopId];
                if (!station) return null;
                return { ...station, id: station.id || stopId };
            })
            .filter(Boolean);
        if (stationItems.length < 2) return;

        for (let i = 0; i < stationItems.length; i++) {
            const station = stationItems[i];
            const stationKey = station.id || station.stationId || station.name;
            const arrivalData = arrivalsByStation[stationKey]?.data;
            const arrivals = Array.isArray(arrivalData?.arrivals) ? arrivalData.arrivals : [];

            arrivals.forEach(arr => {
                const estimatedTs = Number(arr.estimatedArrivalTs);
                const eta = Number.isFinite(estimatedTs) && estimatedTs > 0
                    ? estimatedTs - nowTs
                    : Number(arr.etaSeconds);
                if (!Number.isFinite(eta) || eta < 0 || eta > 900) return;

                const trainKey = `${lineId}::${arr.destino || ''}::${Math.floor(eta / 120)}`;
                if (claimedKeys.has(trainKey)) return;
                claimedKeys.add(trainKey);

                let trainLat = station.lat;
                let trainLon = station.lon;

                if (eta > 60 && i > 0) {
                    const prevStation = stationItems[i - 1];
                    const progress = Math.min(0.85, Math.max(0.15, 1 - (eta / 600)));
                    trainLat = prevStation.lat + (station.lat - prevStation.lat) * progress;
                    trainLon = prevStation.lon + (station.lon - prevStation.lon) * progress;
                }

                if (!bounds.contains([trainLat, trainLon])) return;
                seenKeys.add(trainKey);

                const m = Math.round(eta / 60);
                upsertLiveTrainMarker(trainKey, trainLat, trainLon, {
                    color: line.color,
                    etaText: m <= 0 ? 'Ahora' : `En ${m} min`,
                    lineLabel: line.short || line.name || '',
                    destino: arr.destino,
                    plataforma: arr.plataforma,
                    stationName: station.name
                });
                visibleCount++;
            });
        }
    });

    return visibleCount;
}

function renderTrainLayer(filter, bounds) {
    const stationStore = markerStores.trainStations;
    const lineStore = markerStores.trainLines;
    const seenStationKeys = new Set();
    const seenLineKeys = new Set();
    const seenVehicleKeys = new Set();
    let visibleCount = 0;
    if (isTransportTypeEnabled('train') && activeTypes.train) {
        const trainStatic = globalThis.cache.trainStatic || {};
        const trainLines = trainStatic?.lines || {};
        const trainStations = trainStatic?.stations || {};
        const filterToken = filter ? normalizeLineToken(filter) : '';

        Object.entries(trainLines).forEach(([lineId, line]) => {
            const routeFilterMatch = !filter
                || (!!filterToken && (
                    matchesLineToken(normalizeLineToken(lineId), filterToken)
                    || matchesLineToken(normalizeLineToken(line.short || ''), filterToken)
                ))
                || normalizeText(line.name || '').includes(filter);

            const stationItems = (line.stations || [])
                .map(stopId => {
                    const station = trainStations[stopId];
                    if (!station) return null;
                    return {
                        ...station,
                        id: station.id || stopId,
                        lineId,
                        lineShort: station.lineShort || line.short,
                        lineName: station.lineName || line.name,
                        color: line.color || '#0ea5e9'
                    };
                })
                .filter(Boolean);

            const hasStationMatch = stationItems.some(s => normalizeText(s.name).includes(filter));
            if (!routeFilterMatch && !hasStationMatch) return;

            const polyCoords = stationItems.map(s => [s.lat, s.lon]);
            if (polyCoords.length >= 2) {
                seenLineKeys.add(lineId);
                upsertKeyedPolyline(layers.trainLines, lineStore, lineId, polyCoords, {
                    color: line.color || '#0ea5e9',
                    weight: 4,
                    opacity: 0.85,
                    lineCap: 'round',
                    lineJoin: 'round'
                });
            }

            stationItems.forEach(station => {
                if (!bounds.contains([station.lat, station.lon])) return;
                const key = `${lineId}:${station.id}`;
                if (seenStationKeys.has(key)) return;
                seenStationKeys.add(key);

                upsertKeyedMarker(layers.trainStations, stationStore, key, station.lat, station.lon, station.name, station.color || '#0ea5e9', 'train', station);
                visibleCount++;
            });
        });

        visibleCount += renderTrainVehicles(trainLines, trainStations, bounds, seenVehicleKeys);
    }

    pruneKeyedLayers(layers.trainLines, lineStore, seenLineKeys);
    pruneKeyedLayers(layers.trainStations, stationStore, seenStationKeys);
    pruneKeyedLayers(layers.trainVehicles, markerStores.trainVehicles, seenVehicleKeys);
    return visibleCount;
}

function scheduleRenderMarkers(delayMs = 100, options = {}) {
    markerRenderState.debounceForce = markerRenderState.debounceForce || !!options.force;
    clearTimeout(markerRenderState.debounceTimer);
    markerRenderState.debounceTimer = setTimeout(() => {
        const force = markerRenderState.debounceForce;
        markerRenderState.debounceTimer = null;
        markerRenderState.debounceForce = false;
        renderMarkers({ force });
    }, delayMs);
}

// Tras cerrar un popup se poda el marker que quedó vivo solo por estar abierto.
function handleMarkerPopupClose() {
    if (markerRenderState.pending) scheduleRenderMarkers(100);
}

// Evita que la transición CSS de los iconos (p.ej. .nearby-live-bus-icon) los arrastre durante el zoom.
function setupMarkerZoomTransitionGuard() {
    if (!map || map._transitZoomGuardReady) return;
    map._transitZoomGuardReady = true;

    const container = map.getContainer();
    const transitionedIconSelector = '.leaflet-marker-icon.nearby-live-bus-icon';
    let releaseFrame = 0;

    map.on('zoomstart', () => {
        cancelAnimationFrame(releaseFrame);
        container.classList.add('map-zooming');
        container.querySelectorAll(transitionedIconSelector).forEach(el => { el.style.transition = 'none'; });
    });

    map.on('zoomend', () => {
        cancelAnimationFrame(releaseFrame);
        // Doble rAF: la nueva posición ya quedó aplicada antes de devolver la transición.
        releaseFrame = requestAnimationFrame(() => {
            releaseFrame = requestAnimationFrame(() => {
                container.classList.remove('map-zooming');
                container.querySelectorAll(transitionedIconSelector).forEach(el => { el.style.transition = ''; });
            });
        });
    });
}

function renderMarkers(options = {}) {
    if (!map || !globalThis.cache) return;
    markerRenderState.pending = false;

    const searchValue = document.getElementById('search').value || '';
    const filter = normalizeText(searchValue);
    const bounds = map.getBounds().pad(0.1);

    renderBikeRoutesLayer();

    const visibleCount =
        renderBusLayer(filter, bounds)
        + renderBikeLayer(filter, bounds)
        + renderSubteLayer(filter, bounds)
        + renderTrainLayer(filter, bounds);

    // El filtro de marcadores sigue al texto en vivo (local); el recorrido (red) solo a la búsqueda
    // confirmada (Enter, sugerencia o link).
    updateBusRouteOverlay(getCommittedSearchQuery()).catch(() => {});

    const mapContainer = document.getElementById('map');
    if (visibleCount > 1500) {
        mapContainer.classList.add('hide-labels');
    } else {
        mapContainer.classList.remove('hide-labels');
    }

    setMapStatusCount(visibleCount, markerRenderState.busHiddenByZoom);
    scheduleFavoritesRender();
}
