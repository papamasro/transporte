// Superficie única de la app: hoja inferior en mobile (< 768px) y barra lateral desde 768px.
// Cercanos y alertas son vistas dentro de la hoja (clase is-open en #nearby-panel / #alerts-panel):
// al abrir una, la vista principal queda oculta e inert. También: menú "Más opciones", línea de estado
// ("1.234 en vista · hace 12 s") y los márgenes del mapa tapados por la hoja.

const SHEET_MEDIA_QUERY = '(max-width: 767px)';
const SHEET_STATES = ['peek', 'half', 'full'];
const SHEET_DRAG_THRESHOLD_PX = 6;
const SHEET_FLING_VELOCITY = 0.45;
const MAP_STATUS_TICK_MS = 5000;

const SHEET_VIEWS = [
    { name: 'nearby', panelId: 'nearby-panel', openerId: 'action-nearby' },
    { name: 'alerts', panelId: 'alerts-panel', openerId: 'action-alerts' }
];

const layoutState = {
    sheetState: 'peek',
    view: 'main',
    heights: { peek: 0, half: 0, full: 0 },
    offset: 0,
    drag: null,
    suppressHandleClick: false,
    lastUpdateAt: 0,
    statusCount: null,
    statusHiddenByZoom: false,
    // Con cercanos abierto la capa principal está apagada: la línea de estado cuenta lo cercano.
    nearbyCount: null,
    nearbyLoading: false,
    remeasureFrame: 0
};

function isSheetMode() {
    return globalThis.matchMedia?.(SHEET_MEDIA_QUERY)?.matches === true;
}

function getSheetElements() {
    return {
        sheet: document.getElementById('app-sheet'),
        body: document.getElementById('sheet-body'),
        dragZone: document.getElementById('sheet-drag-zone'),
        handle: document.getElementById('panel-toggle'),
        content: document.getElementById('panel-content'),
        mainView: document.getElementById('view-main')
    };
}

function getActiveViewElement() {
    const view = SHEET_VIEWS.find(item => item.name === layoutState.view);
    return document.getElementById(view ? view.panelId : 'view-main');
}

// ─── Alturas y posición de la hoja ───────────────────────────────────────────

function readSafeAreaBottom(sheet) {
    return Number.parseFloat(getComputedStyle(sheet).getPropertyValue('--safe-bottom')) || 0;
}

// peek = arrastre + encabezado + el bloque marcado con data-peek-end de la vista activa.
function measureSheetHeights() {
    const { sheet, body } = getSheetElements();
    if (!sheet || !body) return;
    const full = sheet.offsetHeight;
    const peekEnd = getActiveViewElement()?.querySelector('[data-peek-end]');
    const bodyTop = body.getBoundingClientRect().top - sheet.getBoundingClientRect().top;
    const peekEndBottom = peekEnd
        ? peekEnd.getBoundingClientRect().bottom - body.getBoundingClientRect().top + body.scrollTop
        : 0;
    const peek = Math.min(full, Math.round(bodyTop + peekEndBottom + 12 + readSafeAreaBottom(sheet)));
    const half = Math.min(full, Math.max(peek + 120, Math.round(globalThis.innerHeight * 0.52)));
    layoutState.heights = { peek, half, full };
}

function getSheetOffsetFor(state) {
    const { full } = layoutState.heights;
    return Math.max(0, full - (layoutState.heights[state] || 0));
}

function applySheetOffset(offset) {
    const { sheet } = getSheetElements();
    if (!sheet) return;
    layoutState.offset = offset;
    sheet.style.setProperty('--sheet-offset', `${Math.round(offset)}px`);
}

