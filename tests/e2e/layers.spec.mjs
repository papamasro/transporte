import { test, expect } from '@playwright/test';
import { bootApp, expectStatus, openPanel, pickBusMarker, trackPageErrors, MAIN_BUS_CHIPS, BUS_CLUSTERS } from './helpers.mjs';
import { XSS_HEADSIGN } from '../fixtures/data.mjs';

const pressedTypes = page => page.evaluate(() => ['bus', 'subte', 'train', 'bike']
    .filter(type => document.getElementById(`t-${type}`).getAttribute('aria-pressed') === 'true'));

// Zoom 14: las estaciones de bici dejan de ser puntos y entran en la pantalla del teléfono.
const showWholeBikeArea = page => page.evaluate(() => map.setZoom(14, { animate: false }));

test('toggle de tipos: subte reemplaza a colectivos y vuelve', async ({ page }) => {
    const mock = await bootApp(page);
    await openPanel(page);

    await page.locator('#t-subte').click();
    await expect(page.locator('.leaflet-marker-icon', { hasText: '🚇' }).first()).toBeVisible();
    await expect(page.locator(MAIN_BUS_CHIPS)).toHaveCount(0);
    expect(await pressedTypes(page)).toEqual(['subte']);
    expect(mock.count('/subtes/forecastGTFS')).toBe(1);

    await page.locator('#t-bus').click();
    await expect(page.locator(MAIN_BUS_CHIPS).first()).toBeVisible();
    await expect(page.locator('.leaflet-marker-icon', { hasText: '🚇' })).toHaveCount(0);
    expect(await pressedTypes(page)).toEqual(['bus']);
    await expectStatus(page, 'LIVE');
});

test('toggles rápidos: gana el último y no quedan capas mezcladas', async ({ page }) => {
    const errors = trackPageErrors(page);
    await bootApp(page);
    await openPanel(page);

    for (const type of ['subte', 'train', 'bike', 'subte', 'train', 'bike']) {
        await page.locator(`#t-${type}`).click({ delay: 0 });
    }
    await expect.poll(() => pressedTypes(page)).toEqual(['bike']);
    await showWholeBikeArea(page);
    await expect(page.locator('.leaflet-marker-icon', { hasText: '🚲' }).first()).toBeVisible();
    await page.waitForTimeout(800);
    await expect(page.locator(MAIN_BUS_CHIPS)).toHaveCount(0);
    await expect(page.locator('.leaflet-marker-icon', { hasText: '🚇' })).toHaveCount(0);
    await expectStatus(page, 'LIVE');
    expect(errors).toEqual([]);
});

test('buscar "60" muestra 60 y 60A pero no 160 ni 601', async ({ page }) => {
    await bootApp(page);
    await openPanel(page);
    await page.locator('#search').fill('60');
    await expect.poll(async () => {
        const labels = await page.locator(MAIN_BUS_CHIPS).allTextContents();
        return labels.length > 0 && labels.every(label => label === '60' || label === '60A');
    }).toBe(true);
    const labels = new Set(await page.locator(MAIN_BUS_CHIPS).allTextContents());
    expect([...labels].sort()).toEqual(['60', '60A']);
});

test('si fallan los colectivos: estado ERROR y se conservan los markers', async ({ page }) => {
    const mock = await bootApp(page);
    const before = await page.locator(MAIN_BUS_CHIPS).count();
    mock.options.busMode = 'error';
    await page.evaluate(() => forceRefresh());
    await expectStatus(page, 'ERROR', { timeout: 15_000 });
    expect(await page.locator(MAIN_BUS_CHIPS).count()).toBe(before);

    mock.options.busMode = 'ok';
    await page.evaluate(() => forceRefresh());
    await expectStatus(page, 'LIVE');
});

test('datos con HTML se muestran como texto (sin XSS)', async ({ page }) => {
    await bootApp(page);
    await pickBusMarker(page, { id: '1007' });
    // Los markers se superponen en mobile: se abre el popup del colectivo exacto.
    await page.evaluate(() => {
        for (const marker of markerStores.bus.values()) {
            if (marker._transitMarker?.data?.id === '1007') marker.openPopup();
        }
    });
    const popup = page.locator('.leaflet-popup-content');
    await expect(popup).toContainText(XSS_HEADSIGN.toUpperCase().slice(0, 4), { ignoreCase: true });
    await expect(popup).toContainText('<img src=x', { ignoreCase: true });
    await expect(popup).toContainText('<script>', { ignoreCase: true });
    expect(await popup.locator('img, script').count()).toBe(0);
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => window.__xss)).toBeUndefined();
});

