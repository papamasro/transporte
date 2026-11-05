// Única fuente de configuración de la app. Para overrides puntuales (p. ej. otro backend en un
// deploy), definir globalThis.APP_CONFIG parcial antes de cargar este archivo: se mezcla en
// profundidad sobre estos defaults.
(() => {
    const APP_CONFIG_DEFAULTS = {
        API: {
            backendBaseUrl: 'https://transporte-be.papamasro.workers.dev',
            sofseBaseUrl: 'https://transporte-be.papamasro.workers.dev/trenes'
        },
        PATHS: {
            kvGet: '/obtener-kv',
            busVehiclePositions: '/colectivos/vehiclePositionsSimple',
            // { current: { ts, data }, prev: { ts, data } | null }: solo para la animación (ver BUS_ANIMATION).
            busVehiclePositionsKV: '/colectivos/vehiclePositionsKV',
            busInfoTrayecto: '/info-trayecto',
            busSearchLine: '/buscar-linea',
            // Relativo al sitio (no al backend): JSON generados por scripts/build-static-routes.py.
            busStaticRoutes: './data/routes/',
            busServiceAlerts: '/colectivos/serviceAlerts',
            busServiceAlertsJson: '/colectivos/serviceAlertsJson',
            subteForecast: '/subtes/forecastGTFS',
            subteServiceAlerts: '/subtes/serviceAlerts',
            subteServiceAlertsJson: '/subtes/serviceAlertsJson',
            trainLineArrivals: '/trenes/arribosLinea',
            clientErrors: '/client-errors',
            bikeStationInformation: '/ecobici/gbfs/stationInformation',
            bikeStationStatus: '/ecobici/gbfs/stationStatus',
            bikeRoutes: '/obtener-bicisenda',
            sofseStations: '/infraestructura/estaciones',
            sofseArrivalsByStation: '/arribos/estacion'
        },
        KV_KEYS: {
            subteLines: 'subte-lines',
            subteStations: 'subte-stations',
            trainLines: 'train-lines',
            trainStations: 'train-stations'
        },
        // Polling adaptativo: cada fuente se pide solo si su capa está activa y venció su intervalo.
        // El loop se pausa con la pestaña oculta.
        POLLING: {
            busIntervalMs: 30000,
            subteIntervalMs: 60000,
            bikeIntervalMs: 60000,
            trainIntervalMs: 60000,
            // Panel de cercanos: colectivos en vivo del radio (ecobici/subte/trenes usan sus intervalos).
            nearbyIntervalMs: 30000,
            // Debajo de este zoom no se dibujan colectivos ni se piden posiciones (salvo búsqueda de línea).
            busMinZoom: 12
        },
        // Agrupado de colectivos en pantalla (grilla en píxeles): debajo de chipsFromZoom las celdas con
        // minClusterSize o más colectivos se dibujan como una burbuja con el total (tocar = acercar).
        // Con búsqueda de línea se usan celdas más chicas y solo se agrupa con mucha densidad.
        // chipAreaPx: px² de mapa por chip; con más colectivos en vista que (ancho × alto) / chipAreaPx
        // se sigue agrupando aunque el zoom alcance (hasta denseMaxZoom). 0 = sin tope.
        BUS_CLUSTER: {
            enabled: true,
            chipsFromZoom: 15,
            cellSizePx: 64,
            minClusterSize: 2,
            filterCellSizePx: 44,
            filterMinClusterSize: 8,
            chipAreaPx: 2000,
            denseMaxZoom: 17
        },
        BUS_ANIMATION: {
            // Además del flag busAnimation; con prefers-reduced-motion nunca se anima.
            enabled: true,
            // Duración de cada tramo (posición mostrada -> nueva) = intervalo medido entre snapshots, acotado.
            minSegmentMs: 8000,
            maxSegmentMs: 45000,
            // Si el próximo snapshot se demora, se sigue proyectando el último rumbo/velocidad un rato corto.
            deadReckoningMs: 6000,
            deadReckoningMaxMeters: 40,
            // Saltos más largos (GPS erróneo, otro recorrido) no se animan.
            maxAnimatedJumpMeters: 2500,
            frameBudgetMs: 3,
            // Si ningún snapshot del cliente es más nuevo que esto se pide la ruta KV (trae el previo).
            kvWhenSnapshotOlderThanMs: 75000
        },
        TIMEOUTS: {
            // Intervalo base del loop (compat); los intervalos por fuente están en POLLING.
            updateIntervalMs: 30000,
            trainArrivalsTtlMs: 20000,
            trainTooltipFetchDelayMs: 280,
            // Ecobici stationInformation (estático); stationStatus se pide en cada refresh.
            bikeStationInfoTtlMs: 3600000
        },
        NETWORK: {
            // fetchAPI: timeout por intento y reintentos extra (solo ante red/timeout/5xx).
            requestTimeoutMs: 10000,
            requestRetries: 2,
            // Claves = claves de PATHS.
            endpointPolicies: {
                busVehiclePositions: { timeoutMs: 35000, retries: 1 },
                // Sin reintentos: ante 404/5xx se cae enseguida a busVehiclePositions.
                busVehiclePositionsKV: { timeoutMs: 35000, retries: 0 },
                // En frío el worker consulta ~15-20 estaciones SOFSE (4 en paralelo).
                trainLineArrivals: { timeoutMs: 25000, retries: 0 },
                busServiceAlertsJson: { retries: 0 },
                subteServiceAlertsJson: { retries: 0 }
            },
            retryMax: 3,
            retryDelayMs: 1000,
            sofse403DelayMs: 2800,
            // Timeout por intento SOFSE (incluye la lectura del body).
            sofseRequestTimeoutMs: 12000,
            // Estaciones que no se pudieron mapear a SOFSE no se vuelven a buscar durante este TTL.
            sofseStationNegativeCacheTtlMs: 600000,
            busRouteMaxTripCandidates: 3,
            busRouteMaxFallbackVehicles: 3,
            busRouteMaxCallsPerSelection: 3,
            busRouteNoResultTtlMs: 30000,
            // Cache de recorridos/búsqueda de línea (independiente del refresh de posiciones).
            busRouteCacheTtlMs: 600000,
            busRouteNegativeCacheTtlMs: 120000,
            busRouteMaxShapeDistanceMeters: 1500,
            busRouteMinShapePoints: 20
        },
        FEATURES: {
            busStaticRoutes: true,
            // Trenes en vivo (/trenes/arribosLinea): máximo de líneas en vista pedidas por refresh.
            trainLiveMaxLines: 4,
            // Líneas que SOFSE no informa (operadores privados): sin arribos en vivo, no se consultan.
            trainLinesWithoutRealtime: ['URQUIZA1', 'BELGRANO NORTE'],
            // Radio inicial del panel de cercanos; si no está en nearbyRadiusOptions se agrega como opción.
            nearbyStopsRadiusMeters: 1000,
            nearbyRadiusOptions: [500, 1000, 2000],
            nearbyBusRouteFetchMax: 8,
            nearbyTrainRealtimeStations: 4,
            nearbyBusCacheMaxAgeMs: 45000
        },
        // Reporte de errores JS al worker (POST /client-errors, sin terceros). Mantener appVersion
        // igual a CACHE_VERSION de sw.js.
        ERROR_REPORTING: {
            enabled: true,
            appVersion: 'v7',
            maxPerSession: 5,
            allowLocalhost: false
        },
        ANALYTICS: {
            // Google Analytics 4: se carga solo tras el consentimiento (js/app/consent.js).
            gaMeasurementId: 'G-RHZN8GPH8G'
        },
        MAP: {
            apiKey: '',
            // Esri World Street Map: no requiere API key, pero su uso está sujeto a los términos de Esri
            // (atribución visible obligatoria; uso comercial o de alto volumen puede requerir cuenta ArcGIS).
            tileUrl: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}',
            maxZoom: 19,
            // copyrightText del servicio (…/World_Street_Map/MapServer?f=json) + "Powered by Esri".
            attribution: 'Powered by <a href="https://www.esri.com" target="_blank" rel="noopener">Esri</a> | Sources: Esri, HERE, Garmin, USGS, Intermap, INCREMENT P, NRCan, Esri Japan, METI, Esri China (Hong Kong), Esri Korea, Esri (Thailand), NGCC, &copy; OpenStreetMap contributors, and the GIS User Community',
            // Tema oscuro: Esri Dark Gray Canvas (base + etiquetas en capa aparte), mismos términos de uso.
            // En AMBA solo hay teselas hasta z16: más cerca se escalan (maxNativeZoom) en vez de
            // mostrar "Map data not yet available".
            darkTileUrl: 'https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
            darkReferenceTileUrl: 'https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}',
            darkMaxNativeZoom: 16,
            // copyrightText de ambos servicios (…/World_Dark_Gray_Base/MapServer?f=json) + "Powered by Esri".
            darkAttribution: 'Powered by <a href="https://www.esri.com" target="_blank" rel="noopener">Esri</a> | Esri, HERE, Garmin, &copy; OpenStreetMap contributors, and the GIS user community'
        }
    };

    const isPlainObject = value => !!value && typeof value === 'object' && !Array.isArray(value);

    const deepMerge = (base, overrides) => {
        const result = { ...base };
        if (!isPlainObject(overrides)) return result;
        Object.keys(overrides).forEach(key => {
            const value = overrides[key];
            if (value === undefined) return;
            result[key] = isPlainObject(value) && isPlainObject(base[key])
                ? deepMerge(base[key], value)
                : value;
        });
        return result;
    };

    globalThis.APP_CONFIG = deepMerge(APP_CONFIG_DEFAULTS, globalThis.APP_CONFIG);
})();
