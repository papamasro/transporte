import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadScripts } from './load-scripts.mjs';

function createDirectionsApp(cacheOverride = {}) {
    const mockElements = new Map();
    const getEl = id => {
        if (!mockElements.has(id)) {
            mockElements.set(id, {
                id,
                value: '',
                hidden: false,
                inert: false,
                classes: new Set(),
                classList: {
                    add(c) { this.owner.classes.add(c); },
                    remove(c) { this.owner.classes.delete(c); },
                    toggle(c, force) {
                        const on = force !== undefined ? force : !this.owner.classes.has(c);
                        on ? this.owner.classes.add(c) : this.owner.classes.delete(c);
                    },
                    contains(c) { return this.owner.classes.has(c); }
                },
                setAttribute() {},
                removeAttribute() {},
                addEventListener() {},
                querySelectorAll: () => []
            });
            mockElements.get(id).classList.owner = mockElements.get(id);
        }
        return mockElements.get(id);
    };

    const app = loadScripts(['js/shared/utils.js', 'js/features/directions.js'], {
        isFeatureEnabled: () => true,
        document: {
            readyState: 'complete',
            getElementById: getEl,
            addEventListener() {},
            querySelectorAll: () => []
        },
        cache: {
            subteStatic: {
                lines: {
                    LineaD: {
                        short: 'D',
                        color: '#008033',
                        stationIds: ['D1', 'D2', 'D3', 'D4', 'D5']
                    }
                },
                stations: {
                    D1: { name: 'Catedral', lat: -34.6076, lon: -58.3742 },
                    D2: { name: '9 de Julio', lat: -34.6044, lon: -58.3802 },
                    D3: { name: 'Tribunales', lat: -34.6018, lon: -58.3855 },
                    D4: { name: 'Callao', lat: -34.5992, lon: -58.3923 },
                    D5: { name: 'Facultad de Medicina', lat: -34.5985, lon: -58.3989 }
                }
            },
            trainStatic: {
                lines: {
                    mitre: {
                        short: 'Mitre',
                        name: 'Línea Mitre',
                        color: '#0ea5e9',
                        stationIds: ['T1', 'T2']
                    }
                },
                stations: {
                    T1: { name: 'Retiro', lat: -34.5915, lon: -58.3746 },
                    T2: { name: 'Belgrano C', lat: -34.5582, lon: -58.4503 }
                }
            },
            bike: [
                { station_id: 'B1', name: 'Plaza Lavalle', lat: -34.6020, lon: -58.3850, num_bikes_available: 5, num_docks_available: 3 },
                { station_id: 'B2', name: 'Facultad de Medicina', lat: -34.5980, lon: -58.3980, num_bikes_available: 2, num_docks_available: 6 }
            ],
            bus: [],
            ...cacheOverride
        }
    });

    return { app, mockElements };
}

test('computeDirectionsRoutes calcula opción caminando', async () => {
    const { app } = createDirectionsApp();
    const origin = { lat: -34.6037, lon: -58.3816, label: 'Obelisco' };
    const destination = { lat: -34.6083, lon: -58.3721, label: 'Plaza de Mayo' };

    const routes = await app.computeDirectionsRoutes(origin, destination);
    assert.ok(Array.isArray(routes));
    assert.ok(routes.length >= 1);

    const walkRoute = routes.find(r => r.type === 'walk');
    assert.ok(walkRoute);
    assert.equal(walkRoute.title, 'Caminando');
    assert.ok(walkRoute.durationMin > 0);
    assert.ok(walkRoute.distanceMeters > 0);
    assert.ok(walkRoute.legs.length === 1);
});

