function renderBusLayer(filter, bounds) {
    let visibleCount = 0;
    if (!activeTypes.bus) return visibleCount;

    globalThis.cache.bus.forEach(v => {
        const line = getBusDisplayLine(v);
        const routeShortName = (v?.route_short_name || v?.vehicle?.trip?.route_short_name || '').toString().trim();
        const normalizedRouteShortName = normalizeText(routeShortName);
        const compactFilter = normalizeLineToken(filter);
        const compactRouteShortName = normalizeLineToken(routeShortName);

        const matchesFilter = !filter || (
            normalizedRouteShortName.includes(filter)
            || (compactFilter && compactRouteShortName.includes(compactFilter))
        );
        if (!matchesFilter) return;

        const coords = getVehicleCoordinates(v);
        const shouldRenderByBounds = !filter;
        if (coords && (!shouldRenderByBounds || bounds.contains([coords.lat, coords.lon]))) {
            createMarker(coords.lat, coords.lon, line, getColor('bus', line), 'bus', v).addTo(layers.bus);
            visibleCount++;
        }
    });

    return visibleCount;
}

function renderBikeRoutesLayer() {
    if (!activeTypes.bike) return;

    const bikeRoutes = globalThis.cache.bikeRoutes;
    if (!bikeRoutes?.features?.length) return;

    L.geoJSON(bikeRoutes, {
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
    let visibleCount = 0;
    if (!activeTypes.bike) return visibleCount;

    globalThis.cache.bike.forEach(s => {
        if (filter && !normalizeText(s.name).includes(filter)) return;
        const lat = Number.parseFloat(s.lat);
        const lon = Number.parseFloat(s.lon);
        if (!Number.isNaN(lat) && !Number.isNaN(lon) && bounds.contains([lat, lon])) {
            const bikesCount = s.num_bikes_available;
            const markerColor = bikesCount === 0 ? '#ef4444' : '#10b981';
            const labelText = bikesCount === 0 ? 'Sin 🚲' : `🚲 ${bikesCount}`;

            createMarker(lat, lon, labelText, markerColor, 'bike', s).addTo(layers.bike);
            visibleCount++;
        }
    });

    return visibleCount;
}

function renderSubteLayer(filter, bounds) {
    let visibleCount = 0;
    if (!activeTypes.subte) return visibleCount;

    const subteLines = globalThis.cache.subteStatic?.lines || {};
    const subteStations = globalThis.cache.subteStatic?.stations || {};

    Object.entries(subteLines).forEach(([routeId, line]) => {
        const routeFilterMatch = !filter
            || normalizeText(routeId).includes(filter)
            || normalizeText(line.short).includes(filter);

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
            L.polyline(polyCoords, {
                color: line.color,
                weight: 5,
                opacity: 0.8,
                lineCap: 'round',
                lineJoin: 'round'
            }).addTo(layers.subteLines);
        }

        stationItems.forEach(station => {
            if (filter && !normalizeText(station.name).includes(filter) && !routeFilterMatch && !hasStationMatch) return;
            if (!bounds.contains([station.lat, station.lon])) return;

            createMarker(
                station.lat,
                station.lon,
                station.name,
                line.color,
                'subte',
                station
            ).addTo(layers.subteStations);
            visibleCount++;
        });
    });

    return visibleCount;
}

function renderTrainLayer(filter, bounds) {
    let visibleCount = 0;
    if (!activeTypes.train) return visibleCount;

    const trainStatic = globalThis.cache.trainStatic || {};
    const trainLines = trainStatic?.lines || {};
    const trainStations = trainStatic?.stations || {};

    Object.entries(trainLines).forEach(([lineId, line]) => {
        const routeFilterMatch = !filter
            || normalizeText(lineId).includes(filter)
            || normalizeText(line.short || '').includes(filter)
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
            L.polyline(polyCoords, {
                color: line.color || '#0ea5e9',
                weight: 4,
                opacity: 0.85,
                lineCap: 'round',
                lineJoin: 'round'
            }).addTo(layers.trainLines);
        }

        stationItems.forEach(station => {
            if (filter && !normalizeText(station.name).includes(filter) && !routeFilterMatch && !hasStationMatch) return;
            if (!bounds.contains([station.lat, station.lon])) return;

            createMarker(
                station.lat,
                station.lon,
                station.name,
                station.color || '#0ea5e9',
                'train',
                station
            ).addTo(layers.trainStations);
            visibleCount++;
        });
    });

    // Render de formaciones de trenes visuales en base a arribos reportados
    const arrivalsByStation = globalThis.cache.trainArrivalsByStation || {};
    const renderedTrainKeys = new Set();

    Object.entries(trainLines).forEach(([lineId, line]) => {
        const stationItems = (line.stations || []).map(id => trainStations[id]).filter(Boolean);
        if (stationItems.length < 2) return;

        for (let i = 0; i < stationItems.length; i++) {
            const station = stationItems[i];
            const stationKey = station.id || station.stationId || station.name;
            const arrivalData = arrivalsByStation[stationKey]?.data;
            const arrivals = Array.isArray(arrivalData?.arribos) ? arrivalData.arribos : [];

            arrivals.forEach(arr => {
                const eta = Number(arr.etaSeconds);
                if (!Number.isFinite(eta) || eta < 0 || eta > 900) return;

                const trainKey = `${lineId}::${arr.destino || ''}::${Math.floor(eta / 120)}`;
                if (renderedTrainKeys.has(trainKey)) return;
                renderedTrainKeys.add(trainKey);

                let trainLat = station.lat;
                let trainLon = station.lon;

                if (eta > 60 && i > 0) {
                    const prevStation = stationItems[i - 1];
                    const progress = Math.min(0.85, Math.max(0.15, 1 - (eta / 600)));
                    trainLat = prevStation.lat + (station.lat - prevStation.lat) * progress;
                    trainLon = prevStation.lon + (station.lon - prevStation.lon) * progress;
                }

                if (!bounds.contains([trainLat, trainLon])) return;

                const m = Math.round(eta / 60);
                const etaText = m <= 0 ? 'Ahora' : `En ${m} min`;
                const trainIcon = L.divIcon({
                    className: 'train-vehicle-marker',
                    html: `
                        <div class="train-moving-badge animate-pulse" style="border: 2px solid ${line.color || '#0284c7'};">
                            🚆 <span class="font-black text-[9px] text-white">${etaText}</span>
                        </div>
                    `,
                    iconSize: [52, 24],
                    iconAnchor: [26, 12]
                });

                const trainMarker = L.marker([trainLat, trainLon], { icon: trainIcon })
                    .bindTooltip(`
                        <div class="tooltip-dark p-2.5 rounded-xl shadow-lg min-w-[160px]">
                            <div class="text-[10px] font-black text-white flex items-center gap-1.5">
                                <span>🚆 Tren ${line.short || line.name || ''}</span>
                            </div>
                            <div class="text-[9px] text-cyan-400 font-bold mt-0.5">Destino: ${arr.destino || 'Sin destino'}</div>
                            <div class="text-[8px] text-slate-300 mt-1">Hacia: ${station.name} (${etaText})</div>
                            <div class="text-[7px] text-slate-400 mt-0.5">Andén: ${arr.plataforma || '-'}</div>
                        </div>
                    `, { className: 'custom-tooltip', direction: 'top', offset: [0, -12] });

                if (layers.trainVehicles) {
                    trainMarker.addTo(layers.trainVehicles);
                    visibleCount++;
                }
            });
        }
    });

    return visibleCount;
}

function renderMarkers() {
    if (!map || !globalThis.cache) return;
    const searchValue = document.getElementById('search').value || '';
    const filter = normalizeText(searchValue);
    const bounds = map.getBounds().pad(0.1);

    layers.bus.clearLayers();
    layers.bike.clearLayers();
    layers.bikeRoutes.clearLayers();
    layers.subteLines.clearLayers();
    layers.subteStations.clearLayers();
    layers.trainLines.clearLayers();
    layers.trainStations.clearLayers();
    layers.trainVehicles?.clearLayers();

    renderBikeRoutesLayer();

    const visibleCount =
        renderBusLayer(filter, bounds)
        + renderBikeLayer(filter, bounds)
        + renderSubteLayer(filter, bounds)
        + renderTrainLayer(filter, bounds);

    updateBusRouteOverlay(searchValue).catch(() => {});

    const mapContainer = document.getElementById('map');
    if (visibleCount > 1500) {
        mapContainer.classList.add('hide-labels');
    } else {
        mapContainer.classList.remove('hide-labels');
    }

    document.getElementById('unit-count').innerText = `${visibleCount} EN VISTA`;
}
