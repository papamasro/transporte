import { test, expect } from '@playwright/test';
import { bootApp, openPanel, trackPageErrors, MAIN_BUS_CHIPS } from './helpers.mjs';

const searchParams = page => new URL(page.url()).searchParams;

async function openMenuItem(page, name) {
    await page.locator('#app-menu-btn').click();
    await page.locator('#app-menu').getByRole('menuitem', { name }).click();
}

test.describe('links compartibles', () => {
    test('la URL sigue al mapa, la capa, la búsqueda y la estación abierta', async ({ page }) => {
        await bootApp(page);
        await page.evaluate(() => map.setView([-34.61, -58.39], 15, { animate: false }));
        await expect.poll(() => searchParams(page).get('@')).toMatch(/^-34\.\d{1,5},-58\.\d{1,5},15$/);
        expect(new URL(page.url()).pathname).toBe('/transporte/');

        await openPanel(page);
        await page.locator('#t-subte').click();
        await expect.poll(() => searchParams(page).get('capa')).toBe('subte');
        await page.evaluate(() => {
            const station = globalThis.cache.subteStatic.stations.A2;
            map.setView(getVisibleMapCenter([station.lat, station.lon], 16), 16, { animate: false });
            renderMarkers({ force: true });
            markerStores.subteStations.get('LineaA:A2').openPopup();
        });
        await expect.poll(() => searchParams(page).get('est')).toBe('subte:LineaA:A2');
        await page.locator('.leaflet-popup-close-button').click();
        await expect.poll(() => searchParams(page).get('est')).toBeNull();

        await openPanel(page);
        await page.locator('#t-bus').click();
        await page.locator('#search').fill('60');
        await page.locator('#search').press('Enter');
        await expect.poll(() => searchParams(page).get('q')).toBe('60');
        await expect.poll(() => searchParams(page).get('capa')).toBeNull();
    });

    test('abrir un link: vista y capa del link, sin pedir ubicación', async ({ page }) => {
        const errors = trackPageErrors(page);
        await bootApp(page, { path: './?@=-34.6086,-58.3742,16&capa=subte', dismissLocation: false, waitForBuses: false, zoom: null });
        await expect(page.locator('#t-subte')).toHaveAttribute('aria-pressed', 'true');
        await expect(page.locator('.leaflet-marker-icon', { hasText: '🚇' }).first()).toBeVisible();
        await expect(page.locator(MAIN_BUS_CHIPS)).toHaveCount(0);
        const view = await page.evaluate(() => ({ zoom: map.getZoom(), center: getVisibleViewCenter() }));
        expect(view.zoom).toBe(16);
        expect(view.center.lat).toBeCloseTo(-34.6086, 3);
        expect(view.center.lng).toBeCloseTo(-58.3742, 3);
        await page.waitForTimeout(400);
        await expect(page.locator('#location-prompt-overlay')).toHaveClass(/hidden/);
        expect(errors).toEqual([]);
    });

    test('link con línea: filtra y muestra el recorrido; con estación: abre su popup', async ({ page }) => {
        await bootApp(page, { path: './?linea=60', waitForBuses: false, zoom: null });
        await expect(page.locator('#search')).toHaveValue('60');
        await expect.poll(async () => new Set(await page.locator(MAIN_BUS_CHIPS).allTextContents())).toEqual(new Set(['60', '60A']));
        await expect.poll(() => page.evaluate(() => layers.busRoute.getLayers().length)).toBeGreaterThan(0);

        await page.goto('./?est=subte:LineaA:A2');
        await expect(page.locator('.leaflet-popup-content')).toContainText('Perú');
        await expect(page.locator('#t-subte')).toHaveAttribute('aria-pressed', 'true');
    });

    test('parámetros inválidos o maliciosos se ignoran sin romper nada', async ({ page }) => {
        const errors = trackPageErrors(page);
        const evil = encodeURIComponent('<img src=x onerror="window.__xss=1">');
        await bootApp(page, { path: `./?@=999,abc,50&capa=%3Cscript%3E&est=evil&q=${evil}`, waitForBuses: false, zoom: null });
        // Vista inválida: arranca normal (pide ubicación) en la vista por defecto.
        const zoom = await page.evaluate(() => map.getZoom());
        expect([13, 14]).toContain(zoom);
        await expect(page.locator('#t-bus')).toHaveAttribute('aria-pressed', 'true');
        await expect(page.locator('#search')).toHaveValue('<img src=x onerror="window.__xss=1">');
        expect(await page.locator('#app-sheet img').count()).toBe(0);
        await page.waitForTimeout(300);
        expect(await page.evaluate(() => typeof window.__xss)).toBe('undefined');
        expect(errors).toEqual([]);
    });

    test('Compartir: sin hoja de compartir copia el link y avisa', async ({ page }) => {
        await page.addInitScript(() => {
            Object.defineProperty(navigator, 'share', { value: undefined, configurable: true });
            Object.defineProperty(navigator, 'clipboard', {
                value: { writeText: async text => { globalThis.__copied = text; } },
                configurable: true
            });
        });
        await bootApp(page);
        await page.evaluate(() => map.setView([-34.6, -58.38], 15, { animate: false }));
        await openMenuItem(page, 'Compartir');
        await expect(page.locator('#toast-region .toast')).toHaveText(/Link copiado/);
        const copied = await page.evaluate(() => globalThis.__copied);
        const url = new URL(copied);
        expect(url.pathname).toBe('/transporte/');
        expect(url.searchParams.get('@')).toMatch(/,15$/);
        // El toast se cierra solo.
        await expect(page.locator('#toast-region .toast')).toHaveCount(0, { timeout: 6000 });
    });

    test('Compartir: usa navigator.share si existe', async ({ page }) => {
        await page.addInitScript(() => {
            Object.defineProperty(navigator, 'share', { value: async data => { globalThis.__shared = data; }, configurable: true });
            Object.defineProperty(navigator, 'canShare', { value: () => true, configurable: true });
        });
        await bootApp(page);
        await openMenuItem(page, 'Compartir');
        await expect.poll(() => page.evaluate(() => globalThis.__shared?.url || '')).toContain('/transporte/?@=');
        expect(await page.evaluate(() => globalThis.__shared.title)).toBe('Radar AMBA');
        await page.waitForTimeout(200);
        await expect(page.locator('#toast-region .toast')).toHaveCount(0);
    });
});
