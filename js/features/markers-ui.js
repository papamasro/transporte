function getStationIconSize(zoom) {
    if (zoom <= 12) return 16;
    if (zoom <= 14) return 14;
    return 12;
}

function buildMarkerHtml(type, label, color, stationIconSize, stationFontSize) {
    if (type === 'bus') {
        const busLabel = label || '?';
        const labelLen = busLabel.length;
        let busFontSize = 11;
        if (labelLen > 3) busFontSize = 9;
        else if (labelLen > 2) busFontSize = 10;
        const busWidth = Math.max(28, 12 + labelLen * 6);
        return `<div class="marker-container"><div class="bus-chip" style="background:${color};min-width:${busWidth}px;font-size:${busFontSize}px;">${busLabel}</div></div>`;
    }

    if (type === 'bike') {
        const bikeIconSize = stationIconSize + 14;
        const bikeFontSize = stationFontSize + 5;
        const bikeLabelSize = bikeFontSize - 1;
        return `<div class="marker-container"><div style="width:${bikeIconSize}px;height:${bikeIconSize}px;border-radius:50%;background:${color};display:flex;align-items:center;justify-content:center;box-shadow:0 2px 6px rgba(0,0,0,0.35);font-size:${bikeFontSize}px;color:white;font-weight:900;">🚲</div><div class="vehicle-label" style="font-size:${bikeLabelSize}px;background:${color};color:white;border:none;padding:1px 6px;">${label}</div></div>`;
    }

    if (type === 'train') {
        const trainIconSize = stationIconSize + 14;
        const trainFontSize = stationFontSize + 5;
        return `<div class="marker-container"><div style="width:${trainIconSize}px;height:${trainIconSize}px;border-radius:8px;background:white;border:2.5px solid ${color};display:flex;align-items:center;justify-content:center;box-shadow:0 2px 6px rgba(0,0,0,0.3);font-size:${trainFontSize}px;">🚆</div><div class="vehicle-label">${label}</div></div>`;
    }

    const subteIconSize = stationIconSize + 14;
    const subteFontSize = stationFontSize + 5;
    return `<div class="marker-container"><div style="width:${subteIconSize}px;height:${subteIconSize}px;border-radius:8px;background:white;border:2.5px solid ${color};display:flex;align-items:center;justify-content:center;box-shadow:0 2px 6px rgba(0,0,0,0.3);font-size:${subteFontSize}px;">🚇</div><div class="vehicle-label">${label}</div></div>`;
}

