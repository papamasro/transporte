// Mocks deterministas del backend (Cloudflare Worker), tiles, GA y data/routes/ vía page.route.
// Cada test puede cambiar el comportamiento en caliente: mock.options.busMode = 'error', etc.
import * as fx from './data.mjs';

export const BACKEND = 'https://transporte-be.papamasro.workers.dev';

// PNG 1x1 transparente para las tiles de Esri (sin red y sin variabilidad visual).
const EMPTY_TILE = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

const json = (route, body, status = 200) => route.fulfill({
    status,
    contentType: 'application/json',
    headers: { 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(body)
});

const fail = (route, status = 500) => route.fulfill({
    status,
    contentType: 'text/plain',
    headers: { 'Access-Control-Allow-Origin': '*' },
    body: 'error'
});

export async function installBackendMocks(target, overrides = {}) {
    const options = {
        busCount: 300,
        busStepMeters: 60,
        // 'ok' | 'error'
        busMode: 'ok',
        // 'ok' (current+prev) | 'notfound' (worker sin desplegar) | 'error'
        kvMode: 'ok',
        kvPrevAgeMs: 30000,
        // 'static' (data/routes publicados) | 'missing' (404 -> worker)
        staticRoutes: 'static',
        // 'ok' | 'error'
        alertsMode: 'ok',
        // 'ok' | 'error' (pronóstico de subte)
        subteMode: 'ok',
        ...overrides
    };
    const requests = [];
    const state = { busStep: 0 };

    const nextBuses = () => {
        state.busStep += 1;
        return fx.makeBuses({ count: options.busCount, step: state.busStep, stepMeters: options.busStepMeters });
    };

    await target.route(`${BACKEND}/**`, async route => {
        const request = route.request();
        const url = new URL(request.url());
        const { pathname, searchParams } = url;
        requests.push({ method: request.method(), pathname, search: url.search, body: request.postData() });
        const nowSec = Math.floor(Date.now() / 1000);

        if (request.method() === 'OPTIONS') {
            return route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST', 'Access-Control-Allow-Headers': 'Content-Type' } });
        }

        switch (pathname) {
            case '/colectivos/vehiclePositionsSimple':
                if (options.busMode === 'error') return fail(route);
                return json(route, nextBuses());
            case '/colectivos/vehiclePositionsKV': {
                if (options.kvMode === 'notfound') return fail(route, 404);
                if (options.kvMode === 'error' || options.busMode === 'error') return fail(route, 500);
                const prev = fx.makeBuses({ count: options.busCount, step: state.busStep, stepMeters: options.busStepMeters });
                const current = nextBuses();
                const ts = Date.now();
                return json(route, { current: { ts, data: current }, prev: { ts: ts - options.kvPrevAgeMs, data: prev } });
            }
            case '/obtener-kv': {
                const key = searchParams.get('clave');
                const values = {
                    'subte-lines': fx.SUBTE_LINES,
                    'subte-stations': fx.SUBTE_STATIONS,
                    'train-lines': fx.TRAIN_LINES,
                    'train-stations': fx.TRAIN_STATIONS
                };
                return key in values ? json(route, values[key]) : fail(route, 404);
            }
            case '/subtes/forecastGTFS':
                if (options.subteMode === 'error') return fail(route);
                return json(route, fx.makeSubteForecast(nowSec));
            case '/ecobici/gbfs/stationInformation':
                return json(route, fx.BIKE_INFO);
            case '/ecobici/gbfs/stationStatus':
                return json(route, fx.BIKE_STATUS);
            case '/obtener-bicisenda':
                return route.fulfill({ status: 200, contentType: 'application/geo+json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(fx.BIKE_ROUTES) });
            case '/trenes/arribosLinea':
                return json(route, fx.makeTrainLineArrivals(nowSec));
            case '/subtes/serviceAlertsJson':
                return options.alertsMode === 'error' ? fail(route) : json(route, fx.SUBTE_ALERTS);
            case '/colectivos/serviceAlertsJson':
                return options.alertsMode === 'error' ? fail(route) : json(route, fx.BUS_ALERTS);
            case '/subtes/serviceAlerts':
            case '/colectivos/serviceAlerts':
                return fail(route);
            case '/buscar-linea':
                return json(route, fx.LINE_SEARCH_60);
            case '/info-trayecto':
                return json(route, fx.TRAYECTO_60);
            case '/client-errors':
                return route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*' } });
            default:
                if (pathname.startsWith('/trenes/arribos/estacion/')) {
                    return json(route, fx.makeTrainLineArrivals(nowSec).stations.T1.data);
                }
                return fail(route, 404);
        }
    });

    await target.route('https://server.arcgisonline.com/**', route => route.fulfill({ status: 200, contentType: 'image/png', body: EMPTY_TILE }));
    // Mapa oscuro (Esri Dark Gray Canvas).
    await target.route('https://services.arcgisonline.com/**', route => {
        requests.push({ method: 'GET', pathname: new URL(route.request().url()).pathname, search: '', tile: true });
        return route.fulfill({ status: 200, contentType: 'image/png', body: EMPTY_TILE });
    });
    await target.route('https://www.googletagmanager.com/**', route => {
        requests.push({ method: 'GET', pathname: '/gtag', search: '', external: true });
        return route.fulfill({ status: 200, contentType: 'text/javascript', body: '/* gtag mock */' });
    });

    await target.route('**/transporte/data/routes/**', route => {
        const url = new URL(route.request().url());
        requests.push({ method: route.request().method(), pathname: url.pathname, search: '', staticRoute: true });
        if (options.staticRoutes !== 'static') return route.fulfill({ status: 404, body: 'Not found' });
        if (url.pathname.endsWith('/index.json')) return json(route, { lines: { 60: { file: '60', variants: [{ id: 'v60' }] } } });
        if (url.pathname.endsWith('/60.json')) return json(route, fx.makeStaticRouteFile60());
        // Como en producción, cada línea tiene su archivo; las del fixture sin recorrido van vacías.
        if (/\/data\/routes\/[\w-]+\.json$/.test(url.pathname)) return json(route, { agencies: {}, stops: {}, routes: {}, variants: {} });
        return route.fulfill({ status: 404, body: 'Not found' });
    });

    return {
        options,
        requests,
        count: predicate => requests.filter(item => (typeof predicate === 'string' ? item.pathname === predicate : predicate(item))).length,
        reset: () => { requests.length = 0; }
    };
}
