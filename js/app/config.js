globalThis.APP_CONFIG = {
    API: {
        backendBaseUrl: 'https://transporte-be.papamasro.workers.dev',
        sofseBaseUrl: 'https://transporte-be.papamasro.workers.dev/trenes'
    },
    PATHS: {
        kvGet: '/obtener-kv',
        busVehiclePositions: '/colectivos/vehiclePositionsSimple',
        busInfoTrayecto: '/info-trayecto',
        busSearchLine: '/buscar-linea',
        busServiceAlerts: '/colectivos/serviceAlerts',
        subteForecast: '/subtes/forecastGTFS',
        subteServiceAlerts: '/subtes/serviceAlerts',
        bikeStationInformation: '/ecobici/gbfs/stationInformation',
        bikeStationStatus: '/ecobici/gbfs/stationStatus',
        sofseStations: '/infraestructura/estaciones',
        sofseArrivalsByStation: '/arribos/estacion'
    },
    KV_KEYS: {
        subteLines: 'subte-lines',
        subteStations: 'subte-stations',
        trainLines: 'train-lines',
        trainStations: 'train-stations'
    },
    TIMEOUTS: {
        updateIntervalMs: 30000,
        trainArrivalsTtlMs: 20000,
        trainTooltipFetchDelayMs: 280
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
