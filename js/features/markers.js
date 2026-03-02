function renderBusLayer(filter, bounds) {
    let visibleCount = 0;
    if (!activeTypes.bus) return visibleCount;

    globalThis.cache.bus.forEach(v => {
        const line = getBusDisplayLine(v);

        const matchesFilter = !filter || (
            normalizeText(line) === filter
            || normalizeText(v?.route_short_name || '') === filter
            || normalizeText(getVehicleRouteId(v)) === filter
            || normalizeText(getVehicleTripId(v)) === filter
            || normalizeText(v?.id || v?.vehicle?.id || '') === filter
            || normalizeText(v?.agency_name || '') === filter
            || normalizeText(v?.trip_headsign || '') === filter
        );
        if (!matchesFilter) return;

        const coords = getVehicleCoordinates(v);
        if (coords && bounds.contains([coords.lat, coords.lon])) {
            createMarker(coords.lat, coords.lon, line, getColor('bus', line), 'bus', v).addTo(layers.bus);
            visibleCount++;
        }
    });

    return visibleCount;
}

function renderBikeLayer(filter, bounds) {
    let visibleCount = 0;
    if (!activeTypes.bike) return visibleCount;

    globalThis.cache.bike.forEach(s => {
        if (filter && normalizeText(s.name) !== filter) return;
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
        const routeFilterMatch = !filter || normalizeText(routeId) === filter || normalizeText(line.short) === filter;

        const stationItems = line.stations
            .map(stopId => {
                const station = subteStations[stopId];
                if (!station) return null;
                return { id: stopId, ...station, lineShort: line.short, routeId };
            })
            .filter(Boolean);

        const hasStationMatch = stationItems.some(s => normalizeText(s.name) === filter);
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
            if (filter && normalizeText(station.name) !== filter && !routeFilterMatch && !hasStationMatch) return;
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
            || normalizeText(lineId) === filter
            || normalizeText(line.short || '') === filter
            || normalizeText(line.name || '') === filter
            || normalizeText(line.concession || '') === filter;

        const stationItems = (line.stations || [])
            .map(stopId => trainStations[stopId])
            .filter(Boolean);

        const hasStationMatch = stationItems.some(s =>
            normalizeText(s.name) === filter
            || normalizeText(s.concession || '') === filter
        );
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
            if (filter && normalizeText(station.name) !== filter && !routeFilterMatch && !hasStationMatch) return;
            if (!bounds.contains([station.lat, station.lon])) return;

            createMarker(
                station.lat,
                station.lon,
                station.name,
                line.color || '#0ea5e9',
                'train',
                station
            ).addTo(layers.trainStations);
            visibleCount++;
        });
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
    layers.subteLines.clearLayers();
    layers.subteStations.clearLayers();
    layers.trainLines.clearLayers();
    layers.trainStations.clearLayers();

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
