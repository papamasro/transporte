// Tema del mapa base: Automático (sigue prefers-color-scheme), Claro (Esri World Street Map) u
// Oscuro (Esri Dark Gray Canvas). La preferencia se guarda; el tema resuelto queda en
// <html data-map-theme="light|dark"> para que el CSS ajuste controles y trazos sobre el mapa.

const MAP_THEME_STORAGE_KEY = 'radaramba.map-theme-v1';
const MAP_THEME_PREFERENCES = ['auto', 'light', 'dark'];
const MAP_THEME_LABELS = { auto: 'Automático', light: 'Claro', dark: 'Oscuro' };

const mapThemeState = {
    map: null,
    preference: 'auto',
    resolved: null,
    layers: { light: [], dark: [] },
    mediaQuery: null
};

function readMapThemePreference() {
    try {
        const stored = globalThis.localStorage?.getItem(MAP_THEME_STORAGE_KEY);
        return MAP_THEME_PREFERENCES.includes(stored) ? stored : 'auto';
    } catch {
        return 'auto';
    }
}

function storeMapThemePreference(preference) {
    try {
        if (preference === 'auto') globalThis.localStorage?.removeItem(MAP_THEME_STORAGE_KEY);
        else globalThis.localStorage?.setItem(MAP_THEME_STORAGE_KEY, preference);
    } catch {}
}

function resolveMapTheme(preference = mapThemeState.preference) {
    if (preference === 'light' || preference === 'dark') return preference;
    return mapThemeState.mediaQuery?.matches ? 'dark' : 'light';
}

function withMapApiKey(url, apiKey) {
    if (!apiKey || !url) return url;
    if (url.includes('{apiKey}')) return url.replace('{apiKey}', encodeURIComponent(apiKey));
    if (url.includes('api_key=')) return url;
    return `${url}${url.includes('?') ? '&' : '?'}api_key=${encodeURIComponent(apiKey)}`;
}

function buildMapThemeLayers() {
    const mapConfig = globalThis.APP_CONFIG?.MAP || {};
    const apiKey = (mapConfig.apiKey || '').toString().trim();
    const maxZoom = Number(mapConfig.maxZoom) || 19;
    const light = [L.tileLayer(withMapApiKey(mapConfig.tileUrl || '', apiKey), {
        maxZoom,
        attribution: mapConfig.attribution || 'Powered by Esri'
    })];
    const dark = [];
    if (mapConfig.darkTileUrl) {
        const darkOptions = { maxZoom, maxNativeZoom: Number(mapConfig.darkMaxNativeZoom) || maxZoom };
        dark.push(L.tileLayer(withMapApiKey(mapConfig.darkTileUrl, apiKey), {
            ...darkOptions,
            attribution: mapConfig.darkAttribution || mapConfig.attribution || 'Powered by Esri'
        }));
        if (mapConfig.darkReferenceTileUrl) {
            dark.push(L.tileLayer(withMapApiKey(mapConfig.darkReferenceTileUrl, apiKey), { ...darkOptions, zIndex: 2 }));
        }
    }
    return { light, dark };
}

function syncMapThemeMenu() {
    document.querySelectorAll('[data-map-theme]').forEach(item => {
        item.setAttribute('aria-checked', String(item.dataset.mapTheme === mapThemeState.preference));
    });
    const summary = document.getElementById('map-theme-current');
    if (summary) summary.textContent = MAP_THEME_LABELS[mapThemeState.preference];
}

function applyMapTheme() {
    const { map, layers } = mapThemeState;
    // Sin configuración de mapa oscuro se queda en el claro.
    const resolved = layers.dark.length > 0 ? resolveMapTheme() : 'light';
    document.documentElement.dataset.mapTheme = resolved;
    syncMapThemeMenu();
    if (!map || mapThemeState.resolved === resolved) return;
    mapThemeState.resolved = resolved;
    const hidden = resolved === 'dark' ? layers.light : layers.dark;
    const shown = resolved === 'dark' ? layers.dark : layers.light;
    hidden.forEach(layer => map.removeLayer(layer));
    shown.forEach(layer => layer.addTo(map));
}

function getMapTheme() {
    return document.documentElement.dataset.mapTheme === 'dark' ? 'dark' : 'light';
}

function setMapThemePreference(preference) {
    if (!MAP_THEME_PREFERENCES.includes(preference)) return;
    mapThemeState.preference = preference;
    storeMapThemePreference(preference);
    applyMapTheme();
}

function initMapTheme(map) {
    mapThemeState.map = map;
    mapThemeState.preference = readMapThemePreference();
    mapThemeState.mediaQuery = globalThis.matchMedia?.('(prefers-color-scheme: dark)') || null;
    mapThemeState.mediaQuery?.addEventListener?.('change', () => {
        if (mapThemeState.preference === 'auto') applyMapTheme();
    });
    mapThemeState.layers = buildMapThemeLayers();
    document.getElementById('app-menu')?.addEventListener('click', event => {
        const item = event.target.closest('[data-map-theme]');
        if (item) setMapThemePreference(item.dataset.mapTheme);
    });
    applyMapTheme();
}

globalThis.initMapTheme = initMapTheme;
globalThis.getMapTheme = getMapTheme;
globalThis.setMapThemePreference = setMapThemePreference;