test('computeDirectionsRoutes encuentra Subte directo si hay estaciones en rango', async () => {
    const { app } = createDirectionsApp();
    // Origen cerca de Tribunales (D3)
    const origin = { lat: -34.6020, lon: -58.3850, label: 'Teatro Colón' };
    // Destino cerca de Facultad de Medicina (D5)
    const destination = { lat: -34.5980, lon: -58.3990, label: 'Hospital de Clínicas' };

    const routes = await app.computeDirectionsRoutes(origin, destination);
    const subteRoute = routes.find(r => r.type === 'subte');

    assert.ok(subteRoute, 'Debe encontrar ruta de subte');
    assert.ok(subteRoute.title.includes('Línea D'));
    assert.ok(subteRoute.durationMin > 0);
    assert.ok(subteRoute.legs.length >= 3, 'Debe incluir caminata origen + subte + caminata destino');
    assert.ok(subteRoute.steps.length >= 3);
});

test('computeDirectionsRoutes encuentra Tren si hay estaciones en rango', async () => {
    const { app } = createDirectionsApp();
    // Origen cerca de Retiro (T1)
    const origin = { lat: -34.5920, lon: -58.3750, label: 'Torre de los Ingleses' };
    // Destino cerca de Belgrano C (T2)
    const destination = { lat: -34.5590, lon: -58.4510, label: 'Barrancas de Belgrano' };

    const routes = await app.computeDirectionsRoutes(origin, destination);
    const trainRoute = routes.find(r => r.type === 'train');

    assert.ok(trainRoute, 'Debe encontrar ruta de tren');
    assert.ok(trainRoute.title.includes('Mitre'));
    assert.ok(trainRoute.legs.some(l => l.mode === 'train'));
});

test('computeDirectionsRoutes encuentra Ecobici si hay estaciones con disponibilidad', async () => {
    const { app } = createDirectionsApp();
    // Origen cerca de B1
    const origin = { lat: -34.6022, lon: -58.3848, label: 'Lavalle y Talcahuano' };
    // Destino cerca de B2
    const destination = { lat: -34.5982, lon: -58.3982, label: 'Paraguay y Uriburu' };

    const routes = await app.computeDirectionsRoutes(origin, destination);
    const bikeRoute = routes.find(r => r.type === 'bike');

    assert.ok(bikeRoute, 'Debe encontrar ruta de ecobici');
    assert.equal(bikeRoute.title, 'Ecobici');
    assert.ok(bikeRoute.legs.some(l => l.mode === 'bike'));
});

test('swapDirectionsLocations invierte origen y destino', () => {
    const { app } = createDirectionsApp();
    app.directionsState.origin = { lat: -34.60, lon: -58.38, label: 'Punto A' };
    app.directionsState.destination = { lat: -34.61, lon: -58.39, label: 'Punto B' };

    app.swapDirectionsLocations();

    assert.equal(app.directionsState.origin.label, 'Punto B');
    assert.equal(app.directionsState.destination.label, 'Punto A');
});

test('clearDirectionsField y resetDirectionsForm limpian el estado', () => {
    const { app } = createDirectionsApp();
    app.directionsState.origin = { lat: -34.60, lon: -58.38, label: 'Punto A' };
    app.directionsState.destination = { lat: -34.61, lon: -58.39, label: 'Punto B' };

    app.clearDirectionsField('origin');
    assert.equal(app.directionsState.origin, null);
    assert.ok(app.directionsState.destination);

    app.resetDirectionsForm();
    assert.equal(app.directionsState.origin, null);
    assert.equal(app.directionsState.destination, null);
    assert.equal(app.directionsState.routes.length, 0);
});

test('computeDirectionsRoutes encuentra colectivo por fallback si no hay estáticos', async () => {
    const { app } = createDirectionsApp({
        bus: [
            {
                latitude: -34.6030,
                longitude: -34.6030, // cerca
                route_short_name: '60'
            }
        ]
    });
    // Puntos separados más de 1200 metros
    const origin = { lat: -34.6037, lon: -58.3816, label: 'Obelisco' };
    const destination = { lat: -34.5590, lon: -58.4510, label: 'Belgrano' };

    const routes = await app.computeDirectionsRoutes(origin, destination);
    const busRoute = routes.find(r => r.type === 'bus');
    assert.ok(busRoute, 'Debe incluir opción de colectivo para distancias > 1200m');
    assert.equal(busRoute.type, 'bus');
});