test('zoom muy lejano: no se dibujan ni piden colectivos', async ({ page }) => {
    const mock = await bootApp(page);
    await page.evaluate(() => map.setZoom(10, { animate: false }));
    await expect(page.locator(MAIN_BUS_CHIPS)).toHaveCount(0);
    await expect(page.locator('#unit-count')).toContainText('Acercá para ver colectivos');
    await expect(page.locator('#map-hint')).toBeVisible();
    await expect(page.locator(BUS_CLUSTERS)).toHaveCount(0);
    const busRequests = () => mock.count(item => item.pathname.startsWith('/colectivos/vehiclePositions'));
    const beforeCount = busRequests();
    await page.evaluate(() => forceRefresh());
    await page.waitForTimeout(500);
    expect(busRequests()).toBe(beforeCount);

    // Al acercar con el dato vencido se pide enseguida.
    await page.evaluate(() => {
        globalThis.cache.busFetchedAt = 1;
        pollLastAt.bus = 0;
        map.setZoom(14, { animate: false });
    });
    await expect.poll(busRequests).toBe(beforeCount + 1);
    // Zoom 14: agrupados en burbujas.
    await expect(page.locator(BUS_CLUSTERS).first()).toBeVisible();
    await expect(page.locator('#map-hint')).toBeHidden();
});

test.describe('feature flags', () => {
    test('capas y paneles apagados: UI oculta y sin requests', async ({ page }) => {
        const errors = trackPageErrors(page);
        const mock = await bootApp(page, {
            flags: { subteLayer: false, trainLayer: false, alertsPanel: false, nearbyPanel: false, busAnimation: false, bikeRoutes: false }
        });
        await openPanel(page);
        await expect(page.locator('#t-subte')).toBeHidden();
        await expect(page.locator('#t-train')).toBeHidden();
        await expect(page.locator('#t-bike')).toBeVisible();
        await expect(page.locator('#action-alerts')).toBeHidden();
        await expect(page.locator('#action-nearby')).toBeHidden();

        await page.evaluate(() => { toggleType('subte'); toggleAlertPanel(); toggleNearbyPanel(); });
        await page.locator('#t-bike').click();
        await showWholeBikeArea(page);
        await expect(page.locator('.leaflet-marker-icon', { hasText: '🚲' }).first()).toBeVisible();
        await page.waitForTimeout(500);

        expect(mock.count(item => item.pathname.startsWith('/subtes/'))).toBe(0);
        expect(mock.count(item => item.search.includes('subte'))).toBe(0);
        expect(mock.count(item => item.pathname.includes('serviceAlerts'))).toBe(0);
        expect(mock.count('/obtener-bicisenda')).toBe(0);
        // busAnimation apagado: no hace falta la ruta KV (más pesada).
        expect(mock.count('/colectivos/vehiclePositionsKV')).toBe(0);
        expect(mock.count('/colectivos/vehiclePositionsSimple')).toBe(1);
        expect(await page.evaluate(() => busAnimGetStats().active)).toBe(0);
        expect(errors).toEqual([]);
    });

    test('subteRealtime apagado: estaciones sin pedir el pronóstico', async ({ page }) => {
        const mock = await bootApp(page, { flags: { subteRealtime: false } });
        await openPanel(page);
        await page.locator('#t-subte').click();
        await expect(page.locator('.leaflet-marker-icon', { hasText: '🚇' }).first()).toBeVisible();
        await expectStatus(page, 'LIVE');
        expect(mock.count('/subtes/forecastGTFS')).toBe(0);
    });

    test('colectivos apagados: arranca sin capa y sin pedir posiciones', async ({ page }) => {
        const mock = await bootApp(page, { flags: { busLayer: false }, waitForBuses: false });
        await page.waitForTimeout(800);
        await openPanel(page);
        await expect(page.locator('#t-bus')).toBeHidden();
        await expect(page.locator(MAIN_BUS_CHIPS)).toHaveCount(0);
        expect(mock.count(item => item.pathname.startsWith('/colectivos/vehiclePositions'))).toBe(0);
    });
});
