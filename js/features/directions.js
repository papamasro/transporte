// Cómo ir / Planificador de viajes multimodal para el AMBA
// Permite ingresar origen y destino (por texto, GPS o seleccionando en el mapa)
// y calcula las mejores alternativas en Subte, Tren, Colectivo, Ecobici y Caminando.

(() => {
    const directionsState = {
        isOpen: false,
        origin: null, // { lat: number, lon: number, label: string, isUserLocation?: boolean }
        destination: null, // { lat: number, lon: number, label: string }
        routes: [],
        selectedRouteIndex: 0,
        activeField: null,
        mapPickField: null,
        mapPickHandler: null,
        searchDebounceTimer: null,
        searchAbortController: null,
        searchRequestId: 0,
        isRouting: false
    };

    const SUBTE_FALLBACK_COLORS = {
        LineaA: '#0072ce',
        LineaB: '#eb1923',
        LineaC: '#00569d',
        LineaD: '#008033',
        LineaE: '#6d2077',
        LineaH: '#fec300',
        LineaP: '#f58220'
    };

    const TRAIN_FALLBACK_COLORS = {
        mitre: '#0080c8',
        sarmiento: '#009ee2',
        roca: '#005a9c',
        san_martin: '#e30613',
        belgrano_norte: '#b61726',
        belgrano_sur: '#802334',
        urquiza: '#ec1c24'
    };

    // Nodos de combinación de la red de subtes de Buenos Aires
    const SUBTE_TRANSFER_HUBS = [
        { name: 'Obelisco', matchNames: ['carlos pellegrini', 'diagonal norte', '9 de julio'] },
        { name: 'Plaza de Mayo', matchNames: ['peru', 'catedral', 'bolivar'] },
        { name: 'Pueyrredón / Corrientes', matchNames: ['pueyrredon', 'corrientes'] },
        { name: 'Santa Fe / Pueyrredón', matchNames: ['santa fe', 'pueyrredon'] },
        { name: 'Once / Miserere', matchNames: ['plaza miserere', 'once'] },
        { name: 'Independencia', matchNames: ['independencia'] },
        { name: 'Av. de Mayo / Lima', matchNames: ['lima', 'avenida de mayo'] },
        { name: 'Retiro', matchNames: ['retiro'] },
        { name: 'Jujuy / Humberto 1º', matchNames: ['jujuy', 'humberto 1'] }
    ];

    function getDirectionsLayer() {
        return (typeof layers !== 'undefined' && layers?.directionsRoute) ? layers.directionsRoute : null;
    }

    function clearDirectionsMapOverlay() {
        const layer = getDirectionsLayer();
        layer?.clearLayers?.();
    }

    // ─── Control de apertura y cierre del panel ───────────────────────────────────

    function toggleDirectionsPanel() {
        if (typeof isFeatureEnabled === 'function' && !isFeatureEnabled('directionsPanel')) return;

        const panel = document.getElementById('directions-panel');
        const isOpen = directionsState.isOpen || panel?.classList?.contains('is-open');
        if (isOpen) {
            closeDirectionsPanel();
        } else {
            openDirectionsPanel();
        }
    }

    async function openDirectionsPanel() {
        if (typeof isFeatureEnabled === 'function' && !isFeatureEnabled('directionsPanel')) return;

        // Si otros paneles estaban abiertos, cerrarlos
        if (typeof closeNearbyPanel === 'function') closeNearbyPanel({ restoreFilters: false });
        const alertsPanel = document.getElementById('alerts-panel');
        if (alertsPanel?.classList?.contains('is-open') && typeof toggleAlertPanel === 'function') {
            await toggleAlertPanel();
        }

        directionsState.isOpen = true;
        if (typeof setDashboardActionActive === 'function') {
            setDashboardActionActive('directions', true);
        }

        const panel = document.getElementById('directions-panel');
        if (panel) {
            panel.classList.add('is-open');
            panel.inert = false;
        }

        // Si no hay origen definido, intentar usar la ubicación conocida del usuario
        if (!directionsState.origin) {
            const known = typeof getKnownUserLocation === 'function' ? getKnownUserLocation() : null;
            if (known && Number.isFinite(known.lat) && Number.isFinite(known.lon)) {
                directionsState.origin = {
                    lat: known.lat,
                    lon: known.lon,
                    label: 'Mi ubicación',
                    isUserLocation: true
                };
            }
        }

        renderDirectionsInputs();

        if (directionsState.origin && directionsState.destination) {
            await calculateDirectionsRoutes();
        } else {
            renderDirectionsInitialPrompt();
        }

        // Foco automático en el destino si está vacío
        setTimeout(() => {
            if (!directionsState.destination) {
                document.getElementById('directions-dest')?.focus();
            }
        }, 120);
    }

    function closeDirectionsPanel() {
        directionsState.isOpen = false;
        if (typeof setDashboardActionActive === 'function') {
            setDashboardActionActive('directions', false);
        }

        const panel = document.getElementById('directions-panel');
        if (panel) {
            panel.classList.remove('is-open');
            panel.inert = true;
        }

        globalThis._directionsActiveTransit = null;
        hideSuggestions();
        stopDirectionsMapPick();
        clearDirectionsMapOverlay();
        if (typeof scheduleRenderMarkers === 'function') {
            scheduleRenderMarkers(50, { force: true });
        }
    }

    // ─── Gestión de inputs y UI ───────────────────────────────────────────────────

    function renderDirectionsInputs() {
        const originInput = document.getElementById('directions-origin');
        const destInput = document.getElementById('directions-dest');
        const originClear = document.getElementById('directions-origin-clear');
        const destClear = document.getElementById('directions-dest-clear');

        if (originInput && directionsState.origin) {
            originInput.value = directionsState.origin.label || 'Mi ubicación';
        }
        if (destInput && directionsState.destination) {
            destInput.value = directionsState.destination.label || '';
        }

        if (originClear) originClear.hidden = !directionsState.origin;
        if (destClear) destClear.hidden = !directionsState.destination;
    }

    function setOriginToCurrentLocation() {
        const known = typeof getKnownUserLocation === 'function' ? getKnownUserLocation() : null;
        if (known && Number.isFinite(known.lat) && Number.isFinite(known.lon)) {
            directionsState.origin = {
                lat: known.lat,
                lon: known.lon,
                label: 'Mi ubicación',
                isUserLocation: true
            };
            renderDirectionsInputs();
            if (directionsState.destination) calculateDirectionsRoutes();
        } else if (typeof locateUser === 'function') {
            locateUser({ autoActivateNearby: false }).then(loc => {
                if (loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lon)) {
                    directionsState.origin = {
                        lat: loc.lat,
                        lon: loc.lon,
                        label: 'Mi ubicación',
                        isUserLocation: true
                    };
                    renderDirectionsInputs();
                    if (directionsState.destination) calculateDirectionsRoutes();
                }
            }).catch(() => {});
        }
    }

    function swapDirectionsLocations() {
        const temp = directionsState.origin;
        directionsState.origin = directionsState.destination;
        directionsState.destination = temp;
        renderDirectionsInputs();
        if (directionsState.origin && directionsState.destination) {
            calculateDirectionsRoutes();
        } else {
            renderDirectionsInitialPrompt();
            clearDirectionsMapOverlay();
        }
    }

    function clearDirectionsField(field) {
        if (field === 'origin') {
            directionsState.origin = null;
            const el = document.getElementById('directions-origin');
            if (el) el.value = '';
        } else {
            directionsState.destination = null;
            const el = document.getElementById('directions-dest');
            if (el) el.value = '';
        }
        renderDirectionsInputs();
        hideSuggestions();
        clearDirectionsMapOverlay();
        renderDirectionsInitialPrompt();
    }

    function resetDirectionsForm() {
        directionsState.origin = null;
        directionsState.destination = null;
        directionsState.routes = [];
        globalThis._directionsActiveTransit = null;
        renderDirectionsInputs();
        hideSuggestions();
        clearDirectionsMapOverlay();
        renderDirectionsInitialPrompt();
        if (typeof scheduleRenderMarkers === 'function') {
            scheduleRenderMarkers(50, { force: true });
        }
    }

    function hideSuggestions() {
        if (directionsState.searchDebounceTimer) {
            clearTimeout(directionsState.searchDebounceTimer);
            directionsState.searchDebounceTimer = null;
        }
        directionsState.searchAbortController?.abort();
        directionsState.searchAbortController = null;
        directionsState.searchRequestId++;

        const sugg = document.getElementById('directions-suggestions');
        if (sugg) {
            sugg.hidden = true;
            sugg.innerHTML = '';
        }
    }

    // ─── Selección de punto en el mapa ───────────────────────────────────────────

    function startDirectionsMapPick(field = 'destination') {
        stopDirectionsMapPick();
        directionsState.mapPickField = field;

        if (typeof showToast === 'function') {
            const label = field === 'origin' ? 'origen' : 'destino';
            showToast(`Tocá el mapa para indicar el punto de ${label}`);
        }

        const mapInstance = typeof map !== 'undefined' ? map : null;
        if (!mapInstance) return;

        directionsState.mapPickHandler = (e) => {
            const lat = e.latlng.lat;
            const lon = e.latlng.lng;
            const label = `Punto en el mapa (${lat.toFixed(4)}, ${lon.toFixed(4)})`;

            if (field === 'origin') {
                directionsState.origin = { lat, lon, label };
            } else {
                directionsState.destination = { lat, lon, label };
            }

            renderDirectionsInputs();
            stopDirectionsMapPick();

            if (directionsState.origin && directionsState.destination) {
                calculateDirectionsRoutes();
            } else {
                renderDirectionsInitialPrompt();
            }
        };

        mapInstance.once('click', directionsState.mapPickHandler);
    }

    function stopDirectionsMapPick() {
        if (directionsState.mapPickHandler && typeof map !== 'undefined' && map) {
            map.off('click', directionsState.mapPickHandler);
        }
        directionsState.mapPickHandler = null;
        directionsState.mapPickField = null;
    }

    // ─── Búsqueda de direcciones y estaciones (Geocoding & Autocomplete) ────────

    function handleDirectionsInput(field, query) {
        directionsState.activeField = field;
        if (directionsState.searchDebounceTimer) {
            clearTimeout(directionsState.searchDebounceTimer);
            directionsState.searchDebounceTimer = null;
        }
        directionsState.searchAbortController?.abort();
        directionsState.searchAbortController = null;
        const requestId = ++directionsState.searchRequestId;

        const trimmed = (query || '').trim();
        if (trimmed.length < 2) {
            hideSuggestions();
            return;
        }

        directionsState.searchDebounceTimer = setTimeout(async () => {
            const result = await searchLocations(trimmed);
            if (requestId !== directionsState.searchRequestId || field !== directionsState.activeField) return;
            directionsState.searchDebounceTimer = null;
            directionsState.searchAbortController = null;
            renderDirectionsSuggestions(result.suggestions, field, trimmed, result.error);
        }, 400);
    }

    async function searchLocations(query) {
        const norm = typeof normalizeText === 'function' ? normalizeText(query) : query.toLowerCase().trim();
        const stationSuggestions = [];

        // 1. Buscar en estaciones de Subte locales
        const subteStations = globalThis.cache?.subteStatic?.stations || {};
        const subteLines = globalThis.cache?.subteStatic?.lines || {};
        for (const [stopId, station] of Object.entries(subteStations)) {
            const sNameNorm = typeof normalizeText === 'function' ? normalizeText(station.name) : station.name?.toLowerCase();
            if (sNameNorm && sNameNorm.includes(norm)) {
                // Averiguar línea
                let lineShort = '';
                for (const [lId, line] of Object.entries(subteLines)) {
                    const stList = line.stations || line.stationIds || [];
                    if (stList.includes(stopId)) {
                        lineShort = line.short || lId.replace('Linea', '');
                        break;
                    }
                }
                stationSuggestions.push({
                    type: 'subte',
                    title: `Estación ${station.name}`,
                    subtitle: lineShort ? `Subte Línea ${lineShort}` : 'Subte',
                    lat: station.lat,
                    lon: station.lon,
                    icon: '🚇'
                });
                if (stationSuggestions.length >= 3) break;
            }
        }

        // 2. Buscar en estaciones de Tren locales
        const trainStations = globalThis.cache?.trainStatic?.stations || {};
        const trainLines = globalThis.cache?.trainStatic?.lines || {};
        for (const [sId, tStation] of Object.entries(trainStations)) {
            const tNameNorm = typeof normalizeText === 'function' ? normalizeText(tStation.name) : tStation.name?.toLowerCase();
            if (tNameNorm && tNameNorm.includes(norm)) {
                let trainName = 'Tren';
                for (const line of Object.values(trainLines)) {
                    const sList = line.stations || line.stationIds || [];
                    if (sList.includes(sId)) {
                        trainName = line.name || line.short || 'Tren';
                        break;
                    }
                }
                stationSuggestions.push({
                    type: 'train',
                    title: `Estación ${tStation.name}`,
                    subtitle: trainName,
                    lat: tStation.lat,
                    lon: tStation.lon,
                    icon: '🚆'
                });
                if (stationSuggestions.length >= 5) break;
            }
        }

        // 3. Geocodificación Photon (OpenStreetMap AMBA)
        if (directionsState.searchAbortController) {
            directionsState.searchAbortController.abort();
        }
        directionsState.searchAbortController = new AbortController();
        const signal = directionsState.searchAbortController.signal;
        const addressSuggestions = [];
        let lookupError = false;
        const requestedHouseNumber = query.match(/(?:^|\s)(\d+[a-z]?)\s*$/i)?.[1]?.toLowerCase() || '';

        try {
            const photonUrl = `https://photon.komoot.io/api/?q=${encodeURIComponent(query)}&lat=-34.6037&lon=-58.3816&limit=10&lang=default`;
            const resp = await fetch(photonUrl, { signal });
            if (resp.ok) {
                const data = await resp.json();
                const features = Array.isArray(data?.features) ? data.features : [];
                const matches = [];
                for (const feat of features) {
                    const props = feat.properties || {};
                    const coords = feat.geometry?.coordinates;
                    if (!coords || coords.length < 2) continue;

                    const lon = coords[0];
                    const lat = coords[1];

                    // Filtrar aproximado al AMBA (lat entre -35.2 y -34.0, lon entre -59.3 y -57.8)
                    if (lat < -35.2 || lat > -34.0 || lon < -59.3 || lon > -57.8) continue;

                    const streetAddress = [props.street, props.housenumber].filter(Boolean).join(' ');
                    const featureName = String(props.name || '');
                    const isIntersection = /\s(?:y|&|\/|con)\s/i.test(query) &&
                        /\s(?:y|&|\/|con)\s/i.test(featureName);
                    const title = (isIntersection && featureName) || streetAddress || featureName || props.city || '';
                    const hasRequestedHouseNumber = !!requestedHouseNumber &&
                        String(props.housenumber || '').toLowerCase() === requestedHouseNumber;

                    const parts = [];
                    if (isIntersection && streetAddress) parts.push(streetAddress);
                    else if (streetAddress && featureName && featureName !== props.street) parts.push(featureName);
                    if (props.city || props.district || props.county) parts.push(props.city || props.district || props.county);
                    if (props.state) parts.push(props.state);
                    const subtitle = parts.join(', ') || 'Buenos Aires';

                    if (title) {
                        matches.push({
                            type: 'address',
                            title,
                            subtitle,
                            lat,
                            lon,
                            icon: '📍',
                            hasRequestedHouseNumber
                        });
                    }
                }

                matches.sort((a, b) => Number(b.hasRequestedHouseNumber) - Number(a.hasRequestedHouseNumber));
                for (const match of matches.slice(0, 6)) {
                    delete match.hasRequestedHouseNumber;
                    addressSuggestions.push(match);
                }
            } else {
                lookupError = true;
            }
        } catch (error) {
            if (error?.name !== 'AbortError') {
                console.warn('No se pudieron cargar sugerencias de OpenStreetMap:', error);
                lookupError = true;
            }
        }

        return {
            suggestions: [...addressSuggestions, ...stationSuggestions].slice(0, 8),
            error: lookupError
        };
    }

    function renderDirectionsSuggestions(suggestions, field, query, lookupError) {
        const container = document.getElementById('directions-suggestions');
        if (!container) return;

        if (!suggestions || suggestions.length === 0) {
            const safeHtml = typeof escapeHtml === 'function' ? escapeHtml : str => String(str || '');
            const message = lookupError
                ? 'No se pudo consultar OpenStreetMap. Revisá tu conexión e intentá de nuevo.'
                : `No encontramos “${safeHtml(query)}” en el AMBA. Probá con una esquina o elegí el punto en el mapa.`;
            container.innerHTML = `<p class="directions-suggestions-empty" role="status">${message}</p>`;
            container.hidden = false;
            return;
        }

        const safeHtml = typeof escapeHtml === 'function' ? escapeHtml : str => String(str || '');

        const suggestionHtml = suggestions.map((item, index) => `
            <button type="button" class="directions-suggestion-item" data-index="${index}">
                <span class="suggestion-icon" aria-hidden="true">${safeHtml(item.icon || '📍')}</span>
                <span class="suggestion-text">
                    <span class="suggestion-title">${safeHtml(item.title)}</span>
                    <span class="suggestion-subtitle">${safeHtml(item.subtitle || '')}</span>
                </span>
            </button>
        `).join('');
        const lookupNotice = lookupError
            ? '<p class="directions-suggestions-empty" role="status">No se pudieron buscar direcciones en OpenStreetMap.</p>'
            : '';
        container.innerHTML = suggestionHtml + lookupNotice;

        container.hidden = false;

        container.querySelectorAll('.directions-suggestion-item').forEach(btn => {
            btn.addEventListener('click', () => {
                const idx = Number(btn.dataset.index);
                const chosen = suggestions[idx];
                if (chosen) selectSuggestion(field, chosen);
            });
        });
    }

    function selectSuggestion(field, item) {
        hideSuggestions();
        const payload = {
            lat: item.lat,
            lon: item.lon,
            label: item.title
        };

        if (field === 'origin') {
            directionsState.origin = payload;
        } else {
            directionsState.destination = payload;
        }

        renderDirectionsInputs();

        if (directionsState.origin && directionsState.destination) {
            calculateDirectionsRoutes();
        } else {
            renderDirectionsInitialPrompt();
        }
    }

    // ─── Cálculo y Enrutamiento Multimodal ────────────────────────────────────────

    async function calculateDirectionsRoutes() {
        const { origin, destination } = directionsState;
        if (!origin || !destination) return;
        if (!Number.isFinite(origin.lat) || !Number.isFinite(origin.lon) ||
            !Number.isFinite(destination.lat) || !Number.isFinite(destination.lon)) {
            return;
        }

        directionsState.isRouting = true;
        renderDirectionsLoading();

        // Asegurar datos estáticos y en tiempo real de subte, tren y ecobici cargados
        const loadPromises = [];
        if (!globalThis.cache?.subteStatic?.lines && typeof loadSubteStaticFromKV === 'function') {
            loadPromises.push(loadSubteStaticFromKV().catch(() => {}));
        }
        if (!globalThis.cache?.trainStatic?.lines && typeof loadTrainStaticFromKV === 'function') {
            loadPromises.push(loadTrainStaticFromKV().catch(() => {}));
        }
        // Cargar estaciones de Ecobici para que siempre pueda recomendar bici
        if ((!globalThis.cache?.bike || globalThis.cache.bike.length === 0) && typeof refreshBikeNow === 'function') {
            loadPromises.push(refreshBikeNow({ force: true }).catch(() => {}));
        }
        if (!globalThis.cache?.bikeRoutes && typeof refreshBikeRoutesNow === 'function') {
            loadPromises.push(refreshBikeRoutesNow());
        }
        // Cargar horarios de subte en tiempo real
        if (typeof refreshSubteNow === 'function') {
            loadPromises.push(refreshSubteNow({ force: true }).catch(() => {}));
        }
        // Cargar arribos de trenes en tiempo real para las líneas del AMBA
        if (typeof fetchAPI === 'function' && typeof getAppPath === 'function') {
            const trainPath = getAppPath('trainLineArrivals', '/trenes/arribosLinea');
            const linesToFetch = ['mitre', 'roca', 'sarmiento', 'san_martin', 'urquiza', 'belgrano_norte', 'belgrano_sur'];
            loadPromises.push(Promise.all(linesToFetch.map(l => fetchAPI(`${trainPath}?linea=${encodeURIComponent(l)}`)))
                .then(responses => {
                    responses.forEach(res => {
                        if (res?.success && typeof storeTrainLineArrivals === 'function') {
                            storeTrainLineArrivals(res.data);
                        }
                    });
                }).catch(() => {}));
        }
        if (loadPromises.length > 0) {
            await Promise.all(loadPromises);
        }

        const routes = await computeRoutes(origin, destination);
        directionsState.routes = routes;
        directionsState.selectedRouteIndex = 0;
        directionsState.isRouting = false;

        renderDirectionsResults();

        if (routes.length > 0) {
            drawDirectionsRoute(routes[0]);
        } else {
            clearDirectionsMapOverlay();
        }
    }

    function getRouteBusLinesKey(route) {
        const busLegs = (route?.legs || []).filter(l => l.mode === 'bus');
        if (busLegs.length === 0) return route?.title || route?.id || 'bus';
        return busLegs.map(l => {
            const name = l.lineName || '';
            const digits = name.replace(/[^0-9]/g, '');
            return digits || name.toLowerCase().replace(/línea\s*/, '').trim();
        }).join('+');
    }

    const BUS_FINAL_WALK_MAX_METERS = 500;

    function getBusLegColor(leg) {
        const lineName = (leg?.lineName || '').replace(/^Línea\s*/i, '').trim();
        return typeof getColor === 'function'
            ? getColor('bus', lineName || leg?.lineName)
            : (leg?.color || '#4f46e5');
    }

    function colorBusLegs(route) {
        let summaryBusIndex = 0;
        const busLegColors = [];
        const legs = (route.legs || []).map(leg => {
            if (leg.mode !== 'bus') return leg;
            const color = getBusLegColor(leg);
            busLegColors.push(color);
            return { ...leg, color };
        });
        const summaryPills = (route.summaryPills || []).map(pill => {
            if (pill.icon !== '🚌') return pill;
            const color = busLegColors[summaryBusIndex];
            summaryBusIndex += 1;
            return color ? { ...pill, color } : pill;
        });
        return { ...route, legs, summaryPills };
    }

    function getBusLegEndpoint(leg) {
        const stops = Array.isArray(leg?.stops) ? leg.stops : [];
        const alightStop = [...stops].reverse().find(stop => stop.role === 'alight');
        if (Number.isFinite(Number(alightStop?.lat)) && Number.isFinite(Number(alightStop?.lon))) {
            return [Number(alightStop.lat), Number(alightStop.lon)];
        }
        const lastCoordinate = Array.isArray(leg?.coords) ? leg.coords[leg.coords.length - 1] : null;
        if (Array.isArray(lastCoordinate) && Number.isFinite(Number(lastCoordinate[0])) &&
            Number.isFinite(Number(lastCoordinate[1]))) {
            return [Number(lastCoordinate[0]), Number(lastCoordinate[1])];
        }
        return null;
    }

    function getBusEgressWalkDistance(leg, destination) {
        const endpoint = getBusLegEndpoint(leg);
        if (!endpoint) return Infinity;
        return Math.round(haversineMeters(destination.lat, destination.lon, endpoint[0], endpoint[1]) * 1.25);
    }

    function getNearbySingleBusRoute(route, destination) {
        const busLegs = (route.legs || []).filter(leg => leg.mode === 'bus');
        if (busLegs.length === 0) return null;

        const firstBusIndex = route.legs.findIndex(leg => leg.mode === 'bus');
        const firstBusLeg = route.legs[firstBusIndex];
        const egressDistance = getBusEgressWalkDistance(firstBusLeg, destination);
        if (egressDistance > BUS_FINAL_WALK_MAX_METERS) return null;
        if (busLegs.length === 1) return route;

        const endpoint = getBusLegEndpoint(firstBusLeg);
        if (!endpoint) return null;
        const endName = firstBusLeg.toName ||
            [...(firstBusLeg.stops || [])].reverse().find(stop => stop.role === 'alight')?.name ||
            'Parada de bajada';
        const walkDuration = egressDistance > 0 ? Math.max(1, Math.round(egressDistance / 80)) : 0;
        const prefixLegs = route.legs.slice(0, firstBusIndex).filter(leg => leg.mode === 'walk');
        const finalWalk = egressDistance >= 30 ? {
            mode: 'walk',
            distanceMeters: egressDistance,
            durationMin: walkDuration,
            fromName: endName,
            toName: destination.label || 'Destino',
            coords: [endpoint, [destination.lat, destination.lon]]
        } : null;
        const legs = [
            ...prefixLegs,
            { ...firstBusLeg, toName: endName },
            ...(finalWalk ? [finalWalk] : [])
        ];
        const lineName = firstBusLeg.lineName || 'Colectivo';
        const busColor = firstBusLeg.color || getBusLegColor(firstBusLeg);
        const busStepIndex = (route.steps || []).findIndex(step => step.icon === '🚌');
        const steps = busStepIndex >= 0
            ? route.steps.slice(0, busStepIndex + 1).filter(step => step.icon !== '🔁')
            : [{ icon: '🚌', text: `Tomar ${lineName} hasta ${endName}` }];
        if (finalWalk) {
            steps.push({
                icon: '🚶',
                text: `Bajar en ${endName} y caminar ${formatDistanceText(egressDistance)} hasta destino (~${walkDuration} min)`
            });
        }

        const summaryPills = prefixLegs.map(leg => ({
            icon: '🚶',
            text: `${leg.durationMin || 1}m`,
            color: '#64748b'
        }));
        summaryPills.push({ icon: '🚌', text: lineName, color: busColor });
        if (finalWalk) summaryPills.push({ icon: '🚶', text: `${walkDuration}m`, color: '#64748b' });

        return {
            ...route,
            id: `${route.id || 'bus'}-walk-final`,
            title: lineName,
            durationMin: prefixLegs.reduce((total, leg) => total + (Number(leg.durationMin) || 0), 0)
                + (Number(firstBusLeg.durationMin) || 0) + 5 + walkDuration,
            distanceMeters: legs.reduce((total, leg) => total + (Number(leg.distanceMeters) || 0), 0),
            summaryPills,
            legs,
            steps
        };
    }

    async function computeRoutes(origin, destination) {
        const distDirect = typeof haversineMeters === 'function'
            ? haversineMeters(origin.lat, origin.lon, destination.lat, destination.lon)
            : 1000;

        const routes = [];

        // 1. Opción Caminando
        const walkDist = Math.round(distDirect * 1.25);
        const walkDurationMin = Math.max(1, Math.round(walkDist / 80));
        routes.push({
            id: 'walk',
            type: 'walk',
            title: 'Caminando',
            durationMin: walkDurationMin,
            distanceMeters: walkDist,
            summaryPills: [
                { icon: '🚶', text: `${walkDurationMin} min`, color: '#64748b' }
            ],
            legs: [
                {
                    mode: 'walk',
                    distanceMeters: walkDist,
                    durationMin: walkDurationMin,
                    fromName: origin.label || 'Origen',
                    toName: destination.label || 'Destino',
                    coords: [[origin.lat, origin.lon], [destination.lat, destination.lon]]
                }
            ],
            steps: [
                { icon: '🚶', text: `Caminar ${formatDistanceText(walkDist)} directo hasta destino (~${walkDurationMin} min)` }
            ]
        });

        // 2. Opción Subte Directo
        const subteDirectRoutes = findSubteDirectRoutes(origin, destination);
        subteDirectRoutes.forEach(r => routes.push(r));

        // 3. Opción Subte con Transbordo (si la distancia es relevante)
        if (subteDirectRoutes.length === 0 || distDirect > 3000) {
            const subteTransferRoutes = findSubteTransferRoutes(origin, destination);
            subteTransferRoutes.forEach(r => routes.push(r));
        }

        // 4. Opción Tren
        const trainRoutes = findTrainDirectRoutes(origin, destination);
        trainRoutes.forEach(r => routes.push(r));

        // 5. Opción Ecobici (si hay estaciones cargadas en cache)
        const bikeRoute = findBikeRoute(origin, destination, distDirect);
        if (bikeRoute) routes.push(bikeRoute);

        // 6. Opción Colectivo (con recorridos reales del GTFS si están disponibles)
        if (distDirect > 1200) {
            const busRoutes = (await findBusRouteOptions(origin, destination)).map(colorBusLegs);
            const nearbySingleBusRoutes = busRoutes
                .map(route => getNearbySingleBusRoute(route, destination))
                .filter(Boolean)
                .sort((a, b) => a.durationMin - b.durationMin);
            const busRoutesToShow = nearbySingleBusRoutes.length > 0
                ? [nearbySingleBusRoutes[0]]
                : busRoutes;
            // Deduplicar ramales que usan las mismas líneas base (ej: 114A+19 vs 114B+19 → solo el más rápido)
            const seenBusBases = new Map();
            for (const r of busRoutesToShow) {
                const key = getRouteBusLinesKey(r);
                const existing = seenBusBases.get(key);
                if (!existing || r.durationMin < existing.durationMin) {
                    seenBusBases.set(key, r);
                }
            }
            seenBusBases.forEach(r => routes.push(r));
        }

        routes.sort((a, b) =>
            getRouteTransferCount(a) - getRouteTransferCount(b) || a.durationMin - b.durationMin);

        // Asignar etiquetas destacadas
        if (routes.length > 0) {
            const fastestRoute = routes.reduce((fastest, route) =>
                route.durationMin < fastest.durationMin ? route : fastest);
            fastestRoute.tag = 'Más rápido';
            fastestRoute.tagClass = 'card-tag-fastest';
        }
        for (let i = 1; i < routes.length; i++) {
            if (routes[i].type !== 'walk' && getRouteTransferCount(routes[i]) === 0) {
                routes[i].tag = 'Directo';
                routes[i].tagClass = 'card-tag-direct';
                break;
            }
        }

        return routes;
    }

    function getRouteTransferCount(route) {
        if (route.type === 'walk') {
            return route.durationMin > 20 ? 1 : 0;
        }
        const transitLegCount = (route.legs || []).filter(leg => leg.mode !== 'walk').length;
        return Math.max(0, transitLegCount - 1);
    }

    function findSubteDirectRoutes(origin, destination) {
        const subteStatic = globalThis.cache?.subteStatic;
        const lines = subteStatic?.lines || {};
        const stations = subteStatic?.stations || {};
        if (!lines || Object.keys(lines).length === 0) return [];

        const candidates = [];

        for (const [lineId, line] of Object.entries(lines)) {
            const stationIds = line.stations || line.stationIds || [];
            if (!Array.isArray(stationIds) || stationIds.length < 2) continue;

            const stationsWithDist = stationIds.map((id, idx) => {
                const st = stations[id];
                if (!st || !Number.isFinite(st.lat) || !Number.isFinite(st.lon)) return null;
                const dO = typeof haversineMeters === 'function' ? haversineMeters(origin.lat, origin.lon, st.lat, st.lon) : 9999;
                const dD = typeof haversineMeters === 'function' ? haversineMeters(destination.lat, destination.lon, st.lat, st.lon) : 9999;
                return { id, idx, name: st.name, lat: st.lat, lon: st.lon, dO, dD };
            }).filter(Boolean);

            // Estación de subida a menos de 1300 m del origen
            const nearOrigin = stationsWithDist.filter(s => s.dO <= 1300).sort((a, b) => a.dO - b.dO);
            // Estación de bajada a menos de 1300 m del destino
            const nearDest = stationsWithDist.filter(s => s.dD <= 1300).sort((a, b) => a.dD - b.dD);

            if (nearOrigin.length === 0 || nearDest.length === 0) continue;

            const origSt = nearOrigin[0];
            const destSt = nearDest[0];

            if (origSt.id === destSt.id) continue;

            const stationsCount = Math.abs(destSt.idx - origSt.idx);
            if (stationsCount === 0) continue;

            const walk1Dist = Math.round(origSt.dO * 1.25);
            const walk1Min = Math.max(1, Math.round(walk1Dist / 80));
            const subteMin = Math.round(stationsCount * 2.2);
            const walk2Dist = Math.round(destSt.dD * 1.25);
            const walk2Min = Math.max(1, Math.round(walk2Dist / 80));
            const totalDurationMin = walk1Min + 3 + subteMin + walk2Min; // 3 min espera promedio

            const lineShort = line.short || lineId.replace('Linea', '');
            const lineColor = line.color || SUBTE_FALLBACK_COLORS[lineId] || '#008033';

            // Coordenadas y paradas del tramo en subte
            const startIdx = Math.min(origSt.idx, destSt.idx);
            const endIdx = Math.max(origSt.idx, destSt.idx);
            const subteCoords = [];
            const subteStops = [];
            for (let i = startIdx; i <= endIdx; i++) {
                const sId = stationIds[i];
                const s = stations[sId];
                if (s) {
                    subteCoords.push([s.lat, s.lon]);
                    const role = (sId === origSt.id) ? 'board' : (sId === destSt.id) ? 'alight' : 'waypoint';
                    subteStops.push({ id: sId, name: s.name, lat: s.lat, lon: s.lon, role });
                }
            }
            if (origSt.idx > destSt.idx) {
                subteCoords.reverse();
                subteStops.reverse();
            }

            // Cabecera de dirección
            const headsign = destSt.idx > origSt.idx
                ? (stations[stationIds[stationIds.length - 1]]?.name || 'Cabecera')
                : (stations[stationIds[0]]?.name || 'Cabecera');

            candidates.push({
                id: `subte-direct-${lineId}`,
                type: 'subte',
                title: `Subte Línea ${lineShort}`,
                durationMin: totalDurationMin,
                distanceMeters: walk1Dist + walk2Dist + Math.round(stationsCount * 800),
                summaryPills: [
                    { icon: '🚶', text: `${walk1Min}m`, color: '#64748b' },
                    { icon: '🚇', text: `Línea ${lineShort} (${stationsCount} est.)`, color: lineColor },
                    { icon: '🚶', text: `${walk2Min}m`, color: '#64748b' }
                ],
                legs: [
                    {
                        mode: 'walk',
                        distanceMeters: walk1Dist,
                        durationMin: walk1Min,
                        fromName: origin.label || 'Origen',
                        toName: `Estación ${origSt.name}`,
                        coords: [[origin.lat, origin.lon], [origSt.lat, origSt.lon]]
                    },
                    {
                        mode: 'subte',
                        lineName: `Línea ${lineShort}`,
                        color: lineColor,
                        stationsCount,
                        fromName: `Estación ${origSt.name}`,
                        toName: `Estación ${destSt.name}`,
                        headsign,
                        durationMin: subteMin,
                        coords: subteCoords,
                        stops: subteStops
                    },
                    {
                        mode: 'walk',
                        distanceMeters: walk2Dist,
                        durationMin: walk2Min,
                        fromName: `Estación ${destSt.name}`,
                        toName: destination.label || 'Destino',
                        coords: [[destSt.lat, destSt.lon], [destination.lat, destination.lon]]
                    }
                ],
                steps: [
                    { icon: '🚶', text: `Caminar ${formatDistanceText(walk1Dist)} hasta Estación ${origSt.name} (~${walk1Min} min)` },
                    { icon: '🚇', text: `Tomar Subte Línea ${lineShort} hacia ${headsign} (${stationsCount} estaciones, ~${subteMin} min)` },
                    { icon: '🚶', text: `Bajar en Estación ${destSt.name} y caminar ${formatDistanceText(walk2Dist)} hasta destino (~${walk2Min} min)` }
                ]
            });
        }

        candidates.sort((a, b) => a.durationMin - b.durationMin);
        return candidates.slice(0, 2);
    }

    function buildSubteLegSegment(stationIds, fromStation, toStation, stations) {
        const fromIndex = stationIds.indexOf(fromStation.id);
        const toIndex = stationIds.indexOf(toStation.id);
        if (fromIndex < 0 || toIndex < 0) return null;

        const step = fromIndex <= toIndex ? 1 : -1;
        const stops = [];
        for (let index = fromIndex; ; index += step) {
            const id = stationIds[index];
            const station = stations[id];
            if (station && Number.isFinite(station.lat) && Number.isFinite(station.lon)) {
                stops.push({
                    id,
                    name: station.name,
                    lat: station.lat,
                    lon: station.lon,
                    role: id === fromStation.id ? 'board' : id === toStation.id ? 'alight' : 'waypoint'
                });
            }
            if (index === toIndex) break;
        }
        if (stops.length < 2) return null;
        return {
            coords: stops.map(stop => [stop.lat, stop.lon]),
            stops,
            stationsCount: stops.length - 1
        };
    }

    function findSubteTransferRoutes(origin, destination) {
        const subteStatic = globalThis.cache?.subteStatic;
        const lines = subteStatic?.lines || {};
        const stations = subteStatic?.stations || {};
        if (!lines || Object.keys(lines).length === 0) return [];

        const routes = [];
        const getNearestStations = (stationIds, point) => stationIds
            .map(id => {
                const station = stations[id];
                if (!station || !Number.isFinite(station.lat) || !Number.isFinite(station.lon)) return null;
                return {
                    ...station,
                    id,
                    distance: haversineMeters(point.lat, point.lon, station.lat, station.lon)
                };
            })
            .filter(station => station && station.distance <= 1200)
            .sort((a, b) => a.distance - b.distance);

        // Buscar estación 1 cerca de origen y estación 2 cerca de destino en diferentes líneas
        for (const [line1Id, line1] of Object.entries(lines)) {
            const stIds1 = line1.stations || line1.stationIds || [];
            const near1 = getNearestStations(stIds1, origin);
            if (near1.length === 0) continue;
            const startSt = near1[0];

            for (const [line2Id, line2] of Object.entries(lines)) {
                if (line1Id === line2Id) continue;
                const stIds2 = line2.stations || line2.stationIds || [];
                const near2 = getNearestStations(stIds2, destination);
                if (near2.length === 0) continue;
                const endSt = near2[0];

                // Buscar un nodo de combinación común
                for (const hub of SUBTE_TRANSFER_HUBS) {
                    const findHubStation = stationIds => stationIds
                        .map(id => ({ ...stations[id], id }))
                        .find(station => station && hub.matchNames.some(match =>
                            normalizeText(station.name).includes(normalizeText(match))
                        ));
                    const hubStationL1 = findHubStation(stIds1);
                    const hubStationL2 = findHubStation(stIds2);

                    if (hubStationL1 && hubStationL2 && hubStationL1.name !== startSt.name && hubStationL2.name !== endSt.name) {
                        const firstSegment = buildSubteLegSegment(stIds1, startSt, hubStationL1, stations);
                        const secondSegment = buildSubteLegSegment(stIds2, hubStationL2, endSt, stations);
                        if (!firstSegment || !secondSegment) continue;

                        const walk1Dist = Math.round(startSt.distance * 1.25);
                        const walk1Min = Math.max(1, Math.round(walk1Dist / 80));
                        const walk2Dist = Math.round(endSt.distance * 1.25);
                        const walk2Min = Math.max(1, Math.round(walk2Dist / 80));

                        const l1Short = line1.short || line1Id.replace('Linea', '');
                        const l2Short = line2.short || line2Id.replace('Linea', '');
                        const l1Color = line1.color || SUBTE_FALLBACK_COLORS[line1Id] || '#0072ce';
                        const l2Color = line2.color || SUBTE_FALLBACK_COLORS[line2Id] || '#eb1923';
                        const firstRideMin = Math.max(2, Math.round(firstSegment.stationsCount * 2.2));
                        const secondRideMin = Math.max(2, Math.round(secondSegment.stationsCount * 2.2));

                        const durationMin = walk1Min + 3 + firstRideMin + 4 + secondRideMin + walk2Min;

                        routes.push({
                            id: `subte-transfer-${line1Id}-${line2Id}`,
                            type: 'subte',
                            title: `Subte Líneas ${l1Short} y ${l2Short}`,
                            durationMin,
                            distanceMeters: walk1Dist + walk2Dist
                                + (firstSegment.stationsCount + secondSegment.stationsCount) * 800,
                            summaryPills: [
                                { icon: '🚶', text: `${walk1Min}m`, color: '#64748b' },
                                { icon: '🚇', text: `Línea ${l1Short}`, color: l1Color },
                                { icon: '🔄', text: 'Comb.', color: '#475569' },
                                { icon: '🚇', text: `Línea ${l2Short}`, color: l2Color },
                                { icon: '🚶', text: `${walk2Min}m`, color: '#64748b' }
                            ],
                            legs: [
                                {
                                    mode: 'walk',
                                    distanceMeters: walk1Dist,
                                    durationMin: walk1Min,
                                    fromName: origin.label || 'Origen',
                                    toName: `Estación ${startSt.name}`,
                                    coords: [[origin.lat, origin.lon], [startSt.lat, startSt.lon]]
                                },
                                {
                                    mode: 'subte',
                                    lineName: `Línea ${l1Short}`,
                                    color: l1Color,
                                    stationsCount: firstSegment.stationsCount,
                                    fromName: `Estación ${startSt.name}`,
                                    toName: `Estación ${hubStationL1.name}`,
                                    durationMin: firstRideMin,
                                    coords: firstSegment.coords,
                                    stops: firstSegment.stops
                                },
                                {
                                    mode: 'subte',
                                    isTransfer: true,
                                    lineName: `Línea ${l2Short}`,
                                    color: l2Color,
                                    stationsCount: secondSegment.stationsCount,
                                    fromName: `Estación ${hubStationL2.name}`,
                                    toName: `Estación ${endSt.name}`,
                                    durationMin: secondRideMin,
                                    coords: secondSegment.coords,
                                    stops: secondSegment.stops
                                },
                                {
                                    mode: 'walk',
                                    distanceMeters: walk2Dist,
                                    durationMin: walk2Min,
                                    fromName: `Estación ${endSt.name}`,
                                    toName: destination.label || 'Destino',
                                    coords: [[endSt.lat, endSt.lon], [destination.lat, destination.lon]]
                                }
                            ],
                            steps: [
                                { icon: '🚶', text: `Caminar ${formatDistanceText(walk1Dist)} hasta Estación ${startSt.name}` },
                                { icon: '🚇', text: `Tomar Subte Línea ${l1Short} hasta combinación en ${hub.name}` },
                                { icon: '🔄', text: `Combinar con Subte Línea ${l2Short} (~4 min)` },
                                { icon: '🚇', text: `Viajar en Línea ${l2Short} hasta Estación ${endSt.name}` },
                                { icon: '🚶', text: `Caminar ${formatDistanceText(walk2Dist)} hasta destino (~${walk2Min} min)` }
                            ]
                        });
                        break;
                    }
                }
            }
        }

        routes.sort((a, b) => a.durationMin - b.durationMin);
        return routes.slice(0, 1);
    }

    function findTrainDirectRoutes(origin, destination) {
        const trainStatic = globalThis.cache?.trainStatic;
        const lines = trainStatic?.lines || {};
        const stations = trainStatic?.stations || {};
        if (!lines || Object.keys(lines).length === 0) return [];

        const routes = [];

        for (const [lineKey, line] of Object.entries(lines)) {
            const stIds = line.stations || line.stationIds || [];
            if (!Array.isArray(stIds) || stIds.length < 2) continue;

            const stWithDist = stIds.map((id, idx) => {
                const s = stations[id];
                if (!s || !Number.isFinite(s.lat) || !Number.isFinite(s.lon)) return null;
                const dO = haversineMeters(origin.lat, origin.lon, s.lat, s.lon);
                const dD = haversineMeters(destination.lat, destination.lon, s.lat, s.lon);
                return { id, idx, name: s.name, lat: s.lat, lon: s.lon, dO, dD };
            }).filter(Boolean);

            const nearO = stWithDist.filter(s => s.dO <= 2000).sort((a, b) => a.dO - b.dO);
            const nearD = stWithDist.filter(s => s.dD <= 2000).sort((a, b) => a.dD - b.dD);

            if (nearO.length === 0 || nearD.length === 0) continue;
            const origSt = nearO[0];
            const destSt = nearD[0];
            if (origSt.id === destSt.id) continue;

            const stationsCount = Math.abs(destSt.idx - origSt.idx);
            if (stationsCount === 0) continue;

            const walk1Dist = Math.round(origSt.dO * 1.25);
            const walk1Min = Math.max(1, Math.round(walk1Dist / 80));
            const trainMin = Math.round(stationsCount * 2.8);
            const walk2Dist = Math.round(destSt.dD * 1.25);
            const walk2Min = Math.max(1, Math.round(walk2Dist / 80));
            const totalDurationMin = walk1Min + 6 + trainMin + walk2Min; // 6 min espera promedio tren

            const trainName = line.name || `Tren ${line.short || lineKey}`;
            const lineColor = line.color || TRAIN_FALLBACK_COLORS[lineKey] || '#0080c8';

            const startIdx = Math.min(origSt.idx, destSt.idx);
            const endIdx = Math.max(origSt.idx, destSt.idx);
            const trainCoords = [];
            const trainStops = [];
            for (let i = startIdx; i <= endIdx; i++) {
                const sId = stIds[i];
                const s = stations[sId];
                if (s) {
                    trainCoords.push([s.lat, s.lon]);
                    const role = (sId === origSt.id) ? 'board' : (sId === destSt.id) ? 'alight' : 'waypoint';
                    trainStops.push({ id: sId, name: s.name, lat: s.lat, lon: s.lon, role });
                }
            }
            if (origSt.idx > destSt.idx) {
                trainCoords.reverse();
                trainStops.reverse();
            }

            routes.push({
                id: `train-${lineKey}`,
                type: 'train',
                title: trainName,
                durationMin: totalDurationMin,
                distanceMeters: walk1Dist + walk2Dist + Math.round(stationsCount * 1400),
                summaryPills: [
                    { icon: '🚶', text: `${walk1Min}m`, color: '#64748b' },
                    { icon: '🚆', text: `${trainName} (${stationsCount} est.)`, color: lineColor },
                    { icon: '🚶', text: `${walk2Min}m`, color: '#64748b' }
                ],
                legs: [
                    {
                        mode: 'walk',
                        distanceMeters: walk1Dist,
                        durationMin: walk1Min,
                        fromName: origin.label || 'Origen',
                        toName: `Estación ${origSt.name}`,
                        coords: [[origin.lat, origin.lon], [origSt.lat, origSt.lon]]
                    },
                    {
                        mode: 'train',
                        lineName: trainName,
                        color: lineColor,
                        stationsCount,
                        fromName: `Estación ${origSt.name}`,
                        toName: `Estación ${destSt.name}`,
                        durationMin: trainMin,
                        coords: trainCoords,
                        stops: trainStops
                    },
                    {
                        mode: 'walk',
                        distanceMeters: walk2Dist,
                        durationMin: walk2Min,
                        fromName: `Estación ${destSt.name}`,
                        toName: destination.label || 'Destino',
                        coords: [[destSt.lat, destSt.lon], [destination.lat, destination.lon]]
                    }
                ],
                steps: [
                    { icon: '🚶', text: `Caminar ${formatDistanceText(walk1Dist)} hasta Estación ${origSt.name} (~${walk1Min} min)` },
                    { icon: '🚆', text: `Tomar ${trainName} hasta Estación ${destSt.name} (${stationsCount} estaciones, ~${trainMin} min)` },
                    { icon: '🚶', text: `Caminar ${formatDistanceText(walk2Dist)} hasta destino (~${walk2Min} min)` }
                ]
            });
        }

        routes.sort((a, b) => a.durationMin - b.durationMin);
        return routes.slice(0, 1);
    }

    const bikeRouteNetworkCache = new WeakMap();
    const BIKE_ROUTE_SNAP_DISTANCE_M = 400;

    function getBikeRouteNetwork(source) {
        if (!source || typeof source !== 'object' || !Array.isArray(source.features)) return null;
        const cached = bikeRouteNetworkCache.get(source);
        if (cached) return cached;

        const coordinates = [];
        const adjacency = [];
        const edges = [];
        const nodeIds = new Map();
        const edgeIds = new Set();

        function getNodeId(coordinate) {
            const lon = Number(coordinate?.[0]);
            const lat = Number(coordinate?.[1]);
            if (!Number.isFinite(lat) || !Number.isFinite(lon)) return -1;
            const key = `${Math.round(lon * 100000)}:${Math.round(lat * 100000)}`;
            if (nodeIds.has(key)) return nodeIds.get(key);
            const id = coordinates.length;
            nodeIds.set(key, id);
            coordinates.push([lat, lon]);
            adjacency.push([]);
            return id;
        }

        function addLine(line) {
            if (!Array.isArray(line)) return;
            let previousId = -1;
            for (const coordinate of line) {
                const currentId = getNodeId(coordinate);
                if (currentId < 0) {
                    previousId = -1;
                    continue;
                }
                if (previousId >= 0 && previousId !== currentId) {
                    const edgeKey = `${Math.min(previousId, currentId)}:${Math.max(previousId, currentId)}`;
                    if (!edgeIds.has(edgeKey)) {
                        const from = coordinates[previousId];
                        const to = coordinates[currentId];
                        const distance = haversineMeters(from[0], from[1], to[0], to[1]);
                        if (distance > 0) {
                            edgeIds.add(edgeKey);
                            edges.push({ from: previousId, to: currentId, distance });
                            adjacency[previousId].push({ to: currentId, distance });
                            adjacency[currentId].push({ to: previousId, distance });
                        }
                    }
                }
                previousId = currentId;
            }
        }

        source.features.forEach(feature => {
            const geometry = feature?.geometry;
            if (geometry?.type === 'LineString') {
                addLine(geometry.coordinates);
            } else if (geometry?.type === 'MultiLineString') {
                geometry.coordinates?.forEach(addLine);
            }
        });

        const network = { coordinates, adjacency, edges };
        bikeRouteNetworkCache.set(source, network);
        return network;
    }

    function findNearestBikeRoutePoint(network, point) {
        const latitudeScale = 110540;
        const longitudeScale = 111320 * Math.cos(point.lat * Math.PI / 180);
        let nearest = null;

        network.edges.forEach(edge => {
            const from = network.coordinates[edge.from];
            const to = network.coordinates[edge.to];
            const dx = (to[1] - from[1]) * longitudeScale;
            const dy = (to[0] - from[0]) * latitudeScale;
            const lengthSquared = dx * dx + dy * dy;
            if (lengthSquared === 0) return;

            const px = (point.lon - from[1]) * longitudeScale;
            const py = (point.lat - from[0]) * latitudeScale;
            const fraction = Math.max(0, Math.min(1, (px * dx + py * dy) / lengthSquared));
            const lat = from[0] + (to[0] - from[0]) * fraction;
            const lon = from[1] + (to[1] - from[1]) * fraction;
            const distance = haversineMeters(point.lat, point.lon, lat, lon);
            if (distance <= BIKE_ROUTE_SNAP_DISTANCE_M && (!nearest || distance < nearest.distance)) {
                nearest = { edge, fraction, coordinate: [lat, lon], distance };
            }
        });

        return nearest;
    }

    function findBikeLanePath(network, startPoint, endPoint) {
        if (!network?.edges.length) return null;
        const start = findNearestBikeRoutePoint(network, startPoint);
        const end = findNearestBikeRoutePoint(network, endPoint);
        if (!start || !end) return null;

        const startId = network.coordinates.length;
        const endId = startId + 1;
        const adjacency = network.adjacency.slice();
        adjacency.push([], []);
        const addTemporaryEdge = (from, to, distance) => {
            adjacency[from].push({ to, distance });
            adjacency[to].push({ to: from, distance });
        };

        addTemporaryEdge(startId, start.edge.from, start.edge.distance * start.fraction);
        addTemporaryEdge(startId, start.edge.to, start.edge.distance * (1 - start.fraction));
        addTemporaryEdge(endId, end.edge.from, end.edge.distance * end.fraction);
        addTemporaryEdge(endId, end.edge.to, end.edge.distance * (1 - end.fraction));
        if (start.edge.from === end.edge.from && start.edge.to === end.edge.to ||
            start.edge.from === end.edge.to && start.edge.to === end.edge.from) {
            addTemporaryEdge(startId, endId, start.edge.distance * Math.abs(start.fraction - end.fraction));
        }

        const distances = new Float64Array(adjacency.length);
        distances.fill(Infinity);
        const previous = new Int32Array(adjacency.length);
        previous.fill(-1);
        const heap = [];
        const push = (item) => {
            heap.push(item);
            let index = heap.length - 1;
            while (index > 0) {
                const parent = Math.floor((index - 1) / 2);
                if (heap[parent].distance <= item.distance) break;
                heap[index] = heap[parent];
                index = parent;
            }
            heap[index] = item;
        };
        const pop = () => {
            const first = heap[0];
            const last = heap.pop();
            if (heap.length > 0) {
                let index = 0;
                while (true) {
                    const left = index * 2 + 1;
                    const right = left + 1;
                    if (left >= heap.length) break;
                    const child = right < heap.length && heap[right].distance < heap[left].distance ? right : left;
                    if (heap[child].distance >= last.distance) break;
                    heap[index] = heap[child];
                    index = child;
                }
                heap[index] = last;
            }
            return first;
        };

        distances[startId] = 0;
        push({ id: startId, distance: 0 });
        while (heap.length > 0) {
            const current = pop();
            if (current.distance !== distances[current.id]) continue;
            if (current.id === endId) break;
            adjacency[current.id].forEach(edge => {
                const distance = current.distance + edge.distance;
                if (distance < distances[edge.to]) {
                    distances[edge.to] = distance;
                    previous[edge.to] = current.id;
                    push({ id: edge.to, distance });
                }
            });
        }
        if (!Number.isFinite(distances[endId])) return null;

        const path = [];
        for (let id = endId; id >= 0; id = previous[id]) {
            path.push(id);
            if (id === startId) break;
        }
        if (path[path.length - 1] !== startId) return null;
        path.reverse();

        const pathCoordinates = path.map(id => id === startId
            ? start.coordinate
            : id === endId ? end.coordinate : network.coordinates[id]);
        const routeCoordinates = [[startPoint.lat, startPoint.lon], ...pathCoordinates, [endPoint.lat, endPoint.lon]];
        const compactCoordinates = routeCoordinates.filter((coordinate, index) => {
            if (index === 0) return true;
            const previousCoordinate = routeCoordinates[index - 1];
            return haversineMeters(
                coordinate[0], coordinate[1],
                previousCoordinate[0], previousCoordinate[1]
            ) >= 0.5;
        });
        let distanceMeters = 0;
        for (let index = 1; index < compactCoordinates.length; index += 1) {
            distanceMeters += haversineMeters(
                compactCoordinates[index - 1][0], compactCoordinates[index - 1][1],
                compactCoordinates[index][0], compactCoordinates[index][1]
            );
        }
        return { coords: compactCoordinates, distanceMeters };
    }

    function findBikeRoute(origin, destination, distDirect) {
        const bikes = Array.isArray(globalThis.cache?.bike) ? globalThis.cache.bike : [];
        if (bikes.length === 0) return null;

        // Estación origen: buscar estaciones en un radio de hasta 1500m
        const nearOrigin = bikes
            .map(b => ({ ...b, d: haversineMeters(origin.lat, origin.lon, b.lat, b.lon) }))
            .filter(b => b.d <= 1500)
            .sort((a, b) => a.d - b.d);

        // Estación destino: buscar estaciones en un radio de hasta 1500m
        const nearDest = bikes
            .map(b => ({ ...b, d: haversineMeters(destination.lat, destination.lon, b.lat, b.lon) }))
            .filter(b => b.d <= 1500)
            .sort((a, b) => a.d - b.d);

        if (nearOrigin.length === 0 || nearDest.length === 0) return null;

        // Priorizar estación con bicis disponibles en origen; si ninguna tiene, tomar la más cercana
        const originWithBikes = nearOrigin.filter(b => Number(b.num_bikes_available || 0) > 0);
        const stO = originWithBikes.length > 0 ? originWithBikes[0] : nearOrigin[0];

        // Priorizar estación con anclajes disponibles en destino; si ninguna tiene, tomar la más cercana
        const destWithDocks = nearDest.filter(b => Number(b.num_docks_available || 0) > 0);
        const stD = destWithDocks.length > 0 ? destWithDocks[0] : nearDest[0];

        if (stO.station_id === stD.station_id) return null;

        const walk1Dist = Math.round(stO.d * 1.25);
        const walk1Min = Math.max(1, Math.round(walk1Dist / 80));
        const walk2Dist = Math.round(stD.d * 1.25);
        const walk2Min = Math.max(1, Math.round(walk2Dist / 80));

        const network = getBikeRouteNetwork(globalThis.cache?.bikeRoutes);
        const bikePath = findBikeLanePath(network, stO, stD);
        if (!bikePath) return null;
        const bikeRouteCoords = bikePath.coords;
        const bikeDist = Math.round(bikePath.distanceMeters);
        const bikeMin = Math.max(2, Math.round(bikeDist / 230)); // ~14 km/h en bici

        const bikeStops = [
            { id: stO.station_id, name: stO.name, lat: stO.lat, lon: stO.lon, role: 'board' },
            { id: stD.station_id, name: stD.name, lat: stD.lat, lon: stD.lon, role: 'alight' }
        ];

        const totalDurationMin = walk1Min + 2 + bikeMin + walk2Min; // 2 min desbloqueo

        return {
            id: 'ecobici',
            type: 'bike',
            title: 'Ecobici',
            durationMin: totalDurationMin,
            distanceMeters: walk1Dist + bikeDist + walk2Dist,
            summaryPills: [
                { icon: '🚶', text: `${walk1Min}m`, color: '#64748b' },
                { icon: '🚲', text: `Ecobici (${Math.round(bikeDist / 1000 * 10) / 10} km)`, color: '#10b981' },
                { icon: '🚶', text: `${walk2Min}m`, color: '#64748b' }
            ],
            legs: [
                {
                    mode: 'walk',
                    distanceMeters: walk1Dist,
                    durationMin: walk1Min,
                    fromName: origin.label || 'Origen',
                    toName: `Estación ${stO.name}`,
                    coords: [[origin.lat, origin.lon], [stO.lat, stO.lon]]
                },
                {
                    mode: 'bike',
                    color: '#10b981',
                    fromName: stO.name,
                    toName: stD.name,
                    durationMin: bikeMin,
                    distanceMeters: bikeDist,
                    coords: bikeRouteCoords,
                    stops: bikeStops
                },
                {
                    mode: 'walk',
                    distanceMeters: walk2Dist,
                    durationMin: walk2Min,
                    fromName: `Estación ${stD.name}`,
                    toName: destination.label || 'Destino',
                    coords: [[stD.lat, stD.lon], [destination.lat, destination.lon]]
                }
            ],
            steps: [
                { icon: '🚶', text: `Caminar ${formatDistanceText(walk1Dist)} a Estación Ecobici ${stO.name}` },
                { icon: '🚲', text: `Pedalear ${formatDistanceText(bikeDist)} por ciclovías hasta Estación ${stD.name} (~${bikeMin} min)` },
                { icon: '🚶', text: `Anclar bici y caminar ${formatDistanceText(walk2Dist)} hasta destino` }
            ]
        };
    }

    // ─── Búsqueda de colectivos usando recorridos GTFS estáticos ────────────────
    // Usa loadStaticRouteFile y decodeStaticPolyline de markers-bus-overlay.js.
    // Fallback a estimación si los archivos estáticos no están disponibles.

    // Radio máximo en metros para considerar que un shape "pasa cerca" de un punto.
    const BUS_STOP_RADIUS_M = 400;
    // Mínima fracción del recorrido (0-1) que debe haber entre el punto de subida y bajada.
    // Evita rutas donde origen y destino están en el mismo segmento extremo del recorrido.
    const BUS_MIN_COVERAGE = 0.05;
    // Máximo de líneas candidatas a evaluar (por performance)
    const BUS_MAX_CANDIDATES = 60;
    // Máximo de líneas en el resultado
    const BUS_MAX_RESULTS = 2;

    // Encuentra el índice del punto del shape más cercano a un punto geográfico,
    // dentro del radio dado. Devuelve -1 si ningún punto está en rango.
    function findNearestShapePoint(shape, lat, lon, radiusM) {
        let bestIdx = -1;
        let bestDist = radiusM;
        for (let i = 0; i < shape.length; i++) {
            const pt = shape[i];
            const d = haversineMeters(lat, lon, pt.lat, pt.lon);
            if (d < bestDist) {
                bestDist = d;
                bestIdx = i;
            }
        }
        return { idx: bestIdx, dist: bestDist };
    }

    // Calcula la distancia acumulada en metros de un segmento del shape (de idxA a idxB inclusive).
    function shapeSegmentLengthM(shape, idxA, idxB) {
        let total = 0;
        const start = Math.min(idxA, idxB);
        const end = Math.max(idxA, idxB);
        for (let i = start; i < end; i++) {
            total += haversineMeters(shape[i].lat, shape[i].lon, shape[i + 1].lat, shape[i + 1].lon);
        }
        return total;
    }

    // Intenta encontrar líneas de colectivo con recorridos reales que conecten origen y destino.
    // Devuelve array de opciones (puede ser vacío si los estáticos no están disponibles).
    async function findBusRoutesFromStatic(origin, destination) {
        // Verificar que las funciones de markers-bus-overlay.js están disponibles
        if (typeof loadStaticRouteFile !== 'function' ||
            typeof decodeStaticPolyline !== 'function' ||
            typeof getStaticRouteFileBase !== 'function') {
            return [];
        }

        // Verificar que los recorridos estáticos están disponibles (HEAD a index.json)
        let available = false;
        try {
            available = await areStaticRoutesAvailable();
        } catch {
            return [];
        }
        if (!available) return [];

        // Leer el index para obtener la lista de líneas
        let indexData = null;
        try {
            const result = await fetchStaticRouteResource('index.json');
            if (result.ok && result.data && typeof result.data.lines === 'object') {
                indexData = result.data;
            }
        } catch {
            return [];
        }
        if (!indexData) return [];

        const lineNames = Object.keys(indexData.lines || {});
        // Limitar candidatos para no hacer demasiados fetch
        const candidates = lineNames.slice(0, BUS_MAX_CANDIDATES);

        // Archivos únicos a cargar (varias líneas pueden compartir archivo por número base)
        const fileBases = new Set(candidates.map(name => {
            const info = indexData.lines[name];
            return info && info.file ? info.file : getStaticRouteFileBase(name);
        }));

        const results = [];

        for (const base of fileBases) {
            if (results.length >= BUS_MAX_RESULTS) break;
            let file = null;
            try {
                file = await loadStaticRouteFile(base);
            } catch {
                continue;
            }
            if (!file || !file.variants) continue;

            // Evaluar cada variante del archivo
            for (const [variantId, variant] of Object.entries(file.variants)) {
                if (results.length >= BUS_MAX_RESULTS) break;
                const encoded = variant.shape;
                if (!encoded) continue;

                // Decodificar shape (cacheado en _decodedShape por adaptStaticRouteVariant)
                if (!variant._decodedShape) {
                    variant._decodedShape = decodeStaticPolyline(encoded);
                }
                const shape = variant._decodedShape;
                if (!shape || shape.length < 4) continue;

                // Buscar punto del shape más cercano al origen
                const nearO = findNearestShapePoint(shape, origin.lat, origin.lon, BUS_STOP_RADIUS_M);
                if (nearO.idx === -1) continue;

                // Buscar punto del shape más cercano al destino
                const nearD = findNearestShapePoint(shape, destination.lat, destination.lon, BUS_STOP_RADIUS_M);
                if (nearD.idx === -1) continue;

                // El colectivo debe recorrer el trayecto en la dirección correcta
                // (el índice de bajada debe ser mayor que el de subida)
                if (nearD.idx <= nearO.idx) continue;

                // Verificar que hay suficiente recorrido entre los dos puntos
                const coverage = (nearD.idx - nearO.idx) / (shape.length - 1);
                if (coverage < BUS_MIN_COVERAGE) continue;

                // Calcular distancias y tiempos
                const walk1Dist = Math.round(nearO.dist * 1.25);
                const walk1Min = Math.max(1, Math.round(walk1Dist / 80));
                const walk2Dist = Math.round(nearD.dist * 1.25);
                const walk2Min = Math.max(1, Math.round(walk2Dist / 80));

                // Distancia real del recorrido en colectivo (siguiendo el shape)
                const busDist = Math.round(shapeSegmentLengthM(shape, nearO.idx, nearD.idx) * 1.05);
                const busMin = Math.max(3, Math.round(busDist / 220)); // ~13 km/h promedio en CABA

                const totalDurationMin = walk1Min + 5 + busMin + walk2Min; // 5 min espera promedio

                const lineShort = variant.short || base;
                const headsign = variant.headsign || '';

                // Coordenadas reales del tramo en colectivo (subconjunto del shape)
                const busCoords = shape.slice(nearO.idx, nearD.idx + 1).map(pt => [pt.lat, pt.lon]);

                // Punto de subida (parada más cercana al origen, o punto del shape)
                const boardPt = shape[nearO.idx];
                // Punto de bajada
                const alightPt = shape[nearD.idx];

                // Buscar paradas del variant cerca del punto de subida y bajada
                let boardStop = null;
                let alightStop = null;
                if (Array.isArray(variant.stops) && file.stops) {
                    // Encontrar parada más cercana al punto nearO.idx
                    let bestBoardDist = 300;
                    let bestAlightDist = 300;
                    for (const stopId of variant.stops) {
                        const stopData = file.stops[stopId];
                        if (!Array.isArray(stopData) || stopData.length < 3) continue;
                        const sLat = stopData[1];
                        const sLon = stopData[2];
                        const dBoard = haversineMeters(boardPt.lat, boardPt.lon, sLat, sLon);
                        const dAlight = haversineMeters(alightPt.lat, alightPt.lon, sLat, sLon);
                        if (dBoard < bestBoardDist) {
                            bestBoardDist = dBoard;
                            boardStop = { name: stopData[0], lat: sLat, lon: sLon };
                        }
                        if (dAlight < bestAlightDist) {
                            bestAlightDist = dAlight;
                            alightStop = { name: stopData[0], lat: sLat, lon: sLon };
                        }
                    }
                }

                const boardName = boardStop?.name || `Parada ${lineShort}`;
                const alightName = alightStop?.name || `Parada ${lineShort} (bajada)`;
                const boardLatLon = boardStop ? [boardStop.lat, boardStop.lon] : [boardPt.lat, boardPt.lon];
                const alightLatLon = alightStop ? [alightStop.lat, alightStop.lon] : [alightPt.lat, alightPt.lon];

                // Color de la línea (desde cache activo de colectivos si está disponible)
                let badgeColor = '#4f46e5';
                if (typeof getColor === 'function') badgeColor = getColor('bus', lineShort);

                // Evitar duplicados: si ya hay una variante de la misma línea base, saltear
                const lineBase = lineShort.replace(/[^0-9]/g, '') || lineShort;
                const alreadyAdded = results.some(r => (r._lineBase || '') === lineBase);
                if (alreadyAdded) continue;

                const route = {
                    id: `bus-${variantId}`,
                    type: 'bus',
                    title: `Línea ${lineShort}`,
                    _lineBase: lineBase,
                    durationMin: totalDurationMin,
                    distanceMeters: walk1Dist + busDist + walk2Dist,
                    summaryPills: [
                        { icon: '🚶', text: `${walk1Min}m`, color: '#64748b' },
                        { icon: '🚌', text: `Línea ${lineShort}${headsign ? ` → ${headsign}` : ''}`, color: badgeColor },
                        { icon: '🚶', text: `${walk2Min}m`, color: '#64748b' }
                    ],
                    legs: [
                        {
                            mode: 'walk',
                            distanceMeters: walk1Dist,
                            durationMin: walk1Min,
                            fromName: origin.label || 'Origen',
                            toName: boardName,
                            coords: [[origin.lat, origin.lon], boardLatLon]
                        },
                        {
                            mode: 'bus',
                            lineName: `Línea ${lineShort}`,
                            color: badgeColor,
                            durationMin: busMin,
                            distanceMeters: busDist,
                            headsign,
                            fromName: boardName,
                            toName: alightName,
                            coords: busCoords,
                            stops: [
                                boardStop ? { name: boardStop.name, lat: boardStop.lat, lon: boardStop.lon, role: 'board' } : null,
                                alightStop ? { name: alightStop.name, lat: alightStop.lat, lon: alightStop.lon, role: 'alight' } : null
                            ].filter(Boolean)
                        },
                        {
                            mode: 'walk',
                            distanceMeters: walk2Dist,
                            durationMin: walk2Min,
                            fromName: alightName,
                            toName: destination.label || 'Destino',
                            coords: [alightLatLon, [destination.lat, destination.lon]]
                        }
                    ],
                    steps: [
                        { icon: '🚶', text: `Caminar ${formatDistanceText(walk1Dist)} hasta la parada de Línea ${lineShort} (~${walk1Min} min)` },
                        { icon: '🚌', text: `Tomar Línea ${lineShort}${headsign ? ` hacia ${headsign}` : ''} (~${busMin} min, ${formatDistanceText(busDist)})` },
                        { icon: '🚶', text: `Bajar en ${alightName} y caminar ${formatDistanceText(walk2Dist)} hasta destino (~${walk2Min} min)` }
                    ]
                };

                results.push(route);
            }
        }

        // Limpiar campo interno antes de devolver
        results.forEach(r => { delete r._lineBase; });
        return results;
    }

    async function findBusRouteOptions(origin, destination) {
        const useStaticFallback = async () => {
            try {
                return await findBusRoutesFromStatic(origin, destination);
            } catch (error) {
                console.warn('No se pudieron cargar recorridos estáticos de colectivos:', error);
                return [];
            }
        };
        if (typeof fetchAPI !== 'function') return useStaticFallback();

        const path = globalThis.APP_CONFIG?.PATHS?.busRoutePlan || '/planificar-colectivo';
        const endpoint = `${path}?origin_lat=${encodeURIComponent(origin.lat)}&origin_lon=${encodeURIComponent(origin.lon)}`
            + `&destination_lat=${encodeURIComponent(destination.lat)}&destination_lon=${encodeURIComponent(destination.lon)}`;
        const response = await fetchAPI(endpoint);
        if (!response?.success) return useStaticFallback();
        if (!Array.isArray(response.data?.routes)) {
            console.warn('El Worker respondió con un formato inválido al planificar colectivos.');
            return useStaticFallback();
        }

        const rawRoutes = response.data.routes
            .filter(route => route?.type === 'bus' && Number.isFinite(route.durationMin) &&
                Array.isArray(route.legs) && Array.isArray(route.steps) && Array.isArray(route.summaryPills))
            .map(route => {
                const normalized = { ...route, legs: route.legs.map(leg => ({ ...leg })) };
                const firstWalk = normalized.legs.find(leg => leg.mode === 'walk');
                const lastWalk = [...normalized.legs].reverse().find(leg => leg.mode === 'walk');
                if (firstWalk) firstWalk.fromName = origin.label || 'Origen';
                if (lastWalk) lastWalk.toName = destination.label || 'Destino';
                return normalized;
            });

        // Agrupar ramales del mismo conjunto de líneas: conservar solo el más rápido por ramal
        const seenLineBases = new Map();
        for (const route of rawRoutes) {
            const key = getRouteBusLinesKey(route);
            const existing = seenLineBases.get(key);
            if (!existing || route.durationMin < existing.durationMin) {
                seenLineBases.set(key, route);
            }
        }
        return Array.from(seenLineBases.values());
    }

    function formatDistanceText(meters) {
        if (!Number.isFinite(meters) || meters <= 0) return '0 m';
        if (meters < 1000) return `${Math.round(meters)} m`;
        return `${(meters / 1000).toFixed(1)} km`;
    }

    // ─── Renderizado de Resultados en el Panel ───────────────────────────────────

    function renderDirectionsInitialPrompt() {
        const container = document.getElementById('directions-results');
        if (!container) return;
        container.innerHTML = `
            <p class="directions-empty">Ingresá un destino o tocá el mapa para calcular cómo llegar.</p>
        `;
    }

    function renderDirectionsLoading() {
        const container = document.getElementById('directions-results');
        if (!container) return;
        container.innerHTML = `
            <div class="directions-loading">
                <i aria-hidden="true" data-lucide="loader-2" class="w-6 h-6 animate-spin text-indigo-500"></i>
                <span>Buscando las mejores rutas en AMBA...</span>
            </div>
        `;
        if (typeof createLucideIconsIn === 'function') {
            createLucideIconsIn(container);
        }
    }

    function renderDirectionsResults() {
        const container = document.getElementById('directions-results');
        if (!container) return;

        const routes = directionsState.routes;
        if (!routes || routes.length === 0) {
            container.innerHTML = `
                <p class="directions-empty">No se encontraron rutas directas para los puntos seleccionados.</p>
            `;
            return;
        }

        const safeHtml = typeof escapeHtml === 'function' ? escapeHtml : str => String(str || '');

        container.innerHTML = routes.map((route, index) => {
            const isActive = index === directionsState.selectedRouteIndex;
            const tagBadge = route.tag ? `<span class="card-tag ${route.tagClass || ''}">${safeHtml(route.tag)}</span>` : '';

            const pillsHtml = route.summaryPills.map((pill, pIdx) => `
                ${pIdx > 0 ? '<span class="leg-arrow" aria-hidden="true">➔</span>' : ''}
                <span class="leg-pill" style="background-color: ${safeHtml(pill.color)}15; color: ${safeHtml(pill.color)}; border: 1px solid ${safeHtml(pill.color)}40;">
                    <span aria-hidden="true">${safeHtml(pill.icon)}</span>
                    <span>${safeHtml(pill.text)}</span>
                </span>
            `).join('');

            const stepsHtml = route.steps.map(step => `
                <div class="step-item">
                    <span class="step-icon" aria-hidden="true">${safeHtml(step.icon)}</span>
                    <span class="step-desc">${safeHtml(step.text)}</span>
                </div>
            `).join('');

            return `
                <div class="directions-card ${isActive ? 'is-active' : ''}" data-route-index="${index}" role="button" tabindex="0" aria-pressed="${isActive}">
                    <div class="card-header-row">
                        <div class="card-duration-wrap">
                            <span class="card-duration">⏱️ ${route.durationMin} min</span>
                            <span class="card-distance">(${formatDistanceText(route.distanceMeters)})</span>
                        </div>
                        ${tagBadge}
                    </div>
                    <div class="card-legs-flow">
                        ${pillsHtml}
                    </div>
                    <div class="card-steps-list">
                        ${stepsHtml}
                    </div>
                </div>
            `;
        }).join('');

        container.querySelectorAll('.directions-card').forEach(card => {
            card.addEventListener('click', () => {
                const idx = Number(card.dataset.routeIndex);
                selectDirectionsRoute(idx);
            });
            card.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    const idx = Number(card.dataset.routeIndex);
                    selectDirectionsRoute(idx);
                }
            });
        });
    }

    function selectDirectionsRoute(index) {
        if (!directionsState.routes[index]) return;
        directionsState.selectedRouteIndex = index;

        // Actualizar visual de tarjetas
        const cards = document.querySelectorAll('.directions-card');
        cards.forEach((c, i) => {
            const active = i === index;
            c.classList.toggle('is-active', active);
            c.setAttribute('aria-pressed', String(active));
        });

        // Dibujar en el mapa
        drawDirectionsRoute(directionsState.routes[index]);
    }

    // ─── Dibujo en el mapa con Leaflet ──────────────────────────────────────────

    // Extrae los identificadores de líneas de la ruta activa para filtrar el mapa en tiempo real.
    // Devuelve { busLines: Set<string>, subteLines: Set<string>, trainLines: Set<string>, hasBike: boolean }
    function getActiveRouteTransitIds(route, allRoutes) {
        const busLines = new Set();
        const subteLines = new Set();
        const trainLines = new Set();
        const bikeStationIds = new Set();
        const bikeRouteCoords = [];
        let hasBike = false;
        const hideSubteLayers = route?.type === 'subte';
        const hideTrainLayers = route?.type === 'train';

        // Si se seleccionó una ruta específica con transporte, priorizar esa ruta; si es caminata, mostrar todos los transportes sugeridos
        const targetRoutes = (route && route.type !== 'walk') ? [route] : (allRoutes || [route]).filter(Boolean);
        for (const r of targetRoutes) {
            if (r.type === 'bike') hasBike = true;
            for (const leg of (r.legs || [])) {
                if (leg.mode === 'bike') {
                    if (Array.isArray(leg.coords)) bikeRouteCoords.push(leg.coords);
                    (leg.stops || []).forEach(stop => {
                        if (stop.id !== undefined && stop.id !== null) bikeStationIds.add(String(stop.id));
                    });
                } else if (leg.mode === 'bus' && leg.lineName) {
                    const base = leg.lineName.replace(/[^0-9]/g, '') || leg.lineName;
                    busLines.add(base);
                    busLines.add(leg.lineName.replace(/Línea\s*/i, '').trim());
                } else if (leg.mode === 'subte' && leg.lineName) {
                    const sShort = leg.lineName.replace(/Línea\s*/i, '').trim();
                    subteLines.add(sShort);
                    subteLines.add(`Linea${sShort}`);
                } else if (leg.mode === 'train' && leg.lineName) {
                    const tName = leg.lineName.trim();
                    trainLines.add(tName);
                    const clean = tName.toLowerCase().replace(/^tren\s*/, '');
                    trainLines.add(clean);
                }
            }
        }
        return {
            busLines,
            subteLines,
            trainLines,
            hasBike,
            bikeStationIds,
            bikeRouteCoords,
            hideSubteLayers,
            hideTrainLayers
        };
    }

    // Construye el HTML del horario en tiempo real para una estación de subte/tren.
    function buildStationScheduleHtml(mode, stationName, stationId, lineId) {
        const safeHtml = typeof escapeHtml === 'function' ? escapeHtml : s => String(s || '');
        let rows = [];

        if (mode === 'subte') {
            const byBaseStop = globalThis.cache?.subteForecastByBaseStop || {};
            const byName = globalThis.cache?.subteForecastByName || {};
            const baseId = stationId ? String(stationId).replace(/-[^-]*$/, '') : null;
            const arrivals = (baseId && byBaseStop[baseId]) || byName[typeof normalizeText === 'function' ? normalizeText(stationName) : stationName.toLowerCase()] || [];
            const nowTs = Math.floor(Date.now() / 1000);
            rows = arrivals
                .filter(a => !lineId || a.routeId?.includes(lineId) || a.routeShort?.includes(lineId))
                .slice(0, 5)
                .map(a => {
                    const eta = a.arrivalTime - nowTs;
                    const etaText = eta <= 0 ? 'Ahora' : eta < 60 ? `${eta}s` : `${Math.round(eta / 60)} min`;
                    return `<div style="display:flex;justify-content:space-between;gap:12px;font-size:11px;padding:2px 0">
                        <span style="color:#cbd5e1">${safeHtml(a.destination || '-')}</span>
                        <span style="color:#fbbf24;font-weight:700">${etaText}</span>
                    </div>`;
                });
        } else if (mode === 'train') {
            const arrivalsByStation = globalThis.cache?.trainArrivalsByStation || {};
            const normName = typeof normalizeText === 'function' ? normalizeText(stationName) : stationName.toLowerCase();
            let data = (stationId && arrivalsByStation[stationId]?.data) || arrivalsByStation[stationName]?.data;
            if (!data) {
                for (const [k, v] of Object.entries(arrivalsByStation)) {
                    if (typeof normalizeText === 'function' && normalizeText(k).includes(normName)) {
                        data = v.data;
                        break;
                    }
                }
            }
            const arrivals = Array.isArray(data?.arrivals) ? data.arrivals : [];
            const nowTs = Math.floor(Date.now() / 1000);
            rows = arrivals.slice(0, 5).map(a => {
                const estimatedTs = Number(a.estimatedArrivalTs);
                const eta = Number.isFinite(estimatedTs) && estimatedTs > 0
                    ? estimatedTs - nowTs
                    : Number(a.etaSeconds);
                const etaText = !Number.isFinite(eta) || eta < 0 ? '-'
                    : eta <= 0 ? 'Ahora' : eta < 60 ? `${eta}s` : `${Math.round(eta / 60)} min`;
                return `<div style="display:flex;justify-content:space-between;gap:12px;font-size:11px;padding:2px 0">
                    <span style="color:#cbd5e1">${safeHtml(a.destino || '-')}</span>
                    <span style="color:#fbbf24;font-weight:700">${etaText}</span>
                </div>`;
            });
        }

        const scheduleSection = rows.length > 0
            ? `<div style="margin-top:6px;border-top:1px solid rgba(255,255,255,0.12);padding-top:5px">${rows.join('')}</div>`
            : `<div style="margin-top:5px;font-size:10px;color:#94a3b8">Sin arribos en tiempo real en este momento</div>`;

        return `
            <div style="font-size:12px;font-weight:700;color:#f1f5f9;margin-bottom:2px">${safeHtml(stationName)}</div>
            ${scheduleSection}
        `;
    }

    function drawDirectionsRoute(route) {
        const layer = getDirectionsLayer();
        if (!layer) return;
        layer.clearLayers();

        if (!route || !Array.isArray(route.legs)) {
            // Sin ruta activa: restaurar renderizado completo del mapa
            globalThis._directionsActiveTransit = null;
            if (typeof scheduleRenderMarkers === 'function') scheduleRenderMarkers(50, { force: true });
            return;
        }

        // Guardar los identificadores de la ruta activa para que renderMarkers pueda filtrar
        globalThis._directionsActiveTransit = getActiveRouteTransitIds(route, directionsState.routes);
        if (typeof scheduleRenderMarkers === 'function') scheduleRenderMarkers(50, { force: true });

        const allLatLngs = [];

        // 1. Dibujar piernas de ruta
        route.legs.forEach(leg => {
            const coords = leg.coords || [];
            if (coords.length < 2) return;

            coords.forEach(pt => allLatLngs.push(pt));

            if (leg.mode === 'walk') {
                L.polyline(coords, {
                    color: '#64748b',
                    weight: 4,
                    dashArray: '6, 8',
                    opacity: 0.9
                }).addTo(layer);
            } else {
                // Transit leg (subte, train, bus, bike)
                const color = leg.color || '#4f46e5';
                L.polyline(coords, {
                    color,
                    weight: 6,
                    opacity: 0.95
                }).addTo(layer);

                // Si tiene paradas intermedias/cabeceras
                if (Array.isArray(leg.stops) && leg.mode !== 'subte' && leg.mode !== 'train') {
                    leg.stops.forEach(st => {
                        const isWaypoint = st.role === 'waypoint';
                        const marker = L.circleMarker([st.lat, st.lon], {
                            radius: isWaypoint ? 4 : 6,
                            fillColor: isWaypoint ? color : '#ffffff',
                            color,
                            weight: isWaypoint ? 1.5 : 2.5,
                            fillOpacity: isWaypoint ? 0.7 : 1,
                            opacity: isWaypoint ? 0.8 : 1
                        }).addTo(layer);
                        const label = isWaypoint
                            ? `Estación Ecobici ${st.name}`
                            : `<b>Estación ${st.name}</b>`;
                        marker.bindTooltip(label, { direction: 'top', offset: [0, -6] });
                    });
                }

                // ── Estaciones de subte/tren con horarios en tiempo real ────────────────
                if ((leg.mode === 'subte' || leg.mode === 'train') && Array.isArray(leg.stops)) {
                    leg.stops.forEach(st => {
                        const lineId = leg.mode === 'subte'
                            ? (leg.lineName || '').replace(/Línea\s*/i, '').trim()
                            : null;
                        const baseIconSpec = typeof getMarkerIconSpec === 'function'
                            ? getMarkerIconSpec(leg.mode, st.name, color, st)
                            : null;
                        const stationIcon = baseIconSpec && typeof buildMarkerIcon === 'function'
                            ? buildMarkerIcon(leg.mode, st.name, color, { ...baseIconSpec, dot: false })
                            : L.divIcon({
                                className: '',
                                html: `<div class="marker-container"><div class="vehicle-label">${escapeHtml(st.name)}</div></div>`,
                                iconSize: [36, 24],
                                iconAnchor: [18, 12]
                            });
                        const stationMarker = L.marker([st.lat, st.lon], {
                            icon: stationIcon,
                            zIndexOffset: 100
                        }).addTo(layer);
                        stationMarker.bindTooltip(
                            () => buildStationScheduleHtml(leg.mode, st.name, st.id, lineId),
                            { className: 'tooltip-dark directions-station-tooltip', direction: 'top', offset: [0, -12], sticky: false }
                        );
                    });
                }
            }
        });

        // 2. Marcador Origen (A)
        const origin = directionsState.origin;
        if (origin) {
            allLatLngs.push([origin.lat, origin.lon]);
            const originMarker = L.marker([origin.lat, origin.lon], {
                icon: L.divIcon({
                    className: 'directions-pin-origin',
                    html: '<div style="background:#10b981; color:#fff; font-weight:800; font-size:12px; width:26px; height:26px; border-radius:50%; display:grid; place-items:center; box-shadow:0 2px 6px rgba(0,0,0,0.3); border:2px solid #fff;">A</div>',
                    iconSize: [26, 26],
                    iconAnchor: [13, 13]
                })
            }).addTo(layer);
            originMarker.bindTooltip(`<b>Origen:</b> ${origin.label || 'Inicio'}`, { direction: 'top', offset: [0, -14] });
        }

        // 3. Marcador Destino (B)
        const dest = directionsState.destination;
        if (dest) {
            allLatLngs.push([dest.lat, dest.lon]);
            const destMarker = L.marker([dest.lat, dest.lon], {
                icon: L.divIcon({
                    className: 'directions-pin-dest',
                    html: '<div style="background:#e11d48; color:#fff; font-weight:800; font-size:12px; width:26px; height:26px; border-radius:50%; display:grid; place-items:center; box-shadow:0 2px 6px rgba(0,0,0,0.3); border:2px solid #fff;">B</div>',
                    iconSize: [26, 26],
                    iconAnchor: [13, 13]
                })
            }).addTo(layer);
            destMarker.bindTooltip(`<b>Destino:</b> ${dest.label || 'Llegada'}`, { direction: 'top', offset: [0, -14] });
        }

        // 4. Ajustar vista del mapa para encuadrar todo el trayecto
        const mapInstance = typeof map !== 'undefined' ? map : null;
        if (mapInstance && allLatLngs.length > 0) {
            try {
                const bounds = L.latLngBounds(allLatLngs);
                mapInstance.fitBounds(bounds, { padding: [50, 50], maxZoom: 16 });
            } catch {}
        }
    }

    // ─── Setup Inicial ───────────────────────────────────────────────────────────

    function initDirectionsEvents() {
        const originInput = document.getElementById('directions-origin');
        const destInput = document.getElementById('directions-dest');

        if (originInput) {
            originInput.addEventListener('input', (e) => handleDirectionsInput('origin', e.target.value));
            originInput.addEventListener('focus', () => {
                if (originInput.value.trim().length >= 2) handleDirectionsInput('origin', originInput.value);
            });
        }

        if (destInput) {
            destInput.addEventListener('input', (e) => handleDirectionsInput('destination', e.target.value));
            destInput.addEventListener('focus', () => {
                if (destInput.value.trim().length >= 2) handleDirectionsInput('destination', destInput.value);
            });
        }

        // Cerrar sugerencias al hacer click fuera
        document.addEventListener('click', (e) => {
            const container = document.getElementById('directions-panel');
            const suggestions = document.getElementById('directions-suggestions');
            if (suggestions && !suggestions.hidden && !container?.contains(e.target)) {
                hideSuggestions();
            }
        });

        // Cerrar panel con tecla Escape si está abierto
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && (directionsState.isOpen || document.getElementById('directions-panel')?.classList.contains('is-open'))) {
                const sugg = document.getElementById('directions-suggestions');
                if (sugg && !sugg.hidden) {
                    hideSuggestions();
                } else {
                    closeDirectionsPanel();
                }
            }
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initDirectionsEvents);
    } else {
        initDirectionsEvents();
    }

    // Exponer a globalThis para integración y tests
    globalThis.toggleDirectionsPanel = toggleDirectionsPanel;
    globalThis.openDirectionsPanel = openDirectionsPanel;
    globalThis.closeDirectionsPanel = closeDirectionsPanel;
    globalThis.setOriginToCurrentLocation = setOriginToCurrentLocation;
    globalThis.swapDirectionsLocations = swapDirectionsLocations;
    globalThis.clearDirectionsField = clearDirectionsField;
    globalThis.resetDirectionsForm = resetDirectionsForm;
    globalThis.startDirectionsMapPick = startDirectionsMapPick;
    globalThis.selectDirectionsRoute = selectDirectionsRoute;
    globalThis.calculateDirectionsRoutes = calculateDirectionsRoutes;
    globalThis.computeDirectionsRoutes = computeRoutes;
    globalThis.directionsState = directionsState;
})();
