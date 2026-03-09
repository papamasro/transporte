function getStationIconSize(zoom) {
    if (zoom <= 12) return 16;
    if (zoom <= 14) return 14;
    return 12;
}

function buildMarkerHtml(type, label, color, stationIconSize, stationFontSize) {
    if (type === 'bus') {
        return `<div class="marker-container"><div class="v-marker" style="background:${color}; width: 10px; height: 10px;"></div><div class="vehicle-label">${label}</div></div>`;
    }

    if (type === 'bike') {
        const bikeIconSize = stationIconSize + 8;
        const bikeFontSize = stationFontSize + 3;
        return `<div class="marker-container"><div style="width:${bikeIconSize}px;height:${bikeIconSize}px;border-radius:50%;background:white;border:2px solid ${color};display:flex;align-items:center;justify-content:center;box-shadow:0 2px 4px rgba(0,0,0,0.25);font-size:${bikeFontSize}px;">🚲</div><div class="vehicle-label">${label}</div></div>`;
    }

    if (type === 'train') {
        return `<div class="marker-container"><div style="width:${stationIconSize}px;height:${stationIconSize}px;border-radius:6px;background:white;border:2px solid ${color};display:flex;align-items:center;justify-content:center;box-shadow:0 2px 4px rgba(0,0,0,0.25);font-size:${stationFontSize}px;">🚆</div><div class="vehicle-label">${label}</div></div>`;
    }

    return `<div class="marker-container"><div style="width:${stationIconSize}px;height:${stationIconSize}px;border-radius:6px;background:white;border:2px solid ${color};display:flex;align-items:center;justify-content:center;box-shadow:0 2px 4px rgba(0,0,0,0.25);font-size:${stationFontSize}px;">🚇</div><div class="vehicle-label">${label}</div></div>`;
}

