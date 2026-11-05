let deferredInstallPrompt = null;
const USER_LOCATION_STORAGE_KEY = 'radaramba.user-location-v1';
const USER_LOCATION_CACHE_MAX_AGE_MS = 15 * 60 * 1000;
// Privacidad: una ubicación guardada más vieja que esto se borra del localStorage.
const USER_LOCATION_STORAGE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function setDashboardActionActive(actionKey, isActive) {
    const actionMap = {
        alerts: 'action-alerts',
        nearby: 'action-nearby',
        locate: 'action-locate',
        refresh: 'action-refresh'
    };

    const buttonId = actionMap[actionKey];
    if (!buttonId) return;

    const button = document.getElementById(buttonId);
    if (!button) return;
    button.classList.toggle('is-active', !!isActive);
}

function setInstallButtonState({ label, disabled = false, ready = false, title = '' } = {}) {
    const installBtn = document.getElementById('install-app-btn');
    const installLabel = document.getElementById('install-app-label');
    if (!installBtn || !installLabel) return;

    installBtn.disabled = !!disabled;
    installBtn.classList.toggle('install-ready', !!ready);
    if (title) installBtn.title = title;
    installLabel.innerText = label || 'Instalar app';
}

// iPadOS 13+ se presenta como "Macintosh" en el user agent; se distingue por el touch.
function isIosDevice() {
    const ua = navigator.userAgent || '';
    if (/iphone|ipad|ipod/i.test(ua)) return true;
    return Number(navigator.maxTouchPoints) > 1 && /Mac/.test(ua);
}

function setInstallButtonWaitingForPrompt() {
    setInstallButtonState({
        label: 'Instalar app',
        disabled: true,
        ready: false,
        title: 'El navegador volverá a ofrecer la instalación más adelante'
    });
}

function setupInstallPrompt() {
    const installBtn = document.getElementById('install-app-btn');
    if (!installBtn) return;

    const isSupportedOrigin = globalThis.location.protocol === 'http:' || globalThis.location.protocol === 'https:';
    if (!isSupportedOrigin) {
        setInstallButtonState({
            label: 'Instalar app',
            disabled: true,
            ready: false,
            title: 'Disponible solo desde HTTP/HTTPS'
        });
        return;
    }

    const isIos = isIosDevice();
    const isAndroid = /android/i.test(navigator.userAgent);
    const isStandalone = globalThis.matchMedia('(display-mode: standalone)').matches || globalThis.navigator.standalone;

    globalThis.addEventListener('beforeinstallprompt', (event) => {
        event.preventDefault();
        deferredInstallPrompt = event;
        setInstallButtonState({
            label: 'Instalar app',
            disabled: false,
            ready: true,
            title: 'Instalar aplicación'
        });
    });

    globalThis.addEventListener('appinstalled', () => {
        deferredInstallPrompt = null;
        setInstallButtonState({
            label: 'App instalada',
            disabled: true,
            ready: false,
            title: 'La app ya está instalada'
        });
    });

    if (isStandalone) {
        setInstallButtonState({
            label: 'App instalada',
            disabled: true,
            ready: false,
            title: 'La app ya está instalada'
        });
        return;
    }

    if (isIos && !isStandalone) {
        setInstallButtonState({
            label: 'Instalar app',
            disabled: false,
            ready: true,
            title: 'Agregar a pantalla de inicio'
        });
        return;
    }

    if (isAndroid && !isStandalone) {
        setInstallButtonState({
            label: 'Instalar app',
            disabled: false,
            ready: true,
            title: 'Instalar aplicación'
        });
        return;
    }

    setInstallButtonState({
        label: 'Instalar app',
        disabled: false,
        ready: false,
        title: 'Ver cómo instalar en este navegador'
    });
}

