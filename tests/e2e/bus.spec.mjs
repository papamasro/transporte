import { test, expect } from '@playwright/test';
import { bootApp, expectStatus, openPanel, closePanel, pickBusMarker, trackPageErrors, MAIN_BUS_CHIPS } from './helpers.mjs';

// Tramos cortos para que la animación entre en el tiempo de un test (en producción ≈ 30 s).
const FAST_ANIMATION = { BUS_ANIMATION: { minSegmentMs: 1500, maxSegmentMs: 2500, deadReckoningMs: 0 } };
const FAST_MOCKS = { kvPrevAgeMs: 2000, busStepMeters: 300 };

const routeLayerCount = page => page.evaluate(() => layers.busRoute.getLayers().length);
const waitAnimationIdle = page => expect.poll(() => page.evaluate(() => busAnimGetStats().active), { timeout: 8000 }).toBe(0);

// Muestrea en cada frame la posición en pantalla de un colectivo mientras corre `action`.
async function sampleMarkerDuring(page, vehicleId, durationMs) {
    return page.evaluate(({ id, duration }) => new Promise(resolve => {
        const marker = [...markerStores.bus.values()].find(item => item._transitMarker?.data?.id === id);
        const samples = [];
        const started = performance.now();
        forceRefresh();
        const tick = () => {
            const point = map.latLngToContainerPoint(marker.getLatLng());
            samples.push({ t: performance.now() - started, x: point.x, y: point.y, popupOpen: marker.isPopupOpen() });
            if (performance.now() - started < duration) requestAnimationFrame(tick);
            else resolve(samples);
        };
        requestAnimationFrame(tick);
    }), { id: vehicleId, duration: durationMs });
}

const targetPoint = (page, vehicleId) => page.evaluate(id => {
    const vehicle = globalThis.cache.bus.find(item => item.id === id);
    const point = map.latLngToContainerPoint([vehicle.latitude, vehicle.longitude]);
    return { x: point.x, y: point.y };
}, vehicleId);

