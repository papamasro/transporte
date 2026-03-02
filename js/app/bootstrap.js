        const BACKEND_URL = "https://transporte-be.papamasro.workers.dev";
        const KV_ENDPOINT = "/obtener-kv";
        const KV_KEYS = {
            subteLines: 'subte-lines',
            subteStations: 'subte-stations',
            trainLines: 'train-lines',
            trainStations: 'train-stations'
        };
        const UPDATE_INTERVAL = 30000;

        let map;
        let layers = {
            bus: null,
            bike: null,
            subteLines: null,
            subteStations: null,
            trainLines: null,
            trainStations: null,
            busRoute: null,
            busStops: null
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
            subteStaticPromise: null,
            trainStaticPromise: null
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
                const busData = await fetchWithRetry("/colectivos/vehiclePositionsSimple", 1000);
                updateBusCache(busData);

                if (activeTypes.subte) await refreshSubteNow();
                if (activeTypes.bike) await refreshBikeNow();

                loadingLine.style.width = '100%';
                renderMarkers();
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
            activeTypes[type] = !activeTypes[type];
            setTypeButtonState(type, activeTypes[type]);

            let onDemandHadError = false;

            if (activeTypes[type]) {
                const activated = await activateType(type);
                onDemandHadError = !activated;
            } else {
                deactivateType(type);
            }
            
            renderMarkers();
            if (onDemandHadError) setStatus('ERROR');
        }

        document.addEventListener('DOMContentLoaded', init);
