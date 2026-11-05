// Animación de colectivos de la capa principal (markerStores.bus de markers.js).
//
// Cada snapshot nuevo arranca, por marker, un tramo desde la posición mostrada hasta la reportada con
// duración ≈ intervalo medido entre snapshots: el marker nunca salta (va ~1 intervalo detrás del dato).
// Si el snapshot siguiente se demora, se proyecta el último tramo un poco más (dead reckoning acotado
// y con desaceleración). Sin animación: prefers-reduced-motion, flag busAnimation apagado, saltos
// largos y markers fuera de pantalla (se ubican directo). Pausa durante el zoom y con pestaña oculta.
//
// Rendimiento: el tramo se precalcula en layer points; por frame solo se mueve un marker si cambió de
// píxel (transform directo del icono), y el loop corta al agotar BUS_ANIMATION.frameBudgetMs.

const busAnimState = {
    active: new Set(),
    list: [],
    listDirty: true,
    cursor: 0,
    rafId: 0,
    paused: false,
    setupDone: false,
    lastSnapshotAt: 0,
    segmentMs: null,
    lastPositions: new Map(),
    spawnFrom: new Map(),
    stats: { frames: 0, totalMs: 0, maxMs: 0, updates: 0, samples: [] }
};

const BUS_ANIM_VIEW_PADDING_PX = 150;
const BUS_ANIM_MIN_BEARING_METERS = 12;
const BUS_ANIM_MIN_DR_SPEED_M_PER_MS = 0.0015;
const BUS_ANIM_STATS_SAMPLES = 600;

function getBusAnimConfig() {
    if (busAnimState.config) return busAnimState.config;
    const cfg = globalThis.APP_CONFIG?.BUS_ANIMATION || {};
    const num = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
    busAnimState.config = {
        enabled: cfg.enabled !== false,
        minSegmentMs: Math.max(1000, num(cfg.minSegmentMs, 8000)),
        maxSegmentMs: Math.max(1000, num(cfg.maxSegmentMs, 45000)),
        deadReckoningMs: Math.max(0, num(cfg.deadReckoningMs, 6000)),
        deadReckoningMaxMeters: Math.max(0, num(cfg.deadReckoningMaxMeters, 40)),
        maxAnimatedJumpMeters: Math.max(0, num(cfg.maxAnimatedJumpMeters, 2500)),
        frameBudgetMs: Math.max(0.5, num(cfg.frameBudgetMs, 3)),
        defaultSegmentMs: Math.max(1000, num(globalThis.APP_CONFIG?.POLLING?.busIntervalMs, 30000))
    };
    return busAnimState.config;
}

function isBusAnimFeatureEnabled() {
    return isFeatureEnabled('busAnimation') && getBusAnimConfig().enabled;
}

function isBusAnimationActive() {
    return !!map && isBusAnimFeatureEnabled() && !prefersReducedMotion();
}

function busAnimClamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function busAnimComputeBearing(from, to) {
    const rad = Math.PI / 180;
    const dLon = (to.lon - from.lon) * rad;
    const lat1 = from.lat * rad;
    const lat2 = to.lat * rad;
    const y = Math.sin(dLon) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
    return (Math.atan2(y, x) / rad + 360) % 360;
}

// ─── Snapshots ───────────────────────────────────────────────────────────────

