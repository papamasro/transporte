import { test, expect } from '@playwright/test';
import { bootApp, trackPageErrors, BUS_CLUSTERS, MAIN_BUS_CHIPS } from './helpers.mjs';

const darkTileRequests = mock => mock.count(item => item.tile && item.pathname.includes('World_Dark_Gray'));
const themeRadio = (page, name) => page.locator('#app-menu').getByRole('menuitemradio', { name });

test.describe('tema del mapa', () => {
    test('Automático con sistema claro usa el mapa claro; Oscuro cambia las teselas y se recuerda', async ({ page }) => {
        const errors = trackPageErrors(page);
        const mock = await bootApp(page);
        await expect(page.locator('html')).toHaveAttribute('data-map-theme', 'light');
        expect(darkTileRequests(mock)).toBe(0);

        await page.locator('#app-menu-btn').click();
        await expect(page.locator('#app-menu').getByRole('group', { name: 'Mapa' })).toBeVisible();
        await expect(themeRadio(page, 'Automático')).toHaveAttribute('aria-checked', 'true');
        await themeRadio(page, 'Oscuro').click();
        await expect(page.locator('#app-menu')).toBeHidden();
        await expect(page.locator('html')).toHaveAttribute('data-map-theme', 'dark');
        await expect.poll(() => mock.count(item => item.tile && item.pathname.includes('World_Dark_Gray_Base'))).toBeGreaterThan(0);
        await expect.poll(() => mock.count(item => item.tile && item.pathname.includes('World_Dark_Gray_Reference'))).toBeGreaterThan(0);
        await expect(page.locator('.leaflet-tile-pane img[src*="server.arcgisonline.com"]')).toHaveCount(0);
        await expect(page.locator('.leaflet-control-attribution')).toContainText('Esri, HERE, Garmin');
        // Marcadores y burbujas siguen ahí sobre el fondo oscuro.
        await expect(page.locator(MAIN_BUS_CHIPS).first()).toBeVisible();
        await page.evaluate(() => map.setZoom(13, { animate: false }));
        await expect(page.locator(BUS_CLUSTERS).first()).toBeVisible();
        // A más de z16 las teselas oscuras se escalan (no hay datos más cerca en AMBA).
        await page.evaluate(() => map.setZoom(18, { animate: false }));
        await page.waitForTimeout(300);
        const requestedZooms = mock.requests.filter(item => item.tile).map(item => Number(item.pathname.match(/tile\/(\d+)\//)?.[1]));
        expect(Math.max(...requestedZooms)).toBeLessThanOrEqual(16);

        await page.goto('./');
        await page.locator('#location-prompt-dismiss').click();
        await expect(page.locator('html')).toHaveAttribute('data-map-theme', 'dark');
        await page.locator('#app-menu-btn').click();
        await expect(themeRadio(page, 'Oscuro')).toHaveAttribute('aria-checked', 'true');
        await expect(themeRadio(page, 'Automático')).toHaveAttribute('aria-checked', 'false');
        await themeRadio(page, 'Claro').click();
        await expect(page.locator('html')).toHaveAttribute('data-map-theme', 'light');
        await expect(page.locator('.leaflet-tile-pane img[src*="services.arcgisonline.com"]')).toHaveCount(0);
        expect(errors).toEqual([]);
    });

    test('Automático sigue prefers-color-scheme: dark', async ({ page }) => {
        await page.emulateMedia({ colorScheme: 'dark' });
        const mock = await bootApp(page);
        await expect(page.locator('html')).toHaveAttribute('data-map-theme', 'dark');
        await expect.poll(() => darkTileRequests(mock)).toBeGreaterThan(0);
        await page.emulateMedia({ colorScheme: 'light' });
        await expect(page.locator('html')).toHaveAttribute('data-map-theme', 'light');
    });

    test('las opciones del mapa se recorren con flechas en el menú', async ({ page, isMobile }) => {
        test.skip(isMobile, 'Navegación por teclado: solo desktop');
        await bootApp(page);
        await page.locator('#app-menu-btn').focus();
        await page.keyboard.press('Enter');
        await page.keyboard.press('Home');
        let found = false;
        for (let index = 0; index < 8 && !found; index += 1) {
            await page.keyboard.press('ArrowDown');
            found = await themeRadio(page, 'Oscuro').evaluate(el => el === document.activeElement);
        }
        expect(found).toBe(true);
        await page.keyboard.press('Enter');
        await expect(page.locator('html')).toHaveAttribute('data-map-theme', 'dark');
        await expect(page.locator('#app-menu-btn')).toBeFocused();
    });
});
