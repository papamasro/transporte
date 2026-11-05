// Flags de funcionalidades. Los valores efectivos salen de js/app/feature-flags.config.js (cargado
// antes) mezclados sobre estos defaults. index.html carga este archivo antes que cualquier js/features
// y que consent.js: el resto del código llama a isFeatureEnabled() & cía. sin guards de typeof.
(() => {
    const DEFAULT_FEATURE_FLAGS = {
        // Shell general
        analytics: true,
        serviceWorker: true,
        installPrompt: true,
        geolocation: true,
        manualRefresh: true,
        autoRefresh: true,
        alertsPanel: true,
        nearbyPanel: true,

        // Modos principales
        busLayer: true,
        subteLayer: true,
        trainLayer: true,
        bikeLayer: true,

        // Funcionalidades con backend
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

        // Cortes del panel de cercanos
        nearbyBusVehicles: true,
        nearbyBusStops: true,
        nearbySubte: true,
        nearbyTrain: true,
        nearbyBike: true
    };

    const configuredFlags = globalThis.APP_FEATURE_FLAGS;
    const mergedFlags = (configuredFlags && typeof configuredFlags === 'object')
        ? { ...DEFAULT_FEATURE_FLAGS, ...configuredFlags }
        : { ...DEFAULT_FEATURE_FLAGS };

    function isFeatureEnabled(flagKey) {
        if (!flagKey) return true;
        return mergedFlags[flagKey] !== false;
    }

    // Capa disponible para el usuario (botón visible y toggleable).
    function isTransportTypeEnabled(type) {
        switch (type) {
            case 'bus':
                return isFeatureEnabled('busLayer') && isFeatureEnabled('busLivePositions');
            case 'subte':
                return isFeatureEnabled('subteLayer') && isFeatureEnabled('subteStaticData');
            case 'train':
                return isFeatureEnabled('trainLayer') && isFeatureEnabled('trainStaticData');
            case 'bike':
                return isFeatureEnabled('bikeLayer') && (isFeatureEnabled('bikeStations') || isFeatureEnabled('bikeRoutes'));
            default:
                return false;
        }
    }

    function isNearbySliceEnabled(sliceKey) {
        if (!isFeatureEnabled('nearbyPanel')) return false;

        switch (sliceKey) {
            case 'busVehicles':
                return isFeatureEnabled('nearbyBusVehicles') && isFeatureEnabled('busLivePositions');
            case 'busStops':
                return isFeatureEnabled('nearbyBusStops')
                    && isFeatureEnabled('nearbyBusVehicles')
                    && isFeatureEnabled('busRouteOverlay')
                    && isFeatureEnabled('busLivePositions');
            case 'subte':
                return isFeatureEnabled('nearbySubte') && isFeatureEnabled('subteStaticData');
            case 'train':
                return isFeatureEnabled('nearbyTrain') && isFeatureEnabled('trainStaticData');
            case 'bike':
                return isFeatureEnabled('nearbyBike') && (isFeatureEnabled('bikeStations') || isFeatureEnabled('bikeRoutes'));
            // Dentro del corte de ecobici: estaciones y bicisendas son independientes.
            case 'bikeStations':
                return isFeatureEnabled('nearbyBike') && isFeatureEnabled('bikeStations');
            case 'bikeRoutes':
                return isFeatureEnabled('nearbyBike') && isFeatureEnabled('bikeRoutes');
            default:
                return false;
        }
    }

    function getEnabledTransportTypes() {
        return ['bus', 'subte', 'train', 'bike'].filter(isTransportTypeEnabled);
    }

    // Controles del shell que se ocultan (clase .feature-off) si su funcionalidad está apagada.
    const FLAGGED_ELEMENTS = [
        ['t-bus', () => isTransportTypeEnabled('bus')],
        ['t-subte', () => isTransportTypeEnabled('subte')],
        ['t-train', () => isTransportTypeEnabled('train')],
        ['t-bike', () => isTransportTypeEnabled('bike')],
        ['action-locate', () => isFeatureEnabled('geolocation')],
        ['map-locate-fab', () => isFeatureEnabled('geolocation')],
        ['action-nearby', () => isFeatureEnabled('nearbyPanel')],
        ['nearby-panel', () => isFeatureEnabled('nearbyPanel')],
        ['action-refresh', () => isFeatureEnabled('manualRefresh')],
        ['action-alerts', () => isFeatureEnabled('alertsPanel')],
        ['alerts-panel', () => isFeatureEnabled('alertsPanel')],
        ['install-app-btn', () => isFeatureEnabled('installPrompt')],
        ['location-prompt-gps', () => isFeatureEnabled('geolocation')]
    ];

    function applyFeatureFlagsToDom() {
        FLAGGED_ELEMENTS.forEach(([id, isEnabled]) => {
            const element = document.getElementById(id);
            if (!element) return;
            const enabled = isEnabled();
            element.classList.toggle('feature-off', !enabled);
            if (enabled) element.removeAttribute('aria-hidden');
            else element.setAttribute('aria-hidden', 'true');
        });
    }

    globalThis.APP_FEATURE_FLAGS = mergedFlags;
    globalThis.isFeatureEnabled = isFeatureEnabled;
    globalThis.isTransportTypeEnabled = isTransportTypeEnabled;
    globalThis.isNearbySliceEnabled = isNearbySliceEnabled;
    globalThis.getEnabledTransportTypes = getEnabledTransportTypes;
    globalThis.applyFeatureFlagsToDom = applyFeatureFlagsToDom;

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', applyFeatureFlagsToDom);
    else applyFeatureFlagsToDom();
})();