// Lo que tapa la hoja ya asentada (no durante el arrastre): margen inferior de controles del mapa.
function applySheetInsets() {
    const root = document.documentElement;
    const { sheet } = getSheetElements();
    if (!isSheetMode()) {
        root.style.setProperty('--map-inset-bottom', '0px');
        sheet?.style.removeProperty('--sheet-hidden');
        return;
    }
    const visible = layoutState.heights[layoutState.sheetState] || 0;
    const inset = Math.min(visible, layoutState.heights.half || visible);
    root.style.setProperty('--map-inset-bottom', `${Math.round(inset)}px`);
    // El contenido que queda debajo del borde de la pantalla se puede scrollear hasta verlo.
    sheet?.style.setProperty('--sheet-hidden', `${Math.round(getSheetOffsetFor(layoutState.sheetState))}px`);
}

function getMapObscuredInsets() {
    if (!isSheetMode()) return { top: 0, bottom: 0 };
    const visible = layoutState.heights[layoutState.sheetState] || 0;
    return { top: 0, bottom: Math.min(visible, layoutState.heights.half || visible) };
}

// Centro a usar para que `latLng` quede en el medio de la parte visible del mapa (no bajo la hoja).
function getVisibleMapCenter(latLng, zoom) {
    const insets = getMapObscuredInsets();
    if (!map || !insets.bottom) return latLng;
    const targetZoom = Number.isFinite(zoom) ? zoom : map.getZoom();
    const point = map.project(L.latLng(latLng), targetZoom).add([0, insets.bottom / 2]);
    return map.unproject(point, targetZoom);
}

// Punto del mapa en el centro de la parte visible (sobre la hoja).
function getVisibleViewCenter() {
    if (!map) return null;
    const insets = getMapObscuredInsets();
    const center = map.getCenter();
    if (!insets.bottom) return center;
    return map.containerPointToLatLng(map.latLngToContainerPoint(center).subtract([0, insets.bottom / 2]));
}

function syncSheetA11y() {
    const { handle, content, sheet } = getSheetElements();
    const collapsed = isSheetMode() && layoutState.sheetState === 'peek';
    if (sheet) sheet.dataset.sheetState = layoutState.sheetState;
    if (handle) {
        handle.setAttribute('aria-expanded', String(!collapsed));
        handle.setAttribute('aria-label', collapsed ? 'Expandir panel' : 'Contraer panel');
    }
    if (content) {
        if (collapsed && content.contains(document.activeElement)) handle?.focus({ preventScroll: true });
        content.inert = collapsed;
    }
}

function setSheetState(state, options = {}) {
    if (!SHEET_STATES.includes(state)) return;
    const { body } = getSheetElements();
    layoutState.sheetState = state;
    if (isSheetMode()) {
        measureSheetHeights();
        applySheetOffset(getSheetOffsetFor(state));
        if (state === 'peek' && body) body.scrollTop = 0;
    }
    syncSheetA11y();
    applySheetInsets();
    if (!options.silent) closeAppMenu();
}

// Cambió el alto de lo que se ve contraído (p. ej. aparece un aviso arriba): se vuelve a medir.
function remeasureSheet() {
    cancelAnimationFrame(layoutState.remeasureFrame);
    layoutState.remeasureFrame = requestAnimationFrame(() => setSheetState(layoutState.sheetState, { silent: true }));
}

function stepSheetState(direction) {
    const index = SHEET_STATES.indexOf(layoutState.sheetState);
    const next = SHEET_STATES[Math.min(SHEET_STATES.length - 1, Math.max(0, index + direction))];
    setSheetState(next);
}

// Botón del asa: contraída -> media; abierta -> contraída.
function togglePanel() {
    if (!isSheetMode()) return;
    setSheetState(layoutState.sheetState === 'peek' ? 'half' : 'peek');
}

function expandSheetIfCollapsed() {
    if (isSheetMode() && layoutState.sheetState === 'peek') setSheetState('half');
}

// ─── Arrastre (pointer events) ───────────────────────────────────────────────

function isSheetDragExcluded(target) {
    return !!target?.closest?.('input, select, textarea, a, [role="menu"], button:not(#panel-toggle)');
}

