import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { bootApp, dismissLocationPrompt } from './helpers.mjs';

const swSource = readFileSync(new URL('../../sw.js', import.meta.url), 'utf8');
const CACHE_VERSION = swSource.match(/const CACHE_VERSION = '([^']+)'/)[1];
const PRECACHE_PATHS = [...swSource.match(/const PRECACHE_PATHS = \[([\s\S]*?)\];/)[1].matchAll(/'([^']+)'/g)].map(match => match[1]);

test.describe('service worker', () => {
    test.use({ serviceWorkers: 'allow' });

    test('precachea el app shell y abre sin conexión', async ({ page, context }) => {
        await bootApp(page);
        const cached = await page.evaluate(async version => {
            await navigator.serviceWorker.ready;
            const cache = await caches.open(`radar-amba-shell-${version}`);
            const keys = await cache.keys();
            return { keys: keys.map(request => new URL(request.url).pathname), names: await caches.keys() };
        }, CACHE_VERSION);
        expect(cached.names).toContain(`radar-amba-shell-${CACHE_VERSION}`);
        const expected = PRECACHE_PATHS.map(path => new URL(path, 'http://x/transporte/').pathname);
        expect(cached.keys.sort()).toEqual([...new Set(expected)].sort());

        await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
        await context.setOffline(true);
        await page.reload();
        await expect(page.locator('#app-sheet')).toBeVisible();
        await expect(page.locator('#t-bus')).toBeVisible();
        await expect(page.locator('#map.leaflet-container')).toBeVisible();
        expect(await page.evaluate(() => typeof L === 'object' && typeof busAnimGetStats === 'function')).toBe(true);
        expect(await page.evaluate(() => document.fonts.check('700 16px Outfit'))).toBe(true);

        // Un link compartido (con query) también abre desde el cache, bajo /transporte/.
        await page.goto('./?@=-34.6086,-58.3742,16&capa=subte');
        await expect(page.locator('#map.leaflet-container')).toBeVisible();
        expect(new URL(page.url()).pathname).toBe('/transporte/');
        await expect(page.locator('#t-subte')).toHaveAttribute('aria-pressed', 'true');
        expect(await page.evaluate(() => map.getZoom())).toBe(16);
        await expect(page.locator('.status-banner[data-banner="offline"]')).toContainText('Sin conexión');
        await expect(page.locator('#status-dot')).toHaveAttribute('data-status', 'OFFLINE');
        await context.setOffline(false);
    });
});

test('index.html y PRECACHE_PATHS listan los mismos assets locales', async ({ request }) => {
    const html = await (await request.get('./index.html')).text();
    const local = [...html.matchAll(/<(?:script|link)\b[^>]*(?:src|href)="(\.\/[^"]+)"/g)]
        .map(match => match[1].split('?')[0]);
    expect(local.length).toBeGreaterThan(15);
    for (const path of local) expect(PRECACHE_PATHS, path).toContain(path);
    const manifest = await (await request.get('./manifest.webmanifest')).json();
    for (const icon of manifest.icons) {
        expect(PRECACHE_PATHS, icon.src).toContain(icon.src.startsWith('./') ? icon.src : `./${icon.src}`);
        expect((await request.get(icon.src)).ok(), icon.src).toBe(true);
    }
    expect(manifest.icons.filter(icon => icon.purpose === 'maskable').map(icon => icon.sizes).sort()).toEqual(['192x192', '512x512']);
});

test('error-reporter: sin duplicados y con tope por sesión', async ({ page }) => {
    const mock = await bootApp(page, {
        config: { ERROR_REPORTING: { allowLocalhost: true, maxPerSession: 2 } },
        dismissLocation: false,
        waitForBuses: false
    });
    await dismissLocationPrompt(page);
    await page.evaluate(() => {
        const fail = message => setTimeout(() => { throw new Error(message); }, 0);
        fail('falla A en https://example.com/x?lat=-34.603712&token=secreto');
        fail('falla A en https://example.com/x?lat=-34.603712&token=secreto');
        fail('falla B');
        fail('falla C');
        Promise.reject(new Error('rechazo D'));
    });
    await expect.poll(() => mock.count('/client-errors')).toBe(2);
    await page.waitForTimeout(500);
    expect(mock.count('/client-errors')).toBe(2);

    const reports = mock.requests.filter(item => item.pathname === '/client-errors').map(item => JSON.parse(item.body));
    expect(reports.map(report => report.message)).toEqual(['Uncaught Error: falla A en https://example.com/x', 'Uncaught Error: falla B']);
    expect(JSON.stringify(reports)).not.toContain('secreto');
    expect(JSON.stringify(reports)).not.toContain('-34.603712');
    expect(reports[0].appVersion).toBe(CACHE_VERSION);

    // El tope sobrevive a recargar (sessionStorage).
    await page.reload();
    await page.evaluate(() => setTimeout(() => { throw new Error('falla E'); }, 0));
    await page.waitForTimeout(500);
    expect(mock.count('/client-errors')).toBe(2);
});
