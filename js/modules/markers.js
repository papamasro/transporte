function getStationIconSize(zoom) {
            if (zoom <= 12) return 22;
            if (zoom <= 14) return 20;
            return 18;
        }

        const busRouteCache = new Map();
        const busLineSearchCache = new Map();
        let currentBusRouteKey = '';
        let currentLineOverlayQuery = '';
        let selectedBusVehicleKey = '';
        let busRouteRequestToken = 0;
        let busLineRequestToken = 0;

        function clearBusRouteLayers() {
            layers.busRoute?.clearLayers();
            layers.busStops?.clearLayers();
            currentBusRouteKey = '';
            currentLineOverlayQuery = '';
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
            // Nuevo contrato: usar route_id, tip_id y direction exactos
            if (!routeId) return null;
            const routeKey = `${routeId}::${tipId || ''}`;
            if (busRouteCache.has(routeKey)) return busRouteCache.get(routeKey);

            const params = new URLSearchParams({ route_id: routeId });
            if (tipId) params.set('tip_id', tipId);
            if (direction !== undefined && direction !== null) params.set('direction', direction);

            const response = await fetchAPI(`/info-trayecto?${params.toString()}`);
            if (!response.success || !response.data) return null;

            const shapeSize = Array.isArray(response.data?.shape) ? response.data.shape.length : 0;
            if (shapeSize < 2) return null;

            busRouteCache.set(routeKey, response.data);
            return response.data;
        }

        async function fetchLineSearchInfo(numero) {
            const normalizedNumero = normalizeText(numero);
            if (!normalizedNumero) return null;
            if (busLineSearchCache.has(normalizedNumero)) return busLineSearchCache.get(normalizedNumero);

            const response = await fetchAPI(`/buscar-linea?numero=${encodeURIComponent(numero)}`);
            if (!response.success || !response.data) return null;

            busLineSearchCache.set(normalizedNumero, response.data);
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
            // Usar los campos exactos del objeto colectivo
            const routeId = selectedVehicle?.route_id;
            const tipId = selectedVehicle?.tip_id;
            const direction = selectedVehicle?.direction;

            if (!routeId || !tipId) {
                clearBusRouteLayers();
                return;
            }

            const routeKey = `${routeId}::${tipId}`;
            if (routeKey === currentBusRouteKey && (layers.busRoute?.getLayers()?.length || 0) > 0) return;

            const requestToken = ++busRouteRequestToken;
            try {
                const routeInfo = await fetchRouteInfo(routeId, tipId, direction);
                if (requestToken !== busRouteRequestToken) return;
                if (!routeInfo) {
                    clearBusRouteLayers();
                    return;
                }

                renderBusRouteInfo(routeInfo);
                currentBusRouteKey = `${routeId}::${tipId}`;
                currentLineOverlayQuery = '';
            } catch {
                if (requestToken !== busRouteRequestToken) return;
                clearBusRouteLayers();
            }
        }

        async function updateLineSearchOverlay(rawQuery) {
            const query = normalizeText(rawQuery);
            if (!query) {
                clearBusRouteLayers();
                return;
            }

            if (query === currentLineOverlayQuery && (layers.busRoute?.getLayers()?.length || 0) > 0) return;

            const requestToken = ++busLineRequestToken;
            try {
                const lineInfo = await fetchLineSearchInfo(rawQuery);
                if (requestToken !== busLineRequestToken) return;
                if (!lineInfo || !Array.isArray(lineInfo.recorridos) || lineInfo.recorridos.length === 0) {
                    clearBusRouteLayers();
                    return;
                }

                renderLineSearchOverlay(lineInfo);
                currentLineOverlayQuery = query;
                currentBusRouteKey = '';
            } catch {
                if (requestToken !== busLineRequestToken) return;
                clearBusRouteLayers();
            }
        }

        async function updateBusRouteOverlay(filterQuery) {
            if (!activeTypes.bus) {
                selectedBusVehicleKey = '';
                clearBusRouteLayers();
                return;
            }

            const normalizedQuery = normalizeText(filterQuery);
            if (normalizedQuery) {
                const searchedVehicle = findVehicleForBusSearch(filterQuery, globalThis.cache.bus);
                if (searchedVehicle) {
                    selectedBusVehicleKey = getVehicleUniqueKey(searchedVehicle);
                    await updateSelectedBusOverlay(searchedVehicle);
                    return;
                }

                selectedBusVehicleKey = '';
                await updateLineSearchOverlay(filterQuery);
                return;
            }

            const selectedVehicle = findVehicleByKey(selectedBusVehicleKey, globalThis.cache.bus);
            if (selectedVehicle) {
                await updateSelectedBusOverlay(selectedVehicle);
                return;
            }

            selectedBusVehicleKey = '';
            await updateLineSearchOverlay(filterQuery);
        }

        function buildMarkerHtml(type, label, color, stationIconSize, stationFontSize) {
            if (type === 'bus') {
                return `<div class="marker-container"><div class="v-marker" style="background:${color}; width: 10px; height: 10px;"></div><div class="vehicle-label">${label}</div></div>`;
            }

            if (type === 'bike') {
                return `<div class="marker-container"><div style="width:${stationIconSize}px;height:${stationIconSize}px;border-radius:50%;background:white;border:2px solid ${color};display:flex;align-items:center;justify-content:center;box-shadow:0 2px 4px rgba(0,0,0,0.25);font-size:${stationFontSize}px;">🚲</div><div class="vehicle-label">${label}</div></div>`;
            }

            if (type === 'train') {
                return `<div class="marker-container"><div style="width:${stationIconSize}px;height:${stationIconSize}px;border-radius:6px;background:white;border:2px solid ${color};display:flex;align-items:center;justify-content:center;box-shadow:0 2px 4px rgba(0,0,0,0.25);font-size:${stationFontSize}px;">🚆</div><div class="vehicle-label">${label}</div></div>`;
            }

            return `<div class="marker-container"><div style="width:${stationIconSize}px;height:${stationIconSize}px;border-radius:6px;background:white;border:2px solid ${color};display:flex;align-items:center;justify-content:center;box-shadow:0 2px 4px rgba(0,0,0,0.25);font-size:${stationFontSize}px;">🚇</div><div class="vehicle-label">${label}</div></div>`;
        }

        function buildBusTooltip(data, color, label) {
            const speed = Math.max(0, Math.round((Number(data.speed) || 0) * 3.6));
            const shortName = (data.route_short_name || label || '-').toString();
            const agencyName = data.agency_name || 'Servicio AMBA';
            const agencyDisplay = agencyName.length > 34 ? `${agencyName.slice(0, 34).trim()}…` : agencyName;
            const agencyTitle = agencyName.replaceAll('"', '&quot;');
            const headsign = data.trip_headsign || 'Sin destino';
            return `
                <div class="glass p-3 rounded-2xl shadow-xl border border-white/50 min-w-[220px]">
                    <div class="flex items-center gap-2 mb-2">
                        <div class="w-7 h-7 rounded-lg flex items-center justify-center text-white" style="background: ${color}">
                            <i data-lucide="bus" class="w-4 h-4"></i>
                        </div>
                        <div class="min-w-0">
                            <span class="inline-flex items-center text-[8px] font-black text-indigo-700 bg-indigo-50 border border-indigo-100 rounded-md px-1.5 py-0.5 uppercase tracking-wide">${shortName}</span>
                            <h4 class="text-[10px] font-black text-slate-700 leading-tight mt-1 truncate" title="${agencyTitle}">${agencyDisplay}</h4>
                        </div>
                    </div>
                    <div class="space-y-1.5">
                        <div class="bg-slate-50 p-2 rounded-lg border border-slate-100">
                            <span class="block text-[8px] font-bold text-slate-400 mb-0.5 uppercase tracking-tighter">Hacia</span>
                            <span class="dest-text text-[10px] font-black text-indigo-600 uppercase leading-tight">
                                ${headsign}
                            </span>
                        </div>
                        <div class="flex gap-1.5">
                            <div class="flex-1 bg-slate-50 p-1.5 rounded-lg border border-slate-100 text-center">
                                <span class="block text-[7px] font-bold text-slate-400">SPEED</span>
                                <span class="text-[10px] font-black text-slate-700">${speed} km/h</span>
                            </div>
                            <div class="flex-1 bg-slate-50 p-1.5 rounded-lg border border-slate-100 text-center">
                                <span class="block text-[7px] font-bold text-slate-400">ROUTE</span>
                                <span class="text-[10px] font-black text-indigo-600">${shortName}</span>
                            </div>
                        </div>
                    </div>
                </div>`;
        }

        function buildBikeTooltip(data, color) {
            const bikes = Number(data.num_bikes_available || 0);
            const docks = Number(data.num_docks_available || 0);
            const statusText = bikes === 0 ? 'Sin bicis disponibles' : `${bikes} bicis listas`;

            return `
                <div class="glass p-2.5 rounded-2xl shadow-xl border border-white/50 min-w-[190px]">
                    <div class="flex items-center gap-1.5 mb-1.5">
                        <div class="w-6 h-6 rounded-lg flex items-center justify-center text-white" style="background: ${color}">
                            <i data-lucide="bike" class="w-3.5 h-3.5"></i>
                        </div>
                        <div>
                            <h4 class="text-[10px] font-black text-slate-800 leading-none">${data.name}</h4>
                            <span class="text-[7px] font-bold uppercase tracking-tighter" style="color: ${color};">${statusText}</span>
                        </div>
                    </div>
                    <div class="grid grid-cols-2 gap-1.5">
                        <div class="bg-emerald-50 p-2 rounded-lg border border-emerald-100 text-center" style="border-color: ${color}40; background-color: ${color}10;">
                            <span class="block text-[7px] font-bold" style="color: ${color}">BICIS</span>
                            <span class="text-xs font-black" style="color: ${color}">${bikes}</span>
                        </div>
                        <div class="bg-slate-50 p-2 rounded-lg border border-slate-100 text-center">
                            <span class="block text-[7px] font-bold text-slate-400">BOXES</span>
                            <span class="text-xs font-black text-slate-700">${docks}</span>
                        </div>
                    </div>
                </div>`;
        }

        function buildSubteTooltip(data, color) {
            const referenceTs = globalThis.cache.subteTimestamp || Math.floor(Date.now() / 1000);
            const stationForecast = getSubteStationForecast(data)
                .filter(r => r.arrivalTime > 0)
                .filter(r => r.arrivalTime >= (referenceTs - 60) && r.arrivalTime <= (referenceTs + 7200))
                .sort((a, b) => a.arrivalTime - b.arrivalTime);

            const groupedByDestination = new Map();
            stationForecast.forEach(item => {
                const key = `${item.routeShort}|${item.destination}`;
                if (!groupedByDestination.has(key)) groupedByDestination.set(key, []);
                groupedByDestination.get(key).push(item);
            });

            const rows = Array.from(groupedByDestination.entries())
                .map(([key, items]) => {
                    const [routeShort, destination] = key.split('|');
                    const nextItems = items.slice(0, 2);
                    const etaParts = nextItems.map(r => {
                        const etaText = formatEtaMinutes(r.arrivalTime, referenceTs);
                        return `Llega ${formatTimestamp(r.arrivalTime)} (${etaText})`;
                    }).join(' · ');
                    const maxDelay = Math.max(...nextItems.map(r => r.delay || 0));
                    const tone = getDelayTone(maxDelay);

                    return {
                        firstArrival: nextItems[0]?.arrivalTime || Number.MAX_SAFE_INTEGER,
                        html: `
                            <div class="py-1 border-b border-slate-100 last:border-b-0">
                                <div class="flex items-center justify-between gap-2">
                                    <span class="text-[9px] font-black text-slate-700">Línea ${routeShort}</span>
                                    <span class="text-[8px] font-bold border rounded-md px-1.5 py-0.5 ${tone.badgeClass}">${formatDelay(maxDelay)}</span>
                                </div>
                                <div class="text-[9px] font-bold text-indigo-600 leading-tight">Hacia ${destination}</div>
                                <div class="text-[8px] font-mono text-slate-500">${etaParts}</div>
                            </div>`
                    };
                })
                .sort((a, b) => a.firstArrival - b.firstArrival)
                .slice(0, 4)
                .map(item => item.html)
                .join('');

            const noData = '<div class="text-[9px] font-medium text-slate-500 py-1">Sin pronóstico para esta estación.</div>';
            const hasDynamic = stationForecast.length > 0;
            const stationWorstDelay = hasDynamic ? Math.max(...stationForecast.map(r => r.delay || 0)) : 0;
            const stationTone = getDelayTone(stationWorstDelay);
            const popupBorderColor = hasDynamic ? stationTone.borderColor : '#e2e8f0';
            const lastUpdateText = globalThis.cache.subteTimestamp
                ? new Date(globalThis.cache.subteTimestamp * 1000).toLocaleTimeString('es-AR', { hour12: false })
                : '--:--:--';

            return `
                <div class="glass p-3 rounded-2xl shadow-xl border min-w-[220px]" style="border-color: ${popupBorderColor}; border-width: 2px;">
                    <div class="flex items-center gap-2 mb-2">
                        <div class="w-7 h-7 rounded-lg flex items-center justify-center text-white" style="background: ${color}">
                            <i data-lucide="train-front" class="w-4 h-4"></i>
                        </div>
                        <div>
                            <h4 class="text-[11px] font-black text-slate-800 leading-none">${data.name}</h4>
                            <span class="text-[7px] font-bold text-slate-400 uppercase tracking-tighter">Línea ${data.lineShort}</span>
                        </div>
                    </div>
                    <div class="bg-slate-50 p-2 rounded-lg border border-slate-100">
                        <span class="block text-[8px] font-bold text-slate-400 mb-1 uppercase tracking-tighter">Próximas llegadas</span>
                        ${rows || noData}
                    </div>
                    <div class="mt-2 pt-2 border-t border-slate-100 text-[8px]">
                        <div class="font-bold text-slate-500">Última actualización: ${lastUpdateText}</div>
                    </div>
                </div>`;
        }

        function buildTrainTooltip(data, color) {
            const lineName = data.lineName || data.lineShort || 'Tren';
            const description = data.description || 'Sin descripción';
            const concession = data.concession || 'Sin dato';
            const gauge = data.gauge || 'Sin dato';
            const latText = Number(data.lat).toFixed(5);
            const lonText = Number(data.lon).toFixed(5);

            return `
                <div class="glass p-3 rounded-2xl shadow-xl border border-white/50 min-w-[230px]">
                    <div class="flex items-center gap-2 mb-2">
                        <div class="w-7 h-7 rounded-lg flex items-center justify-center text-white" style="background: ${color}">
                            <i data-lucide="train-track" class="w-4 h-4"></i>
                        </div>
                        <div>
                            <h4 class="text-[11px] font-black text-slate-800 leading-none">${data.name}</h4>
                            <span class="text-[7px] font-bold text-slate-400 uppercase tracking-tighter">${lineName}</span>
                        </div>
                    </div>
                    <div class="space-y-1.5">
                        <div class="bg-slate-50 p-2 rounded-lg border border-slate-100 text-[9px] font-semibold text-slate-700">${description}</div>
                        <div class="grid grid-cols-2 gap-1.5 text-[8px]">
                            <div class="bg-slate-50 p-1.5 rounded-lg border border-slate-100">
                                <span class="block font-bold text-slate-400 uppercase">Concesión</span>
                                <span class="font-black text-slate-700">${concession}</span>
                            </div>
                            <div class="bg-slate-50 p-1.5 rounded-lg border border-slate-100">
                                <span class="block font-bold text-slate-400 uppercase">Trocha</span>
                                <span class="font-black text-slate-700">${gauge}</span>
                            </div>
                        </div>
                        <div class="text-[8px] font-mono text-slate-500">${latText}, ${lonText}</div>
                    </div>
                </div>`;
        }

        function buildTooltipHtml(type, data, color, label) {
            if (type === 'bus' && data) return buildBusTooltip(data, color, label);
            if (type === 'bike' && data) return buildBikeTooltip(data, color);
            if (type === 'subte' && data) return buildSubteTooltip(data, color);
            if (type === 'train' && data) return buildTrainTooltip(data, color);
            return '';
        }

        function createMarker(lat, lng, label, color, type, data = null) {
            const zoom = map?.getZoom?.() || 14;
            const stationIconSize = getStationIconSize(zoom);
            const stationFontSize = zoom <= 12 ? 13 : 11;
            const markerBoxSize = type === 'bus' ? 20 : stationIconSize + 8;
            const markerHtml = buildMarkerHtml(type, label, color, stationIconSize, stationFontSize);

            const marker = L.marker([lat, lng], {
                icon: L.divIcon({
                    className: '',
                    html: markerHtml,
                    iconSize: [markerBoxSize, markerBoxSize],
                    iconAnchor: [Math.round(markerBoxSize / 2), Math.round(markerBoxSize / 2)]
                })
            });

            const tooltipHtml = buildTooltipHtml(type, data, color, label);

            marker.bindTooltip(tooltipHtml, {
                className: 'custom-tooltip',
                direction: 'top',
                offset: [0, -10],
                opacity: 1
            });

            if (type === 'bus' && data) {
                marker.on('click', () => {
                    selectedBusVehicleKey = getVehicleUniqueKey(data);
                    void updateBusRouteOverlay('');
                });
            }

            marker.on('tooltipopen', () => lucide.createIcons());
            return marker;
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

            let visibleCount = 0;

            if (activeTypes.bus) {
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
            }

            if (activeTypes.bike) {
                globalThis.cache.bike.forEach(s => {
                    if (filter && normalizeText(s.name) !== filter) return;
                    const lat = Number.parseFloat(s.lat), lon = Number.parseFloat(s.lon);
                    if (!Number.isNaN(lat) && !Number.isNaN(lon) && bounds.contains([lat, lon])) {
                        const bikesCount = s.num_bikes_available;
                        const markerColor = bikesCount === 0 ? '#ef4444' : '#10b981';
                        const labelText = bikesCount === 0 ? 'Sin 🚲' : `🚲 ${bikesCount}`;
                        
                        createMarker(lat, lon, labelText, markerColor, 'bike', s).addTo(layers.bike);
                        visibleCount++;
                    }
                });
            }

            if (activeTypes.subte) {
                Object.entries(SUBTE_STATIC.lines).forEach(([routeId, line]) => {
                    const routeFilterMatch = !filter || normalizeText(routeId) === filter || normalizeText(line.short) === filter;

                    const stationItems = line.stations
                        .map(stopId => {
                            const station = SUBTE_STATIC.stations[stopId];
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
            }

            if (activeTypes.train) {
                const trainStatic = globalThis.cache.trainStatic || globalThis.TRAIN_STATIC;
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
            }

            void updateBusRouteOverlay(searchValue);

            const mapContainer = document.getElementById('map');
            if (visibleCount > 1500) {
                mapContainer.classList.add('hide-labels');
            } else {
                mapContainer.classList.remove('hide-labels');
            }

            document.getElementById('unit-count').innerText = `${visibleCount} EN VISTA`;
        }