function onSheetPointerDown(event) {
    if (!isSheetMode() || layoutState.drag) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (isSheetDragExcluded(event.target)) return;
    const { dragZone } = getSheetElements();
    measureSheetHeights();
    layoutState.drag = {
        pointerId: event.pointerId,
        startY: event.clientY,
        startOffset: getSheetOffsetFor(layoutState.sheetState),
        lastY: event.clientY,
        lastT: performance.now(),
        velocity: 0,
        moved: false
    };
}

function onSheetPointerMove(event) {
    const drag = layoutState.drag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dy = event.clientY - drag.startY;
    if (!drag.moved && Math.abs(dy) < SHEET_DRAG_THRESHOLD_PX) return;
    // La captura recién al empezar a arrastrar: con captura desde el pointerdown, Chrome manda el click
    // de un simple toque a la zona de arrastre en vez de al asa.
    if (!drag.moved) {
        drag.moved = true;
        const { sheet, dragZone } = getSheetElements();
        sheet?.classList.add('is-dragging');
        dragZone?.setPointerCapture?.(event.pointerId);
    }
    const now = performance.now();
    const dt = Math.max(1, now - drag.lastT);
    drag.velocity = drag.velocity * 0.4 + ((event.clientY - drag.lastY) / dt) * 0.6;
    drag.lastY = event.clientY;
    drag.lastT = now;

    const minOffset = 0;
    const maxOffset = getSheetOffsetFor('peek');
    let offset = drag.startOffset + dy;
    // Resistencia elástica fuera de los extremos.
    if (offset < minOffset) offset = minOffset - Math.sqrt(minOffset - offset) * 2;
    if (offset > maxOffset) offset = maxOffset + Math.sqrt(offset - maxOffset) * 2;
    applySheetOffset(offset);
    event.preventDefault();
}

function pickSheetSnap(offset, velocity) {
    const visible = layoutState.heights.full - offset;
    const ordered = SHEET_STATES.map(state => ({ state, height: layoutState.heights[state] }));
    if (Math.abs(velocity) > SHEET_FLING_VELOCITY) {
        // Hacia arriba (velocidad negativa): el siguiente estado más alto que lo visible; hacia abajo, el más bajo.
        if (velocity < 0) return (ordered.find(item => item.height > visible + 8) || ordered.at(-1)).state;
        return ([...ordered].reverse().find(item => item.height < visible - 8) || ordered[0]).state;
    }
    return ordered.reduce((best, item) => (Math.abs(item.height - visible) < Math.abs(best.height - visible) ? item : best)).state;
}

function onSheetPointerUp(event) {
    const drag = layoutState.drag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    layoutState.drag = null;
    const { sheet, dragZone } = getSheetElements();
    if (dragZone?.hasPointerCapture?.(event.pointerId)) dragZone.releasePointerCapture(event.pointerId);
    sheet?.classList.remove('is-dragging');
    if (!drag.moved) return;
    // El pointerup de un arrastre sobre el asa dispara además un click: no debe alternar el estado.
    layoutState.suppressHandleClick = true;
    setTimeout(() => { layoutState.suppressHandleClick = false; }, 0);
    setSheetState(pickSheetSnap(layoutState.offset, event.type === 'pointercancel' ? 0 : drag.velocity));
}

function onSheetHandleKeyDown(event) {
    if (!isSheetMode()) return;
    if (event.key === 'ArrowUp') stepSheetState(1);
    else if (event.key === 'ArrowDown') stepSheetState(-1);
    else if (event.key === 'Home') setSheetState('full');
    else if (event.key === 'End') setSheetState('peek');
    else return;
    event.preventDefault();
}

// ─── Vistas (principal / cercanos / alertas) ─────────────────────────────────

function getFocusHomeTarget() {
    const { handle } = getSheetElements();
    if (handle && handle.getClientRects().length > 0) return handle;
    return document.getElementById('brand-title');
}

// Destino de foco cuando el elemento enfocado desaparece (modal cerrado, vista cerrada, etc.).
function focusAppHome() {
    getFocusHomeTarget()?.focus({ preventScroll: true });
}

function isFocusLost(container) {
    const active = document.activeElement;
    return !active || active === document.body || (!!container && container.contains(active));
}

