import { test, expect } from '@playwright/test';
import { bootApp, openPanel, trackPageErrors } from './helpers.mjs';

const sheetState = page => page.locator('#app-sheet').getAttribute('data-sheet-state');
const rectOf = (page, selector) => page.locator(selector).first().evaluate(el => {
    const rect = el.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, width: rect.width, height: rect.height };
});
// La hoja se mueve con una transición de transform: se espera a que quede quieta.
const sheetTop = page => page.evaluate(() => new Promise(resolve => {
    const sheet = document.getElementById('app-sheet');
    let last = Number.NaN;
    const check = () => {
        const top = sheet.getBoundingClientRect().top;
        if (Math.abs(top - last) < 0.5) resolve(top);
        else { last = top; setTimeout(check, 80); }
    };
    check();
}));

test.describe('hoja inferior (mobile)', () => {
    test.beforeEach(({}, testInfo) => {
        test.skip(testInfo.project.name !== 'mobile', 'solo en mobile');
    });

    test('asa: aria-expanded, estados y contenido inert al contraer', async ({ page }) => {
        const errors = trackPageErrors(page);
        await bootApp(page);
        const handle = page.locator('#panel-toggle');
        await expect(handle).toHaveAttribute('aria-expanded', 'false');
        await expect(handle).toHaveAttribute('aria-controls', 'panel-content');
        expect(await sheetState(page)).toBe('peek');
        await expect(page.locator('#panel-content')).toHaveAttribute('inert', '');
        // Contraída se ven igual los tipos de transporte.
        await expect(page.locator('#t-bus')).toBeInViewport();

        await handle.click();
        await expect(handle).toHaveAttribute('aria-expanded', 'true');
        expect(await sheetState(page)).toBe('half');
        await expect(page.locator('#panel-content')).not.toHaveAttribute('inert', '');
        await expect(page.locator('#search')).toBeInViewport();

        await handle.focus();
        await page.keyboard.press('ArrowUp');
        expect(await sheetState(page)).toBe('full');
        await page.keyboard.press('ArrowDown');
        expect(await sheetState(page)).toBe('half');
        await page.keyboard.press('Home');
        expect(await sheetState(page)).toBe('full');
        await page.keyboard.press('End');
        expect(await sheetState(page)).toBe('peek');
        await expect(handle).toHaveAttribute('aria-expanded', 'false');
        await expect(page.locator('#panel-content')).toHaveAttribute('inert', '');
        expect(errors).toEqual([]);
    });

    test('arrastrar el asa cambia de estado y un toque no queda como arrastre', async ({ page }) => {
        await bootApp(page);
        const handle = await rectOf(page, '#panel-toggle');
        const x = handle.left + handle.width / 2;
        const y = handle.top + handle.height / 2;
        await page.mouse.move(x, y);
        await page.mouse.down();
        for (let step = 1; step <= 10; step += 1) await page.mouse.move(x, y - step * 60);
        await page.mouse.up();
        await expect.poll(() => sheetState(page)).not.toBe('peek');
        await expect(page.locator('#panel-toggle')).toHaveAttribute('aria-expanded', 'true');

        const expanded = await rectOf(page, '#panel-toggle');
        await page.mouse.move(x, expanded.top + expanded.height / 2);
        await page.mouse.down();
        for (let step = 1; step <= 10; step += 1) await page.mouse.move(x, expanded.top + step * 80);
        await page.mouse.up();
        await expect.poll(() => sheetState(page)).toBe('peek');
    });

    test('arrastre táctil hacia arriba abre la hoja completa', async ({ page }) => {
        await bootApp(page);
        const handle = await rectOf(page, '#panel-toggle');
        const x = handle.left + handle.width / 2;
        const y = handle.top + handle.height / 2;
        const cdp = await page.context().newCDPSession(page);
        const touch = (type, pointY) => cdp.send('Input.dispatchTouchEvent', {
            type,
            touchPoints: type === 'touchEnd' ? [] : [{ x, y: pointY, id: 1 }]
        });
        await touch('touchStart', y);
        for (let step = 1; step <= 12; step += 1) await touch('touchMove', y - step * 55);
        await touch('touchEnd', y - 660);
        await expect.poll(() => sheetState(page)).toBe('full');
        await expect(page.locator('#panel-content')).not.toHaveAttribute('inert', '');
    });

    test('zoom, atribución y botón de ubicación quedan sobre la hoja', async ({ page }) => {
        await bootApp(page);
        for (const state of ['peek', 'half']) {
            await page.evaluate(value => setSheetState(value), state);
            const top = await sheetTop(page);
            for (const selector of ['.leaflet-control-zoom', '.leaflet-control-attribution', '#map-locate-fab']) {
                const rect = await rectOf(page, selector);
                expect(rect.bottom, `${selector} en ${state}`).toBeLessThanOrEqual(top + 1);
                expect(rect.height).toBeGreaterThan(0);
            }
        }
        // Botones de zoom táctiles: al menos 44 px.
        const zoomIn = await rectOf(page, '.leaflet-control-zoom-in');
        expect(zoomIn.height).toBeGreaterThanOrEqual(44);
    });

    test('cercanos y alertas se abren dentro de la hoja con botón Volver', async ({ page }) => {
        await bootApp(page);
        await openPanel(page);
        await page.locator('#action-alerts').click();
        await expect(page.locator('#alerts-panel')).toHaveClass(/is-open/);
        await expect(page.locator('#alerts-back')).toBeFocused();
        await expect(page.locator('#alerts-back')).toBeInViewport();
        expect(await page.locator('#app-sheet').getAttribute('data-view')).toBe('alerts');
        await page.keyboard.press('Enter');
        await expect(page.locator('#alerts-panel')).not.toHaveClass(/is-open/);
        await expect(page.locator('#action-alerts')).toBeFocused();
        expect(await page.locator('#app-sheet').getAttribute('data-view')).toBe('main');
    });
});

