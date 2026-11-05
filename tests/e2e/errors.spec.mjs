import { test, expect } from '@playwright/test';
import { bootApp, expectStatus, openPanel, trackPageErrors, MAIN_BUS_CHIPS } from './helpers.mjs';

const banner = (page, source) => page.locator(`#status-banners .status-banner[data-banner="${source}"]`);
const busRequests = mock => mock.count(item => item.pathname.startsWith('/colectivos/vehiclePositions'));

test.describe('avisos de error con reintento', () => {
    test('colectivos: un aviso por fuente con la antigüedad del dato; Reintentar pide solo esa fuente', async ({ page }) => {
        const errors = trackPageErrors(page);
        const mock = await bootApp(page);
        mock.options.busMode = 'error';
        await page.evaluate(() => forceRefresh());
        const busBanner = banner(page, 'bus');
        await expect(busBanner).toBeVisible({ timeout: 15_000 });
        await expect(busBanner).toContainText('No pudimos actualizar los colectivos');
        await expect(busBanner).toContainText(/Mostrando datos de hace (unos segundos|\d+ min)/);
        await expectStatus(page, 'ERROR');
        // Los colectivos que había siguen en el mapa.
        await expect(page.locator(MAIN_BUS_CHIPS).first()).toBeVisible();

        // Un segundo fallo no apila otro aviso.
        await page.evaluate(() => forceRefresh());
        await page.waitForTimeout(800);
        await expect(page.locator('#status-banners .status-banner')).toHaveCount(1);

        // Pasan 2 minutos: el texto se actualiza solo.
        await page.evaluate(() => { globalThis.cache.busFetchedAt = Date.now() - 125_000; });
        await expect(busBanner).toContainText('Mostrando datos de hace 2 min', { timeout: 7000 });

        mock.options.busMode = 'ok';
        mock.reset();
        await busBanner.getByRole('button', { name: 'Reintentar' }).click();
        await expect(busBanner).toHaveCount(0);
        await expectStatus(page, 'LIVE');
        expect(busRequests(mock)).toBe(1);
        expect(mock.count(item => item.pathname.startsWith('/subtes/') || item.pathname.startsWith('/ecobici/'))).toBe(0);
        expect(errors.filter(error => !error.includes('Failed to load resource'))).toEqual([]);
    });

    test('cerrar el aviso lo oculta mientras siga fallando', async ({ page }) => {
        const mock = await bootApp(page);
        mock.options.busMode = 'error';
        await page.evaluate(() => forceRefresh());
        await expect(banner(page, 'bus')).toBeVisible({ timeout: 15_000 });
        await banner(page, 'bus').getByRole('button', { name: 'Cerrar aviso' }).click();
        await expect(banner(page, 'bus')).toHaveCount(0);
        await expect(page.locator('#status-banners')).toBeHidden();
        await page.evaluate(() => forceRefresh());
        await page.waitForTimeout(800);
        await expect(banner(page, 'bus')).toHaveCount(0);
        // Sigue indicado en el estado.
        await expectStatus(page, 'ERROR');
    });

    test('subte: aviso propio; apagar la capa lo quita y Reintentar lo recupera', async ({ page }) => {
        const mock = await bootApp(page, { mocks: { subteMode: 'error' } });
        await openPanel(page);
        await page.locator('#t-subte').click();
        const subteBanner = banner(page, 'subte');
        await expect(subteBanner).toContainText('No pudimos actualizar el subte');
        await expect(subteBanner).toContainText('Todavía no hay datos para mostrar');
        mock.options.subteMode = 'ok';
        await subteBanner.getByRole('button', { name: 'Reintentar' }).click();
        await expect(subteBanner).toHaveCount(0);
        await expectStatus(page, 'LIVE');

        mock.options.subteMode = 'error';
        await page.evaluate(() => forceRefresh());
        await expect(subteBanner).toBeVisible({ timeout: 15_000 });
        await openPanel(page);
        await page.locator('#t-bus').click();
        await expect(subteBanner).toHaveCount(0);
    });

    test('alertas y cercanos: el error en la vista tiene Reintentar', async ({ page }) => {
        const mock = await bootApp(page, { mocks: { alertsMode: 'error' } });
        await openPanel(page);
        await page.locator('#action-alerts').click();
        const container = page.locator('#alerts-container');
        await expect(container).toContainText('Error al cargar alertas', { timeout: 15_000 });
        mock.options.alertsMode = 'ok';
        await container.getByRole('button', { name: 'Reintentar' }).click();
        await expect(container.locator('.alert-card')).toHaveCount(2);
        await expect(page.locator('#alerts-back')).toBeFocused();
    });
});

test.describe('sin conexión', () => {
    test('aviso y estado sin conexión; al volver la red se actualiza solo', async ({ page, context }) => {
        const mock = await bootApp(page);
        await context.setOffline(true);
        const offline = banner(page, 'offline');
        await expect(offline).toContainText('Sin conexión — mostrando lo último que cargamos');
        await expect(offline.getByRole('button', { name: 'Reintentar' })).toHaveCount(0);
        await expectStatus(page, 'OFFLINE');
        // Con un error pendiente igual se muestra un solo aviso (el de conexión).
        await page.evaluate(() => reportSourceError('bus'));
        await expect(page.locator('#status-banners .status-banner')).toHaveCount(1);
        await expect(page.locator(MAIN_BUS_CHIPS).first()).toBeVisible();

        const before = busRequests(mock);
        await context.setOffline(false);
        await expect(offline).toHaveCount(0);
        await expect(page.locator('#toast-region')).toContainText('Conexión recuperada');
        await expect.poll(() => busRequests(mock)).toBeGreaterThan(before);
        await expectStatus(page, 'LIVE');
        await expect(page.locator('#status-banners .status-banner')).toHaveCount(0);
    });
});
