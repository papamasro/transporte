import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadScripts } from './load-scripts.mjs';

const loadFlags = flags => loadScripts(['js/app/feature-flags.js'], { APP_FEATURE_FLAGS: flags });

test('feature-flags.config.js publicado: todo encendido', () => {
    const app = loadScripts(['js/app/feature-flags.config.js', 'js/app/feature-flags.js']);
    const source = readFileSync(new URL('../../js/app/feature-flags.config.js', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /:\s*false/);
    assert.deepEqual([...app.getEnabledTransportTypes()], ['bus', 'subte', 'train', 'bike']);
    for (const slice of ['busVehicles', 'busStops', 'subte', 'train', 'bike', 'bikeStations', 'bikeRoutes']) {
        assert.equal(app.isNearbySliceEnabled(slice), true, slice);
    }
    assert.equal(app.isFeatureEnabled('busAnimation'), true);
});

test('flags desconocidos o sin config quedan encendidos', () => {
    const app = loadFlags(undefined);
    assert.equal(app.isFeatureEnabled('loQueSea'), true);
    assert.equal(app.isFeatureEnabled(''), true);
});

test('capas dependen de su flag y de sus datos', () => {
    assert.equal(loadFlags({ busLivePositions: false }).isTransportTypeEnabled('bus'), false);
    assert.equal(loadFlags({ subteStaticData: false }).isTransportTypeEnabled('subte'), false);
    assert.equal(loadFlags({ subteRealtime: false }).isTransportTypeEnabled('subte'), true);
    assert.equal(loadFlags({ trainLayer: false }).isTransportTypeEnabled('train'), false);
    assert.equal(loadFlags({ bikeStations: false }).isTransportTypeEnabled('bike'), true);
    assert.equal(loadFlags({ bikeStations: false, bikeRoutes: false }).isTransportTypeEnabled('bike'), false);
    assert.equal(loadFlags({}).isTransportTypeEnabled('avion'), false);
});

test('cortes de cercanos: estaciones y bicisendas independientes', () => {
    const noRoutes = loadFlags({ bikeRoutes: false });
    assert.equal(noRoutes.isNearbySliceEnabled('bike'), true);
    assert.equal(noRoutes.isNearbySliceEnabled('bikeStations'), true);
    assert.equal(noRoutes.isNearbySliceEnabled('bikeRoutes'), false);

    const noPanel = loadFlags({ nearbyPanel: false });
    for (const slice of ['busVehicles', 'subte', 'train', 'bike']) assert.equal(noPanel.isNearbySliceEnabled(slice), false);

    assert.equal(loadFlags({ busRouteOverlay: false }).isNearbySliceEnabled('busStops'), false);
    assert.equal(loadFlags({ busRouteOverlay: false }).isNearbySliceEnabled('busVehicles'), true);
});

test('applyFeatureFlagsToDom oculta los controles apagados', () => {
    const elements = new Map(['t-subte', 'action-alerts', 't-bus'].map(id => [id, {
        classes: new Set(),
        attrs: new Map(),
        classList: { toggle(name, on) { on ? this.owner.classes.add(name) : this.owner.classes.delete(name); } },
        setAttribute(name, value) { this.attrs.set(name, value); },
        removeAttribute(name) { this.attrs.delete(name); }
    }]));
    elements.forEach(element => { element.classList.owner = element; });
    loadScripts(['js/app/feature-flags.js'], {
        APP_FEATURE_FLAGS: { subteLayer: false, alertsPanel: false },
        document: { readyState: 'complete', getElementById: id => elements.get(id) || null, addEventListener() {} }
    });
    assert.equal(elements.get('t-subte').classes.has('feature-off'), true);
    assert.equal(elements.get('t-subte').attrs.get('aria-hidden'), 'true');
    assert.equal(elements.get('action-alerts').classes.has('feature-off'), true);
    assert.equal(elements.get('t-bus').classes.has('feature-off'), false);
    assert.equal(elements.get('t-bus').attrs.has('aria-hidden'), false);
});