async function installApp() {
    const isSupportedOrigin = globalThis.location.protocol === 'http:' || globalThis.location.protocol === 'https:';
    if (!isSupportedOrigin) {
        alert('Para instalar la app, abrila desde un servidor local o HTTPS (no file://).');
        return;
    }

    const isIos = isIosDevice();
    const isAndroid = /android/i.test(navigator.userAgent);
    const isStandalone = globalThis.matchMedia('(display-mode: standalone)').matches || globalThis.navigator.standalone;

    if (deferredInstallPrompt) {
        // prompt() solo se puede usar una vez por evento: se descarta siempre y el botón queda
        // deshabilitado hasta un nuevo beforeinstallprompt (o appinstalled).
        const promptEvent = deferredInstallPrompt;
        deferredInstallPrompt = null;
        let choice = null;
        try {
            promptEvent.prompt();
            choice = await promptEvent.userChoice;
        } catch (error) {
            console.warn('No se pudo mostrar el prompt de instalación', error);
        }
        if (choice?.outcome === 'accepted') {
            setInstallButtonState({
                label: 'App instalada',
                disabled: true,
                ready: false,
                title: 'La app ya está instalada'
            });
        } else {
            if (choice) console.log('Instalación cancelada por el usuario');
            if (!deferredInstallPrompt) setInstallButtonWaitingForPrompt();
        }
        return;
    }

    if (isIos && !isStandalone) {
        alert('Para instalar: tocá Compartir y luego “Agregar a pantalla de inicio”.');
        return;
    }

    if (isAndroid && !isStandalone) {
        alert('Para instalar en Android: abrí el menú del navegador (⋮) y elegí “Instalar app” o “Agregar a pantalla principal”.');
        return;
    }

    alert('Para instalar en compu: abrí el menú del navegador y buscá la opción “Instalar app” (o el ícono de instalación junto a la barra de direcciones).');
}

// Estado interno (LIVE | CARGANDO | ERROR) separado del texto visible: la lógica compara el estado
// (data-status / getStatus()), nunca la etiqueta. Sin conexión, todo lo que no sea CARGANDO es OFFLINE.
const STATUS_BADGES = {
    LIVE: { label: 'EN VIVO', tone: 'is-live' },
    CARGANDO: { label: 'CARGANDO', tone: 'is-loading' },
    ERROR: { label: 'ERROR', tone: 'is-error' },
    OFFLINE: { label: 'SIN CONEXIÓN', tone: 'is-offline' }
};
let requestedStatus = 'CARGANDO';

function getStatus() {
    const offline = typeof isAppOffline === 'function' && isAppOffline();
    return offline && requestedStatus !== 'CARGANDO' ? 'OFFLINE' : requestedStatus;
}

function renderStatusBadge() {
    const dot = document.getElementById('status-dot');
    const text = document.getElementById('status-text');
    if (!dot || !text) return;
    const state = getStatus();
    const badge = STATUS_BADGES[state];
    dot.className = `status-badge ${badge.tone}`;
    dot.dataset.status = state;
    // #status-text es aria-live: solo se reescribe si cambia, para no repetir el anuncio.
    if (text.textContent !== badge.label) text.textContent = badge.label;
}

