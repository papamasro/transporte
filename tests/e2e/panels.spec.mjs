import { test, expect } from '@playwright/test';
import { bootApp, confirmLocationIfPrompted, openPanel, trackPageErrors, MAIN_BUS_CHIPS } from './helpers.mjs';
import { CENTER } from '../fixtures/data.mjs';

const pressedTypes = page => page.evaluate(() => ['bus', 'subte', 'train', 'bike']
    .filter(type => document.getElementById(`t-${type}`).getAttribute('aria-pressed') === 'true'));

test.describe('cercanos', () => {
    test.use({ geolocation: { latitude: CENTER.lat, longitude: CENTER.lon }, permissions: ['geolocation'] });

    test('abrir y cerrar restaura los filtros anteriores', async ({ page }) => {
        const errors = trackPageErrors(page);
        await bootApp(page, { dismissLocation: false });
        await confirmLocationIfPrompted(page);
        // Confirmar la ubicación puede abrir cercanos (reemplaza a la vista principal): se vuelve.
        if (await page.locator('#nearby-panel').evaluate(el => el.classList.contains('is-open'))) {
            await page.locator('#nearby-back').click();
        }
        await openPanel(page);
        await page.locator('#t-subte').click();
        await expect.poll(() => pressedTypes(page)).toEqual(['subte']);

        await page.locator('#action-nearby').click();
        const panel = page.locator('#nearby-panel');
        await expect(panel).toHaveClass(/is-open/);
        await expect(panel).not.toHaveAttribute('inert', '');
        await expect(page.locator('#nearby-container')).toContainText(/60|Plaza|Línea|Estación/i, { timeout: 15_000 });
        expect(await pressedTypes(page)).toEqual([]);
        await expect(page.locator('#nearby-status, #status-text').first()).not.toHaveText('ERROR');
        // La línea de estado cuenta lo cercano (no las unidades "en vista").
        await expect(page.locator('#unit-count')).toHaveText(/^\d[\d.]* cerca$/);
        // Cada resultado tiene su estrella de favorito.
        const star = page.locator('#nearby-container .fav-star').first();
        await expect(star).toHaveAttribute('aria-pressed', 'false');
        await star.click();
        await expect(star).toHaveAttribute('aria-pressed', 'true');
        await expect(page.locator('#toast-region')).toContainText('en favoritos');

        // Una sola superficie: la vista principal queda oculta e inert mientras cercanos está abierto.
        await expect(page.locator('#view-main')).toHaveAttribute('inert', '');
        await expect(page.locator('#view-main')).toBeHidden();

        await page.locator('#nearby-back').click();
        await expect(panel).not.toHaveClass(/is-open/);
        await expect(panel).toHaveAttribute('inert', '');
        await expect(page.locator('#view-main')).toBeVisible();
        await expect(page.locator('#action-nearby')).toBeFocused();
        await expect(page.locator('#unit-count')).toHaveText(/en vista$/);
        await expect(page.locator('#favorites-list .favorite-item')).toHaveCount(1);
        await expect.poll(() => pressedTypes(page)).toEqual(['subte']);
        await expect(page.locator('.leaflet-marker-icon', { hasText: '🚇' }).first()).toBeVisible();
        await expect(page.locator('.nearby-live-bus-icon')).toHaveCount(0);
        expect(errors).toEqual([]);
    });

    test('radio, orden y secciones: cambiar radio busca solo, ordenar no vuelve a pedir', async ({ page }) => {
        const errors = trackPageErrors(page);
        await bootApp(page, { dismissLocation: false });
        await confirmLocationIfPrompted(page);
        await openPanel(page);
        if (!(await page.locator('#nearby-panel').evaluate(el => el.classList.contains('is-open')))) {
            await page.locator('#action-nearby').click();
        }
        const container = page.locator('#nearby-container');
        await expect(container.locator('.nearby-section').first()).toBeVisible({ timeout: 15_000 });

        const radius = page.locator('#nearby-radius-group');
        await expect(radius.getByRole('radio')).toHaveText(['500 m', '1 km', '2 km']);
        await expect(radius.getByRole('radio', { name: '1 km' })).toHaveAttribute('aria-checked', 'true');
        await page.evaluate(() => {
            globalThis.__nearbyRefreshes = [];
            const original = globalThis.refreshNearbyTransport;
            globalThis.refreshNearbyTransport = options => {
                globalThis.__nearbyRefreshes.push(options || {});
                return original(options);
            };
        });
        const refreshes = () => page.evaluate(() => globalThis.__nearbyRefreshes.length);

        await radius.getByRole('radio', { name: '2 km' }).click();
        await expect(radius.getByRole('radio', { name: '2 km' })).toHaveAttribute('aria-checked', 'true');
        await expect(radius.getByRole('radio', { name: '1 km' })).toHaveAttribute('aria-checked', 'false');
        await expect.poll(refreshes).toBe(1);
        // Flechas del radiogroup: mueven la selección y vuelven a buscar.
        await page.keyboard.press('ArrowLeft');
        await expect(radius.getByRole('radio', { name: '1 km' })).toHaveAttribute('aria-checked', 'true');
        await expect(radius.getByRole('radio', { name: '1 km' })).toBeFocused();
        await expect.poll(refreshes).toBe(2);
        await expect(container.locator('.nearby-section').first()).toBeVisible({ timeout: 15_000 });

        const sort = page.locator('#nearby-sort-group');
        await expect(sort.getByRole('radio', { name: 'Distancia' })).toHaveAttribute('aria-checked', 'true');
        await sort.getByRole('radio', { name: 'Llegada' }).click();
        await expect(sort.getByRole('radio', { name: 'Llegada' })).toHaveAttribute('aria-checked', 'true');
        await page.waitForTimeout(300);
        expect(await refreshes()).toBe(2);
        await expect(container.locator('.nearby-section').first()).toBeVisible();

        // Secciones plegables con su cantidad; el estado se mantiene al re-renderizar.
        const section = container.locator('.nearby-section').first();
        const key = await section.getAttribute('data-section');
        await expect(section.locator('.nearby-section-count')).toHaveText(/^\d+/);
        const wasOpen = await section.evaluate(el => el.open);
        await section.locator('summary').click();
        await expect.poll(() => section.evaluate(el => el.open)).toBe(!wasOpen);
        await sort.getByRole('radio', { name: 'Distancia' }).click();
        await expect.poll(() => container.locator(`.nearby-section[data-section="${key}"]`).evaluate(el => el.open)).toBe(!wasOpen);
        expect(errors).toEqual([]);
    });

    test('"Buscar en esta zona" usa el centro del mapa sin moverlo', async ({ page }) => {
        await bootApp(page, { dismissLocation: false });
        await confirmLocationIfPrompted(page);
        // Confirmar la ubicación ya abre cercanos; si no, se abre desde el botón.
        await openPanel(page);
        if (!(await page.locator('#nearby-panel').evaluate(el => el.classList.contains('is-open')))) {
            await page.locator('#action-nearby').click();
        }
        await expect(page.locator('#nearby-panel')).toHaveClass(/is-open/);
        await expect(page.locator('#nearby-container')).not.toBeEmpty({ timeout: 15_000 });

        const target = { lat: CENTER.lat + 0.006, lng: CENTER.lon - 0.006 };
        await page.evaluate(point => map.setView([point.lat, point.lng], map.getZoom(), { animate: false }), target);
        await page.waitForTimeout(300);
        const centerBefore = await page.evaluate(() => map.getCenter());
        // En mobile la hoja tapa la parte de abajo: se usa el centro de la parte visible del mapa.
        const visibleCenter = await page.evaluate(() => getVisibleViewCenter());

        await page.locator('#nearby-area-btn').click();
        await expect.poll(() => page.evaluate(() => globalThis.nearbyState.areaCenter)).not.toBeNull();
        const area = await page.evaluate(() => globalThis.nearbyState.areaCenter);
        expect(area.lat).toBeCloseTo(visibleCenter.lat, 4);
        expect(area.lon ?? area.lng).toBeCloseTo(visibleCenter.lng, 4);
        await page.waitForTimeout(500);
        const centerAfter = await page.evaluate(() => map.getCenter());
        expect(centerAfter.lat).toBeCloseTo(centerBefore.lat, 6);
        expect(centerAfter.lng).toBeCloseTo(centerBefore.lng, 6);
        await expect(page.locator('#nearby-container')).not.toBeEmpty();

        await page.locator('#nearby-back').click();
        await expect.poll(() => pressedTypes(page)).toEqual(['bus']);
        await expect(page.locator(MAIN_BUS_CHIPS).first()).toBeVisible();
    });
});