function syncSheetViews() {
    const { mainView, body, sheet } = getSheetElements();
    const openView = [...SHEET_VIEWS].reverse().find(view => document.getElementById(view.panelId)?.classList.contains('is-open'));
    const nextView = openView ? openView.name : 'main';

    SHEET_VIEWS.forEach(view => {
        const panel = document.getElementById(view.panelId);
        if (panel) panel.inert = view.name !== nextView;
    });
    if (nextView === layoutState.view) return;

    const previous = SHEET_VIEWS.find(view => view.name === layoutState.view);
    const previousPanel = previous ? document.getElementById(previous.panelId) : mainView;
    const focusWasInPrevious = isFocusLost(previousPanel);
    layoutState.view = nextView;
    if (sheet) sheet.dataset.view = nextView;
    if (mainView) {
        mainView.classList.toggle('is-open', nextView === 'main');
        mainView.inert = nextView !== 'main';
    }
    if (body) body.scrollTop = 0;

    if (nextView === 'main') {
        if (focusWasInPrevious && previous) {
            const opener = document.getElementById(previous.openerId);
            if (opener && opener.getClientRects().length > 0 && !opener.closest('[inert]')) opener.focus({ preventScroll: true });
            else focusAppHome();
        }
    } else {
        expandSheetIfCollapsed();
        if (focusWasInPrevious) document.querySelector(`#${openView.panelId} .back-btn`)?.focus({ preventScroll: true });
    }
    requestAnimationFrame(() => setSheetState(layoutState.sheetState, { silent: true }));
}

function setupSheetViews() {
    const observer = new MutationObserver(syncSheetViews);
    SHEET_VIEWS.forEach(view => {
        const panel = document.getElementById(view.panelId);
        if (panel) observer.observe(panel, { attributes: true, attributeFilter: ['class'] });
    });
    syncSheetViews();
}

// ─── Menú "Más opciones" ─────────────────────────────────────────────────────

function getAppMenuItems() {
    const menu = document.getElementById('app-menu');
    if (!menu) return [];
    return [...menu.querySelectorAll('[role="menuitem"], [role="menuitemradio"]')]
        .filter(item => !item.disabled && item.getClientRects().length > 0);
}

function isAppMenuOpen() {
    const menu = document.getElementById('app-menu');
    return !!menu && !menu.hidden;
}

function openAppMenu(focusIndex = 0) {
    const menu = document.getElementById('app-menu');
    const button = document.getElementById('app-menu-btn');
    if (!menu || !button) return;
    menu.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    const items = getAppMenuItems();
    items.at(focusIndex)?.focus({ preventScroll: true });
}

function closeAppMenu(options = {}) {
    const menu = document.getElementById('app-menu');
    const button = document.getElementById('app-menu-btn');
    if (!menu || menu.hidden) return;
    const focusInside = menu.contains(document.activeElement);
    menu.hidden = true;
    button?.setAttribute('aria-expanded', 'false');
    if (options.returnFocus || (focusInside && options.returnFocus !== false)) button?.focus({ preventScroll: true });
}

function moveAppMenuFocus(delta) {
    const items = getAppMenuItems();
    if (items.length === 0) return;
    const index = items.indexOf(document.activeElement);
    const next = index < 0 ? 0 : (index + delta + items.length) % items.length;
    items[next].focus({ preventScroll: true });
}