test.describe('animación de colectivos', () => {
    test('se desliza sin saltos ni retrocesos hasta la nueva posición', async ({ page }) => {
        const errors = trackPageErrors(page);
        const mock = await bootApp(page, { config: FAST_ANIMATION, mocks: { ...FAST_MOCKS, busStepMeters: 600 } });
        expect(mock.count('/colectivos/vehiclePositionsKV')).toBe(1);
        await waitAnimationIdle(page);

        const target = await pickBusMarker(page, { id: (await pickBusMarker(page, { line: '60' })).id });
        const samples = await sampleMarkerDuring(page, target.id, 3200);
        const end = await targetPoint(page, target.id);
        const start = samples[0];
        const total = Math.hypot(end.x - start.x, end.y - start.y);
        expect(total).toBeGreaterThan(20);

        const distinct = new Set(samples.map(s => `${Math.round(s.x)},${Math.round(s.y)}`));
        expect(distinct.size).toBeGreaterThan(10);

        let maxStep = 0;
        for (let index = 1; index < samples.length; index += 1) {
            const step = Math.hypot(samples[index].x - samples[index - 1].x, samples[index].y - samples[index - 1].y);
            maxStep = Math.max(maxStep, step);
            // Línea 60 va hacia el norte: y nunca crece (sin retrocesos).
            expect(samples[index].y).toBeLessThanOrEqual(samples[index - 1].y + 0.5);
        }
        expect(maxStep).toBeLessThan(total / 4);
        const last = samples.at(-1);
        expect(Math.hypot(last.x - end.x, last.y - end.y)).toBeLessThan(1.5);

        const stats = await page.evaluate(() => busAnimGetStats());
        expect(stats.avgMs).toBeLessThan(4);
        expect(errors).toEqual([]);
    });

    test('el popup abierto sigue al colectivo y no mueve el mapa', async ({ page }) => {
        await bootApp(page, { config: FAST_ANIMATION, mocks: FAST_MOCKS });
        await waitAnimationIdle(page);
        const target = await pickBusMarker(page, { line: '60' });
        await target.locator.click();
        const popup = page.locator('.leaflet-popup');
        await expect(popup).toHaveCount(1);
        await expect(popup).toContainText('60');
        await page.waitForTimeout(400);
        const centerBefore = await page.evaluate(() => map.getCenter());

        const samples = await sampleMarkerDuring(page, target.id, 2800);
        expect(samples.every(sample => sample.popupOpen)).toBe(true);
        await expect(popup).toHaveCount(1);
        await expect(popup).toContainText('60');

        const geometry = await page.evaluate(id => {
            const marker = [...markerStores.bus.values()].find(item => item._transitMarker?.data?.id === id);
            const markerPoint = map.latLngToContainerPoint(marker.getLatLng());
            const popupPoint = map.latLngToContainerPoint(marker.getPopup().getLatLng());
            return { dx: markerPoint.x - popupPoint.x, dy: markerPoint.y - popupPoint.y, center: map.getCenter() };
        }, target.id);
        expect(Math.abs(geometry.dx) + Math.abs(geometry.dy)).toBeLessThan(1);
        expect(geometry.center.lat).toBeCloseTo(centerBefore.lat, 6);
        expect(geometry.center.lng).toBeCloseTo(centerBefore.lng, 6);
    });

    // Peor caso de la animación: sin agrupar, los 2000 como chips en zoom 14 (ver clusters.spec para el default).
    test('2000 colectivos: costo por frame dentro del presupuesto', async ({ page }, testInfo) => {
        test.skip(testInfo.project.name !== 'desktop', 'medición en desktop');
        test.setTimeout(90_000);
        await bootApp(page, { config: { ...FAST_ANIMATION, BUS_CLUSTER: { enabled: false } }, mocks: { ...FAST_MOCKS, busCount: 2000 }, zoom: 14 });
        await waitAnimationIdle(page);
        await page.evaluate(() => busAnimResetStats());
        await page.evaluate(() => forceRefresh());
        await page.waitForTimeout(500);
        const midActive = await page.evaluate(() => busAnimGetStats().active);
        await waitAnimationIdle(page);
        const stats = await page.evaluate(() => busAnimGetStats());
        testInfo.annotations.push({ type: 'perf', description: JSON.stringify({ ...stats, midActive }) });
        console.log(`[perf] 2000 colectivos: ${JSON.stringify({ ...stats, midActive })}`);
        expect(midActive).toBeGreaterThan(1000);
        expect(stats.frames).toBeGreaterThan(30);
        expect(stats.avgMs).toBeLessThan(4);
        // Margen para ruido de CI (GC/scheduling); el presupuesto del loop es 3 ms.
        expect(stats.p95Ms).toBeLessThan(8);
    });
});

test.describe('prefers-reduced-motion', () => {
    test.use({ reducedMotion: 'reduce' });

    test('sin animación: los colectivos se ubican directo y no se pide KV', async ({ page }) => {
        const mock = await bootApp(page, { config: FAST_ANIMATION, mocks: FAST_MOCKS });
        expect(mock.count('/colectivos/vehiclePositionsKV')).toBe(0);
        expect(mock.count('/colectivos/vehiclePositionsSimple')).toBe(1);
        // Centrado en la zona libre: al moverse 300 m al norte no sale de la vista (en mobile la hoja tapa abajo).
        const target = await pickBusMarker(page, { id: (await pickBusMarker(page, { line: '60' })).id });
        const samples = await sampleMarkerDuring(page, target.id, 1500);
        const distinct = new Set(samples.map(s => `${Math.round(s.x)},${Math.round(s.y)}`));
        expect(distinct.size).toBeLessThanOrEqual(2);
        const end = await targetPoint(page, target.id);
        const last = samples.at(-1);
        expect(Math.hypot(last.x - end.x, last.y - end.y)).toBeLessThan(1.5);
        expect(await page.evaluate(() => busAnimGetStats().frames)).toBe(0);
    });
});

