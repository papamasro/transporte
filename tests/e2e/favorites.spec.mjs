import { test, expect } from '@playwright/test';
import { bootApp, openPanel, closePanel, dismissLocationPrompt, trackPageErrors } from './helpers.mjs';

const FAVORITES_KEY = 'radaramba.favorites-v1';
const slot = page => page.locator('#favorites-slot');
const storedFavorites = page => page.evaluate(key => JSON.parse(localStorage.getItem(key) || 'null'), FAVORITES_KEY);

async function openSubteStationPopup(page, key) {
    await page.evaluate(async stationKey => {
        if (!activeTypes.subte) await toggleType('subte');
        const [routeId, stopId] = stationKey.split(':');
        const station = globalThis.cache.subteStatic.stations[stopId];
        map.setView(getVisibleMapCenter([station.lat, station.lon], 16), 16, { animate: false });
        renderMarkers({ force: true });
        markerStores.subteStations.get(`${routeId}:${stopId}`).openPopup();
    }, key);
    await expect(page.locator('.leaflet-popup-content')).toBeVisible();
}

test.describe('favoritos', () => {
    test('el panel no muestra la sección; ☆ guarda y restaura la estación', async ({ page }) => {
        const errors = trackPageErrors(page);
        await bootApp(page);
        await openPanel(page);
        await expect(slot(page)).toHaveCount(0);

        await closePanel(page);
        await openSubteStationPopup(page, 'LineaA:A1');
        const star = page.locator('.leaflet-popup-content .fav-star');
        await expect(star).toHaveAttribute('aria-pressed', 'false');
        await expect(star).toHaveAccessibleName('Favorito: Plaza de Mayo');
        await star.click();
        await expect(star).toHaveAttribute('aria-pressed', 'true');
        await expect(page.locator('#toast-region')).toContainText('Guardaste Plaza de Mayo en favoritos');
        // El popup sigue abierto: la ☆ no lo cierra ni hace click en el mapa.
        await expect(page.locator('.leaflet-popup-content')).toBeVisible();

        expect((await storedFavorites(page)).items).toEqual([
            expect.objectContaining({ kind: 'station', type: 'subte', id: 'LineaA:A1', label: 'Plaza de Mayo' })
        ]);

        await page.goto('./');
        await dismissLocationPrompt(page);
        await openSubteStationPopup(page, 'LineaA:A1');
        await expect(page.locator('.leaflet-popup-content .fav-star')).toHaveAttribute('aria-pressed', 'true');
        await expect(slot(page)).toHaveCount(0);
        expect(errors).toEqual([]);
    });

    test('la estrella de una línea desde sugerencias guarda y conserva el estado', async ({ page }) => {
        await bootApp(page);
        await openPanel(page);
        await page.locator('#search').click();
        await page.locator('#search').pressSequentially('60', { delay: 40 });
        const option = page.locator('#search-results [role="option"]').first();
        await option.locator('.fav-star').click();
        await expect(option.locator('.fav-star')).toHaveAttribute('data-fav-pressed', 'true');
        // Tocar la ☆ no elige la sugerencia.
        await expect(page.locator('#search-results')).toBeVisible();
        expect((await storedFavorites(page)).items).toContainEqual(
            expect.objectContaining({ kind: 'line', type: 'bus', id: '60', label: '60' })
        );
        await expect(slot(page)).toHaveCount(0);
    });

    test('una estrella marcada permite quitar un favorito aunque no haya lista en el panel', async ({ page }) => {
        await page.addInitScript(key => {
            localStorage.setItem(key, JSON.stringify({ v: 1, items: [
                { kind: 'line', type: 'bus', id: '60', label: '60', line: '60' }
            ] }));
        }, FAVORITES_KEY);
        await bootApp(page);
        await openPanel(page);
        await expect(slot(page)).toHaveCount(0);
        await page.locator('#search').fill('60');
        const star = page.locator('#search-results [role="option"] .fav-star').first();
        await expect(star).toHaveAttribute('data-fav-pressed', 'true');
        await star.click();
        await expect(star).toHaveAttribute('data-fav-pressed', 'false');
        expect((await storedFavorites(page)).items).toEqual([]);
    });

    test('se conservan los favoritos de Ecobici guardados previamente', async ({ page }) => {
        await page.addInitScript(key => {
            localStorage.setItem(key, JSON.stringify({ v: 1, items: [
                { kind: 'station', type: 'bike', id: '2', label: '002 - Retiro I', color: '#10b981', lat: -34.5924, lon: -58.3747 }
            ] }));
        }, FAVORITES_KEY);
        await bootApp(page);
        await openPanel(page);
        await expect(slot(page)).toHaveCount(0);
        expect((await storedFavorites(page)).items).toEqual([
            expect.objectContaining({ kind: 'station', type: 'bike', id: '2', label: '002 - Retiro I' })
        ]);
    });

    test('localStorage manipulado: se valida, se escapa y se limita a 30', async ({ page }) => {
        const errors = trackPageErrors(page);
        await page.addInitScript(key => {
            const evil = '<img src=x onerror="window.__xss=1">';
            const items = [
                { kind: 'station', type: 'subte', id: 'LineaA:A1', label: evil, color: 'red;background:url(https://evil.test/x)', lat: -34.6, lon: -58.37 },
                { kind: 'line', type: 'bus', id: '"><script>window.__xss=2</script>', label: 'x' },
                { kind: 'evil', type: 'bus', id: '60', label: 'x' },
                { kind: 'station', type: 'stop', id: 'sin-coordenadas', label: 'x' },
                'texto',
                null,
                ...Array.from({ length: 40 }, (_, index) => ({ kind: 'line', type: 'bus', id: String(index + 1), label: String(index + 1) }))
            ];
            localStorage.setItem(key, JSON.stringify({ v: 1, items }));
        }, FAVORITES_KEY);
        await bootApp(page);
        await openPanel(page);
        await expect(slot(page)).toHaveCount(0);
        expect(await page.evaluate(key => globalThis.parseFavoritesPayload(JSON.parse(localStorage.getItem(key))).length, FAVORITES_KEY)).toBe(30);
        await page.waitForTimeout(200);
        expect(await page.evaluate(() => typeof window.__xss)).toBe('undefined');
        expect(errors).toEqual([]);

        // Con 30 guardados no se suma otro.
        await page.locator('#search').click();
        await page.locator('#search').pressSequentially('60', { delay: 40 });
        await page.locator('#search-results [role="option"]').first().locator('.fav-star').click();
        await expect(page.locator('#toast-region')).toContainText('Podés guardar hasta 30 favoritos');
        expect(await page.evaluate(key => globalThis.parseFavoritesPayload(JSON.parse(localStorage.getItem(key))).length, FAVORITES_KEY)).toBe(30);
    });
});