function buildBusTooltip(data, color, label) {
    const speed = Math.max(0, Math.round((Number(data.speed) || 0) * 3.6));
    const shortName = (getVehicleShortName(data) || label || '-').toString();
    const agencyName = data.agency_name || 'Servicio AMBA';
    const agencyDisplay = agencyName.length > 34 ? `${agencyName.slice(0, 34).trim()}…` : agencyName;
    const agencyTitle = agencyName.replaceAll('"', '&quot;');
    const headsign = data.trip_headsign || 'Sin destino';
    return `
        <div class="tooltip-dark p-3 rounded-2xl shadow-xl min-w-[220px]">
            <div class="flex items-center gap-2 mb-2">
                <div class="w-7 h-7 rounded-lg flex items-center justify-center text-white" style="background: ${color}">
                    <i data-lucide="bus" class="w-4 h-4"></i>
                </div>
                <div class="min-w-0">
                    <span class="inline-flex items-center text-[8px] font-black text-indigo-300 bg-indigo-500/20 border border-indigo-500/30 rounded-md px-1.5 py-0.5 uppercase tracking-wide">${shortName}</span>
                    <h4 class="text-[10px] font-black text-slate-200 leading-tight mt-1 truncate" title="${agencyTitle}">${agencyDisplay}</h4>
                </div>
            </div>
            <div class="space-y-1.5">
                <div class="bg-slate-800/60 p-2 rounded-lg border border-slate-600/40">
                    <span class="block text-[8px] font-bold text-slate-400 mb-0.5 uppercase tracking-tighter">Hacia</span>
                    <span class="dest-text text-[10px] font-black text-indigo-400 uppercase leading-tight">
                        ${headsign}
                    </span>
                </div>
                <div class="flex gap-1.5">
                    <div class="flex-1 bg-slate-800/60 p-1.5 rounded-lg border border-slate-600/40 text-center">
                        <span class="block text-[7px] font-bold text-slate-500">SPEED</span>
                        <span class="text-[10px] font-black text-slate-200">${speed} km/h</span>
                    </div>
                    <div class="flex-1 bg-slate-800/60 p-1.5 rounded-lg border border-slate-600/40 text-center">
                        <span class="block text-[7px] font-bold text-slate-500">ROUTE</span>
                        <span class="text-[10px] font-black text-indigo-400">${shortName}</span>
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
        <div class="tooltip-dark p-2.5 rounded-2xl shadow-xl min-w-[190px]">
            <div class="flex items-center gap-1.5 mb-1.5">
                <div class="w-6 h-6 rounded-lg flex items-center justify-center text-white" style="background: ${color}">
                    <i data-lucide="bike" class="w-3.5 h-3.5"></i>
                </div>
                <div>
                    <h4 class="text-[10px] font-black text-slate-200 leading-none">${data.name}</h4>
                    <span class="text-[7px] font-bold uppercase tracking-tighter" style="color: ${color};">${statusText}</span>
                </div>
            </div>
            <div class="grid grid-cols-2 gap-1.5">
                <div class="p-2 rounded-lg text-center" style="border: 1px solid ${color}40; background-color: ${color}15;">
                    <span class="block text-[7px] font-bold" style="color: ${color}">BICIS</span>
                    <span class="text-xs font-black" style="color: ${color}">${bikes}</span>
                </div>
                <div class="bg-slate-800/60 p-2 rounded-lg border border-slate-600/40 text-center">
                    <span class="block text-[7px] font-bold text-slate-500">BOXES</span>
                    <span class="text-xs font-black text-slate-300">${docks}</span>
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
                    <div class="py-1 border-b border-slate-600/30 last:border-b-0">
                        <div class="flex items-center justify-between gap-2">
                            <span class="text-[9px] font-black text-slate-200">Línea ${routeShort}</span>
                            <span class="text-[8px] font-bold border rounded-md px-1.5 py-0.5 ${tone.badgeClass}">${formatDelay(maxDelay)}</span>
                        </div>
                        <div class="text-[9px] font-bold text-indigo-400 leading-tight">Hacia ${destination}</div>
                        <div class="text-[8px] font-mono text-slate-400">${etaParts}</div>
                    </div>`
            };
        })
        .sort((a, b) => a.firstArrival - b.firstArrival)
        .slice(0, 4)
        .map(item => item.html)
        .join('');

    const noData = '<div class="text-[9px] font-medium text-slate-400 py-1">Sin pronóstico para esta estación.</div>';
    const hasDynamic = stationForecast.length > 0;
    const stationWorstDelay = hasDynamic ? Math.max(...stationForecast.map(r => r.delay || 0)) : 0;
    const stationTone = getDelayTone(stationWorstDelay);
    const popupBorderColor = hasDynamic ? stationTone.borderColor : 'rgba(100,116,139,0.4)';
    const lastUpdateText = globalThis.cache.subteTimestamp
        ? new Date(globalThis.cache.subteTimestamp * 1000).toLocaleTimeString('es-AR', { hour12: false })
        : '--:--:--';

    return `
        <div class="tooltip-dark p-3 rounded-2xl shadow-xl min-w-[220px]" style="border-color: ${popupBorderColor}; border-width: 2px;">
            <div class="flex items-center gap-2 mb-2">
                <div class="w-7 h-7 rounded-lg flex items-center justify-center text-white" style="background: ${color}">
                    <i data-lucide="train-front" class="w-4 h-4"></i>
                </div>
                <div>
                    <h4 class="text-[11px] font-black text-slate-200 leading-none">Estación de Subte: ${data.name}</h4>
                    <span class="text-[7px] font-bold text-slate-400 uppercase tracking-tighter">Línea ${data.lineShort}</span>
                </div>
            </div>
            <div class="bg-slate-800/60 p-2 rounded-lg border border-slate-600/40">
                <span class="block text-[8px] font-bold text-slate-400 mb-1 uppercase tracking-tighter">Próximas llegadas</span>
                ${rows || noData}
            </div>
            <div class="mt-2 pt-2 border-t border-slate-600/40 text-[8px]">
                <div class="font-bold text-slate-400">Última actualización: ${lastUpdateText}</div>
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
        return '<div class="text-[9px] font-medium text-slate-400 py-1">Sin arribos reportados.</div>';
    }

    return arrivals
        .slice(0, 4)
        .map(arrival => {
            const eta = formatTrainEta(arrival.etaSeconds);
            const etaTsText = arrival.estimatedArrivalTs ? formatTimestamp(arrival.estimatedArrivalTs) : '--:--';
            const platform = arrival.plataforma || '-';
            const destination = arrival.destino || 'Sin destino';
            return `
                <div class="py-1 border-b border-slate-600/30 last:border-b-0">
                    <div class="flex items-center justify-between gap-2">
                        <span class="text-[9px] font-black text-slate-200 truncate">${destination}</span>
                        <span class="text-[8px] font-bold text-indigo-400">${eta}</span>
                    </div>
                    <div class="text-[8px] font-mono text-slate-400">${etaTsText} · Andén ${platform}</div>
                </div>`;
        })
        .join('');
}

function buildTrainTooltip(data, color, realtimeState = null) {
    const lineName = data.lineName || data.lineShort || 'Tren';
    const latText = Number(data.lat).toFixed(5);
    const lonText = Number(data.lon).toFixed(5);
    const sofseStation = data.sofseStationId ? `ID SOFSE ${data.sofseStationId}` : 'Sin ID SOFSE';

    let realtimeBlock = '<div class="text-[9px] font-medium text-slate-400 py-1">Sin datos en vivo.</div>';
    let realtimeFooter = 'SOFSE en tiempo real no disponible';

    if (realtimeState?.loading) {
        realtimeBlock = '<div class="text-[9px] font-medium text-slate-400 py-1">Consultando arribos...</div>';
        realtimeFooter = 'Consultando API SOFSE';
    } else if (realtimeState?.error) {
        realtimeBlock = '<div class="text-[9px] font-medium text-rose-400 py-1">No se pudo obtener arribos.</div>';
        realtimeFooter = 'Error consultando API SOFSE';
    } else if (realtimeState?.arrivals) {
        realtimeBlock = buildTrainArrivalsRows(realtimeState.arrivals.arrivals || []);
        const ts = realtimeState.arrivals.timestamp || Math.floor(Date.now() / 1000);
        realtimeFooter = `Última actualización: ${new Date(ts * 1000).toLocaleTimeString('es-AR', { hour12: false })}`;
    }

    return `
        <div class="tooltip-dark p-3 rounded-2xl shadow-xl min-w-[230px]">
            <div class="flex items-center gap-2 mb-2">
                <div class="w-7 h-7 rounded-lg flex items-center justify-center text-white" style="background: ${color}">
                    <i data-lucide="train-track" class="w-4 h-4"></i>
                </div>
                <div>
                    <h4 class="text-[11px] font-black text-slate-200 leading-none">Estación de Tren: ${data.name}</h4>
                    <span class="text-[7px] font-bold text-slate-400 uppercase tracking-tighter">${lineName}</span>
                </div>
            </div>
            <div class="space-y-1.5">
                <div class="bg-slate-800/60 p-2 rounded-lg border border-slate-600/40">
                    <span class="block text-[8px] font-bold text-slate-400 mb-1 uppercase tracking-tighter">Próximos arribos</span>
                    ${realtimeBlock}
                </div>
                <div class="text-[8px] font-semibold text-slate-400">${sofseStation}</div>
                <div class="text-[8px] font-semibold text-slate-400">${realtimeFooter}</div>
                <div class="text-[8px] font-mono text-slate-500">${latText}, ${lonText}</div>
            </div>
        </div>`;
}

function buildTooltipHtml(type, data, color, label) {
    if (type === 'bus' && data) return buildBusTooltip(data, color, label);
    if (type === 'bike' && data) return buildBikeTooltip(data, color);
    if (type === 'subte' && data) return buildSubteCompactTooltip(data, color);
    if (type === 'train' && data) return buildTrainCompactTooltip(data, color);
    return '';
}

function buildSubteCompactTooltip(data, color) {
    const lineName = data.lineShort ? `Línea ${data.lineShort}` : 'Subte';
    return `
        <div class="tooltip-dark px-2.5 py-1.5 rounded-xl shadow-lg" style="border-left: 3px solid ${color}; min-width: 120px;">
            <div class="text-[10px] font-black text-slate-200 leading-tight">Estación de Subte: ${data.name}</div>
            <div class="text-[8px] font-bold text-indigo-400 leading-snug mt-0.5">${lineName} · Tocá para ver llegadas</div>
        </div>`;
}

function buildTrainCompactTooltip(data, color) {
    const lineName = data.lineName || data.lineShort || 'Tren';
    return `
        <div class="tooltip-dark px-2.5 py-1.5 rounded-xl shadow-lg" style="border-left: 3px solid ${color}; min-width: 120px;">
            <div class="text-[10px] font-black text-slate-200 leading-tight">Estación de Tren: ${data.name}</div>
            <div class="text-[8px] font-bold text-indigo-400 leading-snug mt-0.5">${lineName} · Tocá para ver arribos</div>
        </div>`;
}

function createMarker(lat, lng, label, color, type, data = null) {
    const zoom = map?.getZoom?.() || 14;
    const stationIconSize = getStationIconSize(zoom);
    const stationFontSize = zoom <= 12 ? 11 : 9;
    let markerBoxSize = stationIconSize + 22;
    if (type === 'bus') markerBoxSize = 32;
    if (type === 'bike') markerBoxSize = stationIconSize + 22;
    const markerHtml = buildMarkerHtml(type, label, color, stationIconSize, stationFontSize);

    const marker = L.marker([lat, lng], {
        icon: L.divIcon({
            className: '',
            html: markerHtml,
            iconSize: [markerBoxSize, markerBoxSize],
            iconAnchor: [Math.round(markerBoxSize / 2), Math.round(markerBoxSize / 2)]
        })
    });

    // Compact tooltip on hover for all types
    const tooltipHtml = buildTooltipHtml(type, data, color, label);
    if (tooltipHtml) {
        marker.bindTooltip(tooltipHtml, {
            className: 'custom-tooltip',
            direction: 'top',
            offset: [0, -10],
            opacity: 1
        });
    }

    // Full popup on click (stays pinned, closes with X or clicking another marker)
    const isExpandable = type === 'subte' || type === 'train';
    const showPopupOnClick = true;

    if (showPopupOnClick) {
        const getFullPopupHtml = (realtimeState) => {
            if (type === 'bus' && data) return buildBusTooltip(data, color, label);
            if (type === 'bike' && data) return buildBikeTooltip(data, color);
            if (type === 'subte' && data) return buildSubteTooltip(data, color);
            if (type === 'train' && data) return buildTrainTooltip(data, color, realtimeState);
            return '';
        };

        marker.bindPopup(getFullPopupHtml(isExpandable ? { loading: false } : null), {
            className: 'custom-popup',
            closeButton: true,
            autoClose: true,
            closeOnClick: false,
            maxWidth: 300,
            offset: [0, -10]
        });

        marker.on('click', (e) => {
            L.DomEvent.stopPropagation(e);
            marker.closeTooltip();
            marker.openPopup();
            lucide.createIcons();

            // Bus route overlay
            if (type === 'bus' && data) {
                globalThis.markerState.selectedBusVehicleKey = getVehicleUniqueKey(data);
                if (typeof updateSelectedBusOverlay === 'function') {
                    updateSelectedBusOverlay(data).catch(() => {
                        updateBusRouteOverlay('').catch(() => {});
                    });
                } else {
                    updateBusRouteOverlay('').catch(() => {});
                }
            }
        });

        marker.on('popupopen', () => lucide.createIcons());
    }

    // Train real-time arrivals fetch on popup open
    if (type === 'train' && data) {
        const HOVER_FETCH_DELAY_MS = Math.max(0, Number(globalThis.APP_CONFIG?.TIMEOUTS?.trainTooltipFetchDelayMs ?? 280));
        let hoverFetchTimer = null;
        let hoverFetchRequestId = 0;

        const runTrainArrivalsFetch = async (requestId) => {
            if (!marker.isPopupOpen() || requestId !== hoverFetchRequestId) return;

            marker.setPopupContent(buildTrainTooltip(data, color, { loading: true }));
            lucide.createIcons();

            const result = await getTrainArrivalsForStation(data);
            if (!marker.isPopupOpen() || requestId !== hoverFetchRequestId) return;

            if (!result?.success) {
                marker.setPopupContent(buildTrainTooltip(data, color, { error: true }));
                lucide.createIcons();
                return;
            }

            marker.setPopupContent(buildTrainTooltip(data, color, { arrivals: result.data }));
            lucide.createIcons();
        };

        marker.on('popupopen', () => {
            hoverFetchRequestId += 1;
            const requestId = hoverFetchRequestId;
            if (hoverFetchTimer) clearTimeout(hoverFetchTimer);
            hoverFetchTimer = setTimeout(() => {
                runTrainArrivalsFetch(requestId).catch(() => {});
            }, HOVER_FETCH_DELAY_MS);
        });

        marker.on('popupclose', () => {
            hoverFetchRequestId += 1;
            if (hoverFetchTimer) {
                clearTimeout(hoverFetchTimer);
                hoverFetchTimer = null;
            }
        });
    }

    marker.on('tooltipopen', () => lucide.createIcons());
    return marker;
}
