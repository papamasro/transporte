import { test, expect } from '@playwright/test';
import { bootApp, openPanel, trackPageErrors, MAIN_BUS_CHIPS } from './helpers.mjs';

const search = page => page.locator('#search');
const listbox = page => page.locator('#search-results');
const options = page => listbox(page).getByRole('option');
const routeLayerCount = page => page.evaluate(() => layers.busRoute.getLayers().length);

// Enfoca el campo y espera a que terminen de cargar las fuentes de sugerencias (se piden una vez al enfocar).
async function focusSearch(page) {
    await openPanel(page);
    await search(page).click();
    await page.waitForFunction(() => !!globalThis.cache.subteStatic?.lines && !!globalThis.cache.trainStatic?.lines);
}

test.describe('búsqueda con sugerencias', () => {
    test('combobox accesible: grupos, flechas, Enter confirma y Escape cierra/borra', async ({ page }) => {
        const errors = trackPageErrors(page);
        await bootApp(page);
        await focusSearch(page);
        const input = search(page);
        await expect(input).toHaveAttribute('role', 'combobox');
        await expect(input).toHaveAttribute('aria-controls', 'search-results');
        await expect(input).toHaveAttribute('aria-expanded', 'false');

        await input.pressSequentially('60', { delay: 40 });
        await expect(listbox(page)).toBeVisible();
        await expect(input).toHaveAttribute('aria-expanded', 'true');
        const busGroup = listbox(page).getByRole('group', { name: 'Colectivos' });
        await expect(busGroup.getByRole('option')).toHaveText([/^\s*60\s/, /^\s*60A\s/]);
        await expect(listbox(page)).not.toContainText('160');
        await expect(listbox(page)).not.toContainText('601');
        await expect(page.locator('#search-live')).toHaveText(/\d+ sugerencias?/);

        await input.press('ArrowDown');
        const first = options(page).first();
        await expect(first).toHaveAttribute('aria-selected', 'true');
        await expect(input).toHaveAttribute('aria-activedescendant', await first.getAttribute('id'));
        await input.press('ArrowDown');
        await expect(options(page).nth(1)).toHaveAttribute('aria-selected', 'true');
        await input.press('ArrowUp');
        await expect(first).toHaveAttribute('aria-selected', 'true');

        await input.press('Escape');
        await expect(listbox(page)).toBeHidden();
        await expect(input).toHaveAttribute('aria-expanded', 'false');
        await expect(input).toHaveValue('60');
        await input.press('Escape');
        await expect(input).toHaveValue('');

        await input.pressSequentially('60', { delay: 40 });
        await input.press('ArrowDown');
        await input.press('Enter');
        await expect(listbox(page)).toBeHidden();
        await expect(input).toHaveValue('60');
        await expect.poll(() => routeLayerCount(page)).toBeGreaterThan(0);
        await expect.poll(async () => new Set(await page.locator(MAIN_BUS_CHIPS).allTextContents())).toEqual(new Set(['60', '60A']));
        expect(errors).toEqual([]);
    });

    test('escribir no hace pedidos de red; las fuentes se piden una vez al enfocar', async ({ page }) => {
        const mock = await bootApp(page);
        await focusSearch(page);
        await page.waitForTimeout(300);
        mock.reset();
        await search(page).pressSequentially('plaza de', { delay: 50 });
        await expect(options(page).first()).toBeVisible();
        await search(page).fill('');
        await search(page).pressSequentially('retiro', { delay: 50 });
        await expect(options(page).first()).toBeVisible();
        await page.waitForTimeout(400);
        expect(mock.requests.filter(item => !item.tile)).toEqual([]);
    });

    test('estación: grupos de subte, trenes y Ecobici sin acentos; elegirla activa la capa y abre el popup', async ({ page }) => {
        await bootApp(page);
        await focusSearch(page);
        await search(page).pressSequentially('retiro', { delay: 40 });
        await expect(listbox(page).getByRole('group', { name: 'Trenes' }).getByRole('option')).toContainText(['Retiro']);
        await expect(listbox(page).getByRole('group', { name: 'Ecobici' }).getByRole('option')).toContainText(['002 - Retiro I']);

        await search(page).fill('');
        await search(page).pressSequentially('peru', { delay: 40 });
        const option = listbox(page).getByRole('group', { name: 'Subte' }).getByRole('option', { name: /Perú/ });
        await expect(option).toBeVisible();
        await option.click();

        await expect(page.locator('#t-subte')).toHaveAttribute('aria-pressed', 'true');
        await expect(page.locator('.leaflet-popup-content')).toContainText('Perú');
        await expect(search(page)).toHaveValue('');
        expect(await page.evaluate(() => map.getZoom())).toBeGreaterThanOrEqual(16);
    });

    test('línea de subte: filtra la capa y centra el recorrido', async ({ page }) => {
        await bootApp(page);
        await focusSearch(page);
        await search(page).pressSequentially('linea b', { delay: 40 });
        await listbox(page).getByRole('option', { name: /Línea B/ }).click();
        await expect(page.locator('#t-subte')).toHaveAttribute('aria-pressed', 'true');
        await expect(search(page)).toHaveValue('Línea B');
        await expect.poll(() => page.evaluate(() => [...markerStores.subteStations.keys()].filter(key => layers.subteStations.hasLayer(markerStores.subteStations.get(key))).every(key => key.startsWith('LineaB:')))).toBe(true);
        expect(await routeLayerCount(page)).toBe(0);
    });

    test('botón borrar y sin sugerencias', async ({ page }) => {
        await bootApp(page);
        await focusSearch(page);
        const clear = page.locator('#search-clear');
        await expect(clear).toBeHidden();
        await search(page).pressSequentially('zzzz', { delay: 30 });
        await expect(listbox(page)).toContainText('Sin sugerencias');
        await expect(options(page)).toHaveCount(0);
        await expect(clear).toBeVisible();
        await clear.click();
        await expect(search(page)).toHaveValue('');
        await expect(search(page)).toBeFocused();
        await expect(clear).toBeHidden();
        await expect(listbox(page)).toBeHidden();
    });

    test('mobile: la hoja se expande al escribir y se contrae al elegir', async ({ page, isMobile }) => {
        test.skip(!isMobile, 'Hoja inferior: solo mobile');
        await bootApp(page);
        await focusSearch(page);
        await expect(page.locator('#app-sheet')).toHaveAttribute('data-sheet-state', 'full');
        await search(page).pressSequentially('60', { delay: 40 });
        await options(page).first().tap();
        await expect(page.locator('#app-sheet')).toHaveAttribute('data-sheet-state', 'peek');
        await expect(search(page)).toHaveValue('60');
    });
});
