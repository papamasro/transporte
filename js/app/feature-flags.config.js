// Flags efectivos del deploy (se mezclan sobre los defaults de js/app/feature-flags.js).
// false apaga la funcionalidad: se oculta su UI y no se piden sus datos.
globalThis.APP_FEATURE_FLAGS = {
    // Shell general
    analytics: true,
    serviceWorker: true,
    installPrompt: true,
    geolocation: true,
    manualRefresh: true,
    autoRefresh: true,
    alertsPanel: true,
    nearbyPanel: true,

    // Modos principales de la app
    busLayer: true,
    subteLayer: true,
    trainLayer: true,
    bikeLayer: true,

    // Integraciones y datos remotos
    busLivePositions: true,
    busRouteOverlay: true,
    busLineSearchOverlay: true,
    busServiceAlerts: true,
    busAnimation: true,
    subteStaticData: true,
    subteRealtime: true,
    subteServiceAlerts: true,
    trainStaticData: true,
    trainRealtime: true,
    bikeStations: true,
    bikeRoutes: true,

    // Panel de cercanos
    nearbyBusVehicles: true,
    nearbyBusStops: true,
    nearbySubte: true,
    nearbyTrain: true,
    nearbyBike: true
};
