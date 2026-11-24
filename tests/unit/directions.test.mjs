import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadScripts } from './load-scripts.mjs';

function createDirectionsApp(cacheOverride = {}, runtimeGlobals = {}) {
    const mockElements = new Map();
    const getEl = id => {
        if (!mockElements.has(id)) {
            mockElements.set(id, {
                id,
                value: '',
                hidden: false,
                inert: false,
                listeners: {},
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
                addEventListener(type, listener) { this.listeners[type] = listener; },
                querySelectorAll: () => []
            });
            mockElements.get(id).classList.owner = mockElements.get(id);
        }
        return mockElements.get(id);
    };

    const app = loadScripts(['js/shared/utils.js', 'js/features/directions.js'], {
        isFeatureEnabled: () => true,
        lineColors: {},
        document: {
            readyState: 'complete',
            getElementById: getEl,
            addEventListener() {},
            querySelectorAll: () => []
        },
        ...runtimeGlobals,
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

test('autocomplete de destino prioriza la altura exacta de direcciones OpenStreetMap', async () => {
    let requestedUrl = '';
    const { mockElements } = createDirectionsApp({
        subteStatic: {
            lines: { LineaB: { short: 'B', stationIds: ['B1'] } },
            stations: { B1: { name: 'Corrientes', lat: -34.604, lon: -58.38 } }
        }
    }, {
        fetch: async url => {
            requestedUrl = String(url);
            return {
                ok: true,
                json: async () => ({
                    features: [
                        {
                            properties: { street: 'Avenida Corrientes', city: 'Buenos Aires' },
                            geometry: { coordinates: [-58.39, -34.60] }
                        },
                        {
                            properties: {
                                street: 'Avenida Corrientes',
                                housenumber: '1234',
                                city: 'Buenos Aires'
                            },
                            geometry: { coordinates: [-58.3901, -34.6001] }
                        }
                    ]
                })
            };
        },
        AbortController,
        setTimeout,
        clearTimeout
    });

    mockElements.get('directions-dest').listeners.input({ target: { value: 'Corrientes 1234' } });
    await new Promise(resolve => setTimeout(resolve, 450));

    const suggestions = mockElements.get('directions-suggestions');
    assert.match(requestedUrl, /^https:\/\/photon\.komoot\.io\/api\/\?q=Corrientes%201234/);
    assert.match(requestedUrl, /&limit=10&lang=default$/);
    assert.equal(suggestions.hidden, false);
    assert.match(suggestions.innerHTML, /Avenida Corrientes 1234/);
    assert.match(suggestions.innerHTML, /Buenos Aires/);
    assert.ok(suggestions.innerHTML.indexOf('Avenida Corrientes 1234') < suggestions.innerHTML.indexOf('Avenida Corrientes</span>'));
});

test('autocomplete muestra una intersección como nombre principal', async () => {
    const { mockElements } = createDirectionsApp({}, {
        fetch: async () => ({
            ok: true,
            json: async () => ({
                features: [{
                    properties: {
                        name: 'Lacroze y Conde',
                        street: 'Avenida Federico Lacroze',
                        county: 'Distrito Audiovisual'
                    },
                    geometry: { coordinates: [-58.4494, -34.5782] }
                }]
            })
        }),
        AbortController,
        setTimeout,
        clearTimeout
    });

    mockElements.get('directions-dest').listeners.input({ target: { value: 'Lacroze y Conde' } });
    await new Promise(resolve => setTimeout(resolve, 450));

    const html = mockElements.get('directions-suggestions').innerHTML;
    assert.match(html, /<span class="suggestion-title">Lacroze y Conde<\/span>/);
    assert.match(html, /Avenida Federico Lacroze, Distrito Audiovisual/);
});

test('autocomplete explica cuando la dirección no tiene resultados en AMBA', async () => {
    const { mockElements } = createDirectionsApp({}, {
        fetch: async () => ({
            ok: true,
            json: async () => ({
                features: [{
                    properties: { street: 'Vera Mujíca', housenumber: '1786', city: 'Rosario' },
                    geometry: { coordinates: [-60.6699, -32.9530] }
                }]
            })
        }),
        AbortController,
        setTimeout,
        clearTimeout
    });

    mockElements.get('directions-dest').listeners.input({ target: { value: 'vera 1786' } });
    await new Promise(resolve => setTimeout(resolve, 450));

    const suggestions = mockElements.get('directions-suggestions');
    assert.equal(suggestions.hidden, false);
    assert.match(suggestions.innerHTML, /No encontramos “vera 1786” en el AMBA/);
    assert.match(suggestions.innerHTML, /elegí el punto en el mapa/);
});

test('autocomplete informa si no puede consultar OpenStreetMap', async () => {
    const { mockElements } = createDirectionsApp({}, {
        fetch: async () => { throw new Error('sin conexión'); },
        AbortController,
        setTimeout,
        clearTimeout
    });

    mockElements.get('directions-dest').listeners.input({ target: { value: 'Corrientes 1234' } });
    await new Promise(resolve => setTimeout(resolve, 450));

    const suggestions = mockElements.get('directions-suggestions');
    assert.equal(suggestions.hidden, false);
    assert.match(suggestions.innerHTML, /No se pudo consultar OpenStreetMap/);
});

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

test('computeDirectionsRoutes dibuja solo las estaciones de cada tramo en una combinación de Subte', async () => {
    const { app } = createDirectionsApp({
        subteStatic: {
            lines: {
                LineaD: { short: 'D', color: '#008033', stationIds: ['D1', 'D2', 'D3'] },
                LineaC: { short: 'C', color: '#eb1923', stationIds: ['C1', 'C2', 'C3'] }
            },
            stations: {
                D1: { name: 'Congreso de Tucumán', lat: -34.6, lon: -58.45 },
                D2: { name: 'Callao', lat: -34.6, lon: -58.44 },
                D3: { name: 'Pueyrredón', lat: -34.6, lon: -58.43 },
                C1: { name: 'Corrientes', lat: -34.6, lon: -58.43 },
                C2: { name: 'Retiro intermedia', lat: -34.6, lon: -58.42 },
                C3: { name: 'General San Martín', lat: -34.6, lon: -58.41 }
            }
        },
        trainStatic: { lines: {}, stations: {} }
    });

    const routes = await app.computeDirectionsRoutes(
        { lat: -34.6, lon: -58.45, label: 'Origen' },
        { lat: -34.6, lon: -58.41, label: 'Destino' }
    );
    const route = routes.find(candidate => candidate.id === 'subte-transfer-LineaD-LineaC');
    const subteLegs = route?.legs.filter(leg => leg.mode === 'subte') || [];

    assert.equal(subteLegs.length, 2);
    assert.deepEqual(Array.from(subteLegs[0].stops, stop => stop.name), ['Congreso de Tucumán', 'Callao', 'Pueyrredón']);
    assert.deepEqual(Array.from(subteLegs[1].stops, stop => stop.name), ['Corrientes', 'Retiro intermedia', 'General San Martín']);
    assert.equal(subteLegs[0].coords.length, 3);
    assert.equal(subteLegs[1].coords.length, 3);
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

test('calculateDirectionsRoutes carga y sigue las ciclovías entre estaciones Ecobici', async () => {
    const bikeRoutes = {
        type: 'FeatureCollection',
        features: [
            { type: 'Feature', geometry: { type: 'LineString', coordinates: [[-58.3850, -34.6020], [-58.3900, -34.6020]] } },
            { type: 'Feature', geometry: { type: 'LineString', coordinates: [[-58.3900, -34.6020], [-58.3900, -34.5980]] } },
            { type: 'Feature', geometry: { type: 'LineString', coordinates: [[-58.3900, -34.5980], [-58.3980, -34.5980]] } }
        ]
    };
    const { app } = createDirectionsApp({
        bike: [
            { station_id: 'B1', name: 'Plaza Lavalle', lat: -34.6020, lon: -58.3850, num_bikes_available: 5, num_docks_available: 3 },
            { station_id: 'B2', name: 'Facultad de Medicina', lat: -34.5980, lon: -58.3980, num_bikes_available: 2, num_docks_available: 6 },
            { station_id: 'B3', name: 'Estación intermedia', lat: -34.6000, lon: -58.3910, num_bikes_available: 4, num_docks_available: 4 }
        ]
    }, {
        refreshBikeRoutesNow: async () => {
            app.cache.bikeRoutes = bikeRoutes;
            return true;
        }
    });
    // Origen cerca de B1
    const origin = { lat: -34.6022, lon: -58.3848, label: 'Lavalle y Talcahuano' };
    // Destino cerca de B2
    const destination = { lat: -34.5982, lon: -58.3982, label: 'Paraguay y Uriburu' };

    app.directionsState.origin = origin;
    app.directionsState.destination = destination;
    await app.calculateDirectionsRoutes();
    const routes = app.directionsState.routes;
    const bikeRoute = routes.find(r => r.type === 'bike');

    assert.ok(bikeRoute, 'Debe encontrar ruta de ecobici');
    assert.equal(bikeRoute.title, 'Ecobici');
    const bikeLeg = bikeRoute.legs.find(l => l.mode === 'bike');
    assert.ok(bikeLeg);
    const routePoints = bikeLeg.coords.map(point => point.join(','));
    assert.ok(routePoints.includes('-34.602,-58.39'), 'Debe seguir la primera ciclovía hasta el giro');
    assert.ok(routePoints.includes('-34.598,-58.39'), 'Debe seguir la ciclovía que conecta el giro con el destino');
    assert.ok(!routePoints.includes('-34.6,-58.391'), 'No debe unir estaciones intermedias como si fueran el recorrido');
    assert.equal(bikeLeg.stops.length, 2, 'Solo debe marcar las estaciones donde se toma y se deja la bici');
});

test('computeDirectionsRoutes no inventa una conexión cuando las ciclovías están desconectadas', async () => {
    const { app } = createDirectionsApp({
        bikeRoutes: {
            type: 'FeatureCollection',
            features: [
                { type: 'Feature', geometry: { type: 'LineString', coordinates: [[-58.3850, -34.6020], [-58.3860, -34.6020]] } },
                { type: 'Feature', geometry: { type: 'LineString', coordinates: [[-58.3970, -34.5980], [-58.3980, -34.5980]] } }
            ]
        }
    });

    const routes = await app.computeDirectionsRoutes(
        { lat: -34.6022, lon: -58.3848, label: 'Lavalle y Talcahuano' },
        { lat: -34.5982, lon: -58.3982, label: 'Paraguay y Uriburu' }
    );

    assert.ok(!routes.some(route => route.type === 'bike'));
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

test('computeDirectionsRoutes incorpora colectivos devueltos por el Worker', async () => {
    let requestedEndpoint = '';
    const workerRoute = {
        id: 'bus-60',
        type: 'bus',
        title: 'Línea 60',
        durationMin: 35,
        distanceMeters: 4200,
        summaryPills: [{ icon: '🚌', text: 'Línea 60', color: '#f59e0b' }],
        legs: [
            { mode: 'walk', fromName: 'Origen', toName: 'Parada A', coords: [[-34.6037, -58.3816], [-34.60, -58.38]] },
            { mode: 'bus', lineName: 'Línea 60', coords: [[-34.60, -58.38], [-34.56, -58.45]], stops: [] },
            { mode: 'walk', fromName: 'Parada B', toName: 'Destino', coords: [[-34.56, -58.45], [-34.559, -58.451]] }
        ],
        steps: [{ icon: '🚌', text: 'Tomar la Línea 60' }]
    };
    const { app } = createDirectionsApp({}, {
        APP_CONFIG: { PATHS: { busRoutePlan: '/planificar-colectivo' } },
        fetchAPI: async endpoint => {
            requestedEndpoint = endpoint;
            return { success: true, data: { routes: [workerRoute] } };
        }
    });

    const origin = { lat: -34.6037, lon: -58.3816, label: 'Obelisco' };
    const destination = { lat: -34.5590, lon: -58.4510, label: 'Belgrano' };

    const routes = await app.computeDirectionsRoutes(origin, destination);
    const busRoute = routes.find(r => r.type === 'bus');
    assert.ok(requestedEndpoint.startsWith('/planificar-colectivo?origin_lat=-34.6037'));
    assert.ok(requestedEndpoint.includes('destination_lat=-34.559'));
    assert.equal(busRoute?.title, 'Línea 60');
    assert.equal(busRoute?.legs[0].fromName, 'Obelisco');
    assert.equal(busRoute?.legs[2].toName, 'Belgrano');
});

test('computeDirectionsRoutes prioriza un colectivo directo sobre una combinación', async () => {
    const directRoute = {
        id: 'bus-19',
        type: 'bus',
        title: 'Línea 19',
        durationMin: 50,
        distanceMeters: 8000,
        summaryPills: [{ icon: '🚌', text: 'Línea 19', color: '#f59e0b' }],
        legs: [
            { mode: 'walk' },
            { mode: 'bus', lineName: 'Línea 19' },
            { mode: 'walk' }
        ],
        steps: [{ icon: '🚌', text: 'Tomar la Línea 19' }]
    };
    const transferRoute = {
        id: 'bus-19-42',
        type: 'bus',
        title: 'Líneas 19 y 42',
        durationMin: 35,
        distanceMeters: 7000,
        summaryPills: [
            { icon: '🚌', text: 'Línea 19', color: '#f59e0b' },
            { icon: '🚌', text: 'Línea 42', color: '#f59e0b' }
        ],
        legs: [
            { mode: 'walk' },
            { mode: 'bus', lineName: 'Línea 19' },
            { mode: 'bus', lineName: 'Línea 42' },
            { mode: 'walk' }
        ],
        steps: [{ icon: '🚌', text: 'Combinar las líneas 19 y 42' }]
    };
    const { app } = createDirectionsApp({
        trainStatic: { lines: {}, stations: {} },
        subteStatic: { lines: {}, stations: {} }
    }, {
        APP_CONFIG: { PATHS: { busRoutePlan: '/planificar-colectivo' } },
        fetchAPI: async () => ({
            success: true,
            data: { routes: [transferRoute, directRoute] }
        })
    });

    const routes = await app.computeDirectionsRoutes(
        { lat: -34.6037, lon: -58.3816, label: 'Origen' },
        { lat: -34.5590, lon: -58.4510, label: 'Destino' }
    );
    const busRoutes = routes.filter(route => route.type === 'bus');

    assert.equal(busRoutes[0].title, 'Línea 19');
    assert.equal(busRoutes[1].title, 'Líneas 19 y 42');
    assert.equal(busRoutes[1].tag, 'Más rápido');
    const transferBusLegs = busRoutes[1].legs.filter(leg => leg.mode === 'bus');
    assert.notEqual(transferBusLegs[0].color, transferBusLegs[1].color);
    const transferBusPills = busRoutes[1].summaryPills.filter(pill => pill.icon === '🚌');
    assert.notEqual(transferBusPills[0].color, transferBusPills[1].color);
});

test('si el primer colectivo deja a menos de cinco cuadras, recomienda bajarse y caminar', async () => {
    const transferRoute = {
        id: 'bus-transfer-near',
        type: 'bus',
        title: 'Líneas 151A y 104A',
        durationMin: 40,
        distanceMeters: 5000,
        summaryPills: [
            { icon: '🚶', text: '2m', color: '#64748b' },
            { icon: '🚌', text: 'Línea 151A', color: '#f59e0b' },
            { icon: '🚌', text: 'Línea 104A', color: '#f59e0b' },
            { icon: '🚶', text: '1m', color: '#64748b' }
        ],
        legs: [
            { mode: 'walk', durationMin: 2, distanceMeters: 200, coords: [[-34.62, -58.42], [-34.618, -58.418]] },
            {
                mode: 'bus', lineName: 'Línea 151A', durationMin: 12, distanceMeters: 2500,
                fromName: 'Parada de origen', toName: 'Parada cercana',
                coords: [[-34.618, -58.418], [-34.6, -58.404]],
                stops: [
                    { name: 'Parada de origen', lat: -34.618, lon: -58.418, role: 'board' },
                    { name: 'Parada cercana', lat: -34.6, lon: -58.404, role: 'alight' }
                ]
            },
            {
                mode: 'bus', lineName: 'Línea 104A', durationMin: 8, distanceMeters: 1200,
                fromName: 'Parada cercana', toName: 'Destino',
                coords: [[-34.6, -58.404], [-34.6, -58.4005]],
                stops: [{ name: 'Destino', lat: -34.6, lon: -58.4005, role: 'alight' }]
            },
            { mode: 'walk', durationMin: 1, distanceMeters: 50, coords: [[-34.6, -58.4005], [-34.6, -58.4]] }
        ],
        steps: [
            { icon: '🚶', text: 'Caminar a la parada' },
            { icon: '🚌', text: 'Tomar Línea 151A y bajar en Parada cercana' },
            { icon: '🔁', text: 'Combinar con Línea 104A' },
            { icon: '🚌', text: 'Tomar Línea 104A' },
            { icon: '🚶', text: 'Caminar al destino' }
        ]
    };
    const { app } = createDirectionsApp({
        trainStatic: { lines: {}, stations: {} },
        subteStatic: { lines: {}, stations: {} }
    }, {
        APP_CONFIG: { PATHS: { busRoutePlan: '/planificar-colectivo' } },
        fetchAPI: async () => ({ success: true, data: { routes: [transferRoute] } })
    });

    const routes = await app.computeDirectionsRoutes(
        { lat: -34.62, lon: -58.42, label: 'Origen' },
        { lat: -34.6, lon: -58.4, label: 'Destino' }
    );
    const busRoutes = routes.filter(route => route.type === 'bus');

    assert.equal(busRoutes.length, 1);
    assert.equal(busRoutes[0].title, 'Línea 151A');
    assert.equal(busRoutes[0].legs.filter(leg => leg.mode === 'bus').length, 1);
    assert.equal(busRoutes[0].legs.at(-1).mode, 'walk');
    assert.equal(busRoutes[0].legs.at(-1).toName, 'Destino');
    assert.match(busRoutes[0].steps.at(-1).text, /caminar .* hasta destino/i);
});

test('Ecobici filtra estaciones por cercanía a los extremos o al recorrido', () => {
    const app = loadScripts(['js/shared/utils.js', 'js/features/markers.js'], {
        directionsState: {
            origin: { lat: -34.6, lon: -58.45 },
            destination: { lat: -34.6, lon: -58.41 }
        }
    });
    const activeTransit = {
        bikeStationIds: new Set(['chosen']),
        bikeRouteCoords: [[[-34.6, -58.45], [-34.6, -58.41]]]
    };

    assert.equal(app.isBikeStationRelevantToDirections({ station_id: 'near-origin' }, -34.6, -58.455, activeTransit), true);
    assert.equal(app.isBikeStationRelevantToDirections({ station_id: 'on-route' }, -34.6005, -58.43, activeTransit), true);
    assert.equal(app.isBikeStationRelevantToDirections({ station_id: 'chosen' }, -34.62, -58.43, activeTransit), true);
    assert.equal(app.isBikeStationRelevantToDirections({ station_id: 'far-away' }, -34.61, -58.43, activeTransit), false);
});