test.describe('ruta KV', () => {
    test('404 (worker viejo): cae a vehiclePositionsSimple y no reintenta KV', async ({ page }) => {
        const errors = trackPageErrors(page);
        const mock = await bootApp(page, { mocks: { kvMode: 'notfound' } });
        expect(mock.count('/colectivos/vehiclePositionsKV')).toBe(1);
        expect(mock.count('/colectivos/vehiclePositionsSimple')).toBe(1);
        await expectStatus(page, 'LIVE');

        await page.evaluate(() => { globalThis.cache.busFetchedAt = 1; pollLastAt.bus = 0; return forceRefresh(); });
        await expect.poll(() => mock.count('/colectivos/vehiclePositionsSimple')).toBe(2);
        expect(mock.count('/colectivos/vehiclePositionsKV')).toBe(1);
        expect(errors.filter(text => !text.includes('404'))).toEqual([]);
    });

    test('500: cae a vehiclePositionsSimple', async ({ page }) => {
        const mock = await bootApp(page, { mocks: { kvMode: 'error' } });
        expect(mock.count('/colectivos/vehiclePositionsSimple')).toBe(1);
        await expect(page.locator(MAIN_BUS_CHIPS).first()).toBeVisible();
        await expectStatus(page, 'LIVE');
    });
});

test.describe('recorrido del colectivo', () => {
    test('desde data/routes estático; se oculta al cerrar el popup', async ({ page }) => {
        const mock = await bootApp(page);
        const target = await pickBusMarker(page, { line: '60' });
        await target.locator.click();
        await expect.poll(() => routeLayerCount(page)).toBeGreaterThan(0);
        expect(mock.count(item => item.staticRoute && item.pathname.endsWith('/60.json'))).toBe(1);
        expect(mock.count('/info-trayecto')).toBe(0);
        expect(mock.count('/buscar-linea')).toBe(0);

        await page.locator('.leaflet-popup-close-button').click();
        await expect(page.locator('.leaflet-popup')).toHaveCount(0);
        await expect.poll(() => routeLayerCount(page)).toBe(0);
    });

    test('sin data/routes publicados: usa el worker', async ({ page }) => {
        const mock = await bootApp(page, { mocks: { staticRoutes: 'missing' } });
        const target = await pickBusMarker(page, { line: '60' });
        await target.locator.click();
        await expect.poll(() => routeLayerCount(page)).toBeGreaterThan(0);
        expect(mock.count('/info-trayecto') + mock.count('/buscar-linea')).toBeGreaterThan(0);
    });

    test('escribir filtra sin pedir el recorrido; Enter lo confirma y pide uno solo', async ({ page }) => {
        const mock = await bootApp(page);
        await openPanel(page);
        mock.reset();
        await page.locator('#search').pressSequentially('60', { delay: 60 });
        await expect.poll(async () => {
            const labels = await page.locator(MAIN_BUS_CHIPS).allTextContents();
            return labels.length > 0 && labels.every(label => label === '60' || label === '60A');
        }).toBe(true);
        await page.waitForTimeout(500);
        // Por tecla no hay red: ni recorridos estáticos ni /buscar-linea.
        expect(mock.count(item => item.staticRoute && !item.pathname.endsWith('/index.json'))).toBe(0);
        expect(mock.count('/buscar-linea')).toBe(0);
        expect(await routeLayerCount(page)).toBe(0);

        await page.locator('#search').press('Enter');
        await expect.poll(() => routeLayerCount(page)).toBeGreaterThan(0);
        expect(mock.count(item => item.staticRoute && item.pathname.endsWith('/60.json'))).toBe(1);
    });

    test('con búsqueda de línea: el recorrido queda hasta limpiar la búsqueda', async ({ page }) => {
        await bootApp(page);
        await openPanel(page);
        await page.locator('#search').fill('60');
        await page.locator('#search').press('Enter');
        await expect.poll(() => routeLayerCount(page)).toBeGreaterThan(0);

        await closePanel(page);
        const target = await pickBusMarker(page, { line: '60' });
        await target.locator.click();
        await expect(page.locator('.leaflet-popup')).toHaveCount(1);
        await page.locator('.leaflet-popup-close-button').click();
        await page.waitForTimeout(300);
        expect(await routeLayerCount(page)).toBeGreaterThan(0);

        await openPanel(page);
        await page.locator('#search').fill('');
        await expect.poll(() => routeLayerCount(page)).toBe(0);
    });
});
