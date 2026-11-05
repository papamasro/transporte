import { test, expect } from '@playwright/test';
import { bootApp, openPanel, pickBusMarker, trackPageErrors, MAIN_BUS_CHIPS, BUS_CLUSTERS, CHIPS_ZOOM } from './helpers.mjs';

const setZoom = (page, zoom) => page.evaluate(value => {
    map.setZoom(value, { animate: false });
    renderMarkers({ force: true });
}, zoom);

// Lo dibujado (chips + suma de burbujas) tiene que coincidir con "N en vista": nadie se pierde al agrupar.
const drawnBusCount = page => page.evaluate(() => {
    let total = 0;
    for (const marker of markerStores.bus.values()) if (layers.bus.hasLayer(marker)) total += 1;
    for (const marker of markerStores.busClusters.values()) {
        if (layers.busClusters.hasLayer(marker)) total += marker._clusterCount;
    }
    return total;
});
const statusCount = async page => Number((await page.locator('#unit-count').textContent()).replace(/\D/g, ''));

test.describe('agrupación de colectivos', () => {
    test('zoom 13: burbujas con cantidad, sin perder colectivos', async ({ page }) => {
        const errors = trackPageErrors(page);
        await bootApp(page, { zoom: 13, waitForBuses: false });
        const clusters = page.locator(BUS_CLUSTERS);
        await expect(clusters.first()).toBeVisible();
        const labels = await clusters.allTextContents();
        expect(labels.every(label => /^\d+$/.test(label.trim()) && Number(label) >= 2)).toBe(true);
        await expect(clusters.first()).toHaveAttribute('role', 'button');
        await expect(clusters.first()).toHaveAttribute('aria-label', /\d+ colectivos\. Acercar el mapa/);
        await expect.poll(async () => (await drawnBusCount(page)) === (await statusCount(page))).toBe(true);
        expect(errors).toEqual([]);
    });

    test('tocar una burbuja acerca el mapa a sus colectivos', async ({ page }) => {
        await bootApp(page, { zoom: 13, waitForBuses: false });
        await expect(page.locator(BUS_CLUSTERS).first()).toBeVisible();
        const target = await page.evaluate(() => {
            const insets = getMapObscuredInsets();
            const height = map.getSize().y - insets.bottom;
            for (const marker of markerStores.busClusters.values()) {
                if (!layers.busClusters.hasLayer(marker)) continue;
                const point = map.latLngToContainerPoint(marker.getLatLng());
                if (point.y < 40 || point.y > height - 40 || point.x < 40 || point.x > map.getSize().x - 40) continue;
                marker.getElement().setAttribute('data-test-cluster', '1');
                const bounds = marker._clusterBounds;
                return { south: bounds.getSouth(), north: bounds.getNorth(), west: bounds.getWest(), east: bounds.getEast() };
            }
            return null;
        });
        expect(target).not.toBeNull();
        await page.locator('[data-test-cluster="1"]').click();
        await expect.poll(() => page.evaluate(() => map.getZoom())).toBeGreaterThan(13);
        await page.waitForTimeout(400);
        const view = await page.evaluate(() => {
            const bounds = map.getBounds();
            return { south: bounds.getSouth(), north: bounds.getNorth(), west: bounds.getWest(), east: bounds.getEast() };
        });
        expect(view.south).toBeLessThanOrEqual(target.south);
        expect(view.north).toBeGreaterThanOrEqual(target.north);
        expect(view.west).toBeLessThanOrEqual(target.west);
        expect(view.east).toBeGreaterThanOrEqual(target.east);
    });

    test(`zoom ${CHIPS_ZOOM}: chips individuales sin burbujas`, async ({ page }) => {
        await bootApp(page);
        await expect(page.locator(MAIN_BUS_CHIPS).first()).toBeVisible();
        await expect(page.locator(BUS_CLUSTERS)).toHaveCount(0);
        expect(await drawnBusCount(page)).toBe(await statusCount(page));
    });

    test('con búsqueda de línea se ven chips aunque el zoom sea bajo', async ({ page }) => {
        await bootApp(page, { zoom: 13, waitForBuses: false });
        await expect(page.locator(BUS_CLUSTERS).first()).toBeVisible();
        const unfilteredClusters = await page.locator(BUS_CLUSTERS).count();
        await openPanel(page);
        await page.locator('#search').fill('60');
        await expect.poll(async () => {
            const labels = await page.locator(MAIN_BUS_CHIPS).allTextContents();
            return labels.length > 0 && labels.every(label => label === '60' || label === '60A');
        }).toBe(true);
        // Solo se agrupa donde hay muchos de la misma línea encimados; los demás quedan como chip.
        const counts = await page.evaluate(() => ({
            chips: [...markerStores.bus.values()].filter(marker => layers.bus.hasLayer(marker)).length,
            clusters: [...markerStores.busClusters.values()].filter(marker => layers.busClusters.hasLayer(marker)).length
        }));
        expect(counts.chips).toBeGreaterThan(counts.clusters);
        expect(counts.clusters).toBeLessThanOrEqual(unfilteredClusters);
        await expect.poll(async () => (await drawnBusCount(page)) === (await statusCount(page))).toBe(true);
        await page.locator('#search').fill('');
        await expect(page.locator(BUS_CLUSTERS).first()).toBeVisible();
    });

    test('el colectivo con popup abierto no se agrupa al alejar', async ({ page }) => {
        await bootApp(page);
        const target = await pickBusMarker(page, { line: '60' });
        await target.locator.click();
        await expect(page.locator('.leaflet-popup')).toHaveCount(1);
        await setZoom(page, 13);
        await expect(page.locator(BUS_CLUSTERS).first()).toBeVisible();
        await expect(page.locator('.leaflet-popup')).toHaveCount(1);
        await expect(page.locator('.leaflet-popup')).toContainText('60');
        const inLayer = await page.evaluate(key => layers.bus.hasLayer(markerStores.bus.get(key)), target.key);
        expect(inLayer).toBe(true);
    });

    test('zoom lejano: estaciones como puntos; al acercar, íconos', async ({ page }) => {
        await bootApp(page);
        await openPanel(page);
        await page.locator('#t-subte').click();
        await expect(page.locator('.leaflet-marker-icon', { hasText: '🚇' }).first()).toBeVisible();
        await setZoom(page, 12);
        await expect(page.locator('.station-dot-subte').first()).toBeAttached();
        await expect(page.locator('.leaflet-marker-icon', { hasText: '🚇' })).toHaveCount(0);
        await setZoom(page, 14);
        await expect(page.locator('.leaflet-marker-icon', { hasText: '🚇' }).first()).toBeAttached();
        await expect(page.locator('.station-dot-subte')).toHaveCount(0);
    });

    test('2000 colectivos agrupados: render inicial dentro del presupuesto', async ({ page }, testInfo) => {
        test.skip(testInfo.project.name !== 'desktop', 'medición en desktop');
        test.setTimeout(90_000);
        await bootApp(page, { mocks: { busCount: 2000 }, zoom: 13, waitForBuses: false });
        await expect.poll(() => page.evaluate(() => globalThis.cache.bus.length)).toBe(2000);
        const results = [];
        for (const zoom of [12, 13, 14, 15]) {
            results.push(await page.evaluate(async value => {
                map.setView([-34.6037, -58.3816], value, { animate: false });
                await new Promise(resolve => setTimeout(resolve, 300));
                const samples = [];
                for (let index = 0; index < 5; index += 1) {
                    busAnimClear?.();
                    layers.bus.clearLayers(); markerStores.bus.clear();
                    layers.busClusters?.clearLayers(); markerStores.busClusters.clear();
                    const started = performance.now();
                    renderMarkers({ force: true });
                    samples.push(performance.now() - started);
                }
                samples.sort((a, b) => a - b);
                return {
                    zoom: value,
                    medianMs: +samples[2].toFixed(1),
                    markers: document.querySelectorAll('.leaflet-marker-icon').length
                };
            }, zoom));
        }
        console.log(`[perf] 2000 colectivos agrupados: ${JSON.stringify(results)}`);
        testInfo.annotations.push({ type: 'perf', description: JSON.stringify(results) });
        for (const result of results) {
            expect(result.medianMs, `zoom ${result.zoom}`).toBeLessThan(30);
            // Agrupados: muchos menos elementos en el DOM que colectivos.
            expect(result.markers, `zoom ${result.zoom}`).toBeLessThan(600);
        }
    });
});
