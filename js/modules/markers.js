        function getStationIconSize(zoom) {
            if (zoom <= 12) return 22;
            if (zoom <= 14) return 20;
            return 18;
        }

        function buildMarkerHtml(type, label, color, stationIconSize, stationFontSize) {
            if (type === 'bus') {
                return `<div class="marker-container"><div class="v-marker" style="background:${color}; width: 10px; height: 10px;"></div><div class="vehicle-label">${label}</div></div>`;
            }

            if (type === 'bike') {
                return `<div class="marker-container"><div style="width:${stationIconSize}px;height:${stationIconSize}px;border-radius:50%;background:white;border:2px solid ${color};display:flex;align-items:center;justify-content:center;box-shadow:0 2px 4px rgba(0,0,0,0.25);font-size:${stationFontSize}px;">🚲</div><div class="vehicle-label">${label}</div></div>`;
            }

            return `<div class="marker-container"><div style="width:${stationIconSize}px;height:${stationIconSize}px;border-radius:6px;background:white;border:2px solid ${color};display:flex;align-items:center;justify-content:center;box-shadow:0 2px 4px rgba(0,0,0,0.25);font-size:${stationFontSize}px;">🚇</div><div class="vehicle-label">${label}</div></div>`;
        }

        function buildBusTooltip(data, color, label) {
            const speed = Math.round((data.speed || 0) * 3.6);
            const shortName = data.route_short_name || '-';
            return `
                <div class="glass p-3 rounded-2xl shadow-xl border border-white/50 min-w-[220px]">
                    <div class="flex items-center gap-2 mb-2">
                        <div class="w-7 h-7 rounded-lg flex items-center justify-center text-white" style="background: ${color}">
                            <i data-lucide="bus" class="w-4 h-4"></i>
                        </div>
                        <div>
                            <h4 class="text-[11px] font-black text-slate-800 leading-none">Línea ${label}</h4>
                            <span class="text-[9px] font-black text-slate-500 uppercase tracking-tight">${data.agency_name || 'Servicio AMBA'}</span>
                        </div>
                    </div>
                    <div class="space-y-1.5">
                        <div class="bg-slate-50 p-2 rounded-lg border border-slate-100">
                            <span class="block text-[8px] font-bold text-slate-400 mb-0.5 uppercase tracking-tighter">Hacia</span>
                            <span class="dest-text text-[10px] font-black text-indigo-600 uppercase leading-tight">
                                ${data.trip_headsign || 'SIN DESTINO'}
                            </span>
                        </div>
                        <div class="flex gap-1.5">
                            <div class="flex-1 bg-slate-50 p-1.5 rounded-lg border border-slate-100">
                                <span class="block text-[7px] font-bold text-slate-400">VEL</span>
                                <span class="text-[10px] font-black text-slate-700">${speed} km/h</span>
                            </div>
                            <div class="flex-1 bg-slate-50 p-1.5 rounded-lg border border-slate-100">
                                <span class="block text-[7px] font-bold text-slate-400">ID</span>
                                <span class="text-[10px] font-black text-slate-700">#${data.id?.toString().slice(-4) || '-'}</span>
                            </div>
                            <div class="flex-1 bg-slate-50 p-1.5 rounded-lg border border-slate-100">
                                <span class="block text-[7px] font-bold text-slate-400">SHORT</span>
                                <span class="text-[10px] font-black text-indigo-600">${label || shortName}</span>
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

        function buildTooltipHtml(type, data, color, label) {
            if (type === 'bus' && data) return buildBusTooltip(data, color, label);
            if (type === 'bike' && data) return buildBikeTooltip(data, color);
            if (type === 'subte' && data) return buildSubteTooltip(data, color);
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

            marker.on('tooltipopen', () => lucide.createIcons());
            return marker;
        }

        function renderMarkers() {
            if (!map || !globalThis.cache) return;
            const filter = document.getElementById('search').value.toLowerCase();
            const bounds = map.getBounds().pad(0.1);
            
            layers.bus.clearLayers();
            layers.bike.clearLayers();
            layers.subteLines.clearLayers();
            layers.subteStations.clearLayers();

            let visibleCount = 0;

            if (activeTypes.bus) {
                globalThis.cache.bus.forEach(v => {
                    let line = getBusDisplayLine(v);
                    if (filter && !line.toLowerCase().includes(filter)) return;
                    const lat = Number.parseFloat(v.latitude), lon = Number.parseFloat(v.longitude);
                    if (!Number.isNaN(lat) && !Number.isNaN(lon) && bounds.contains([lat, lon])) {
                        createMarker(lat, lon, line, getColor('bus', line), 'bus', v).addTo(layers.bus);
                        visibleCount++;
                    }
                });
            }

            if (activeTypes.bike) {
                globalThis.cache.bike.forEach(s => {
                    if (filter && !s.name.toLowerCase().includes(filter)) return;
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
                    const routeFilterMatch = !filter || routeId.toLowerCase().includes(filter) || line.short.toLowerCase().includes(filter);

                    const stationItems = line.stations
                        .map(stopId => {
                            const station = SUBTE_STATIC.stations[stopId];
                            if (!station) return null;
                            return { id: stopId, ...station, lineShort: line.short, routeId };
                        })
                        .filter(Boolean);

                    const hasStationMatch = stationItems.some(s => s.name.toLowerCase().includes(filter));
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
                        if (!station.name.toLowerCase().includes(filter) && !routeFilterMatch && !hasStationMatch) return;
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

            const mapContainer = document.getElementById('map');
            if (visibleCount > 1500) {
                mapContainer.classList.add('hide-labels');
            } else {
                mapContainer.classList.remove('hide-labels');
            }

            document.getElementById('unit-count').innerText = `${visibleCount} EN VISTA`;
        }
