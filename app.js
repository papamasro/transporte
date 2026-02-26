        const BACKEND_URL = "https://transporte-be.papamasro.workers.dev";
        const UPDATE_INTERVAL = 30000; 
        
        let map, layers = { bus: null, bike: null, subteLines: null, subteStations: null }, userLayer;
        let activeTypes = { bus: true, subte: false, bike: false };
        let isRefreshing = false;
        let isPanelOpen = true;
        let isAlertsOpen = false;
        let deferredInstallPrompt = null;
        let refreshTimeout;
        const lineColors = {};
        window.cache = { bus: [], bike: [], subteForecast: [], subteForecastByStop: {}, subteForecastByBaseStop: {}, subteForecastByName: {}, subteTimestamp: null };

        const SUBTE_STATIC = window.SUBTE_STATIC;
        const SUBTE_STATIC_TIMETABLE = window.SUBTE_STATIC_TIMETABLE;

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

            const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
            const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;

            window.addEventListener('beforeinstallprompt', (event) => {
                event.preventDefault();
                deferredInstallPrompt = event;
                installBtn.classList.remove('hidden');
            });

            window.addEventListener('appinstalled', () => {
                deferredInstallPrompt = null;
                installBtn.classList.add('hidden');
            });

            if (isIos && !isStandalone) {
                installBtn.classList.remove('hidden');
            }
        }

        async function installApp() {
            const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
            const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;

            if (deferredInstallPrompt) {
                deferredInstallPrompt.prompt();
                await deferredInstallPrompt.userChoice;
                deferredInstallPrompt = null;
                document.getElementById('install-app-btn')?.classList.add('hidden');
                return;
            }

            if (isIos && !isStandalone) {
                alert('Para instalar: tocá Compartir y luego “Agregar a pantalla de inicio”.');
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
            userLayer = L.layerGroup().addTo(map);

            lucide.createIcons();
            
            document.getElementById('search').addEventListener('input', renderMarkers);
            map.on('moveend', renderMarkers);
            
            // CAMBIO 4: Auto-ubicar al usuario cuando termina de inicializar
            locateUser();
            setupInstallPrompt();
            warmupInitialData();
            forceRefresh();

            if ('serviceWorker' in navigator) {
                navigator.serviceWorker.register('./sw.js').catch(err => console.log('SW setup skipped:', err));
            }
        }

        async function warmupInitialData() {
            try {
                const [busRes, subteRes, bikeInfoRes, bikeStatusRes] = await Promise.all([
                    fetchAPI("/colectivos/vehiclePositionsSimple"),
                    fetchAPI("/subtes/forecastGTFS"),
                    fetchAPI("/ecobici/gbfs/stationInformation"),
                    fetchAPI("/ecobici/gbfs/stationStatus")
                ]);

                if (busRes.success && Array.isArray(busRes.data)) {
                    window.cache.bus = busRes.data;
                }

                if (subteRes.success && subteRes.data) {
                    window.cache.subteForecast = subteRes.data?.Entity || [];
                    window.cache.subteTimestamp = subteRes.data?.Header?.timestamp || Math.floor(Date.now() / 1000);
                    buildSubteForecastIndex(subteRes.data);
                }

                if (bikeInfoRes.success && bikeStatusRes.success) {
                    const infoMap = {};
                    (bikeInfoRes.data?.data?.stations || []).forEach(s => infoMap[s.station_id] = s);
                    window.cache.bike = (bikeStatusRes.data?.data?.stations || [])
                        .filter(s => infoMap[s.station_id])
                        .map(s => ({ ...infoMap[s.station_id], ...s }));
                }

                renderMarkers();
            } catch (e) {
                console.warn('Warmup inicial incompleto', e);
            }
        }

        async function fetchAPI(endpoint) {
            try {
                const url = `${BACKEND_URL}${endpoint}`;
                const response = await fetch(url, { 
                    method: 'GET',
                    headers: { 'Accept': 'application/json' },
                    signal: AbortSignal.timeout(10000) 
                });
                
                if (!response.ok) return { success: false, data: null };

                const contentType = response.headers.get("content-type");
                if (!contentType || !contentType.includes("application/json")) {
                    return { success: false, data: null };
                }

                const data = await response.json();
                return { success: !!data, data };
            } catch (e) { 
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
                console.warn(`Falló fetch a ${endpoint}, reintentando en 3s...`);
                await new Promise(resolve => setTimeout(resolve, 3000));
            }
        }

        function forceRefresh() {
            if (!isRefreshing) refreshLoop();
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
                
                if (activeTypes.bus) {
                    window.cache.bus = Array.isArray(busData) ? busData : [];
                    document.getElementById('last-update').innerText = `Última act: ${new Date().toLocaleTimeString('es-AR', { hour12: false })}`;
                }

                if (activeTypes.bike && bikeInfo && bikeStatus) {
                    const infoMap = {};
                    (bikeInfo.data?.stations || []).forEach(s => infoMap[s.station_id] = s);
                    window.cache.bike = (bikeStatus.data?.stations || [])
                        .filter(s => infoMap[s.station_id])
                        .map(s => ({ ...infoMap[s.station_id], ...s }));
                } else if (!activeTypes.bike) {
                    window.cache.bike = [];
                }

                if (activeTypes.subte && subteData) {
                    window.cache.subteForecast = subteData?.Entity || [];
                    window.cache.subteTimestamp = subteData?.Header?.timestamp || Math.floor(Date.now() / 1000);
                    buildSubteForecastIndex(subteData);
                } else if (!activeTypes.subte) {
                    window.cache.subteForecast = [];
                    window.cache.subteForecastByStop = {};
                    window.cache.subteForecastByBaseStop = {};
                    window.cache.subteForecastByName = {};
                    window.cache.subteTimestamp = null;
                }

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



        function toggleType(type) {
            activeTypes[type] = !activeTypes[type];
            const btn = document.getElementById(`t-${type}`);
            
            if (type === 'bike') {
                btn.classList.toggle('active-eco', activeTypes[type]);
            } else {
                btn.classList.toggle('active', activeTypes[type]);
            }
            
            forceRefresh();
        }

        function locateUser() {
            if (!navigator.geolocation) return;
            navigator.geolocation.getCurrentPosition(pos => {
                const { latitude, longitude } = pos.coords;
                userLayer.clearLayers();
                L.circleMarker([latitude, longitude], { 
                    radius: 8, 
                    fillColor: '#4f46e5', 
                    color: 'white', 
                    weight: 3, 
                    fillOpacity: 0.8 
                }).addTo(userLayer);
                map.flyTo([latitude, longitude], 15);
            }, (err) => {
                console.warn("Geolocation error", err);
            }, { enableHighAccuracy: true });
        }

        document.addEventListener('DOMContentLoaded', init);
