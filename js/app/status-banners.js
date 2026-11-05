// Avisos de error por fuente de datos y de conexión, arriba de la hoja/barra lateral (se ven también
// con la hoja contraída). Uno por fuente: un error repetido no apila avisos, solo actualiza el que
// está. Cerrar un aviso lo oculta hasta que esa fuente vuelva a andar y falle de nuevo.

const STATUS_BANNER_TICK_MS = 5000;

// fetchedAt: momento del último dato bueno de la fuente (para "mostrando datos de hace…").
const STATUS_BANNER_SOURCES = {
    bus: { title: 'No pudimos actualizar los colectivos', fetchedAt: () => globalThis.cache?.busFetchedAt },
    subte: { title: 'No pudimos actualizar el subte', fetchedAt: () => globalThis.cache?.subteFetchedAt },
    train: { title: 'No pudimos actualizar los trenes', fetchedAt: () => getLatestTrainArrivalsAt() },
    bike: { title: 'No pudimos actualizar Ecobici', fetchedAt: () => globalThis.cache?.bikeFetchedAt },
    nearby: { title: 'No pudimos actualizar lo cercano', fetchedAt: () => globalThis.nearbyState?.updatedAt },
    app: { title: 'No pudimos actualizar los datos', fetchedAt: () => getMapStatusUpdatedAt() }
};

const statusBannerState = {
    // fuente -> { dismissed }
    errors: new Map(),
    offline: false,
    offlineDismissed: false,
    tickTimer: null
};

function getLatestTrainArrivalsAt() {
    const entries = Object.values(globalThis.cache?.trainArrivalsByStation || {});
    return entries.reduce((latest, entry) => Math.max(latest, Number(entry?.fetchedAt) || 0), 0);
}

function getMapStatusUpdatedAt() {
    return typeof getLastDataUpdateAt === 'function' ? getLastDataUpdateAt() : 0;
}

function isAppOffline() {
    return statusBannerState.offline;
}

// Una fuente apagada (capa desactivada, cercanos cerrado) no muestra su error aunque siga registrado.
function isStatusSourceRelevant(source) {
    const nearbyActive = !!globalThis.nearbyState?.active;
    if (source === 'nearby') return nearbyActive;
    if (source === 'app') return true;
    if (typeof activeTypes !== 'object' || !activeTypes) return true;
    if (source === 'bus') return !!activeTypes.bus || nearbyActive;
    return !!activeTypes[source];
}

function formatDataAgeText(timestamp, now = Date.now()) {
    const value = Number(timestamp);
    if (!Number.isFinite(value) || value <= 0) return 'Todavía no hay datos para mostrar';
    const seconds = Math.max(0, Math.round((now - value) / 1000));
    if (seconds < 60) return 'Mostrando datos de hace unos segundos';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `Mostrando datos de hace ${minutes} min`;
    return `Mostrando datos de hace ${Math.floor(minutes / 60)} h`;
}

function reportSourceError(source) {
    if (!Object.hasOwn(STATUS_BANNER_SOURCES, source)) return;
    if (!statusBannerState.errors.has(source)) {
        statusBannerState.errors.set(source, { dismissed: false });
        if (!statusBannerState.offline && isStatusSourceRelevant(source)) {
            const config = STATUS_BANNER_SOURCES[source];
            announce(`${config.title}. ${formatDataAgeText(config.fetchedAt())}.`);
        }
    }
    renderStatusBanners();
}

function reportSourceOk(source) {
    if (!statusBannerState.errors.delete(source)) return;
    renderStatusBanners();
}

// result: true (dato nuevo) | false (falló) | null (nada que pedir: no cambia el aviso).
function reportSourceResult(source, result) {
    if (result === false) reportSourceError(source);
    else if (result === true) reportSourceOk(source);
}

function clearSourceError(source) {
    reportSourceOk(source);
}

function retryStatusSource(source) {
    statusBannerState.errors.delete(source);
    renderStatusBanners();
    if (typeof retryDataSource === 'function') retryDataSource(source);
}

function buildStatusBanner(key, { tone, icon, title, detail, retryable }) {
    const banner = document.createElement('div');
    banner.className = `status-banner is-${tone}`;
    banner.dataset.banner = key;
    banner.setAttribute('role', 'group');
    banner.setAttribute('aria-label', title);
    banner.innerHTML = `
        <i aria-hidden="true" data-lucide="${icon}" class="status-banner-icon w-4 h-4"></i>
        <div class="status-banner-text"><strong class="status-banner-title"></strong><span class="status-banner-detail"></span></div>
        <div class="status-banner-actions">
            ${retryable ? '<button type="button" class="status-banner-retry" data-banner-action="retry">Reintentar</button>' : ''}
            <button type="button" class="status-banner-close" data-banner-action="dismiss" aria-label="Cerrar aviso">×</button>
        </div>`;
    banner.querySelector('.status-banner-title').textContent = title;
    banner.querySelector('.status-banner-detail').textContent = detail;
    if (typeof createLucideIconsIn === 'function') createLucideIconsIn(banner);
    return banner;
}

