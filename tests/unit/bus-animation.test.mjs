import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadScripts } from './load-scripts.mjs';

function loadAnimation(config = {}) {
    let now = 1000;
    const app = loadScripts([
        'js/shared/utils.js',
        'js/app/feature-flags.js',
        'js/features/markers-bus-overlay.js',
        'js/features/bus-animation.js'
    ], {
        APP_CONFIG: { BUS_ANIMATION: { minSegmentMs: 8000, maxSegmentMs: 45000, ...config }, POLLING: { busIntervalMs: 30000 } },
        performance: { now: () => now },
        matchMedia: () => ({ matches: false })
    });
    return { app, advance: ms => { now += ms; } };
}

const bus = (id, lat, lon, extra = {}) => ({ id, route_id: '1', route_short_name: '60', tip_id: `${id}-1`, latitude: lat, longitude: lon, ...extra });

test('el primer snapshot KV usa current.ts - prev.ts como duración del tramo', () => {
    const { app } = loadAnimation();
    app.busAnimIngestSnapshot([bus('1', -34.6, -58.4)], [bus('1', -34.601, -58.4)], { currentTs: 100_000, prevTs: 70_000 });
    assert.equal(app.busAnimGetStats().segmentMs, 30_000);
});

test('la duración sigue al intervalo medido (EMA) dentro de [min, max]', () => {
    const { app, advance } = loadAnimation();
    app.busAnimIngestSnapshot([bus('1', -34.6, -58.4)]);
    assert.equal(app.busAnimGetStats().segmentMs, null);
    advance(30_000);
    app.busAnimIngestSnapshot([bus('1', -34.6, -58.4)]);
    assert.equal(app.busAnimGetStats().segmentMs, 30_000);
    advance(60_000);
    app.busAnimIngestSnapshot([bus('1', -34.6, -58.4)]);
    // 60 s se acota a maxSegmentMs = 45 s: 30 * 0.6 + 45 * 0.4.
    assert.equal(app.busAnimGetStats().segmentMs, 36_000);
    advance(500);
    app.busAnimIngestSnapshot([bus('1', -34.6, -58.4)]);
    assert.equal(app.busAnimGetStats().segmentMs, 36_000, 'intervalos < 1 s (refresh manual doble) no cuentan');
});

test('rumbo derivado del movimiento (cuantizado a 5°) solo si el dato no trae bearing', () => {
    const { app, advance } = loadAnimation();
    app.busAnimIngestSnapshot([bus('1', -34.6, -58.4), bus('2', -34.6, -58.4), bus('3', -34.6, -58.4, { bearing: 270 })]);
    advance(30_000);
    const next = [
        bus('1', -34.599, -58.4), // ~111 m al norte
        bus('2', -34.6, -58.39995), // ~4.6 m: no alcanza para derivar rumbo
        bus('3', -34.599, -58.4, { bearing: 270 })
    ];
    app.busAnimIngestSnapshot(next);
    assert.equal(next[0]._derivedBearing, 0);
    assert.equal(next[1]._derivedBearing, undefined);
    assert.equal(next[2]._derivedBearing, undefined);

    advance(30_000);
    const east = [bus('1', -34.599, -58.398)];
    app.busAnimIngestSnapshot(east);
    assert.ok(Math.abs(east[0]._derivedBearing - 90) <= 5, String(east[0]._derivedBearing));
    assert.equal(east[0]._derivedBearing % 5, 0);
});

test('saltos mayores a maxAnimatedJumpMeters no generan rumbo', () => {
    const { app, advance } = loadAnimation({ maxAnimatedJumpMeters: 2500 });
    app.busAnimIngestSnapshot([bus('1', -34.6, -58.4)]);
    advance(30_000);
    const jumped = [bus('1', -34.5, -58.4)];
    app.busAnimIngestSnapshot(jumped);
    assert.equal(jumped[0]._derivedBearing, undefined);
});

test('con busAnimation apagado no hace nada', () => {
    const app = loadScripts([
        'js/shared/utils.js',
        'js/app/feature-flags.js',
        'js/features/markers-bus-overlay.js',
        'js/features/bus-animation.js'
    ], { APP_FEATURE_FLAGS: { busAnimation: false }, APP_CONFIG: {}, performance: { now: () => 1 }, matchMedia: () => ({ matches: false }) });
    const vehicles = [bus('1', -34.6, -58.4)];
    app.busAnimIngestSnapshot(vehicles, [bus('1', -34.61, -58.4)], { currentTs: 2, prevTs: 1 });
    assert.equal(app.busAnimGetStats().segmentMs, null);
    assert.equal(vehicles[0]._derivedBearing, undefined);
});