// Llamar con cada snapshot de posiciones antes de renderizar. prevVehicles (ruta KV) solo se usa si
// el cliente todavía no tiene un snapshot propio: da rumbo y punto de partida desde la primera carga.
function busAnimIngestSnapshot(vehicles, prevVehicles = null, meta = {}) {
    if (!Array.isArray(vehicles) || !isBusAnimFeatureEnabled()) return;
    const cfg = getBusAnimConfig();
    const now = performance.now();

    let observedMs = null;
    if (busAnimState.lastSnapshotAt) {
        observedMs = now - busAnimState.lastSnapshotAt;
    } else if (Number.isFinite(meta.currentTs) && Number.isFinite(meta.prevTs) && meta.currentTs > meta.prevTs) {
        observedMs = meta.currentTs - meta.prevTs;
    }
    if (observedMs !== null && observedMs >= 1000) {
        const clamped = busAnimClamp(observedMs, cfg.minSegmentMs, cfg.maxSegmentMs);
        busAnimState.segmentMs = busAnimState.segmentMs === null ? clamped : (busAnimState.segmentMs * 0.6 + clamped * 0.4);
    }
    busAnimState.lastSnapshotAt = now;

    const useServerPrev = busAnimState.lastPositions.size === 0 && Array.isArray(prevVehicles);
    let previous = busAnimState.lastPositions;
    if (useServerPrev) {
        previous = new Map();
        prevVehicles.forEach(vehicle => {
            const key = getVehicleUniqueKey(vehicle);
            const coords = getVehicleCoordinates(vehicle);
            if (key && coords) previous.set(key, { lat: coords.lat, lon: coords.lon, bearing: null });
        });
    }

    busAnimState.spawnFrom.clear();
    const next = new Map();
    vehicles.forEach(vehicle => {
        const key = getVehicleUniqueKey(vehicle);
        const coords = getVehicleCoordinates(vehicle);
        if (!key || !coords) return;

        const before = previous.get(key);
        let bearing = before?.bearing ?? null;
        if (before) {
            const distance = haversineMeters(before.lat, before.lon, coords.lat, coords.lon);
            if (distance >= BUS_ANIM_MIN_BEARING_METERS && distance <= cfg.maxAnimatedJumpMeters) {
                // Cuantizado a 5° para no regenerar iconos por cambios mínimos.
                bearing = (Math.round(busAnimComputeBearing(before, coords) / 5) * 5) % 360;
            }
            if (useServerPrev && distance > 1 && distance <= cfg.maxAnimatedJumpMeters) {
                busAnimState.spawnFrom.set(key, { lat: before.lat, lon: before.lon });
            }
        }
        if (bearing !== null && getVehicleBearing(vehicle) === null) vehicle._derivedBearing = bearing;
        next.set(key, { lat: coords.lat, lon: coords.lon, bearing });
    });
    busAnimState.lastPositions = next;
}

// ─── Tramos ──────────────────────────────────────────────────────────────────

function getBusAnimLayerView() {
    const topLeft = map.containerPointToLayerPoint([0, 0]);
    const size = map.getSize();
    return {
        minX: topLeft.x - BUS_ANIM_VIEW_PADDING_PX,
        minY: topLeft.y - BUS_ANIM_VIEW_PADDING_PX,
        maxX: topLeft.x + size.x + BUS_ANIM_VIEW_PADDING_PX,
        maxY: topLeft.y + size.y + BUS_ANIM_VIEW_PADDING_PX
    };
}

function isPointInBusAnimView(point, view) {
    return point.x >= view.minX && point.x <= view.maxX && point.y >= view.minY && point.y <= view.maxY;
}

function setBusMarkerLatLng(marker, lat, lng) {
    if (marker.isPopupOpen()) withoutPopupAutoPan(marker, () => marker.setLatLng([lat, lng]));
    else marker.setLatLng([lat, lng]);
}

function busAnimComputePixels(anim) {
    anim.fromPx = map.latLngToLayerPoint([anim.fromLat, anim.fromLng]);
    anim.toPx = map.latLngToLayerPoint([anim.toLat, anim.toLng]);
    anim.lastX = Number.NaN;
    anim.lastY = Number.NaN;
}

function busAnimMarkActive(marker) {
    if (!busAnimState.active.has(marker)) {
        busAnimState.active.add(marker);
        busAnimState.listDirty = true;
    }
    busAnimSchedule();
}

function busAnimDeactivate(marker) {
    if (busAnimState.active.delete(marker)) busAnimState.listDirty = true;
}

