import { test, expect } from '@playwright/test';
import { bootApp, trackPageErrors, dismissLocationPrompt, CONSENT_KEY, MAIN_BUS_CHIPS } from './helpers.mjs';

test('arranca sin errores de consola, con colectivos y estado en vivo', async ({ page }) => {
    const errors = trackPageErrors(page);
    const mock = await bootApp(page);

    await expect(page.locator('#status-dot')).toHaveAttribute('data-status', 'LIVE');
    await expect(page.locator('#status-text')).toHaveText('EN VIVO');
    await expect(page.locator('#unit-count')).toHaveText(/^\d[\d.]* en vista$/);
    await expect(page.locator('#last-update')).toHaveText(/recién|hace \d+ s/);
    expect(await page.locator(MAIN_BUS_CHIPS).count()).toBeGreaterThan(50);
    // Primera carga: la ruta KV (trae el snapshot previo para animar); nada más de colectivos.
    expect(mock.count('/colectivos/vehiclePositionsKV')).toBe(1);
    expect(mock.count('/colectivos/vehiclePositionsSimple')).toBe(0);
    // Fuente autoalojada: nada de Google Fonts.
    const fontFaces = await page.evaluate(() => Array.from(document.fonts).map(font => font.family));
    expect(fontFaces.some(family => family.includes('Outfit'))).toBe(true);
    expect(errors).toEqual([]);
});

test('no pide fuentes ni scripts a terceros salvo tiles', async ({ page }) => {
    const external = [];
    page.on('request', request => {
        const url = new URL(request.url());
        if (url.hostname !== '127.0.0.1') external.push(url.hostname);
    });
    await bootApp(page);
    const unexpected = external.filter(host => !['transporte-be.papamasro.workers.dev', 'server.arcgisonline.com', 'services.arcgisonline.com'].includes(host));
    expect(unexpected).toEqual([]);
});

test.describe('consentimiento de estadísticas', () => {
    test('aceptar carga GA y no vuelve a mostrar el banner', async ({ page }) => {
        const mock = await bootApp(page, { consent: null, dismissLocation: false, waitForBuses: false });
        const banner = page.locator('#consent-banner');
        await expect(banner).toBeVisible();
        expect(mock.count('/gtag')).toBe(0);

        await dismissLocationPrompt(page);
        await page.locator('#consent-accept').click();
        await expect(banner).toBeHidden();
        await expect.poll(() => mock.count('/gtag')).toBe(1);
        const stored = await page.evaluate(key => JSON.parse(localStorage.getItem(key)).value, CONSENT_KEY);
        expect(stored).toBe('granted');

        await page.reload();
        await expect(page.locator('#consent-banner')).toBeHidden();
    });

    test('rechazar no carga GA', async ({ page }) => {
        const mock = await bootApp(page, { consent: null, dismissLocation: false, waitForBuses: false });
        await dismissLocationPrompt(page);
        await page.locator('#consent-reject').click();
        await expect(page.locator('#consent-banner')).toBeHidden();
        await page.waitForTimeout(300);
        expect(mock.count('/gtag')).toBe(0);
        const stored = await page.evaluate(key => JSON.parse(localStorage.getItem(key)).value, CONSENT_KEY);
        expect(stored).toBe('denied');
    });
});

test.describe('modal de ubicación', () => {
    test('"Omitir por ahora" cierra el modal y deja el mapa usable', async ({ page }) => {
        await bootApp(page, { dismissLocation: false, waitForBuses: false });
        const overlay = page.locator('#location-prompt-overlay');
        await expect(overlay).not.toHaveClass(/hidden/);
        await page.locator('#location-prompt-dismiss').click();
        await expect(overlay).toHaveClass(/hidden/);
        await expect(page.locator(MAIN_BUS_CHIPS).first()).toBeVisible();
    });

    test('atrapa el foco con Tab y Escape lo cierra', async ({ page, isMobile }) => {
        test.skip(isMobile, 'Navegación por teclado: solo desktop');
        await bootApp(page, { dismissLocation: false, waitForBuses: false });
        await expect(page.locator('#location-prompt-overlay')).not.toHaveClass(/hidden/);

        const insideModal = () => page.evaluate(() => document.getElementById('location-prompt-modal').contains(document.activeElement));
        for (let index = 0; index < 6; index += 1) {
            await page.keyboard.press('Tab');
            expect(await insideModal()).toBe(true);
        }
        for (let index = 0; index < 3; index += 1) {
            await page.keyboard.press('Shift+Tab');
            expect(await insideModal()).toBe(true);
        }
        await page.keyboard.press('Escape');
        await expect(page.locator('#location-prompt-overlay')).toHaveClass(/hidden/);
    });
});