function buildBusTooltip(data, color, label) {
    const speed = Math.max(0, Math.round((Number(data.speed) || 0) * 3.6));
    const shortName = (getVehicleShortName(data) || label || '-').toString();
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

function formatTrainEta(etaSeconds) {
    if (etaSeconds === null || etaSeconds === undefined) return 'Sin ETA';
    const minutes = Math.round(etaSeconds / 60);
    if (minutes <= 0) return 'Ahora';
    if (minutes === 1) return 'En 1 min';
    return `En ${minutes} min`;
}

function buildTrainArrivalsRows(arrivals) {
    if (!Array.isArray(arrivals) || arrivals.length === 0) {
        return '<div class="text-[9px] font-medium text-slate-500 py-1">Sin arribos reportados.</div>';
    }

    return arrivals
        .slice(0, 4)
        .map(arrival => {
            const eta = formatTrainEta(arrival.etaSeconds);
            const etaTsText = arrival.estimatedArrivalTs ? formatTimestamp(arrival.estimatedArrivalTs) : '--:--';
            const platform = arrival.plataforma || '-';
            const destination = arrival.destino || 'Sin destino';
            return `
                <div class="py-1 border-b border-slate-100 last:border-b-0">
                    <div class="flex items-center justify-between gap-2">
                        <span class="text-[9px] font-black text-slate-700 truncate">${destination}</span>
                        <span class="text-[8px] font-bold text-indigo-600">${eta}</span>
                    </div>
                    <div class="text-[8px] font-mono text-slate-500">${etaTsText} · Andén ${platform}</div>
                </div>`;
        })
        .join('');
}

function buildTrainTooltip(data, color, realtimeState = null) {
    const lineName = data.lineName || data.lineShort || 'Tren';
    const latText = Number(data.lat).toFixed(5);
    const lonText = Number(data.lon).toFixed(5);
    const sofseStation = data.sofseStationId ? `ID SOFSE ${data.sofseStationId}` : 'Sin ID SOFSE';

    let realtimeBlock = '<div class="text-[9px] font-medium text-slate-500 py-1">Sin datos en vivo.</div>';
    let realtimeFooter = 'SOFSE en tiempo real no disponible';

    if (realtimeState?.loading) {
        realtimeBlock = '<div class="text-[9px] font-medium text-slate-500 py-1">Consultando arribos...</div>';
        realtimeFooter = 'Consultando API SOFSE';
    } else if (realtimeState?.error) {
        realtimeBlock = '<div class="text-[9px] font-medium text-rose-600 py-1">No se pudo obtener arribos.</div>';
        realtimeFooter = 'Error consultando API SOFSE';
    } else if (realtimeState?.arrivals) {
        realtimeBlock = buildTrainArrivalsRows(realtimeState.arrivals.arrivals || []);
        const ts = realtimeState.arrivals.timestamp || Math.floor(Date.now() / 1000);
        realtimeFooter = `Última actualización: ${new Date(ts * 1000).toLocaleTimeString('es-AR', { hour12: false })}`;
    }

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
                <div class="bg-slate-50 p-2 rounded-lg border border-slate-100">
                    <span class="block text-[8px] font-bold text-slate-400 mb-1 uppercase tracking-tighter">Próximos arribos</span>
                    ${realtimeBlock}
                </div>
                <div class="text-[8px] font-semibold text-slate-500">${sofseStation}</div>
                <div class="text-[8px] font-semibold text-slate-500">${realtimeFooter}</div>
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
    const stationFontSize = zoom <= 12 ? 11 : 9;
    let markerBoxSize = stationIconSize + 8;
    if (type === 'bus') markerBoxSize = 20;
    if (type === 'bike') markerBoxSize = stationIconSize + 16;
    const markerHtml = buildMarkerHtml(type, label, color, stationIconSize, stationFontSize);

    const marker = L.marker([lat, lng], {
        icon: L.divIcon({
            className: '',
            html: markerHtml,
            iconSize: [markerBoxSize, markerBoxSize],
            iconAnchor: [Math.round(markerBoxSize / 2), Math.round(markerBoxSize / 2)]
        })
    });

    const tooltipHtml = type === 'train'
        ? buildTrainTooltip(data || {}, color, { loading: false })
        : buildTooltipHtml(type, data, color, label);

    marker.bindTooltip(tooltipHtml, {
        className: 'custom-tooltip',
        direction: 'top',
        offset: [0, -10],
        opacity: 1
    });

    if (type === 'bus' && data) {
        marker.on('click', () => {
            globalThis.markerState.selectedBusVehicleKey = getVehicleUniqueKey(data);
            if (typeof updateSelectedBusOverlay === 'function') {
                updateSelectedBusOverlay(data).catch(() => {
                    updateBusRouteOverlay('').catch(() => {});
                });
                return;
            }

            updateBusRouteOverlay('').catch(() => {});
        });
    }

    if (type === 'train' && data) {
        const HOVER_FETCH_DELAY_MS = Math.max(0, Number(globalThis.APP_CONFIG?.TIMEOUTS?.trainTooltipFetchDelayMs ?? 280));
        let hoverFetchTimer = null;
        let hoverFetchRequestId = 0;

        const runTrainArrivalsFetch = async (requestId) => {
            if (!marker.isTooltipOpen() || requestId !== hoverFetchRequestId) return;

            marker.setTooltipContent(buildTrainTooltip(data, color, { loading: true }));
            lucide.createIcons();

            const result = await getTrainArrivalsForStation(data);
            if (!marker.isTooltipOpen() || requestId !== hoverFetchRequestId) return;

            if (!result?.success) {
                marker.setTooltipContent(buildTrainTooltip(data, color, { error: true }));
                lucide.createIcons();
                return;
            }

            marker.setTooltipContent(buildTrainTooltip(data, color, { arrivals: result.data }));
            lucide.createIcons();
        };

        marker.on('tooltipopen', async () => {
            hoverFetchRequestId += 1;
            const requestId = hoverFetchRequestId;

            if (hoverFetchTimer) clearTimeout(hoverFetchTimer);
            hoverFetchTimer = setTimeout(() => {
                runTrainArrivalsFetch(requestId).catch(() => {});
            }, HOVER_FETCH_DELAY_MS);
        });

        marker.on('tooltipclose', () => {
            hoverFetchRequestId += 1;
            if (hoverFetchTimer) {
                clearTimeout(hoverFetchTimer);
                hoverFetchTimer = null;
            }
        });

        marker.on('click', async () => {
            marker.openTooltip();
        });
    }

    marker.on('tooltipopen', () => lucide.createIcons());
    return marker;
}
