import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadScripts } from './load-scripts.mjs';

const app = loadScripts(['js/shared/utils.js', 'js/app/url-state.js', 'js/features/favorites.js'], { URLSearchParams });
// Los objetos del contexto vm tienen otros prototipos: se comparan como JSON.
const plain = value => JSON.parse(JSON.stringify(value));

test('parseShareParams lee vista, capa, búsqueda y estación', () => {
    assert.deepEqual(plain(app.parseShareParams('?@=-34.6086,-58.3742,16&capa=subte&q=60&est=subte:LineaA:A1')), {
        view: { lat: -34.6086, lng: -58.3742, zoom: 16 },
        type: 'subte',
        query: '60',
        station: { type: 'subte', id: 'LineaA:A1' }
    });
    assert.deepEqual(plain(app.parseShareParams('?@=-34.6,-58.4')).view, { lat: -34.6, lng: -58.4, zoom: 15 });
    assert.equal(app.parseShareParams('?capa=TREN').type, 'train');
    assert.equal(app.parseShareParams('?capa=ninguna').type, 'none');
    assert.equal(app.parseShareParams('?linea=152').query, '152');
    assert.deepEqual(plain(app.parseShareParams('?est=ecobici:42')).station, { type: 'bike', id: '42' });
    assert.deepEqual(plain(app.parseShareParams('')), { view: null, type: null, query: '', station: null });
});

test('parseShareParams descarta valores inválidos', () => {
    const parsed = app.parseShareParams('?@=999,abc,50&capa=<script>&est=evil&q=' + encodeURIComponent('a\u0000b  c'.padEnd(80, 'x')));
    assert.equal(parsed.view, null);
    assert.equal(parsed.type, null);
    assert.equal(parsed.station, null);
    assert.equal(parsed.query.length, 40);
    assert.ok(parsed.query.startsWith('ab c'));
    assert.equal(app.parseShareParams('?@=-34.6,-58.4,25').view, null);
    assert.equal(app.parseShareParams('?@=-34.6,-58.4,16,1').view, null);
    assert.equal(app.parseShareParams('?@=1e3,2').view, null);
    assert.equal(app.parseShareParams('?est=colectivo:60').station, null);
    assert.equal(app.parseShareParams('?est=subte:' + encodeURIComponent('<img>')).station, null);
    assert.equal(app.parseShareParams('?est=subte:').station, null);
});

test('buildShareSearch arma la URL corta y es reversible', () => {
    const state = {
        view: { lat: -34.6086123, lng: -58.374219, zoom: 16 },
        type: 'train',
        query: 'Retiro',
        station: { type: 'train', id: 'Mitre:R1' }
    };
    const search = app.buildShareSearch(state);
    assert.equal(search, '?@=-34.60861,-58.37422,16&capa=tren&q=Retiro&est=tren:Mitre%3AR1');
    const parsed = plain(app.parseShareParams(search));
    assert.equal(parsed.type, 'train');
    assert.equal(parsed.query, 'Retiro');
    assert.deepEqual(parsed.station, { type: 'train', id: 'Mitre:R1' });
    // Colectivos es la capa de siempre: no se escribe.
    assert.equal(app.buildShareSearch({ type: 'bus' }), '');
    assert.equal(app.buildShareSearch({ type: 'none' }), '?capa=ninguna');
    assert.equal(app.buildShareSearch({ query: 'a&b=c' }), '?q=a%26b%3Dc');
    assert.equal(app.buildShareSearch({ station: { type: 'subte', id: '<x>' } }), '');
    assert.equal(app.buildShareSearch(null), '');
});

test('sanitizeFavorite valida tipo, id, color y coordenadas', () => {
    assert.deepEqual(plain(app.sanitizeFavorite({ kind: 'line', type: 'bus', id: '60', label: '60', color: '#ff0000', extra: 'x' })),
        { kind: 'line', type: 'bus', id: '60', label: '60', color: '#ff0000' });
    assert.equal(app.sanitizeFavorite({ kind: 'line', type: 'bike', id: '1' }), null);
    assert.equal(app.sanitizeFavorite({ kind: 'admin', type: 'bus', id: '1' }), null);
    assert.equal(app.sanitizeFavorite({ kind: 'line', type: 'bus', id: '"><script>' }), null);
    assert.equal(app.sanitizeFavorite({ kind: 'line', type: 'bus', id: '' }), null);
    assert.equal(app.sanitizeFavorite(null), null);
    assert.equal(app.sanitizeFavorite('60'), null);

    const evil = app.sanitizeFavorite({ kind: 'station', type: 'subte', id: 'LineaA:A1', label: 'Plaza\u0000 de Mayo'.padEnd(200, '!'), color: 'red;background:url(x)' });
    assert.equal(evil.label.length, 80);
    assert.ok(evil.label.startsWith('Plaza de Mayo'));
    assert.equal(evil.color, '#475569');
    assert.equal(app.sanitizeFavorite({ kind: 'station', type: 'subte', id: 'A1' }).label, 'A1');

    assert.equal(app.sanitizeFavorite({ kind: 'station', type: 'stop', id: '123', lat: 'x', lon: -58 }), null);
    const stop = plain(app.sanitizeFavorite({ kind: 'station', type: 'stop', id: '123', lat: '-34.6', lon: -58.4 }));
    assert.equal(stop.lat, -34.6);
    assert.equal(stop.lon, -58.4);
    assert.equal(app.sanitizeFavorite({ kind: 'station', type: 'bike', id: '7', lat: 200, lon: 0 }).lat, undefined);
});

test('parseFavoritesPayload exige versión, deduplica y limita a 30', () => {
    const items = Array.from({ length: 45 }, (_, index) => ({ kind: 'line', type: 'bus', id: String(index % 40) }));
    const parsed = app.parseFavoritesPayload({ v: 1, items: [{ kind: 'x' }, ...items] });
    assert.equal(parsed.length, 30);
    assert.equal(new Set(parsed.map(item => item.id)).size, 30);
    assert.deepEqual(plain(app.parseFavoritesPayload({ v: 2, items }) ), []);
    assert.deepEqual(plain(app.parseFavoritesPayload({ v: 1, items: 'nope' })), []);
    assert.deepEqual(plain(app.parseFavoritesPayload(null)), []);
});