function getVisibleStatusBanners() {
    if (statusBannerState.offline) {
        if (statusBannerState.offlineDismissed) return [];
        return [{
            key: 'offline',
            tone: 'offline',
            icon: 'wifi-off',
            title: 'Sin conexión — mostrando lo último que cargamos',
            detail: formatDataAgeText(getMapStatusUpdatedAt()).replace('Mostrando datos', 'Datos'),
            retryable: false
        }];
    }
    const banners = [];
    statusBannerState.errors.forEach((entry, source) => {
        if (entry.dismissed || !isStatusSourceRelevant(source)) return;
        const config = STATUS_BANNER_SOURCES[source];
        banners.push({ key: source, tone: 'error', icon: 'alert-triangle', title: config.title, detail: formatDataAgeText(config.fetchedAt()), retryable: true });
    });
    return banners;
}

// Diff por clave: un aviso existente solo actualiza su texto (sin recrear botones ni perder el foco).
function renderStatusBanners() {
    const container = document.getElementById('status-banners');
    if (!container) return;
    const wanted = getVisibleStatusBanners();
    const wantedKeys = new Set(wanted.map(item => item.key));
    let changedLayout = false;

    container.querySelectorAll('.status-banner').forEach(element => {
        if (wantedKeys.has(element.dataset.banner)) return;
        if (element.contains(document.activeElement) && typeof focusAppHome === 'function') focusAppHome();
        element.remove();
        changedLayout = true;
    });

    wanted.forEach((item, index) => {
        let element = container.querySelector(`.status-banner[data-banner="${item.key}"]`);
        if (element) {
            const detail = element.querySelector('.status-banner-detail');
            if (detail && detail.textContent !== item.detail) detail.textContent = item.detail;
        } else {
            element = buildStatusBanner(item.key, item);
            changedLayout = true;
        }
        if (container.children[index] !== element) container.insertBefore(element, container.children[index] || null);
    });

    container.hidden = wanted.length === 0;
    syncStatusBannerTicker(wanted.length > 0);
    if (changedLayout && typeof remeasureSheet === 'function') remeasureSheet();
}

function syncStatusBannerTicker(active) {
    if (active && !statusBannerState.tickTimer) {
        statusBannerState.tickTimer = setInterval(() => {
            if (!document.hidden) renderStatusBanners();
        }, STATUS_BANNER_TICK_MS);
    } else if (!active && statusBannerState.tickTimer) {
        clearInterval(statusBannerState.tickTimer);
        statusBannerState.tickTimer = null;
    }
}

function handleStatusBannerClick(event) {
    const action = event.target.closest('[data-banner-action]');
    if (!action) return;
    const key = action.closest('.status-banner')?.dataset.banner;
    if (!key) return;
    if (action.dataset.bannerAction === 'retry') {
        retryStatusSource(key);
        return;
    }
    if (key === 'offline') statusBannerState.offlineDismissed = true;
    else if (statusBannerState.errors.has(key)) statusBannerState.errors.get(key).dismissed = true;
    renderStatusBanners();
}

function setAppOffline(offline) {
    if (statusBannerState.offline === offline) return;
    statusBannerState.offline = offline;
    statusBannerState.offlineDismissed = false;
    renderStatusBanners();
    if (typeof renderStatusBadge === 'function') renderStatusBadge();
    if (offline) {
        announce('Sin conexión. Mostrando lo último que cargamos.');
        return;
    }
    // Los errores de mientras no había red eran por la red: se vuelve a pedir todo.
    statusBannerState.errors.clear();
    renderStatusBanners();
    showToast('Conexión recuperada', { id: 'connectivity', tone: 'success' });
    if (typeof handleConnectivityRestored === 'function') handleConnectivityRestored();
}

function initStatusBanners() {
    const container = document.getElementById('status-banners');
    container?.addEventListener('click', handleStatusBannerClick);
    statusBannerState.offline = navigator.onLine === false;
    globalThis.addEventListener('offline', () => setAppOffline(true));
    globalThis.addEventListener('online', () => setAppOffline(false));
    renderStatusBanners();
}

globalThis.reportSourceError = reportSourceError;
globalThis.reportSourceOk = reportSourceOk;
globalThis.reportSourceResult = reportSourceResult;
globalThis.clearSourceError = clearSourceError;
globalThis.isAppOffline = isAppOffline;