function setupAppMenu() {
    const menu = document.getElementById('app-menu');
    const button = document.getElementById('app-menu-btn');
    if (!menu || !button) return;

    button.addEventListener('click', () => {
        if (isAppMenuOpen()) closeAppMenu({ returnFocus: true });
        else openAppMenu(0);
    });
    button.addEventListener('keydown', event => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
        event.preventDefault();
        openAppMenu(event.key === 'ArrowDown' ? 0 : -1);
    });
    menu.addEventListener('keydown', event => {
        if (event.key === 'ArrowDown') moveAppMenuFocus(1);
        else if (event.key === 'ArrowUp') moveAppMenuFocus(-1);
        else if (event.key === 'Home') getAppMenuItems()[0]?.focus();
        else if (event.key === 'End') getAppMenuItems().at(-1)?.focus();
        else if (event.key === 'Escape') closeAppMenu({ returnFocus: true });
        else if (event.key === 'Tab') { closeAppMenu({ returnFocus: false }); return; }
        else return;
        event.preventDefault();
    });
    // Después del onclick del ítem: si la acción movió el foco (p. ej. al banner de privacidad) se respeta.
    menu.addEventListener('click', event => {
        if (!event.target.closest('[role="menuitem"], [role="menuitemradio"]')) return;
        closeAppMenu();
    });
    document.addEventListener('pointerdown', event => {
        if (!isAppMenuOpen() || menu.contains(event.target) || button.contains(event.target)) return;
        closeAppMenu({ returnFocus: false });
    });
}

// ─── Línea de estado ─────────────────────────────────────────────────────────

const mapStatusNumberFormat = new Intl.NumberFormat('es-AR');

