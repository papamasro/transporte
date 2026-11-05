// Subir CACHE_VERSION en cada deploy que cambie archivos del app shell: el SW nuevo precachea todo
// de nuevo y borra los caches de versiones anteriores al activarse.
const CACHE_VERSION = 'v7';
const CACHE_PREFIX = 'radar-amba-shell-';
const CACHE_NAME = `${CACHE_PREFIX}${CACHE_VERSION}`;
const NAVIGATION_TIMEOUT_MS = 5000;

// Rutas relativas al scope del SW: funciona en la raíz del dominio o bajo un subpath (p. ej. /transporte/).
// Mantener sincronizado con los <link>/<script> de index.html y los íconos del manifest.
const PRECACHE_PATHS = [
    './',
    './index.html',
    './manifest.webmanifest',
    './assets/icons/icon-192.png',
    './assets/icons/icon-512.png',
    './assets/icons/icon-maskable-192.png',
    './assets/icons/icon-maskable-512.png',
    './assets/icons/icon.svg',
    './assets/fonts/outfit/outfit-latin.woff2',
    './assets/fonts/outfit/outfit-latin-ext.woff2',
    './assets/styles/tailwind.css',
    './assets/styles/main.css',
    './assets/vendor/leaflet-1.9.4/leaflet.css',
    './assets/vendor/leaflet-1.9.4/leaflet.js',
    './assets/vendor/leaflet-1.9.4/images/layers.png',
    './assets/vendor/leaflet-1.9.4/images/layers-2x.png',
    './assets/vendor/leaflet-1.9.4/images/marker-icon.png',
    './assets/vendor/leaflet-1.9.4/images/marker-icon-2x.png',
    './assets/vendor/leaflet-1.9.4/images/marker-shadow.png',
    './assets/vendor/lucide-0.321.0/lucide.min.js',
    './js/app/config.js',
    './js/app/error-reporter.js',
    './js/app/feature-flags.config.js',
    './js/app/feature-flags.js',
    './js/app/consent.js',
    './js/shared/utils.js',
    './js/app/toasts.js',
    './js/app/status-banners.js',
    './js/features/subte.js',
    './js/features/markers-bus-overlay.js',
    './js/features/markers-ui.js',
    './js/features/markers.js',
    './js/features/bus-animation.js',
    './js/features/alerts.js',
    './js/app/ui.js',
    './js/app/layout.js',
    './js/app/services.js',
    './js/features/nearby.js',
    './js/features/favorites.js',
    './js/features/search.js',
    './js/app/map-theme.js',
    './js/app/url-state.js',
    './js/app/bootstrap.js'
];

const STATIC_ASSET_PATTERN = /\.(?:css|js|png|svg|ico|webp|jpe?g|gif|woff2?|webmanifest)$/i;

// Recorridos estáticos (data/routes/*.json): no se precachean (son cientos de archivos); se
// guardan al usarse con stale-while-revalidate en un cache propio que sobrevive a los bumps
// de CACHE_VERSION, acotado a DATA_CACHE_MAX_ENTRIES.
const DATA_CACHE_NAME = 'radar-amba-data-v1';
const DATA_CACHE_MAX_ENTRIES = 80;
const DATA_ROUTES_PATTERN = /\/data\/routes\/[^/]+\.json$/;

const scopeUrl = () => new URL(globalThis.registration.scope);
const toScopedUrl = path => new URL(path, scopeUrl()).href;
const indexUrl = () => toScopedUrl('./index.html');

globalThis.addEventListener('install', (event) => {
    event.waitUntil((async () => {
        const cache = await caches.open(CACHE_NAME);
        // cache: 'reload' evita precachear copias viejas del cache HTTP (GitHub Pages cachea ~10 min).
        await cache.addAll(PRECACHE_PATHS.map(path => new Request(toScopedUrl(path), { cache: 'reload' })));
        // Solo se activa enseguida si el precache completo salió bien; si falla, el SW anterior sigue.
        await globalThis.skipWaiting();
    })());
});

