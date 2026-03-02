let isPanelOpen = true;
let deferredInstallPrompt = null;

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