// Devuelve false si el tramo no se anima (el llamador ubica el marker directo en el destino).
function busAnimStartSegment(marker, from, toLat, toLng) {
    const cfg = getBusAnimConfig();
    const distance = haversineMeters(from.lat, from.lng, toLat, toLng);
    if (distance < 0.5 || distance > cfg.maxAnimatedJumpMeters) return false;

    const anim = {
        fromLat: from.lat,
        fromLng: from.lng,
        toLat,
        toLng,
        start: performance.now(),
        duration: busAnimClamp(busAnimState.segmentMs ?? cfg.defaultSegmentMs, cfg.minSegmentMs, cfg.maxSegmentMs),
        drMs: 0,
        drExtra: 0,
        done: false
    };
    busAnimComputePixels(anim);
    const view = getBusAnimLayerView();
    if (!isPointInBusAnimView(anim.fromPx, view) && !isPointInBusAnimView(anim.toPx, view)) return false;

    // Dead reckoning: continúa con la misma velocidad desacelerando hasta 0 en drMs (recorre la mitad
    // de velocidad * drMs), acotado a deadReckoningMaxMeters.
    const speed = distance / anim.duration;
    if (cfg.deadReckoningMs > 0 && speed >= BUS_ANIM_MIN_DR_SPEED_M_PER_MS) {
        const drMeters = Math.min(cfg.deadReckoningMaxMeters, speed * cfg.deadReckoningMs / 2);
        anim.drMs = cfg.deadReckoningMs;
        anim.drExtra = drMeters / distance;
    }

    marker._busAnim = anim;
    busAnimMarkActive(marker);
    return true;
}

// Desde updateMarker (markers-ui.js): true = la posición la maneja la animación.
function busAnimMoveMarker(marker, lat, lng) {
    const anim = marker._busAnim;
    if (!isBusAnimationActive()) {
        if (anim) {
            marker._busAnim = null;
            busAnimDeactivate(marker);
        }
        return false;
    }
    busAnimEnsureSetup();

    if (anim && anim.toLat === lat && anim.toLng === lng) return true;
    const current = marker.getLatLng();
    if (!anim && current.lat === lat && current.lng === lng) return true;

    if (!busAnimStartSegment(marker, current, lat, lng)) {
        marker._busAnim = null;
        busAnimDeactivate(marker);
        setBusMarkerLatLng(marker, lat, lng);
    }
    return true;
}

// Marker recién creado en (lat, lng): si el snapshot previo del servidor lo tenía en otro lado,
// arranca ahí y se desliza hasta la posición actual.
function busAnimPlaceNewMarker(marker, key, lat, lng) {
    const from = busAnimState.spawnFrom.get(key);
    if (!from) return;
    busAnimState.spawnFrom.delete(key);
    if (!isBusAnimationActive()) return;
    busAnimEnsureSetup();

    const start = { lat: from.lat, lng: from.lon };
    marker.setLatLng([start.lat, start.lng]);
    if (!busAnimStartSegment(marker, start, lat, lng)) marker.setLatLng([lat, lng]);
}

// ─── Loop ────────────────────────────────────────────────────────────────────

function busAnimStepMarker(marker, now, view) {
    const anim = marker._busAnim;
    const elapsed = now - anim.start;
    let fraction;
    if (elapsed < anim.duration) {
        fraction = Math.max(0, elapsed / anim.duration);
    } else if (anim.drMs > 0 && elapsed - anim.duration < anim.drMs) {
        const u = (elapsed - anim.duration) / anim.drMs;
        fraction = 1 + anim.drExtra * u * (2 - u);
    } else {
        fraction = 1 + anim.drExtra;
        anim.done = true;
    }

    const x = anim.fromPx.x + (anim.toPx.x - anim.fromPx.x) * fraction;
    const y = anim.fromPx.y + (anim.toPx.y - anim.fromPx.y) * fraction;
    if (!anim.done && (x < view.minX || x > view.maxX || y < view.minY || y > view.maxY)) return 0;

    const roundedX = Math.round(x);
    const roundedY = Math.round(y);
    if (!anim.done && roundedX === anim.lastX && roundedY === anim.lastY) return 0;
    anim.lastX = roundedX;
    anim.lastY = roundedY;

    const lat = anim.fromLat + (anim.toLat - anim.fromLat) * fraction;
    const lng = anim.fromLng + (anim.toLng - anim.fromLng) * fraction;
    if (anim.done || !marker._icon || marker.isPopupOpen() || marker.isTooltipOpen()) {
        setBusMarkerLatLng(marker, lat, lng);
    } else {
        // Camino rápido (Leaflet 1.9): mismo resultado que setLatLng sin proyectar, sin evento 'move'
        // y sin tocar el z-index; el último paso (done) usa setLatLng y deja todo consistente.
        marker._latlng = L.latLng(lat, lng);
        L.DomUtil.setPosition(marker._icon, L.point(roundedX, roundedY));
    }
    if (anim.done) busAnimDeactivate(marker);
    return 1;
}

