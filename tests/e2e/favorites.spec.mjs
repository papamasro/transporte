import { test, expect } from '@playwright/test';
import { bootApp, openPanel, closePanel, dismissLocationPrompt, trackPageErrors, MAIN_BUS_CHIPS } from './helpers.mjs';

const FAVORITES_KEY = 'radaramba.favorites-v1';
const slot = page => page.locator('#favorites-slot');
const favoriteItems = page => page.locator('#favorites-list .favorite-item');
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
    test('vacío muestra la ayuda; ☆ en el popup guarda la estación con su próxima llegada', async ({ page }) => {
        const errors = trackPageErrors(page);
        await bootApp(page);
        await openPanel(page);
        await expect(slot(page)).toBeVisible();
        await expect(page.locator('#favorites-empty')).toHaveText('Tocá ☆ en una línea o estación para guardarla');
        await expect(page.locator('#favorites-edit')).toBeHidden();

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

        await openPanel(page);
        await expect(favoriteItems(page)).toHaveCount(1);
        await expect(favoriteItems(page).first()).toContainText('Plaza de Mayo');
        await expect(favoriteItems(page).first().locator('.favorite-info')).toHaveText(/^Próximo: en \d+ min$/);
        await expect(page.locator('#favorites-empty')).toBeHidden();
        expect((await storedFavorites(page)).items).toEqual([
            expect.objectContaining({ kind: 'station', type: 'subte', id: 'LineaA:A1', label: 'Plaza de Mayo' })
        ]);

        // La URL ya tiene la vista compartible: se recarga sin ella para volver al arranque normal.
        await page.goto('./');
        await dismissLocationPrompt(page);
        await openPanel(page);
        await expect(favoriteItems(page)).toHaveCount(1);
        expect(errors).toEqual([]);
    });

    test('línea desde la sugerencia: muestra cuántos hay en vista y tocarla filtra con su recorrido', async ({ page }) => {
        await bootApp(page);
        await openPanel(page);
        await page.locator('#search').click();
        await page.locator('#search').pressSequentially('60', { delay: 40 });
        const option = page.locator('#search-results [role="option"]').first();
        await option.locator('.fav-star').click();
        await expect(option.locator('.fav-star')).toHaveAttribute('data-fav-pressed', 'true');
        // Tocar la ☆ no elige la sugerencia.
        await expect(page.locator('#search-results')).toBeVisible();
        await page.locator('#search').press('Escape');
        await page.locator('#search').press('Escape');

        const item = favoriteItems(page).first();
        await expect(item).toContainText('60');
        await expect(item.locator('.favorite-info')).toHaveText(/^\d+ en vista$|^El más cercano, a /);
        await item.locator('[data-fav-open]').click();
        await expect(page.locator('#search')).toHaveValue('60');
        await expect.poll(async () => new Set(await page.locator(MAIN_BUS_CHIPS).allTextContents())).toEqual(new Set(['60', '60A']));
        await expect.poll(() => page.evaluate(() => layers.busRoute.getLayers().length)).toBeGreaterThan(0);
    });

    test('Editar muestra los botones para quitar y devuelve el foco', async ({ page }) => {
        await page.addInitScript(key => {
            localStorage.setItem(key, JSON.stringify({ v: 1, items: [
                { kind: 'line', type: 'bus', id: '60', label: '60', line: '60' },
                { kind: 'station', type: 'bike', id: '2', label: '002 - Retiro I', lat: -34.5924, lon: -58.3747 }
            ] }));
        }, FAVORITES_KEY);
        await bootApp(page);
        await openPanel(page);
        await expect(favoriteItems(page)).toHaveCount(2);
        const edit = page.locator('#favorites-edit');
        await expect(page.locator('[data-fav-remove]').first()).toBeHidden();
        await edit.click();
        await expect(edit).toHaveAttribute('aria-pressed', 'true');
        await expect(edit).toHaveText('Listo');
        const removes = page.locator('[data-fav-remove]');
        await expect(removes).toHaveCount(2);
        await expect(removes.first()).toHaveAccessibleName('Quitar 60 de favoritos');
        await removes.first().click();
        await expect(favoriteItems(page)).toHaveCount(1);
        await expect(page.locator('[data-fav-remove]')).toBeFocused();
        await page.locator('[data-fav-remove]').click();
        await expect(favoriteItems(page)).toHaveCount(0);
        await expect(page.locator('#favorites-empty')).toBeVisible();
        await expect(page.locator('#favorites-title')).toBeFocused();
        expect((await storedFavorites(page)).items).toEqual([]);
    });

    test('Ecobici guardada muestra bicis disponibles y abre su estación', async ({ page }) => {
        await page.addInitScript(key => {
            localStorage.setItem(key, JSON.stringify({ v: 1, items: [
                { kind: 'station', type: 'bike', id: '2', label: '002 - Retiro I', color: '#10b981', lat: -34.5924, lon: -58.3747 }
            ] }));
        }, FAVORITES_KEY);
        await bootApp(page);
        await openPanel(page);
        await expect(favoriteItems(page).first().locator('.favorite-info')).toHaveText('Tocá para ver bicis disponibles');
        await favoriteItems(page).first().locator('[data-fav-open]').click();
        await expect(page.locator('#t-bike')).toHaveAttribute('aria-pressed', 'true');
        await expect(page.locator('.leaflet-popup-content')).toContainText('002 - Retiro I');
        await openPanel(page);
        await expect(favoriteItems(page).first().locator('.favorite-info')).toHaveText('6 bicis · 34 lugares');
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
        await expect(favoriteItems(page)).toHaveCount(30);
        const first = favoriteItems(page).first();
        await expect(first.locator('.favorite-title')).toHaveText('<img src=x onerror="window.__xss=1">');
        expect(await page.locator('#favorites-list img, #favorites-list script').count()).toBe(0);
        const badgeStyle = await first.locator('.line-badge').getAttribute('style');
        expect(badgeStyle).not.toContain('evil');
        await page.waitForTimeout(200);
        expect(await page.evaluate(() => typeof window.__xss)).toBe('undefined');
        expect(errors).toEqual([]);

        // Con 30 guardados no se suma otro.
        await page.locator('#search').click();
        await page.locator('#search').pressSequentially('60', { delay: 40 });
        await page.locator('#search-results [role="option"]').first().locator('.fav-star').click();
        await expect(page.locator('#toast-region')).toContainText('Podés guardar hasta 30 favoritos');
        await expect(favoriteItems(page)).toHaveCount(30);
    });
});
