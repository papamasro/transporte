import { expect } from '@playwright/test';
import { installBackendMocks } from '../fixtures/mock-backend.mjs';

export const CONSENT_KEY = 'radaramba.analytics-consent-v1';
export const MAIN_BUS_CHIPS = '.leaflet-marker-icon:not(.nearby-live-bus-icon) .bus-chip';
export const BUS_CLUSTERS = '.leaflet-marker-icon.bus-cluster-icon';
// Zoom con chips por línea (debajo de BUS_CLUSTER.chipsFromZoom se agrupan en burbujas).
export const CHIPS_ZOOM = 16;

// Estado interno del indicador (LIVE | CARGANDO | ERROR | OFFLINE), independiente del texto visible.
export const STATUS_LABELS = { LIVE: 'EN VIVO', CARGANDO: 'CARGANDO', ERROR: 'ERROR', OFFLINE: 'SIN CONEXIÓN' };
export async function expectStatus(page, state, options = {}) {
    await expect(page.locator('#status-dot')).toHaveAttribute('data-status', state, options);
    await expect(page.locator('#status-text')).toHaveText(STATUS_LABELS[state]);
}

// Registra errores de consola y excepciones no capturadas de la página.
export function trackPageErrors(page) {
    const errors = [];
    page.on('console', message => {
        if (message.type() === 'error') errors.push(`console: ${message.text()}`);
    });
    page.on('pageerror', error => errors.push(`pageerror: ${error.message}`));
    return errors;
}

// options.flags reemplaza js/app/feature-flags.config.js; options.config es un APP_CONFIG parcial
// (config.js lo mezcla en profundidad); options.consent = null deja el banner sin responder.
// options.zoom: zoom al que se lleva el mapa tras arrancar (por defecto el de chips; null = el inicial).
export async function bootApp(page, options = {}) {
    // path: relativa a baseURL (/transporte/), p. ej. './?@=-34.6,-58.38,15' para links compartidos.
    const { mocks = {}, consent = 'denied', config = null, flags = null, dismissLocation = true, waitForBuses = true, zoom = CHIPS_ZOOM, path = './' } = options;
    const mock = await installBackendMocks(page, mocks);

    await page.addInitScript(({ consentKey, consentValue, configOverride }) => {
        if (consentValue) localStorage.setItem(consentKey, JSON.stringify({ value: consentValue, timestamp: Date.now() }));
        if (configOverride) globalThis.APP_CONFIG = configOverride;
    }, { consentKey: CONSENT_KEY, consentValue: consent, configOverride: config });

    if (flags) {
        await page.route('**/js/app/feature-flags.config.js', route => route.fulfill({
            status: 200,
            contentType: 'text/javascript',
            body: `globalThis.APP_FEATURE_FLAGS = ${JSON.stringify(flags)};`
        }));
    }

    await page.goto(path);
    if (dismissLocation) await dismissLocationPrompt(page);
    // Render sincrónico tras el zoom: sin esto se podría seguir viendo el render del zoom inicial.
    if (zoom !== null) await page.evaluate(value => { map.setZoom(value, { animate: false }); renderMarkers({ force: true }); }, zoom);
    if (waitForBuses) await expect(page.locator(MAIN_BUS_CHIPS).first()).toBeVisible();
    return mock;
}

export async function dismissLocationPrompt(page) {
    const overlay = page.locator('#location-prompt-overlay');
    await expect(overlay).not.toHaveClass(/hidden/);
    await page.locator('#location-prompt-dismiss').click();
    await expect(overlay).toHaveClass(/hidden/);
}

// Con permiso de geolocalización el prompt pide confirmar la posición detectada (si aparece).
export async function confirmLocationIfPrompted(page) {
    const overlay = page.locator('#location-prompt-overlay');
    await page.waitForTimeout(300);
    if (await overlay.evaluate(el => el.classList.contains('hidden'))) return;
    const confirm = page.locator('#location-prompt-confirm');
    if (await confirm.isVisible()) await confirm.click();
    else await page.locator('#location-prompt-dismiss').click();
    await expect(overlay).toHaveClass(/hidden/);
}

export const isSheetLayout = page => page.evaluate(() => matchMedia('(max-width: 767px)').matches);

// Región de pantalla libre (sin hoja/barra lateral encima), con margen.
async function getClearMapArea(page) {
    return page.evaluate(() => {
        const rect = document.getElementById('app-sheet').getBoundingClientRect();
        const sheet = matchMedia('(max-width: 767px)').matches;
        return {
            left: (sheet ? 0 : rect.right) + 40,
            right: window.innerWidth - 40,
            top: 40,
            bottom: (sheet ? rect.top : window.innerHeight) - 60
        };
    });
}

// Mobile: lleva la hoja a "media" si está contraída. Desktop/tablet: la barra lateral siempre está abierta.
export async function openPanel(page) {
    if (!(await isSheetLayout(page))) return;
    const toggle = page.locator('#panel-toggle');
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
    await expect(page.locator('#panel-content')).not.toHaveAttribute('inert', '');
}

export async function closePanel(page) {
    if (!(await isSheetLayout(page))) return;
    const toggle = page.locator('#panel-toggle');
    if ((await toggle.getAttribute('aria-expanded')) === 'true') await toggle.click();
}

// Marca con data-test-target un colectivo de la capa principal visible y no tapado por el panel.
export async function pickBusMarker(page, { line = null, id = null } = {}) {
    if (id) {
        // Centra el mapa en ese colectivo (puede estar fuera de la vista en mobile).
        await page.evaluate(wantedId => {
            const vehicle = globalThis.cache.bus.find(item => item.id === wantedId);
            map.setView(getVisibleMapCenter([vehicle.latitude, vehicle.longitude]), map.getZoom(), { animate: false });
        }, id);
        await page.waitForTimeout(400);
    }
    const area = await getClearMapArea(page);
    const found = await page.evaluate(({ wantedLine, wantedId, area }) => {
        document.querySelectorAll('[data-test-target]').forEach(el => el.removeAttribute('data-test-target'));
        for (const [key, marker] of markerStores.bus) {
            const vehicle = marker._transitMarker?.data;
            if (wantedId && vehicle?.id !== wantedId) continue;
            if (wantedLine && getBusDisplayLine(vehicle) !== wantedLine) continue;
            const element = marker.getElement();
            if (!element) continue;
            const rect = element.getBoundingClientRect();
            const cx = rect.left + rect.width / 2;
            const cy = rect.top + rect.height / 2;
            const clear = cy > area.top && cy < area.bottom && cx > area.left && cx < area.right;
            if (!clear && !wantedId) continue;
            // Con 300 colectivos los markers se superponen: se trae el elegido al frente.
            marker.setZIndexOffset(100000);
            const hit = document.elementFromPoint(cx, cy);
            if (!wantedId && !element.contains(hit)) {
                marker.setZIndexOffset(0);
                continue;
            }
            element.setAttribute('data-test-target', '1');
            return { key, id: vehicle.id, line: getBusDisplayLine(vehicle) };
        }
        return null;
    }, { wantedLine: line, wantedId: id, area });
    expect(found, `colectivo ${line || id || ''} visible`).not.toBeNull();
    return { ...found, locator: page.locator('[data-test-target="1"]') };
}

export async function getMarkerScreenPosition(page, vehicleId) {
    return page.evaluate(id => {
        for (const marker of markerStores.bus.values()) {
            if (marker._transitMarker?.data?.id !== id) continue;
            const point = map.latLngToContainerPoint(marker.getLatLng());
            return { x: point.x, y: point.y };
        }
        return null;
    }, vehicleId);
}