test.describe('alertas', () => {
    test('muestra las alertas de subte y colectivos', async ({ page }) => {
        const mock = await bootApp(page);
        await openPanel(page);
        await page.locator('#action-alerts').click();
        const panel = page.locator('#alerts-panel');
        await expect(panel).toHaveClass(/is-open/);
        const container = page.locator('#alerts-container');
        await expect(container).toContainText('Medrano');
        await expect(container).toContainText('desviada');
        expect(mock.count('/subtes/serviceAlertsJson')).toBe(1);
        expect(mock.count('/colectivos/serviceAlertsJson')).toBe(1);

        await expect(container.locator('.alert-card')).toHaveCount(2);
        await expect(page.locator('#view-main')).toHaveAttribute('inert', '');
        await page.locator('#alerts-back').click();
        await expect(panel).not.toHaveClass(/is-open/);
        await expect(page.locator('#action-alerts')).toBeFocused();
    });

    test('mientras carga se ven filas esqueleto', async ({ page }) => {
        await bootApp(page);
        await openPanel(page);
        await page.route(url => url.pathname.endsWith('/serviceAlertsJson'), async route => {
            await new Promise(resolve => setTimeout(resolve, 1200));
            await route.fallback();
        });
        await page.locator('#action-alerts').click();
        const container = page.locator('#alerts-container');
        await expect(container.locator('.skeleton-row').first()).toBeVisible();
        await expect(container).toHaveAttribute('aria-busy', 'true');
        await expect(container.locator('.alert-card')).toHaveCount(2, { timeout: 15_000 });
        await expect(container.locator('.skeleton-row')).toHaveCount(0);
    });

    test('si fallan ambas fuentes muestra el error', async ({ page }) => {
        await bootApp(page, { mocks: { alertsMode: 'error' } });
        await openPanel(page);
        await page.locator('#action-alerts').click();
        await expect(page.locator('#alerts-container')).toContainText('Error al cargar alertas', { timeout: 15_000 });
        // La capa principal sigue funcionando.
        await expect(page.locator(MAIN_BUS_CHIPS).first()).toBeVisible();
    });
});
