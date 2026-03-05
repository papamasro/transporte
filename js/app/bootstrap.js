        const DEFAULT_APP_CONFIG = {
            API: {
                backendBaseUrl: 'https://transporte-be.papamasro.workers.dev',
                sofseBaseUrl: 'https://transporte-be.papamasro.workers.dev/trenes'
            },
            PATHS: {
                kvGet: '/obtener-kv',
                busVehiclePositions: '/colectivos/vehiclePositionsSimple'
            },
            KV_KEYS: {
                subteLines: 'subte-lines',
                subteStations: 'subte-stations',
                trainLines: 'train-lines',
                trainStations: 'train-stations'
            },
            TIMEOUTS: {
                updateIntervalMs: 30000,
                trainArrivalsTtlMs: 20000
            },
            NETWORK: {
                retryMax: 3,
                retryDelayMs: 1000,
                sofse403DelayMs: 2800,
                busRouteMaxTripCandidates: 3,
                busRouteMaxFallbackVehicles: 3,
                busRouteMaxCallsPerSelection: 3,
                busRouteNoResultTtlMs: 30000,
                busRouteMaxShapeDistanceMeters: 25000,
                busRouteMinShapePoints: 20
            },
            FEATURES: {
                nearbyStopsRadiusMeters: 1500,
                nearbyBusRouteFetchMax: 8,
                nearbyTrainRealtimeStations: 4
            }
        };

        const appConfig = globalThis.APP_CONFIG || DEFAULT_APP_CONFIG;
        const BACKEND_URL = (appConfig.API?.backendBaseUrl || DEFAULT_APP_CONFIG.API.backendBaseUrl)
            .toString()
            .replace(/\/+$/, '');
        const SOFSE_API_BASE = (appConfig.API?.sofseBaseUrl || DEFAULT_APP_CONFIG.API.sofseBaseUrl)
            .toString()
            .replace(/\/+$/, '');
        const TRAIN_ARRIVALS_TTL_MS = Math.max(0, Number(appConfig.TIMEOUTS?.trainArrivalsTtlMs ?? DEFAULT_APP_CONFIG.TIMEOUTS.trainArrivalsTtlMs));
        const networkOverrides = appConfig.NETWORK;
        globalThis.NETWORK_CONFIG = (networkOverrides && typeof networkOverrides === 'object')
            ? { ...DEFAULT_APP_CONFIG.NETWORK, ...networkOverrides }
            : { ...DEFAULT_APP_CONFIG.NETWORK };
        const KV_ENDPOINT = appConfig.PATHS?.kvGet || DEFAULT_APP_CONFIG.PATHS.kvGet;
        const kvKeyOverrides = appConfig.KV_KEYS;
        const KV_KEYS = (kvKeyOverrides && typeof kvKeyOverrides === 'object')
            ? { ...DEFAULT_APP_CONFIG.KV_KEYS, ...kvKeyOverrides }
            : { ...DEFAULT_APP_CONFIG.KV_KEYS };
        const UPDATE_INTERVAL = Math.max(1000, Number(appConfig.TIMEOUTS?.updateIntervalMs ?? DEFAULT_APP_CONFIG.TIMEOUTS.updateIntervalMs));

        let map;
        let layers = {
            bus: null,
            bike: null,
            subteLines: null,
            subteStations: null,
            trainLines: null,
            trainStations: null,
            busRoute: null,
            busStops: null,
            nearbyRadius: null,
            nearbyStops: null,
            nearbyVehicles: null
        };
        let userLayer;
        let activeTypes = { bus: true, subte: false, train: false, bike: false };
        let isRefreshing = false;
        let refreshTimeout;
        const lineColors = {};

        globalThis.cache = {
            bus: [],
            bike: [],
            subteForecast: [],
            subteForecastByStop: {},
            subteForecastByBaseStop: {},
            subteForecastByName: {},
            subteTimestamp: null,
            subteStatic: { lines: null, stations: null },
            trainStatic: { lines: null, stations: null },
            trainArrivalsByStation: {},
            trainSofseResolveByStationKey: {},
            trainSofseResolveByName: {},
            trainSofseResolvePromiseByStationKey: {},
            subteStaticPromise: null,
            trainStaticPromise: null,
            userLocation: null
        };

        function init() {
            map = L.map('map', { 
                zoomControl: false, 
                attributionControl: false,
                tap: false 
            }).setView([-34.6037, -58.3816], 14);

            L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
                maxZoom: 19
            }).addTo(map);

            layers.bus = L.layerGroup().addTo(map);
            layers.bike = L.layerGroup().addTo(map);
            layers.subteLines = L.layerGroup().addTo(map);
            layers.subteStations = L.layerGroup().addTo(map);
            layers.trainLines = L.layerGroup().addTo(map);
            layers.trainStations = L.layerGroup().addTo(map);
            layers.busRoute = L.layerGroup().addTo(map);
            layers.busStops = L.layerGroup().addTo(map);
            layers.nearbyRadius = L.layerGroup().addTo(map);
            layers.nearbyStops = L.layerGroup().addTo(map);
            layers.nearbyVehicles = L.layerGroup().addTo(map);
            userLayer = L.layerGroup().addTo(map);

            lucide.createIcons();
            
            document.getElementById('search').addEventListener('input', renderMarkers);
            map.on('moveend', renderMarkers);
            
            // CAMBIO 4: Auto-ubicar al usuario cuando termina de inicializar
            locateUser();
            setupInstallPrompt();
            setStatus('CARGANDO');
            forceRefresh();

            const isSupportedOrigin = globalThis.location.protocol === 'http:' || globalThis.location.protocol === 'https:';
            if ('serviceWorker' in navigator && isSupportedOrigin) {
                navigator.serviceWorker.register('./sw.js').catch(err => console.log('SW setup skipped:', err));
            }
        }

        function forceRefresh() {
            if (!isRefreshing) refreshLoop();
        }

        function updateBusCache(busData) {
            globalThis.cache.bus = Array.isArray(busData) ? busData : [];
            document.getElementById('last-update').innerText = `Última act: ${new Date().toLocaleTimeString('es-AR', { hour12: false })}`;
        }


        async function refreshLoop() {
            if (isRefreshing) return;
            isRefreshing = true;
            clearTimeout(refreshTimeout);
            
            const refreshIcon = document.getElementById('refresh-icon');
            const loadingLine = document.getElementById('loading-line');
            
            refreshIcon?.classList.add('animate-spin');
            loadingLine.style.width = '30%';

            try {
                if (activeTypes.bus) {
                    const busVehiclePositionsPath = appConfig.PATHS?.busVehiclePositions || DEFAULT_APP_CONFIG.PATHS.busVehiclePositions;
                    const busData = await fetchWithRetry(busVehiclePositionsPath);
                    updateBusCache(busData);
                } else {
                    globalThis.cache.bus = [];
                    clearBusRouteOverlay();
                }

                if (activeTypes.subte) await refreshSubteNow();
                if (activeTypes.bike) await refreshBikeNow();

                loadingLine.style.width = '100%';
                renderMarkers();
                if (globalThis.nearbyState?.active && typeof refreshNearbyTransport === 'function') {
                    refreshNearbyTransport({ silent: true }).catch(() => {});
                }
                setStatus('LIVE'); 

            } catch (err) {
                console.error("Error crítico en refreshLoop", err);
            } finally {
                setTimeout(() => { 
                    loadingLine.style.width = '0%'; 
                    refreshIcon?.classList.remove('animate-spin');
                    isRefreshing = false;
                }, 500);
                
                refreshTimeout = setTimeout(refreshLoop, UPDATE_INTERVAL);
            }
        }

        function setTypeButtonState(type, isActive) {
            const btn = document.getElementById(`t-${type}`);
            if (!btn) return;

            if (type === 'bike') {
                btn.classList.toggle('active-eco', isActive);
                return;
            }

            btn.classList.toggle('active', isActive);
        }

        async function activateType(type) {
            if (type === 'subte') {
                setStatus('CARGANDO');
                const staticLoaded = await loadSubteStaticFromKV();
                const realtimeLoaded = await refreshSubteNow();
                return staticLoaded && realtimeLoaded;
            }

            if (type === 'train') {
                setStatus('CARGANDO');
                return loadTrainStaticFromKV();
            }

            if (type === 'bike') {
                setStatus('CARGANDO');
                return refreshBikeNow();
            }

            return true;
        }

        function deactivateType(type) {
            if (type === 'bus') {
                globalThis.cache.bus = [];
                clearBusRouteOverlay();
                return;
            }

            if (type === 'subte') {
                globalThis.cache.subteForecast = [];
                globalThis.cache.subteForecastByStop = {};
                globalThis.cache.subteForecastByBaseStop = {};
                globalThis.cache.subteForecastByName = {};
                globalThis.cache.subteTimestamp = null;
                return;
            }

            if (type === 'bike') {
                globalThis.cache.bike = [];
            }
        }



        async function toggleType(type) {
            if (!Object.hasOwn(activeTypes, type)) return;

            const nearbyPanel = document.getElementById('nearby-panel');
            const isNearbyOpen = nearbyPanel?.classList?.contains('is-open');
            if (isNearbyOpen && typeof closeNearbyPanel === 'function') {
                closeNearbyPanel();
            }

            let onDemandHadError = false;

            for (const currentType of Object.keys(activeTypes)) {
                const shouldBeActive = currentType === type;
                const wasActive = !!activeTypes[currentType];

                activeTypes[currentType] = shouldBeActive;
                setTypeButtonState(currentType, shouldBeActive);

                if (shouldBeActive) {
                    if (!wasActive) {
                        const activated = await activateType(currentType);
                        onDemandHadError = onDemandHadError || !activated;
                    }
                    continue;
                }

                if (wasActive) deactivateType(currentType);
            }
            
            renderMarkers();
            if (onDemandHadError) setStatus('ERROR');
        }

        document.addEventListener('DOMContentLoaded', init);