globalThis.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        const keys = await caches.keys();
        await Promise.all(keys
            .filter(key => (key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
                || (key.startsWith('radar-amba-data-') && key !== DATA_CACHE_NAME))
            .map(key => caches.delete(key)));
        await globalThis.clients.claim();
    })());
});

function isCacheableResponse(response) {
    return !!response && response.ok && response.type === 'basic';
}

function isAppShellNavigation(url) {
    const scope = scopeUrl();
    return url.pathname === scope.pathname || url.pathname === new URL('./index.html', scope).pathname;
}

async function handleNavigation(event) {
    const cache = await caches.open(CACHE_NAME);
    const url = new URL(event.request.url);

    const networkPromise = fetch(event.request).then(response => {
        if (isCacheableResponse(response) && isAppShellNavigation(url)) {
            const copy = response.clone();
            event.waitUntil(cache.put(indexUrl(), copy).catch(() => {}));
        }
        return response;
    });
    networkPromise.catch(() => {});

    const cachedShell = () => cache.match(indexUrl()).then(hit => hit || cache.match(toScopedUrl('./')));

    // Network-first: si la red tarda demasiado (lie-fi) y hay shell cacheado, se sirve el cache.
    const timeoutPromise = new Promise(resolve => {
        setTimeout(() => cachedShell().then(resolve, () => resolve(undefined)), NAVIGATION_TIMEOUT_MS);
    });

    try {
        const response = await Promise.race([networkPromise, timeoutPromise]);
        if (response) return response;
        return await networkPromise;
    } catch {
        const fallback = await cachedShell();
        if (fallback) return fallback;
        return new Response('Sin conexión', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
}

async function handleStaticAsset(event) {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(event.request);

    const networkPromise = fetch(event.request).then(response => {
        if (isCacheableResponse(response)) {
            const copy = response.clone();
            return cache.put(event.request, copy).catch(() => {}).then(() => response);
        }
        return response;
    });

    if (cached) {
        // Stale-while-revalidate: respuesta inmediata del cache y actualización en segundo plano.
        event.waitUntil(networkPromise.catch(() => {}));
        return cached;
    }
    return networkPromise;
}

async function trimDataCache(cache) {
    const keys = await cache.keys();
    const excess = keys.length - DATA_CACHE_MAX_ENTRIES;
    if (excess <= 0) return;
    await Promise.all(keys.slice(0, excess).map(key => cache.delete(key)));
}

async function handleDataRoute(event) {
    const cache = await caches.open(DATA_CACHE_NAME);
    const cached = await cache.match(event.request);

    const networkPromise = fetch(event.request).then(response => {
        if (isCacheableResponse(response)) {
            const copy = response.clone();
            event.waitUntil(cache.delete(event.request)
                .then(() => cache.put(event.request, copy))
                .then(() => trimDataCache(cache))
                .catch(() => {}));
        }
        return response;
    });

    if (cached) {
        event.waitUntil(networkPromise.catch(() => {}));
        return cached;
    }
    return networkPromise;
}

globalThis.addEventListener('fetch', (event) => {
    const { request } = event;
    if (request.method !== 'GET') return;
    if (request.headers.has('range')) return;

    const url = new URL(request.url);
    // Cross-origin (backend transporte-be.*.workers.dev, tiles de Esri, fuentes, analytics): sin
    // intervención del SW, nunca se cachean acá.
    if (url.origin !== globalThis.location.origin) return;
    if (!url.href.startsWith(scopeUrl().href)) return;

    if (request.mode === 'navigate') {
        event.respondWith(handleNavigation(event));
        return;
    }

    if (DATA_ROUTES_PATTERN.test(url.pathname)) {
        event.respondWith(handleDataRoute(event));
        return;
    }

    if (STATIC_ASSET_PATTERN.test(url.pathname)) {
        event.respondWith(handleStaticAsset(event));
    }
});
