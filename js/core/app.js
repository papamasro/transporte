        const BACKEND_URL = "https://transporte-be.papamasro.workers.dev";
        const UPDATE_INTERVAL = 30000; 
        
        let map, layers = { bus: null, bike: null, subteLines: null, subteStations: null, trainLines: null, trainStations: null, busRoute: null, busStops: null }, userLayer;
        let activeTypes = { bus: true, subte: false, train: false, bike: false };
        let isRefreshing = false;
        let isPanelOpen = true;
        let isAlertsOpen = false;
        let deferredInstallPrompt = null;
        let refreshTimeout;
        let startupWarmupPromise = null;
        const lineColors = {};
        globalThis.cache = { bus: [], bike: [], subteForecast: [], subteForecastByStop: {}, subteForecastByBaseStop: {}, subteForecastByName: {}, subteTimestamp: null, trainStatic: globalThis.TRAIN_STATIC || null };

        const SUBTE_STATIC = globalThis.SUBTE_STATIC;
        const SUBTE_STATIC_TIMETABLE = globalThis.SUBTE_STATIC_TIMETABLE;

        function togglePanel() {
            isPanelOpen = !isPanelOpen;
            const content = document.getElementById('panel-content');
            const chevron = document.getElementById('panel-chevron');
            content.style.maxHeight = isPanelOpen ? '400px' : '0px';
            content.style.opacity = isPanelOpen ? '1' : '0';
            chevron.style.transform = isPanelOpen ? 'rotate(0deg)' : 'rotate(180deg)';
        }

        function setupInstallPrompt() {
            const installBtn = document.getElementById('install-app-btn');
            if (!installBtn) return;
            const isSupportedOrigin = globalThis.location.protocol === 'http:' || globalThis.location.protocol === 'https:';
            if (!isSupportedOrigin) {
                installBtn.classList.add('hidden');
                return;
            }

            const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
            const isAndroid = /android/i.test(navigator.userAgent);
            const isStandalone = globalThis.matchMedia('(display-mode: standalone)').matches || globalThis.navigator.standalone;

            globalThis.addEventListener('beforeinstallprompt', (event) => {
                event.preventDefault();
                deferredInstallPrompt = event;
                installBtn.classList.remove('hidden');
            });

            globalThis.addEventListener('appinstalled', () => {
                deferredInstallPrompt = null;
                installBtn.classList.add('hidden');
            });

            if (isIos && !isStandalone) {
                installBtn.classList.remove('hidden');
            }

            if (isAndroid && !isStandalone) {
                installBtn.classList.remove('hidden');
            }
        }

        async function installApp() {
            const isSupportedOrigin = globalThis.location.protocol === 'http:' || globalThis.location.protocol === 'https:';
            if (!isSupportedOrigin) {
                alert('Para instalar la app, abrila desde un servidor local o HTTPS (no file://).');
                return;
            }

            const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
            const isAndroid = /android/i.test(navigator.userAgent);
            const isStandalone = globalThis.matchMedia('(display-mode: standalone)').matches || globalThis.navigator.standalone;

            if (deferredInstallPrompt) {
                deferredInstallPrompt.prompt();
                await deferredInstallPrompt.userChoice;
                deferredInstallPrompt = null;
                document.getElementById('install-app-btn')?.classList.add('hidden');
                return;
            }

            if (isIos && !isStandalone) {
                alert('Para instalar: tocá Compartir y luego “Agregar a pantalla de inicio”.');
                return;
            }

            if (isAndroid && !isStandalone) {
                alert('Para instalar en Android: abrí el menú del navegador (⋮) y elegí “Instalar app” o “Agregar a pantalla principal”.');
            }
        }


        function setStatus(state) {
            const dot = document.getElementById('status-dot');
            const text = document.getElementById('status-text');
            const pulse = document.getElementById('status-pulse');
            
            if (state === 'ERROR') {
                dot.className = 'flex items-center gap-1.5 px-2 py-1 bg-red-500/10 rounded-full border border-red-500/10';
                text.className = 'text-[9px] font-black text-red-600';
                text.innerText = 'ERROR';
                pulse.className = 'w-1.5 h-1.5 rounded-full bg-red-500';
            } else {
                dot.className = 'flex items-center gap-1.5 px-2 py-1 bg-emerald-500/10 rounded-full border border-emerald-500/10';
                text.className = 'text-[9px] font-black text-emerald-600';
                text.innerText = 'LIVE';
                pulse.className = 'w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse';
            }
        }

        function init() {
            if (!startupWarmupPromise) {
                startupWarmupPromise = prefetchInitialCache();
            }

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
            warmupInitialData();
            forceRefresh();

            const isSupportedOrigin = globalThis.location.protocol === 'http:' || globalThis.location.protocol === 'https:';
            if ('serviceWorker' in navigator && isSupportedOrigin) {
                navigator.serviceWorker.register('./sw.js').catch(err => console.log('SW setup skipped:', err));
            }
        }

        async function warmupInitialData() {
            try {
                if (!startupWarmupPromise) {
                    startupWarmupPromise = prefetchInitialCache();
                }
                await startupWarmupPromise;
            } catch (e) {
                console.warn('Warmup inicial incompleto', e);
            } finally {
                startupWarmupPromise = null;
            }
        }

        async function prefetchInitialCache() {
            try {
                const busRes = await fetchAPI("/colectivos/vehiclePositionsSimple");

                if (busRes.success && Array.isArray(busRes.data)) {
                    globalThis.cache.bus = busRes.data;
                    document.getElementById('last-update').innerText = `Última act: ${new Date().toLocaleTimeString('es-AR', { hour12: false })}`;
                    renderMarkers();
                }

                const [subteRes, bikeInfoRes, bikeStatusRes] = await Promise.allSettled([
                    fetchAPI("/subtes/forecastGTFS"),
                    fetchAPI("/ecobici/gbfs/stationInformation"),
                    fetchAPI("/ecobici/gbfs/stationStatus")
                ]);

                const resolvedSubte = subteRes.status === 'fulfilled' ? subteRes.value : { success: false, data: null };
                const resolvedBikeInfo = bikeInfoRes.status === 'fulfilled' ? bikeInfoRes.value : { success: false, data: null };
                const resolvedBikeStatus = bikeStatusRes.status === 'fulfilled' ? bikeStatusRes.value : { success: false, data: null };

                if (resolvedSubte.success && resolvedSubte.data) {
                    globalThis.cache.subteForecast = resolvedSubte.data?.Entity || [];
                    globalThis.cache.subteTimestamp = resolvedSubte.data?.Header?.timestamp || Math.floor(Date.now() / 1000);
                    buildSubteForecastIndex(resolvedSubte.data);
                }

                if (resolvedBikeInfo.success && resolvedBikeStatus.success) {
                    const infoMap = {};
                    (resolvedBikeInfo.data?.data?.stations || []).forEach(s => infoMap[s.station_id] = s);
                    globalThis.cache.bike = (resolvedBikeStatus.data?.data?.stations || [])
                        .filter(s => infoMap[s.station_id])
                        .map(s => ({ ...infoMap[s.station_id], ...s }));
                }
            } catch (e) {
                console.warn('Prefetch inicial incompleto', e);
            }
        }

        async function fetchAPI(endpoint) {
            try {
                const url = `${BACKEND_URL}${endpoint}`;
                const response = await fetch(url, { 
                    method: 'GET',
                    headers: { 'Accept': 'application/json' },
                    signal: AbortSignal.timeout(7000) 
                });
                
                if (!response.ok) return { success: false, data: null };

                const contentType = response.headers.get("content-type");
                if (!contentType?.includes("application/json")) {
                    return { success: false, data: null };
                }

                const data = await response.json();
                return { success: !!data, data };
            } catch { 
                return { success: false, data: null }; 
            }
        }

        async function fetchWithRetry(endpoint) {
            while (true) {
                const res = await fetchAPI(endpoint);
                if (res.success) {
                    setStatus('LIVE');
                    return res.data;
                }
                setStatus('ERROR');
                console.warn(`Falló fetch a ${endpoint}, reintentando en 1s...`);
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }

        function forceRefresh() {
            if (!isRefreshing) refreshLoop();
        }

        function updateBusCache(busData) {
            if (!activeTypes.bus) return;
            globalThis.cache.bus = Array.isArray(busData) ? busData : [];
            document.getElementById('last-update').innerText = `Última act: ${new Date().toLocaleTimeString('es-AR', { hour12: false })}`;
        }

        function updateBikeCache(bikeInfo, bikeStatus) {
            if (activeTypes.bike && bikeInfo && bikeStatus) {
                const infoMap = {};
                (bikeInfo.data?.stations || []).forEach(s => infoMap[s.station_id] = s);
                globalThis.cache.bike = (bikeStatus.data?.stations || [])
                    .filter(s => infoMap[s.station_id])
                    .map(s => ({ ...infoMap[s.station_id], ...s }));
                return;
            }

            if (!activeTypes.bike) {
                globalThis.cache.bike = [];
            }
        }

        function updateSubteCache(subteData) {
            if (activeTypes.subte && subteData) {
                globalThis.cache.subteForecast = subteData?.Entity || [];
                globalThis.cache.subteTimestamp = subteData?.Header?.timestamp || Math.floor(Date.now() / 1000);
                buildSubteForecastIndex(subteData);
                return;
            }

            if (!activeTypes.subte) {
                globalThis.cache.subteForecast = [];
                globalThis.cache.subteForecastByStop = {};
                globalThis.cache.subteForecastByBaseStop = {};
                globalThis.cache.subteForecastByName = {};
                globalThis.cache.subteTimestamp = null;
            }
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
                const busPromise = activeTypes.bus ? fetchWithRetry("/colectivos/vehiclePositionsSimple") : Promise.resolve([]);
                const subtePromise = activeTypes.subte ? fetchWithRetry("/subtes/forecastGTFS") : Promise.resolve(null);
                const bikeInfoPromise = activeTypes.bike ? fetchWithRetry("/ecobici/gbfs/stationInformation") : Promise.resolve(null);
                const bikeStatusPromise = activeTypes.bike ? fetchWithRetry("/ecobici/gbfs/stationStatus") : Promise.resolve(null);

                const [busData, subteData, bikeInfo, bikeStatus] = await Promise.all([busPromise, subtePromise, bikeInfoPromise, bikeStatusPromise]);

                updateBusCache(busData);
                updateBikeCache(bikeInfo, bikeStatus);
                updateSubteCache(subteData);
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



        async function toggleType(type) {
            activeTypes[type] = !activeTypes[type];
            const btn = document.getElementById(`t-${type}`);
            
            if (type === 'bike') {
                btn.classList.toggle('active-eco', activeTypes[type]);
            } else {
                btn.classList.toggle('active', activeTypes[type]);
            }

            if (type === 'train' && activeTypes[type] && !globalThis.cache.trainStatic) {
                globalThis.cache.trainStatic = globalThis.TRAIN_STATIC || null;
                renderMarkers();
            }
            
            forceRefresh();
        }

        function buildUserLocationTooltip(position) {
            const coords = position?.coords || {};
            const latitude = Number(coords.latitude || 0);
            const longitude = Number(coords.longitude || 0);
            const latFixed = latitude.toFixed(6);
            const lonFixed = longitude.toFixed(6);

            return `
                <div class="glass p-2.5 rounded-2xl shadow-xl border border-white/50 min-w-[210px]">
                    <div class="text-[9px] font-black text-indigo-700 uppercase tracking-wide mb-1">Tu ubicación</div>
                    <div class="text-[10px] font-black text-slate-800 leading-tight">${latFixed}, ${lonFixed}</div>
                </div>`;
        }

        function locateUser() {
            if (!navigator.geolocation) return;
            navigator.geolocation.getCurrentPosition(pos => {
                const { latitude, longitude } = pos.coords;
                userLayer.clearLayers();
                const userMarker = L.marker([latitude, longitude], {
                    icon: L.divIcon({
                        className: 'user-location-icon',
                        html: '<div class="user-person-marker"><div class="user-person-pulse"></div><div class="user-person-body">🧍</div></div>',
                        iconSize: [38, 38],
                        iconAnchor: [19, 19]
                    })
                }).addTo(userLayer);

                userMarker.bindTooltip(buildUserLocationTooltip(pos), {
                    className: 'custom-tooltip',
                    direction: 'top',
                    offset: [0, -20],
                    opacity: 1
                });

                map.flyTo([latitude, longitude], 15);
            }, (err) => {
                console.warn("Geolocation error", err);
            }, { enableHighAccuracy: true });
        }

        document.addEventListener('DOMContentLoaded', init);

