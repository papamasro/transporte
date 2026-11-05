function getStationIconSize(zoom) {
    if (zoom <= 12) return 16;
    if (zoom <= 14) return 14;
    return 12;
}

// Con zoom bajo las estaciones se dibujan como puntos chicos (sin emoji ni etiqueta) para no taparse.
const STATION_DOT_BELOW_ZOOM = { bike: 14, subte: 13, train: 13 };
const STATION_DOT_SIZE = 14;

function isStationDotZoom(type, zoom) {
    return Object.hasOwn(STATION_DOT_BELOW_ZOOM, type) && zoom < STATION_DOT_BELOW_ZOOM[type];
}

function buildStationDotHtml(type, color) {
    const style = type === 'bike' ? `background:${color}` : `border-color:${color}`;
    return `<div class="marker-container marker-kind-${type}"><div class="station-dot station-dot-${type}" style="${style}"></div></div>`;
}

function buildMarkerHtml(type, label, color, stationIconSize, stationFontSize, bearing, dot = false) {
    if (dot) return buildStationDotHtml(type, color);
    if (type === 'bus') {
        const busLabel = (label || '?').toString();
        const labelLen = busLabel.length;
        let busFontSize = 11;
        if (labelLen > 3) busFontSize = 9;
        else if (labelLen > 2) busFontSize = 10;
        const busWidth = Math.max(28, 12 + labelLen * 6);
        const arrowHtml = (bearing !== null && bearing !== undefined)
            ? `<div class="bus-dir-arrow" style="transform:rotate(${Math.round(bearing)}deg) translateY(-14px)"></div>`
            : '';
        return `<div class="marker-container"><div class="bus-chip" style="background:${color};min-width:${busWidth}px;font-size:${busFontSize}px;">${escapeHtml(busLabel)}</div>${arrowHtml}</div>`;
    }

    if (type === 'bike') {
        const bikeIconSize = stationIconSize + 14;
        const bikeFontSize = stationFontSize + 5;
        return `<div class="marker-container marker-kind-bike"><div style="width:${bikeIconSize}px;height:${bikeIconSize}px;border-radius:50%;background:${color};display:flex;align-items:center;justify-content:center;box-shadow:0 2px 6px rgba(0,0,0,0.35);font-size:${bikeFontSize}px;color:white;font-weight:900;">🚲</div></div>`;
    }

    if (type === 'train') {
        const trainIconSize = stationIconSize + 14;
        const trainFontSize = stationFontSize + 5;
        return `<div class="marker-container marker-kind-train"><div style="width:${trainIconSize}px;height:${trainIconSize}px;border-radius:8px;background:white;border:2.5px solid ${color};display:flex;align-items:center;justify-content:center;box-shadow:0 2px 6px rgba(0,0,0,0.3);font-size:${trainFontSize}px;">🚆</div><div class="vehicle-label">${escapeHtml(label)}</div></div>`;
    }

    const subteIconSize = stationIconSize + 14;
    const subteFontSize = stationFontSize + 5;
    return `<div class="marker-container marker-kind-subte"><div style="width:${subteIconSize}px;height:${subteIconSize}px;border-radius:8px;background:white;border:2.5px solid ${color};display:flex;align-items:center;justify-content:center;box-shadow:0 2px 6px rgba(0,0,0,0.3);font-size:${subteFontSize}px;">🚇</div><div class="vehicle-label">${escapeHtml(label)}</div></div>`;
}