function formatRelativeUpdate(timestamp, now = Date.now()) {
    if (!timestamp) return '';
    const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
    if (seconds < 5) return 'recién';
    if (seconds < 60) return `hace ${seconds} s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `hace ${minutes} min`;
    return `hace ${Math.floor(minutes / 60)} h`;
}

function setTextIfChanged(element, value) {
    if (element && element.textContent !== value) element.textContent = value;
}

function renderMapStatusTime() {
    const element = document.getElementById('last-update');
    setTextIfChanged(element, formatRelativeUpdate(layoutState.lastUpdateAt));
}

// Sin aria-live: se reescribe en cada render/tick. Los cambios de estado los anuncia #status-text.
function renderMapStatusCount() {
    const { statusCount, statusHiddenByZoom, nearbyCount, nearbyLoading } = layoutState;
    let text;
    if (nearbyCount !== null) {
        text = nearbyLoading && nearbyCount === 0 ? 'Buscando cerca…' : `${mapStatusNumberFormat.format(nearbyCount)} cerca`;
    } else {
        const countText = `${mapStatusNumberFormat.format(statusCount || 0)} en vista`;
        text = countText;
        if (statusHiddenByZoom) text = statusCount > 0 ? `${countText} · Acercá para ver colectivos` : 'Acercá para ver colectivos';
    }
    setTextIfChanged(document.getElementById('unit-count'), text);
    const hint = document.getElementById('map-hint');
    if (hint) hint.hidden = !(statusHiddenByZoom && nearbyCount === null);
}

function setMapStatusCount(count, hiddenByZoom = false) {
    if (layoutState.statusCount === count && layoutState.statusHiddenByZoom === hiddenByZoom) return;
    layoutState.statusCount = count;
    layoutState.statusHiddenByZoom = hiddenByZoom;
    renderMapStatusCount();
}

// count = null vuelve al conteo de la capa principal ("N en vista").
function setMapStatusNearbyCount(count, options = {}) {
    layoutState.nearbyCount = Number.isFinite(Number(count)) && count !== null ? Math.max(0, Number(count)) : null;
    layoutState.nearbyLoading = !!options.loading;
    renderMapStatusCount();
}

function getLastDataUpdateAt() {
    return layoutState.lastUpdateAt;
}

function setMapStatusUpdated(timestamp = Date.now()) {
    layoutState.lastUpdateAt = timestamp;
    const element = document.getElementById('last-update');
    if (element) element.title = `Última actualización: ${new Date(timestamp).toLocaleTimeString('es-AR', { hour12: false })}`;
    renderMapStatusTime();
}

function setupMapStatusTicker() {
    setInterval(() => {
        if (!document.hidden) renderMapStatusTime();
    }, MAP_STATUS_TICK_MS);
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) renderMapStatusTime();
    });
}

// ─── Radiogroups (chips y segmentado) ────────────────────────────────────────

// Flechas/Home/End mueven la selección; solo la opción marcada queda en el orden de tabulación.
function setupRadioGroupKeyboard(group, onSelect) {
    if (!group || group.dataset.radioReady === 'true') return;
    group.dataset.radioReady = 'true';
    const options = () => [...group.querySelectorAll('[role="radio"]')].filter(item => !item.disabled);
    group.addEventListener('click', event => {
        const option = event.target.closest('[role="radio"]');
        if (option && group.contains(option)) onSelect(option);
    });
    group.addEventListener('keydown', event => {
        const items = options();
        const index = items.indexOf(document.activeElement);
        if (index < 0) return;
        let next = -1;
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % items.length;
        else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index - 1 + items.length) % items.length;
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = items.length - 1;
        if (next < 0) return;
        event.preventDefault();
        items[next].focus();
        onSelect(items[next]);
    });
}

function setRadioGroupValue(group, matches) {
    group?.querySelectorAll('[role="radio"]').forEach(option => {
        const checked = !!matches(option);
        option.setAttribute('aria-checked', String(checked));
        option.tabIndex = checked ? 0 : -1;
    });
}

// ─── Layout general ──────────────────────────────────────────────────────────

function applyLayoutMode() {
    const { sheet } = getSheetElements();
    if (!sheet) return;
    sheet.classList.toggle('is-sheet', isSheetMode());
    if (isSheetMode()) {
        setSheetState(layoutState.sheetState, { silent: true });
    } else {
        sheet.style.removeProperty('--sheet-offset');
        syncSheetA11y();
        applySheetInsets();
    }
}

// El mapa cambia de tamaño al cruzar breakpoints (barra lateral) o al rotar: Leaflet necesita saberlo.
function setupMapResizeObserver() {
    const element = document.getElementById('map');
    if (!element || typeof ResizeObserver !== 'function') return;
    let frame = 0;
    new ResizeObserver(() => {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => map?.invalidateSize({ pan: false, debounceMoveend: true }));
    }).observe(element);
}

function setupSheet() {
    const { dragZone, handle } = getSheetElements();
    if (!dragZone || !handle) return;
    dragZone.addEventListener('pointerdown', onSheetPointerDown);
    // En el documento: con mouse, un movimiento rápido sale de la zona antes de tomar la captura.
    document.addEventListener('pointermove', onSheetPointerMove, { passive: false });
    document.addEventListener('pointerup', onSheetPointerUp);
    document.addEventListener('pointercancel', onSheetPointerUp);
    handle.addEventListener('click', () => {
        if (!layoutState.suppressHandleClick) togglePanel();
    });
    handle.addEventListener('keydown', onSheetHandleKeyDown);

    const media = globalThis.matchMedia?.(SHEET_MEDIA_QUERY);
    media?.addEventListener?.('change', applyLayoutMode);
    let resizeFrame = 0;
    globalThis.addEventListener('resize', () => {
        cancelAnimationFrame(resizeFrame);
        resizeFrame = requestAnimationFrame(applyLayoutMode);
    });
    document.fonts?.ready?.then(applyLayoutMode).catch(() => {});
    applyLayoutMode();
}

function initLayout() {
    setupSheet();
    setupSheetViews();
    setupAppMenu();
    setupMapStatusTicker();
    setupMapResizeObserver();
}

globalThis.togglePanel = togglePanel;
globalThis.setSheetState = setSheetState;
globalThis.getSheetState = () => layoutState.sheetState;
globalThis.getMapObscuredInsets = getMapObscuredInsets;
globalThis.getVisibleMapCenter = getVisibleMapCenter;
globalThis.getVisibleViewCenter = getVisibleViewCenter;
globalThis.focusAppHome = focusAppHome;
globalThis.setMapStatusCount = setMapStatusCount;
globalThis.setMapStatusNearbyCount = setMapStatusNearbyCount;
globalThis.setMapStatusUpdated = setMapStatusUpdated;
globalThis.getLastDataUpdateAt = getLastDataUpdateAt;
globalThis.remeasureSheet = remeasureSheet;

document.addEventListener('DOMContentLoaded', initLayout);