function setStatus(state) {
    requestedStatus = Object.hasOwn(STATUS_BADGES, state) && state !== 'OFFLINE' ? state : 'LIVE';
    renderStatusBadge();
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

function drawUserMarker(lat, lon, tooltipPosition = null) {
    if (!userLayer) return null;
    userLayer.clearLayers();
    const userMarker = L.marker([lat, lon], {
        icon: L.divIcon({
            className: 'user-location-icon',
            html: '<div class="user-person-marker"><div class="user-person-pulse"></div><div class="user-person-body">🧍</div></div>',
            iconSize: [38, 38],
            iconAnchor: [19, 19]
        })
    }).addTo(userLayer);

    const tooltipData = tooltipPosition || { coords: { latitude: lat, longitude: lon } };
    userMarker.bindTooltip(buildUserLocationTooltip(tooltipData), {
        className: 'custom-tooltip',
        direction: 'top',
        offset: [0, -20],
        opacity: 1
    });
    return userMarker;
}

function readStoredUserLocation() {
    try {
        const raw = globalThis.localStorage?.getItem(USER_LOCATION_STORAGE_KEY);
        if (!raw) return null;

        const parsed = JSON.parse(raw);
        const lat = Number(parsed?.lat);
        const lon = Number(parsed?.lon);
        const timestamp = Number(parsed?.timestamp || 0);
        const isExpired = !Number.isFinite(timestamp) || timestamp <= 0
            || (Date.now() - timestamp) > USER_LOCATION_STORAGE_MAX_AGE_MS;
        if (!Number.isFinite(lat) || !Number.isFinite(lon) || isExpired) {
            globalThis.localStorage?.removeItem(USER_LOCATION_STORAGE_KEY);
            return null;
        }

        return { lat, lon, timestamp };
    } catch {
        return null;
    }
}

// Al cargar: purga la ubicación guardada si venció (readStoredUserLocation la borra).
function purgeExpiredStoredUserLocation() {
    readStoredUserLocation();
}

function persistUserLocation(location) {
    const lat = Number(location?.lat);
    const lon = Number(location?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;

    const payload = {
        lat,
        lon,
        timestamp: Number(location?.timestamp || Date.now())
    };

    try {
        globalThis.localStorage?.setItem(USER_LOCATION_STORAGE_KEY, JSON.stringify(payload));
    } catch {
        // ignore storage failures
    }
}

function getKnownUserLocation() {
    const memory = globalThis.cache?.userLocation;
    if (Number.isFinite(Number(memory?.lat)) && Number.isFinite(Number(memory?.lon))) {
        return {
            lat: Number(memory.lat),
            lon: Number(memory.lon),
            timestamp: Number(memory.timestamp || Date.now())
        };
    }

    const stored = readStoredUserLocation();
    if (stored) {
        if (globalThis.cache) globalThis.cache.userLocation = stored;
        return stored;
    }

    return null;
}

function isLocationCacheFresh(location, maxAgeMs = USER_LOCATION_CACHE_MAX_AGE_MS) {
    const timestamp = Number(location?.timestamp || 0);
    if (!Number.isFinite(timestamp) || timestamp <= 0) return false;
    return (Date.now() - timestamp) <= maxAgeMs;
}

async function getGeolocationPermissionState() {
    if (!navigator?.permissions?.query) return null;

    try {
        const permissionStatus = await navigator.permissions.query({ name: 'geolocation' });
        return permissionStatus?.state || null;
    } catch {
        return null;
    }
}

async function locateUser(options = {}) {
    const {
        autoActivateNearby = true,
        refreshNearby = true,
        skipPromptIfCached = false,
        maxCachedAgeMs = USER_LOCATION_CACHE_MAX_AGE_MS
    } = options;

    const applyUserLocation = async (location, tooltipPosition, shouldPersist) => {
        const lat = Number(location?.lat);
        const lon = Number(location?.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

        const payload = {
            lat,
            lon,
            timestamp: Number(location?.timestamp || Date.now())
        };

        globalThis.cache.userLocation = payload;
        if (shouldPersist) {
            persistUserLocation(payload);
        }

        drawUserMarker(lat, lon, tooltipPosition);

        map?.stop?.();
        moveMapTo(map, getVisibleMapCenter([lat, lon], 15), 15, {
            animate: true,
            duration: 1.05,
            easeLinearity: 0.15,
            noMoveStart: true
        });

        try {
            if (autoActivateNearby && typeof activateNearbyFromLocation === 'function') {
                await activateNearbyFromLocation();
            } else if (refreshNearby && globalThis.nearbyState?.active && typeof refreshNearbyTransport === 'function') {
                await refreshNearbyTransport({ silent: true });
            }
        } catch {
            // geolocation should still resolve even if nearby refresh fails
        }

        return { lat, lon };
    };

    const knownLocation = getKnownUserLocation();
    const permissionState = await getGeolocationPermissionState();

    if (skipPromptIfCached && knownLocation) {
        const isFresh = isLocationCacheFresh(knownLocation, maxCachedAgeMs);
        const canRefreshWithoutPrompt = permissionState === 'granted';

        if (isFresh || !canRefreshWithoutPrompt) {
            const tooltipData = { coords: { latitude: knownLocation.lat, longitude: knownLocation.lon } };
            return applyUserLocation(knownLocation, tooltipData, false);
        }
    }

    if (!navigator.geolocation) {
        if (!knownLocation) return null;
        const tooltipData = { coords: { latitude: knownLocation.lat, longitude: knownLocation.lon } };
        return applyUserLocation(knownLocation, tooltipData, false);
    }

    return new Promise(resolve => {
        navigator.geolocation.getCurrentPosition(async pos => {
            const { latitude, longitude } = pos.coords;
            const liveLocation = {
                lat: Number(latitude),
                lon: Number(longitude),
                timestamp: Date.now()
            };

            const resolvedLocation = await applyUserLocation(liveLocation, pos, true);
            resolve(resolvedLocation);
        }, async (err) => {
            console.warn('Geolocation error', err);

            if (knownLocation) {
                const tooltipData = { coords: { latitude: knownLocation.lat, longitude: knownLocation.lon } };
                const restored = await applyUserLocation(knownLocation, tooltipData, false);
                resolve(restored);
                return;
            }

            resolve(null);
        }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
    });
}

// --- Location prompt flow ---

let _locationPromptMarker = null;
let _locationPromptPicked = null;
let _locationPromptMapHandler = null;
let _locationPromptResolve = null;
let _locationPromptSession = 0;

let _locationPromptReturnFocus = null;

function _getLocationPromptFocusables() {
    const modal = document.getElementById('location-prompt-modal');
    if (!modal) return [];
    return Array.from(modal.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'))
        .filter(el => !el.disabled && el.getClientRects().length > 0);
}

function _isLocationPromptVisible() {
    const overlay = document.getElementById('location-prompt-overlay');
    return !!overlay && !overlay.classList.contains('hidden');
}

function _showLocationPromptOverlay(show) {
    const overlay = document.getElementById('location-prompt-overlay');
    if (!overlay) return;
    const wasVisible = _isLocationPromptVisible();
    if (show) {
        overlay.classList.remove('hidden');
        if (!wasVisible) {
            const active = document.activeElement;
            _locationPromptReturnFocus = active instanceof HTMLElement && active !== document.body ? active : null;
            const initialFocus = document.getElementById('location-prompt-confirm');
            const target = initialFocus && !initialFocus.disabled ? initialFocus : _getLocationPromptFocusables()[0];
            target?.focus({ preventScroll: true });
        }
    } else {
        overlay.classList.add('hidden');
        if (wasVisible) {
            const returnTo = _locationPromptReturnFocus;
            _locationPromptReturnFocus = null;
            if (returnTo?.isConnected && !returnTo.closest('[inert]')) returnTo.focus({ preventScroll: true });
            else focusAppHome();
        }
    }
}

function _trapLocationPromptTab(e) {
    const focusables = _getLocationPromptFocusables();
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables.at(-1);
    const modal = document.getElementById('location-prompt-modal');
    const active = document.activeElement;
    if (!modal?.contains(active)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
    } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
    } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
    }
}

function _updateLocationPromptCoords(lat, lon) {
    const coordsEl = document.getElementById('location-prompt-coords');
    const confirmBtn = document.getElementById('location-prompt-confirm');
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
        _locationPromptPicked = { lat, lon };
        if (coordsEl) {
            coordsEl.textContent = `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
            coordsEl.classList.remove('hidden');
        }
        if (confirmBtn) confirmBtn.disabled = false;
    }
}

function _placePickMarker(lat, lon) {
    if (!map) return;
    if (_locationPromptMarker) {
        _locationPromptMarker.setLatLng([lat, lon]);
    } else {
        _locationPromptMarker = L.marker([lat, lon], {
            draggable: true,
            icon: L.divIcon({
                className: 'location-pick-marker',
                html: '<div class="location-pick-pin">📍</div>',
                iconSize: [40, 40],
                iconAnchor: [20, 40]
            })
        }).addTo(map);

        _locationPromptMarker.on('dragend', () => {
            const pos = _locationPromptMarker.getLatLng();
            _updateLocationPromptCoords(pos.lat, pos.lng);
        });
    }
    _updateLocationPromptCoords(lat, lon);
}

function _enableMapPick() {
    if (_locationPromptMapHandler) return;
    _locationPromptMapHandler = (e) => {
        _placePickMarker(e.latlng.lat, e.latlng.lng);
    };
    map?.on('click', _locationPromptMapHandler);
}

function _disableMapPick() {
    if (_locationPromptMapHandler && map) {
        map.off('click', _locationPromptMapHandler);
    }
    _locationPromptMapHandler = null;
}

function _cleanupLocationPrompt() {
    _locationPromptSession += 1;
    _disableMapPick();
    if (_locationPromptMarker && map) {
        map.removeLayer(_locationPromptMarker);
    }
    _locationPromptMarker = null;
    _locationPromptPicked = null;
    _showLocationPromptOverlay(false);
}

async function locationPromptUseGPS() {
    const gpsBtn = document.getElementById('location-prompt-gps');
    const gpsLabel = document.getElementById('location-prompt-gps-label');
    const promptText = document.getElementById('location-prompt-text');

    const session = _locationPromptSession;
    if (gpsBtn) gpsBtn.classList.add('is-loading');
    if (gpsLabel) gpsLabel.textContent = 'Buscando GPS...';

    if (!navigator.geolocation) {
        if (gpsLabel) gpsLabel.textContent = 'GPS no disponible';
        if (gpsBtn) gpsBtn.classList.remove('is-loading');
        if (promptText) promptText.textContent = 'Tu dispositivo no soporta GPS. Tocá el mapa para marcar tu ubicación.';
        return;
    }

    navigator.geolocation.getCurrentPosition(
        (pos) => {
            if (session !== _locationPromptSession) return;
            const { latitude, longitude } = pos.coords;
            _placePickMarker(latitude, longitude);
            moveMapTo(map, [latitude, longitude], 15, { animate: true, duration: 0.8 });
            if (gpsLabel) gpsLabel.textContent = 'Reintentar GPS';
            if (gpsBtn) gpsBtn.classList.remove('is-loading');
            if (promptText) promptText.textContent = 'Verificá que el marcador esté bien. Podés arrastrarlo o tocar el mapa para corregir.';
        },
        (err) => {
            if (session !== _locationPromptSession) return;
            console.warn('Location prompt GPS error', err);
            if (gpsLabel) gpsLabel.textContent = 'GPS falló - tocá el mapa';
            if (gpsBtn) gpsBtn.classList.remove('is-loading');
            if (promptText) promptText.textContent = 'No se pudo obtener tu ubicación con GPS. Tocá el mapa para indicar dónde estás.';
        },
        { enableHighAccuracy: true, timeout: 10000 }
    );
}

function locationPromptConfirm() {
    if (!_locationPromptPicked) return;

    const location = {
        lat: _locationPromptPicked.lat,
        lon: _locationPromptPicked.lon,
        timestamp: Date.now()
    };

    // Apply location to cache and persist
    globalThis.cache.userLocation = location;
    persistUserLocation(location);

    drawUserMarker(location.lat, location.lon);
    moveMapTo(map, getVisibleMapCenter([location.lat, location.lon], 15), 15, { animate: true, duration: 1.05, easeLinearity: 0.15 });

    _cleanupLocationPrompt();

    // Activate nearby transport around confirmed location
    try {
        if (typeof activateNearbyFromLocation === 'function') {
            activateNearbyFromLocation().catch(() => {});
        }
    } catch {}

    if (_locationPromptResolve) {
        _locationPromptResolve(location);
        _locationPromptResolve = null;
    }
}

function locationPromptDismiss() {
    _cleanupLocationPrompt();
    if (_locationPromptResolve) {
        _locationPromptResolve(null);
        _locationPromptResolve = null;
    }
}

function showLocationPrompt() {
    const knownLocation = getKnownUserLocation();
    if (knownLocation && isLocationCacheFresh(knownLocation)) {
        return locateUser({ skipPromptIfCached: true })
            .catch(() => null)
            .then(() => knownLocation);
    }

    return new Promise((resolve) => {
        const session = ++_locationPromptSession;
        let fallbackTimer = null;
        const isCurrentSession = () => session === _locationPromptSession;
        const revealOverlay = () => {
            if (fallbackTimer) clearTimeout(fallbackTimer);
            fallbackTimer = null;
            if (!isCurrentSession()) return;
            _showLocationPromptOverlay(true);
        };
        const wrappedResolve = (val) => {
            if (fallbackTimer) clearTimeout(fallbackTimer);
            resolve(val);
        };

        _locationPromptResolve = wrappedResolve;
        _locationPromptPicked = null;

        const confirmBtn = document.getElementById('location-prompt-confirm');
        const coordsEl = document.getElementById('location-prompt-coords');
        const gpsLabel = document.getElementById('location-prompt-gps-label');
        const promptText = document.getElementById('location-prompt-text');
        const gpsBtn = document.getElementById('location-prompt-gps');

        if (confirmBtn) confirmBtn.disabled = true;
        if (coordsEl) { coordsEl.textContent = ''; coordsEl.classList.add('hidden'); }
        if (gpsLabel) gpsLabel.textContent = 'Reintentar GPS';
        if (gpsBtn) gpsBtn.classList.remove('is-loading');
        if (promptText) promptText.textContent = 'Buscando tu ubicación...';

        _enableMapPick();

        // Re-render lucide icons inside the modal
        try { createLucideIconsIn(document.getElementById('location-prompt-modal')); } catch {}

        // Try GPS automatically first, then show modal
        if (navigator.geolocation) {
            // El permiso del navegador puede quedar sin responder: no dejar el modal oculto indefinidamente.
            fallbackTimer = setTimeout(() => {
                if (!isCurrentSession()) return;
                if (promptText) promptText.textContent = 'Seguimos buscando tu ubicación. Tocá el mapa para indicar dónde estás, o reintentá el GPS.';
                revealOverlay();
            }, 15000);

            navigator.geolocation.getCurrentPosition(
                (pos) => {
                    if (!isCurrentSession()) return;
                    const { latitude, longitude } = pos.coords;
                    _placePickMarker(latitude, longitude);
                    moveMapTo(map, [latitude, longitude], 15, { animate: true, duration: 0.8 });
                    if (promptText) promptText.textContent = 'Verificá que el marcador esté bien. Podés arrastrarlo o tocar el mapa para corregir.';
                    revealOverlay();
                },
                (err) => {
                    if (!isCurrentSession()) return;
                    console.warn('Auto GPS failed', err);
                    if (promptText) promptText.textContent = 'No se pudo obtener tu ubicación. Tocá el mapa para indicar dónde estás, o reintentá el GPS.';
                    revealOverlay();
                },
                { enableHighAccuracy: true, timeout: 10000 }
            );
        } else {
            if (promptText) promptText.textContent = 'GPS no disponible. Tocá el mapa para indicar dónde estás.';
            _showLocationPromptOverlay(true);
        }
    });
}

// Escape equivale a "Omitir por ahora"; Tab queda atrapado dentro del modal mientras está visible.
globalThis.addEventListener('keydown', (e) => {
    if (!_isLocationPromptVisible()) return;
    if (e.key === 'Escape') {
        e.preventDefault();
        locationPromptDismiss();
    } else if (e.key === 'Tab') {
        _trapLocationPromptTab(e);
    }
});

purgeExpiredStoredUserLocation();