function buildBusTooltip(data, color, label) {
    const speed = Math.max(0, Math.round((Number(data.speed) || 0) * 3.6));
    const shortName = escapeHtml((getVehicleShortName(data) || label || '-').toString());
    const agencyName = (data.agency_name || 'Servicio AMBA').toString();
    const agencyDisplay = escapeHtml(agencyName.length > 34 ? `${agencyName.slice(0, 34).trim()}…` : agencyName);
    const agencyTitle = escapeHtml(agencyName);
    const headsign = escapeHtml(data.trip_headsign || 'Sin destino');
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
                    <h4 class="text-[10px] font-black text-slate-200 leading-none">${escapeHtml(data.name)}</h4>
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
    const nowTs = Math.floor(Date.now() / 1000);
    const stationForecast = getSubteStationForecast(data)
        .filter(r => r.arrivalTime > 0)
        .filter(r => r.arrivalTime >= (nowTs - 60) && r.arrivalTime <= (nowTs + 7200))
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
                const etaText = formatEtaMinutes(r.arrivalTime, nowTs);
                return `Llega ${formatTimestamp(r.arrivalTime)} (${etaText})`;
            }).join(' · ');
            const maxDelay = Math.max(...nextItems.map(r => r.delay || 0));
            const tone = getDelayTone(maxDelay);

            return {
                firstArrival: nextItems[0]?.arrivalTime || Number.MAX_SAFE_INTEGER,
                html: `
                    <div class="py-1 border-b border-slate-600/30 last:border-b-0">
                        <div class="flex items-center justify-between gap-2">
                            <span class="text-[9px] font-black text-slate-200">Línea ${escapeHtml(routeShort)}</span>
                            <span class="text-[8px] font-bold border rounded-md px-1.5 py-0.5 ${tone.badgeClass}">${formatDelay(maxDelay)}</span>
                        </div>
                        <div class="text-[9px] font-bold text-indigo-400 leading-tight">Hacia ${escapeHtml(destination)}</div>
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
                    <h4 class="text-[11px] font-black text-slate-200 leading-none">Estación de Subte: ${escapeHtml(data.name)}</h4>
                    <span class="text-[7px] font-bold text-slate-400 uppercase tracking-tighter">Línea ${escapeHtml(data.lineShort)}</span>
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
            const eta = escapeHtml(formatTrainEta(arrival.etaSeconds));
            const etaTsText = arrival.estimatedArrivalTs ? formatTimestamp(arrival.estimatedArrivalTs) : '--:--';
            const platform = escapeHtml(arrival.plataforma || '-');
            const destination = escapeHtml(arrival.destino || 'Sin destino');
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
    const lineName = escapeHtml(data.lineName || data.lineShort || 'Tren');
    const latText = Number(data.lat).toFixed(5);
    const lonText = Number(data.lon).toFixed(5);
    const sofseStationId = data.sofseStationId || realtimeState?.arrivals?.stationId;
    const sofseStation = sofseStationId ? `ID SOFSE ${escapeHtml(sofseStationId)}` : 'Sin ID SOFSE';

    let realtimeBlock = '<div class="text-[9px] font-medium text-slate-400 py-1">Sin datos en vivo.</div>';
    let realtimeFooter = 'SOFSE en tiempo real no disponible';

    if (!trainLineHasRealtime(data.lineId)) {
        realtimeBlock = '<div class="text-[9px] font-medium text-slate-400 py-1">Esta línea no tiene horarios en vivo.</div>';
        realtimeFooter = 'El operador no publica arribos en tiempo real';
    } else if (realtimeState?.loading) {
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
                    <h4 class="text-[11px] font-black text-slate-200 leading-none">Estación de Tren: ${escapeHtml(data.name)}</h4>
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
    const lineName = data.lineShort ? `Línea ${escapeHtml(data.lineShort)}` : 'Subte';
    return `
        <div class="tooltip-dark px-2.5 py-1.5 rounded-xl shadow-lg" style="border-left: 3px solid ${color}; min-width: 120px;">
            <div class="text-[10px] font-black text-slate-200 leading-tight">Estación de Subte: ${escapeHtml(data.name)}</div>
            <div class="text-[8px] font-bold text-indigo-400 leading-snug mt-0.5">${lineName} · Tocá para ver llegadas</div>
        </div>`;
}

function buildTrainCompactTooltip(data, color) {
    const lineName = escapeHtml(data.lineName || data.lineShort || 'Tren');
    const hint = trainLineHasRealtime(data.lineId) ? 'Tocá para ver arribos' : 'Sin horarios en vivo';
    return `
        <div class="tooltip-dark px-2.5 py-1.5 rounded-xl shadow-lg" style="border-left: 3px solid ${color}; min-width: 120px;">
            <div class="text-[10px] font-black text-slate-200 leading-tight">Estación de Tren: ${escapeHtml(data.name)}</div>
            <div class="text-[8px] font-bold text-indigo-400 leading-snug mt-0.5">${lineName} · ${hint}</div>
        </div>`;
}

const MARKER_TOOLTIP_TYPES = new Set(['bus', 'bike', 'subte', 'train']);

function getMarkerIconSpec(type, label, color, data) {
    const zoom = map?.getZoom?.() || 14;
    const stationIconSize = getStationIconSize(zoom);
    const stationFontSize = zoom <= 12 ? 11 : 9;
    const dot = isStationDotZoom(type, zoom);
    let markerBoxSize = stationIconSize + 22;
    if (type === 'bus') markerBoxSize = 32;
    else if (dot) markerBoxSize = STATION_DOT_SIZE + 10;
    const rawBearing = (type === 'bus' && data) ? getVehicleBearing(data) : null;
    const bearing = rawBearing === null ? null : Math.round(rawBearing);
    const signature = type === 'bus'
        ? `${type}|${label}|${color}|${bearing ?? ''}`
        : `${type}|${label}|${color}|${stationIconSize}|${stationFontSize}|${dot ? 'dot' : ''}`;
    return { stationIconSize, stationFontSize, markerBoxSize, bearing, signature, dot };
}

function buildMarkerIcon(type, label, color, spec, className = '') {
    return L.divIcon({
        className,
        html: buildMarkerHtml(type, label, color, spec.stationIconSize, spec.stationFontSize, spec.bearing, spec.dot),
        iconSize: [spec.markerBoxSize, spec.markerBoxSize],
        iconAnchor: [Math.round(spec.markerBoxSize / 2), Math.round(spec.markerBoxSize / 2)]
    });
}

function getMarkerFavoriteTarget(type, data, label) {
    if (type === 'bus') return getBusLineFavoriteTarget(getBusDisplayLine(data) || label);
    return getStationFavoriteTarget(type, data);
}

function buildMarkerPopupBody(state) {
    const { type, data, color, label } = state;
    if (type === 'bus') return buildBusTooltip(data, color, label);
    if (type === 'bike') return buildBikeTooltip(data, color);
    if (type === 'subte') return buildSubteTooltip(data, color);
    if (type === 'train') return buildTrainTooltip(data, color, state.realtime);
    return '';
}

// La ☆ va arriba a la derecha, junto a la X de Leaflet.
function buildMarkerPopupHtml(state) {
    if (!state.data) return '';
    const body = buildMarkerPopupBody(state);
    if (!body) return '';
    const star = buildFavoriteStarHtml(getMarkerFavoriteTarget(state.type, state.data, state.label));
    return star ? `<div class="popup-with-fav">${star}${body}</div>` : body;
}

// Popup.update()/setLatLng() hacen autoPan: al refrescar en segundo plano no hay que mover el mapa.
function withoutPopupAutoPan(layer, fn) {
    const popup = layer?.isPopupOpen?.() ? layer.getPopup() : null;
    if (!popup) return fn();
    const previousAutoPan = popup.options.autoPan;
    popup.options.autoPan = false;
    try {
        return fn();
    } finally {
        popup.options.autoPan = previousAutoPan;
    }
}

// Layer#isTooltipOpen() lanza si el layer no tiene tooltip bindeado.
function isLayerTooltipOpen(layer) {
    return !!layer?.getTooltip?.()?.isOpen();
}

function refreshOpenMarkerOverlays(layer) {
    if (layer?.isPopupOpen?.()) {
        const popup = layer.getPopup();
        withoutPopupAutoPan(layer, () => popup.update());
    }
    if (isLayerTooltipOpen(layer)) layer.getTooltip().update();
}

// Cada vez que Leaflet re-renderiza el contenido (abrir, update(), reabrir) se crean los
// iconos solo dentro de ese popup/tooltip, en vez de lucide.createIcons() sobre todo el DOM.
function bindLazyIconOverlays(marker) {
    [marker.getPopup(), marker.getTooltip()].forEach(overlay => {
        overlay?.on('contentupdate', () => createLucideIconsIn(overlay.getElement()));
    });
}

function createMarker(lat, lng, label, color, type, data = null, options = {}) {
    const safeColor = safeCssColor(color);
    const state = {
        type,
        label,
        color: safeColor,
        data,
        realtime: null,
        iconSignature: '',
        iconClassName: options.iconClassName || ''
    };
    const spec = getMarkerIconSpec(type, label, safeColor, data);
    state.iconSignature = spec.signature;

    const marker = L.marker([lat, lng], {
        icon: buildMarkerIcon(type, label, safeColor, spec, state.iconClassName)
    });
    marker._transitMarker = state;

    // Contenido lazy: se arma al abrir (y al refrescar si está abierto) con los datos vigentes.
    if (data && MARKER_TOOLTIP_TYPES.has(type)) {
        marker.bindTooltip(() => buildTooltipHtml(state.type, state.data, state.color, state.label), {
            className: 'custom-tooltip',
            direction: 'top',
            offset: [0, -10],
            opacity: 1
        });
    }

    // Full popup on click (stays pinned, closes with X or clicking another marker)
    marker.bindPopup(() => buildMarkerPopupHtml(state), {
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

        // Bus route overlay
        if (state.type === 'bus' && state.data) {
            const selectedVehicle = state.data;
            globalThis.markerState.selectedBusVehicleKey = getVehicleUniqueKey(selectedVehicle);
            if (typeof updateSelectedBusOverlay === 'function') {
                updateSelectedBusOverlay(selectedVehicle).catch(() => {
                    updateBusRouteOverlay('').catch(() => {});
                });
            } else {
                updateBusRouteOverlay('').catch(() => {});
            }
        }
    });

    if (type === 'bus') {
        marker.on('popupopen', () => {
            globalThis.markerState.openBusPopupKey = getVehicleUniqueKey(state.data);
        });
        marker.on('popupclose', () => handleBusPopupClosed(state.data));
    }

    bindLazyIconOverlays(marker);

    // Train real-time arrivals fetch on popup open
    if (type === 'train' && data) {
        const HOVER_FETCH_DELAY_MS = Math.max(0, Number(globalThis.APP_CONFIG?.TIMEOUTS?.trainTooltipFetchDelayMs ?? 280));
        let hoverFetchTimer = null;
        let hoverFetchRequestId = 0;

        const setRealtimeState = (realtime) => {
            state.realtime = realtime;
            refreshOpenMarkerOverlays(marker);
        };

        const runTrainArrivalsFetch = async (requestId) => {
            if (!isFeatureEnabled('trainRealtime') || !trainLineHasRealtime(state.data?.lineId)) return;
            if (!marker.isPopupOpen() || requestId !== hoverFetchRequestId) return;

            setRealtimeState({ loading: true });

            const result = await getTrainArrivalsForStation(state.data);
            if (!marker.isPopupOpen() || requestId !== hoverFetchRequestId) return;

            setRealtimeState(result?.success ? { arrivals: result.data } : { error: true });
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

    return marker;
}

// Actualiza un marker existente: posición siempre, icono solo si cambia su firma visual,
// y el contenido del popup/tooltip solo si están abiertos (si no, se arma al abrir).
// options.animate: la posición la lleva bus-animation.js (si la animación está activa).
function updateMarker(marker, lat, lng, label, color, data = null, options = {}) {
    const state = marker?._transitMarker;
    if (!state) return marker;

    const safeColor = safeCssColor(color);
    state.label = label;
    state.color = safeColor;
    state.data = data;

    const animated = !!options.animate && busAnimMoveMarker(marker, lat, lng);
    const current = marker.getLatLng();
    if (!animated && (current.lat !== lat || current.lng !== lng)) {
        withoutPopupAutoPan(marker, () => marker.setLatLng([lat, lng]));
    }

    const spec = getMarkerIconSpec(state.type, label, safeColor, data);
    if (spec.signature !== state.iconSignature) {
        state.iconSignature = spec.signature;
        marker.setIcon(buildMarkerIcon(state.type, label, safeColor, spec, state.iconClassName));
    }

    refreshOpenMarkerOverlays(marker);
    return marker;
}
