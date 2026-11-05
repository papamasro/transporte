        // js/app/config.js (cargado antes en index.html) es la única fuente de configuración.
        if (!globalThis.APP_CONFIG) console.error('js/app/config.js no se cargó: la app no tiene configuración.');
        const appConfig = globalThis.APP_CONFIG || {};
        const BACKEND_URL = (appConfig.API?.backendBaseUrl || '').toString().replace(/\/+$/, '');
        const SOFSE_API_BASE = (appConfig.API?.sofseBaseUrl || `${BACKEND_URL}/trenes`).toString().replace(/\/+$/, '');
        const TRAIN_ARRIVALS_TTL_MS = Math.max(0, Number(appConfig.TIMEOUTS?.trainArrivalsTtlMs ?? 20000));
        globalThis.NETWORK_CONFIG = appConfig.NETWORK || {};
        const APP_PATHS = appConfig.PATHS || {};
        const KV_ENDPOINT = APP_PATHS.kvGet || '/obtener-kv';
        const KV_KEYS = appConfig.KV_KEYS || {};
        const UPDATE_INTERVAL = Math.max(1000, Number(appConfig.TIMEOUTS?.updateIntervalMs ?? 30000));
        const readPollingMs = (key, fallback) => Math.max(1000, Number(appConfig.POLLING?.[key] ?? fallback));
        const POLL_INTERVALS = {
            bus: readPollingMs('busIntervalMs', UPDATE_INTERVAL),
            subte: readPollingMs('subteIntervalMs', 60000),
            bike: readPollingMs('bikeIntervalMs', 60000),
            train: readPollingMs('trainIntervalMs', 60000),
            nearby: readPollingMs('nearbyIntervalMs', UPDATE_INTERVAL)
        };
        // Último intento por fuente (ms epoch); una fuente se pide solo si venció su intervalo.
        const pollLastAt = { bus: 0, subte: 0, bike: 0, train: 0, nearby: 0 };
        // Tolerancia para que un timer que dispara unos ms antes no saltee la fuente.
        const POLL_SLACK_MS = 1500;

        let map;
        let layers = {
            bus: null,
            bike: null,
            subteLines: null,
            subteStations: null,
            trainLines: null,
            trainStations: null,
            trainVehicles: null,
            bikeRoutes: null,
            busRoute: null,
            busStops: null,
            nearbyRadius: null,
            nearbyCircle: null,
            nearbyStops: null,
            nearbyVehicles: null
        };
        let userLayer;
        let activeTypes = { bus: isTransportTypeEnabled('bus'), subte: false, train: false, bike: false };
        let isRefreshing = false;
        let refreshTimeout;
        let lastRefreshCompletedAt = 0;
        const lineColors = {};

        globalThis.cache = {
            bus: [],
            busFetchedAt: 0,
            bike: [],
            bikeFetchedAt: 0,
            subteForecast: [],
            subteForecastByBaseStop: {},
            subteForecastByName: {},
            subteTimestamp: null,
            subteFetchedAt: 0,
            subteStatic: { lines: null, stations: null },
            trainStatic: { lines: null, stations: null },
            trainArrivalsByStation: {},
            trainSofseResolveByStationKey: {},
            trainSofseResolveByName: {},
            trainSofseResolvePromiseByStationKey: {},
            trainSofseResolveFailedByStationKey: {},
            bikeRoutes: null,
            bikeRoutesPromise: null,
            subteStaticPromise: null,
            trainStaticPromise: null,
            userLocation: null
        };

        function init() {
            const isMobile = window.innerWidth < 768;
            const reduceMotion = prefersReducedMotion();
            map = L.map('map', { 
                zoomControl: false, 
                attributionControl: false,
                tap: false,
                zoomAnimation: !reduceMotion,
                fadeAnimation: !reduceMotion,
                markerZoomAnimation: !reduceMotion,
                inertia: !reduceMotion
            }).setView([-34.6037, -58.3816], isMobile ? 13 : 14);

            // Atribución compacta: el texto largo de Esri se trunca y se expande con hover/foco (tap en mobile).
            const attributionControl = L.control.attribution({
                position: 'bottomright',
                prefix: '<a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a>'
            }).addTo(map);
            const attributionEl = attributionControl.getContainer();
            attributionEl.classList.add('map-attribution-compact');
            attributionEl.tabIndex = 0;
            attributionEl.setAttribute('aria-label', 'Atribución del mapa');
            // Se agrega después de la atribución: en las esquinas inferiores Leaflet apila los nuevos arriba.
            L.control.zoom({ position: 'bottomright', zoomInTitle: 'Acercar', zoomOutTitle: 'Alejar' }).addTo(map);

            initMapTheme(map);

            layers.bus = L.layerGroup().addTo(map);
            layers.bike = L.layerGroup().addTo(map);
            layers.subteLines = L.layerGroup().addTo(map);
            layers.subteStations = L.layerGroup().addTo(map);
            layers.trainLines = L.layerGroup().addTo(map);
            layers.trainStations = L.layerGroup().addTo(map);
            layers.trainVehicles = L.layerGroup().addTo(map);
            layers.bikeRoutes = L.layerGroup().addTo(map);
            layers.busRoute = L.layerGroup().addTo(map);
            layers.busStops = L.layerGroup().addTo(map);
            layers.nearbyCircle = L.layerGroup().addTo(map);
            layers.nearbyRadius = L.layerGroup().addTo(map);
            layers.nearbyStops = L.layerGroup().addTo(map);
            layers.nearbyVehicles = L.layerGroup().addTo(map);
            userLayer = L.layerGroup().addTo(map);
            setupMarkerZoomTransitionGuard();

            lucide.createIcons();
            initStatusBanners();
            initFavorites();
            initSearch();
            
            setTypeButtonState('bus', activeTypes.bus);
            document.getElementById('search').addEventListener('input', () => {
                scheduleRenderMarkers(250, { force: true });
                refreshIfBusBecameDue();
            });
            map.on('moveend', () => {
                scheduleRenderMarkers(100);
                refreshIfBusBecameDue();
            });
            map.on('popupclose', () => {
                handleMarkerPopupClose();
                if (typeof handleNearbyPopupClose === 'function') handleNearbyPopupClose();
            });
            
            if (isFeatureEnabled('installPrompt')) setupInstallPrompt();
            setStatus('CARGANDO');
            // Un link compartido manda sobre la ubicación guardada: no se recentra ni se pide ubicación.
            const sharedView = initUrlState();
            forceRefresh();
            if (isFeatureEnabled('geolocation')) {
                if (sharedView.hasContext) showKnownUserLocationWithoutMoving();
                else showLocationPrompt();
            }
            document.addEventListener('visibilitychange', handleVisibilityChange);

            const isSupportedOrigin = globalThis.location.protocol === 'http:' || globalThis.location.protocol === 'https:';
            if ('serviceWorker' in navigator && isSupportedOrigin && isFeatureEnabled('serviceWorker')) {
                // Ruta y scope relativos: funciona en la raíz o bajo un subpath (GitHub Pages /<repo>/).
                // updateViaCache 'none': el chequeo de sw.js nuevo no usa el cache HTTP.
                navigator.serviceWorker.register('./sw.js', { scope: './', updateViaCache: 'none' })
                    .catch(err => console.log('SW setup skipped:', err));
            }
        }

        function showKnownUserLocationWithoutMoving() {
            const known = getKnownUserLocation();
            if (!known || !isLocationCacheFresh(known)) return;
            globalThis.cache.userLocation = known;
            drawUserMarker(known.lat, known.lon);
        }

        // Pedidos manuales que llegan con un ciclo en curso se encolan: el botón o Reintentar nunca se pierden.
        // true = todas las fuentes activas; Set = solo esas.
        let queuedForcedRefresh = null;

        // Manual / arranque: pide todas las fuentes activas aunque no haya vencido su intervalo.
        function forceRefresh() {
            if (isRefreshing) {
                queuedForcedRefresh = true;
                return;
            }
            refreshLoop({ force: true });
        }

        function forceRefreshSource(source) {
            if (!isRefreshing) {
                refreshLoop({ forceSources: new Set([source]) });
                return;
            }
            if (queuedForcedRefresh === true) return;
            queuedForcedRefresh ||= new Set();
            queuedForcedRefresh.add(source);
        }

        function runQueuedForcedRefresh() {
            const queued = queuedForcedRefresh;
            queuedForcedRefresh = null;
            if (queued === true) refreshLoop({ force: true });
            else if (queued) refreshLoop({ forceSources: queued });
        }

        // "Reintentar" de un aviso: vuelve a pedir solo esa fuente.
        function retryDataSource(source) {
            if (source === 'nearby') {
                if (typeof refreshNearbyTransport === 'function') refreshNearbyTransport({ keepAreaCenter: true }).catch(() => {});
                return;
            }
            // Subte y trenes sin datos estáticos (falló la activación): se reintenta la activación completa.
            const staticMissing = (source === 'subte' && !globalThis.cache.subteStatic?.lines)
                || (source === 'train' && !globalThis.cache.trainStatic?.lines);
            if (staticMissing && activeTypes[source]) retryTypeActivation(source);
            else if (Object.hasOwn(pollLastAt, source)) forceRefreshSource(source);
            else forceRefresh();
        }

        async function retryTypeActivation(type) {
            const toggleSeq = typeToggleSeq;
            const isCurrent = () => toggleSeq === typeToggleSeq;
            const activated = await activateType(type, isCurrent);
            if (!isCurrent() || !activeTypes[type]) return;
            reportSourceResult(type, activated);
            if (activated) markDataUpdated();
            renderMarkers({ force: true });
            setStatus(activated ? 'LIVE' : 'ERROR');
        }

        function handleConnectivityRestored() {
            forceRefresh();
            if (globalThis.nearbyState?.active && typeof refreshNearbyTransport === 'function') {
                refreshNearbyTransport({ silent: true, keepAreaCenter: true }).catch(() => {});
            }
        }

        function markDataUpdated() {
            setMapStatusUpdated(Date.now());
        }

        // Acepta el array de posiciones o el snapshot de fetchBusSnapshot() ({ current, prev, ... }).
        function updateBusCache(busData) {
            const snapshot = Array.isArray(busData) ? { current: busData, prev: null } : busData;
            if (Array.isArray(snapshot?.current)) {
                busAnimIngestSnapshot(snapshot.current, snapshot.prev, snapshot);
                globalThis.cache.bus = snapshot.current;
                globalThis.cache.busFetchedAt = Date.now();
                markDataUpdated();
            } else {
                console.warn('Datos de colectivos inválidos o error de red. Se preserva el caché existente.');
            }
        }

        // /colectivos/vehiclePositionsKV trae además el snapshot previo del worker: solo vale la pena
        // (pesa el doble) cuando el cliente no tiene un snapshot propio reciente para animar. Si la ruta
        // no está desplegada (404) no se vuelve a pedir en la sesión; ante 5xx se pausa un rato.
        const busKvState = { unsupported: false, retryAfter: 0 };
        const BUS_KV_RETRY_AFTER_5XX_MS = 10 * 60 * 1000;

        function shouldUseBusKv() {
            const kvPath = APP_PATHS.busVehiclePositionsKV;
            if (!kvPath || busKvState.unsupported || Date.now() < busKvState.retryAfter) return false;
            if (!isFeatureEnabled('busAnimation') || appConfig.BUS_ANIMATION?.enabled === false || prefersReducedMotion()) return false;
            const maxAgeMs = Number(appConfig.BUS_ANIMATION?.kvWhenSnapshotOlderThanMs ?? 75000);
            return Date.now() - Number(globalThis.cache.busFetchedAt || 0) > maxAgeMs;
        }

        function parseBusKvPayload(payload) {
            const current = payload?.current;
            if (!Array.isArray(current?.data)) return null;
            const prev = Array.isArray(payload.prev?.data) ? payload.prev : null;
            return {
                current: current.data,
                prev: prev ? prev.data : null,
                currentTs: Number(current.ts),
                prevTs: prev ? Number(prev.ts) : Number.NaN
            };
        }

        // null = no se pudo obtener (se preserva el caché).
        async function fetchBusSnapshot() {
            if (shouldUseBusKv()) {
                const kvRes = await fetchAPI(APP_PATHS.busVehiclePositionsKV);
                const parsed = kvRes.success ? parseBusKvPayload(kvRes.data) : null;
                if (parsed) return parsed;
                if (kvRes.status === 404) busKvState.unsupported = true;
                else if (kvRes.status >= 500 || kvRes.success) busKvState.retryAfter = Date.now() + BUS_KV_RETRY_AFTER_5XX_MS;
                // status 0 (red/timeout): la ruta simple también fallaría.
                else if (kvRes.status === 0) return null;
            }
            const busData = await fetchWithRetry(APP_PATHS.busVehiclePositions);
            return Array.isArray(busData) ? { current: busData, prev: null } : null;
        }

        function hasActiveSearch() {
            return !!normalizeText(document.getElementById('search')?.value || '');
        }

        // Colectivos de la capa principal: activos y con zoom suficiente (o con búsqueda de línea).
        function isMainBusPollingNeeded() {
            if (!activeTypes.bus || !isTransportTypeEnabled('bus')) return false;
            if (hasActiveSearch()) return true;
            const minZoom = Number(appConfig.POLLING?.busMinZoom);
            return !map || !Number.isFinite(minZoom) || map.getZoom() >= minZoom;
        }

        function isNearbyBusPollingNeeded() {
            return !!globalThis.nearbyState?.active && isNearbySliceEnabled('busVehicles');
        }

        // Las posiciones de colectivos también las puede haber pedido el panel de cercanos (busFetchedAt).
        function getSourceLastAt(source) {
            if (source === 'bus') return Math.max(pollLastAt.bus, Number(globalThis.cache.busFetchedAt || 0));
            return pollLastAt[source];
        }

        function getSourceInterval(source) {
            if (source === 'bus' && !isMainBusPollingNeeded()) return POLL_INTERVALS.nearby;
            return POLL_INTERVALS[source];
        }

        // force: boolean (todas) o Set de fuentes forzadas.
        function isSourceDue(source, force, now = Date.now()) {
            if (force === true || (force instanceof Set && force.has(source))) return true;
            return (now - getSourceLastAt(source)) >= getSourceInterval(source) - POLL_SLACK_MS;
        }

        // Al acercar el mapa (o buscar) con colectivos vencidos se pide enseguida, sin esperar al timer.
        function refreshIfBusBecameDue() {
            if (isRefreshing || document.hidden || !isFeatureEnabled('autoRefresh')) return;
            if (isMainBusPollingNeeded() && isSourceDue('bus', false)) refreshLoop();
        }

        async function refreshBusForLoop(force) {
            const mainNeeded = isMainBusPollingNeeded();
            const nearbyNeeded = isNearbyBusPollingNeeded();

            if (!activeTypes.bus && !nearbyNeeded) {
                globalThis.cache.bus = [];
                globalThis.cache.busFetchedAt = 0;
                clearBusRouteLayers();
                return null;
            }
            if (!mainNeeded && !nearbyNeeded) return null;
            if (!isSourceDue('bus', force)) return null;

            pollLastAt.bus = Date.now();
            const snapshot = await fetchBusSnapshot();
            if (activeTypes.bus || globalThis.nearbyState?.active) updateBusCache(snapshot);
            if (!activeTypes.bus && !globalThis.markerState?.selectedBusVehicleKey) clearBusRouteLayers();
            return !!snapshot;
        }

        async function refreshBikeForLoop() {
            const [bikeOk, bikeRoutesOk] = await Promise.all([
                refreshBikeNow(),
                refreshBikeRoutesNow()
            ]);
            if (bikeOk === false || bikeRoutesOk === false) return false;
            return bikeOk === true || bikeRoutesOk === true ? true : null;
        }

        // Tareas de un ciclo: cada fuente solo si su capa está activa y venció su intervalo.
        // Cada tarea lleva su fuente para que un fallo avise solo de esa fuente.
        function collectRefreshTasks(force) {
            const now = Date.now();
            const nearbyDue = !!globalThis.nearbyState?.active && isSourceDue('nearby', force, now);
            const tasks = [{ source: 'bus', promise: refreshBusForLoop(force) }];
            const due = source => {
                if (!isSourceDue(source, force, now)) return false;
                pollLastAt[source] = now;
                return true;
            };
            if (activeTypes.subte && due('subte')) tasks.push({ source: 'subte', promise: refreshSubteNow() });
            if (activeTypes.bike && due('bike')) tasks.push({ source: 'bike', promise: refreshBikeForLoop() });
            if (activeTypes.train && due('train')) tasks.push({ source: 'train', promise: refreshTrainLiveNow() });
            return { tasks, nearbyDue };
        }

        // Próximo ciclo: cuando vence la primera fuente activa (sin fuentes activas, el intervalo más largo).
        function getNextRefreshDelay() {
            const now = Date.now();
            const sources = [];
            if (isMainBusPollingNeeded() || isNearbyBusPollingNeeded()) sources.push('bus');
            if (activeTypes.subte) sources.push('subte');
            if (activeTypes.bike) sources.push('bike');
            if (activeTypes.train) sources.push('train');
            if (globalThis.nearbyState?.active) sources.push('nearby');
            if (sources.length === 0) return Math.max(...Object.values(POLL_INTERVALS));
            const waits = sources.map(source => getSourceInterval(source) - (now - getSourceLastAt(source)));
            return Math.max(1000, Math.min(...waits));
        }

        function scheduleNextRefresh(delayMs = getNextRefreshDelay()) {
            clearTimeout(refreshTimeout);
            // Sin conexión no se sondea: al volver la red handleConnectivityRestored() pide todo.
            if (document.hidden || !isFeatureEnabled('autoRefresh') || isAppOffline()) return;
            refreshTimeout = setTimeout(() => refreshLoop(), delayMs);
        }

        function handleVisibilityChange() {
            if (document.hidden) {
                clearTimeout(refreshTimeout);
                return;
            }
            if (isRefreshing) return;
            const delayMs = getNextRefreshDelay();
            if (delayMs <= 1000) refreshLoop();
            else scheduleNextRefresh(delayMs);
        }

        async function refreshLoop(options = {}) {
            if (isRefreshing) return;
            isRefreshing = true;
            clearTimeout(refreshTimeout);
            const force = options.forceSources instanceof Set ? options.forceSources : !!options.force;
            
            const refreshIcon = document.getElementById('refresh-icon');
            const loadingLine = document.getElementById('loading-line');
            
            refreshIcon?.classList.add('animate-spin');
            if (loadingLine) loadingLine.style.width = '30%';

            let hadError = false;
            try {
                const { tasks, nearbyDue } = collectRefreshTasks(force);

                // Render progresivo: lo que llega primero se dibuja sin esperar al resto (p.ej. bus lento).
                let pendingTasks = tasks.length;
                const results = await Promise.allSettled(tasks.map(({ source, promise }) => promise.then(ok => {
                    pendingTasks -= 1;
                    if (ok && pendingTasks > 0) scheduleRenderMarkers(50);
                    reportSourceResult(source, ok === undefined ? null : ok);
                    return ok;
                }, error => {
                    pendingTasks -= 1;
                    reportSourceResult(source, false);
                    throw error;
                })));
                // null = la tarea no tenía nada que pedir (ni error ni dato nuevo).
                hadError = results.some(result => result.status !== 'fulfilled' || result.value === false);
                if (results.some(result => result.status === 'fulfilled' && result.value === true)) markDataUpdated();

                if (loadingLine) loadingLine.style.width = '100%';
                renderMarkers();
                if (nearbyDue && globalThis.nearbyState?.active) {
                    pollLastAt.nearby = Date.now();
                    refreshNearbyTransport({ silent: true }).catch(() => {});
                }

            } catch (err) {
                hadError = true;
                console.error("Error crítico en refreshLoop", err);
            } finally {
                if (hadError) {
                    setStatus('ERROR');
                } else if (globalThis.nearbyState?.loading) {
                    setStatus('CARGANDO');
                } else {
                    setStatus('LIVE');
                }

                isRefreshing = false;
                lastRefreshCompletedAt = Date.now();
                setTimeout(() => { 
                    if (isRefreshing) return;
                    if (loadingLine) loadingLine.style.width = '0%'; 
                    refreshIcon?.classList.remove('animate-spin');
                }, 500);
                
                scheduleNextRefresh();
                if (queuedForcedRefresh) runQueuedForcedRefresh();
            }
        }

        function setTypeButtonState(type, isActive) {
            const btn = document.getElementById(`t-${type}`);
            if (!btn) return;

            btn.setAttribute('aria-pressed', String(!!isActive));
            if (type === 'bike') {
                btn.classList.toggle('active-eco', isActive);
                return;
            }

            btn.classList.toggle('active', isActive);
        }

        // isCurrent(): false si un toggle posterior ya reemplazó a esta activación; en ese caso
        // no se escriben caches (los refresh* también re-chequean activeTypes tras sus awaits).
        async function activateType(type, isCurrent = () => true) {
            const stillWanted = () => isCurrent() && !!activeTypes[type];

            if (type === 'subte') {
                setStatus('CARGANDO');
                const staticLoaded = await loadSubteStaticFromKV();
                if (!stillWanted()) return false;
                pollLastAt.subte = Date.now();
                const realtimeLoaded = await refreshSubteNow();
                return staticLoaded && realtimeLoaded !== false;
            }

            if (type === 'train') {
                setStatus('CARGANDO');
                const staticLoaded = await loadTrainStaticFromKV();
                if (staticLoaded && stillWanted()) {
                    pollLastAt.train = Date.now();
                    refreshTrainLiveNow()
                        .then(updated => { if (updated) scheduleRenderMarkers(50); })
                        .catch(() => {});
                }
                return staticLoaded;
            }

            if (type === 'bike') {
                setStatus('CARGANDO');
                pollLastAt.bike = Date.now();
                const [stationsOk, routesOk] = await Promise.all([
                    refreshBikeNow(),
                    refreshBikeRoutesNow()
                ]);
                return stationsOk !== false && routesOk !== false;
            }

            if (type === 'bus') {
                if (!isMainBusPollingNeeded()) return true;
                setStatus('CARGANDO');
                pollLastAt.bus = Date.now();
                const snapshot = await fetchBusSnapshot();
                if (!stillWanted()) return false;
                updateBusCache(snapshot);
                return !!snapshot;
            }

            return true;
        }

        function deactivateType(type) {
            clearSourceError(type);
            if (type === 'bus') {
                globalThis.cache.bus = [];
                globalThis.cache.busFetchedAt = 0;
                busAnimClear();
                clearBusRouteLayers();
                return;
            }

            if (type === 'subte') {
                globalThis.cache.subteForecast = [];
                globalThis.cache.subteForecastByBaseStop = {};
                globalThis.cache.subteForecastByName = {};
                globalThis.cache.subteTimestamp = null;
                globalThis.cache.subteFetchedAt = 0;
                return;
            }

            if (type === 'bike') {
                globalThis.cache.bike = [];
                layers.bikeRoutes?.clearLayers();
                return;
            }

            if (type === 'train') {
                layers.trainLines?.clearLayers();
                layers.trainStations?.clearLayers();
                layers.trainVehicles?.clearLayers();
                return;
            }
        }



        let typeToggleSeq = 0;

        async function toggleType(type) {
            if (!Object.hasOwn(activeTypes, type) || !isTransportTypeEnabled(type)) return;

            const toggleSeq = ++typeToggleSeq;
            const isCurrentToggle = () => toggleSeq === typeToggleSeq;

            const nearbyPanel = document.getElementById('nearby-panel');
            const isNearbyOpen = nearbyPanel?.classList?.contains('is-open');
            if (isNearbyOpen && typeof closeNearbyPanel === 'function') {
                closeNearbyPanel({ restoreFilters: false });
            }

            // Estado y botones se aplican de forma síncrona; solo la carga del tipo activado es async.
            const isCurrentlyActive = !!activeTypes[type];
            let typeToActivate = null;
            for (const currentType of Object.keys(activeTypes)) {
                const shouldBeActive = isCurrentlyActive ? false : (currentType === type);
                const wasActive = !!activeTypes[currentType];

                activeTypes[currentType] = shouldBeActive;
                setTypeButtonState(currentType, shouldBeActive);

                if (shouldBeActive && !wasActive) typeToActivate = currentType;
                if (!shouldBeActive && wasActive) deactivateType(currentType);
            }

            let onDemandHadError = false;
            if (typeToActivate) {
                renderMarkers({ force: true });
                const activated = await activateType(typeToActivate, isCurrentToggle);
                // Un toggle posterior es dueño del render y del estado.
                if (!isCurrentToggle() || !activeTypes[typeToActivate]) return;
                onDemandHadError = !activated;
                reportSourceResult(typeToActivate, activated);
                if (activated) markDataUpdated();
            }

            renderMarkers({ force: true });
            setStatus(onDemandHadError ? 'ERROR' : 'LIVE');
            // El próximo ciclo depende de qué capas quedaron activas.
            if (!isRefreshing) scheduleNextRefresh();
        }

        document.addEventListener('DOMContentLoaded', init);