test.describe('barra lateral (desktop)', () => {
    test.beforeEach(({}, testInfo) => {
        test.skip(testInfo.project.name !== 'desktop', 'solo en desktop');
    });

    test('panel fijo a la izquierda y el mapa ocupa el resto', async ({ page }) => {
        await bootApp(page);
        const sheet = await rectOf(page, '#app-sheet');
        const mapRect = await rectOf(page, '#map');
        const viewport = page.viewportSize();
        expect(sheet.left).toBe(0);
        expect(sheet.width).toBeGreaterThanOrEqual(360);
        expect(sheet.width).toBeLessThanOrEqual(400);
        expect(sheet.height).toBe(viewport.height);
        expect(Math.abs(mapRect.left - sheet.right)).toBeLessThanOrEqual(1);
        expect(Math.abs(mapRect.right - viewport.width)).toBeLessThanOrEqual(1);
        // Leaflet conoce el tamaño real del contenedor.
        const size = await page.evaluate(() => map.getSize());
        expect(Math.abs(size.x - mapRect.width)).toBeLessThanOrEqual(1);
        await expect(page.locator('#panel-toggle')).toBeHidden();
        await expect(page.locator('#panel-content')).not.toHaveAttribute('inert', '');
        await expect(page.locator('#search')).toBeVisible();
        await expect(page.locator('#action-nearby')).toBeVisible();
    });

    test('al pasar a mobile el mapa toma todo el ancho y vuelve la hoja', async ({ page }) => {
        await bootApp(page);
        await page.setViewportSize({ width: 600, height: 800 });
        await expect.poll(() => page.evaluate(() => map.getSize().x)).toBe(600);
        await expect(page.locator('#panel-toggle')).toBeVisible();
        expect(await sheetState(page)).toBe('peek');
        await page.setViewportSize({ width: 1440, height: 900 });
        await expect.poll(() => page.evaluate(() => map.getSize().x)).toBeLessThan(1100);
        await expect(page.locator('#panel-toggle')).toBeHidden();
    });
});

test.describe('menú "Más opciones"', () => {
    test('accesible con teclado: flechas, Escape y foco de vuelta', async ({ page }) => {
        await bootApp(page);
        await openPanel(page);
        const button = page.locator('#app-menu-btn');
        const menu = page.locator('#app-menu');
        await expect(button).toHaveAttribute('aria-haspopup', 'menu');
        await expect(button).toHaveAttribute('aria-expanded', 'false');
        await expect(menu).toBeHidden();

        await button.click();
        await expect(button).toHaveAttribute('aria-expanded', 'true');
        await expect(menu).toBeVisible();
        await expect(page.locator('#action-refresh')).toBeFocused();
        await expect(menu.getByRole('menuitem', { name: /Actualizar/ })).toBeVisible();
        await expect(menu.getByRole('menuitem', { name: /Privacidad/ })).toBeVisible();
        // El menú entra completo en pantalla.
        const rect = await rectOf(page, '#app-menu');
        const viewport = page.viewportSize();
        expect(rect.top).toBeGreaterThanOrEqual(0);
        expect(rect.bottom).toBeLessThanOrEqual(viewport.height);

        await page.keyboard.press('End');
        await expect(page.locator('#consent-settings-btn')).toBeFocused();
        await page.keyboard.press('ArrowDown');
        await expect(page.locator('#action-refresh')).toBeFocused();
        await page.keyboard.press('Escape');
        await expect(menu).toBeHidden();
        await expect(button).toHaveAttribute('aria-expanded', 'false');
        await expect(button).toBeFocused();

        await page.keyboard.press('ArrowDown');
        await expect(menu).toBeVisible();
        await page.mouse.click(page.viewportSize().width - 20, 20);
        await expect(menu).toBeHidden();
    });

    test('Actualizar pide datos y Privacidad abre el banner', async ({ page }) => {
        const mock = await bootApp(page);
        await openPanel(page);
        const busRequests = () => mock.count(item => item.pathname.startsWith('/colectivos/vehiclePositions'));
        const before = busRequests();
        await page.locator('#app-menu-btn').click();
        await page.locator('#action-refresh').click();
        await expect.poll(busRequests).toBeGreaterThan(before);
        await expect(page.locator('#app-menu')).toBeHidden();

        await page.locator('#app-menu-btn').click();
        await page.locator('#consent-settings-btn').click();
        await expect(page.locator('#consent-banner')).toBeVisible();
    });
});

test.describe('línea de estado', () => {
    test('cantidad en vista y antigüedad del dato; aria-live solo en el estado', async ({ page }) => {
        await bootApp(page);
        await expect(page.locator('#unit-count')).toHaveText(/^\d[\d.]* en vista$/);
        await expect(page.locator('#last-update')).toHaveText(/recién|hace \d+ s/);
        await expect(page.locator('#status-text')).toHaveAttribute('aria-live', /polite|assertive/);
        expect(await page.locator('#map-status').getAttribute('aria-live')).toBeNull();
        expect(await page.locator('#unit-count').getAttribute('aria-live')).toBeNull();

        // El texto relativo avanza solo (tick cada 5 s) sin esperar al próximo refresh.
        await page.evaluate(() => {
            setMapStatusUpdated(Date.now() - 57_000);
            // Que un refresh del polling no lo vuelva a "recién" durante la espera.
            globalThis.setMapStatusUpdated = () => {};
        });
        await expect(page.locator('#last-update')).toHaveText(/hace 5\d s/);
        await expect(page.locator('#last-update')).toHaveText('hace 1 min', { timeout: 8000 });
    });
});