function busAnimRecordFrame(durationMs, updates) {
    const stats = busAnimState.stats;
    stats.frames += 1;
    stats.totalMs += durationMs;
    stats.updates += updates;
    if (durationMs > stats.maxMs) stats.maxMs = durationMs;
    stats.samples.push(durationMs);
    if (stats.samples.length > BUS_ANIM_STATS_SAMPLES) stats.samples.shift();
}

function busAnimTick(now) {
    busAnimState.rafId = 0;
    if (busAnimState.paused || document.hidden || !map) return;

    const startedAt = performance.now();
    const budgetMs = getBusAnimConfig().frameBudgetMs;
    if (busAnimState.listDirty) {
        busAnimState.list = Array.from(busAnimState.active);
        busAnimState.listDirty = false;
        busAnimState.cursor = 0;
    }

    const list = busAnimState.list;
    const total = list.length;
    const view = getBusAnimLayerView();
    let processed = 0;
    let updates = 0;
    for (; processed < total; processed += 1) {
        if (processed > 0 && (processed & 31) === 0 && performance.now() - startedAt > budgetMs) break;
        const marker = list[(busAnimState.cursor + processed) % total];
        if (!marker._map || !marker._busAnim || marker._busAnim.done) {
            busAnimDeactivate(marker);
            continue;
        }
        updates += busAnimStepMarker(marker, now, view);
    }
    busAnimState.cursor = total > 0 ? (busAnimState.cursor + processed) % total : 0;

    busAnimRecordFrame(performance.now() - startedAt, updates);
    if (busAnimState.active.size > 0) busAnimSchedule();
}

function busAnimSchedule() {
    if (busAnimState.rafId || busAnimState.paused || document.hidden) return;
    busAnimState.rafId = requestAnimationFrame(busAnimTick);
}

function busAnimCancelFrame() {
    if (busAnimState.rafId) cancelAnimationFrame(busAnimState.rafId);
    busAnimState.rafId = 0;
}

// Marker que sale del mapa (p. ej. queda dentro de una burbuja agrupada): se olvida su tramo para que
// al volver se ubique directo en la posición vigente.
function busAnimForget(marker) {
    if (!marker?._busAnim) return;
    marker._busAnim = null;
    busAnimDeactivate(marker);
}

// Ubica cada marker animado en su destino (sin la proyección) y vacía el loop.
function busAnimClear() {
    busAnimCancelFrame();
    busAnimState.active.forEach(marker => {
        const anim = marker._busAnim;
        marker._busAnim = null;
        if (anim && marker._map) setBusMarkerLatLng(marker, anim.toLat, anim.toLng);
    });
    busAnimState.active.clear();
    busAnimState.list = [];
    busAnimState.listDirty = true;
}

function busAnimEnsureSetup() {
    if (busAnimState.setupDone || !map) return;
    busAnimState.setupDone = true;

    map.on('zoomstart', () => {
        busAnimState.paused = true;
        busAnimCancelFrame();
    });
    map.on('zoomend viewreset', () => {
        busAnimState.active.forEach(marker => {
            if (marker._busAnim) busAnimComputePixels(marker._busAnim);
        });
        busAnimState.paused = false;
        busAnimSchedule();
    });
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) busAnimCancelFrame();
        else busAnimSchedule();
    });
    globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.addEventListener?.('change', event => {
        if (event.matches) busAnimClear();
    });
}

// Métricas para medir el costo por frame (tests de rendimiento / consola).
function busAnimGetStats() {
    const { frames, totalMs, maxMs, updates, samples } = busAnimState.stats;
    const sorted = [...samples].sort((a, b) => a - b);
    const percentile = p => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0);
    return {
        frames,
        avgMs: frames ? totalMs / frames : 0,
        p50Ms: percentile(0.5),
        p95Ms: percentile(0.95),
        maxMs,
        updatesPerFrame: frames ? updates / frames : 0,
        active: busAnimState.active.size,
        segmentMs: busAnimState.segmentMs
    };
}

function busAnimResetStats() {
    busAnimState.stats = { frames: 0, totalMs: 0, maxMs: 0, updates: 0, samples: [] };
}

globalThis.busAnimGetStats = busAnimGetStats;
globalThis.busAnimResetStats = busAnimResetStats;
