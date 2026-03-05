let isPanelOpen = true;
let deferredInstallPrompt = null;

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
        setInstallButtonState({
            label: 'Instalar app',
            disabled: true,
            ready: false,
            title: 'Disponible solo desde HTTP/HTTPS'
        });
        return;
    }

    const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
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

    const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
    const isAndroid = /android/i.test(navigator.userAgent);
    const isStandalone = globalThis.matchMedia('(display-mode: standalone)').matches || globalThis.navigator.standalone;

    if (deferredInstallPrompt) {
        deferredInstallPrompt.prompt();
        await deferredInstallPrompt.userChoice;
        deferredInstallPrompt = null;
        setInstallButtonState({
            label: 'App instalada',
            disabled: true,
            ready: false,
            title: 'La app ya está instalada'
        });
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

function setStatus(state) {
    const dot = document.getElementById('status-dot');
    const text = document.getElementById('status-text');
    const pulse = document.getElementById('status-pulse');

    if (state === 'ERROR') {
        dot.className = 'flex items-center gap-1.5 px-2 py-1 bg-red-500/10 rounded-full border border-red-500/10';
        text.className = 'text-[9px] font-black text-red-600';
        text.innerText = 'ERROR';
        pulse.className = 'w-1.5 h-1.5 rounded-full bg-red-500';
    } else if (state === 'CARGANDO') {
        dot.className = 'flex items-center gap-1.5 px-2 py-1 bg-amber-500/10 rounded-full border border-amber-500/10';
        text.className = 'text-[9px] font-black text-amber-600';
        text.innerText = 'CARGANDO';
        pulse.className = 'w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse';
    } else {
        dot.className = 'flex items-center gap-1.5 px-2 py-1 bg-emerald-500/10 rounded-full border border-emerald-500/10';
        text.className = 'text-[9px] font-black text-emerald-600';
        text.innerText = 'LIVE';
        pulse.className = 'w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse';
    }
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

function locateUser(options = {}) {
    const { autoActivateNearby = true } = options;
    if (!navigator.geolocation) return Promise.resolve(null);

    return new Promise(resolve => {
        navigator.geolocation.getCurrentPosition(async pos => {
            const { latitude, longitude } = pos.coords;
            const lat = Number(latitude);
            const lon = Number(longitude);

            globalThis.cache.userLocation = {
                lat,
                lon,
                timestamp: Date.now()
            };

            userLayer.clearLayers();
            const userMarker = L.marker([lat, lon], {
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

            map.flyTo([lat, lon], 15);

            try {
                if (autoActivateNearby && typeof activateNearbyFromLocation === 'function') {
                    await activateNearbyFromLocation();
                } else if (globalThis.nearbyState?.active && typeof refreshNearbyTransport === 'function') {
                    await refreshNearbyTransport({ silent: true });
                }
            } catch {
                // geolocation should still resolve even if nearby refresh fails
            }

            resolve({ lat, lon });
        }, (err) => {
            console.warn("Geolocation error", err);
            resolve(null);
        }, { enableHighAccuracy: true });
    });
}
