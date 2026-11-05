import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadScripts } from './load-scripts.mjs';

const app = loadScripts(['js/shared/utils.js']);

test('matchesLineToken: "60" no matchea 160 ni 601', () => {
    const token = value => app.normalizeLineToken(value);
    const matches = (line, filter) => app.matchesLineToken(token(line), token(filter));
    assert.equal(matches('60', '60'), true);
    assert.equal(matches('60A', '60'), true);
    assert.equal(matches('60 Ramal Escobar', '60'), true);
    assert.equal(matches('160', '60'), false);
    assert.equal(matches('601', '60'), false);
    assert.equal(matches('6', '60'), false);
    assert.equal(matches('60', '6'), false);
    assert.equal(matches('Línea B', 'linea b'), true);
    assert.equal(matches('anything', ''), true);
    assert.equal(matches('', '60'), false);
});

test('escapeHtml escapa los cinco caracteres peligrosos', () => {
    assert.equal(app.escapeHtml('<img src=x onerror="a(\'1\')">&'), '&lt;img src=x onerror=&quot;a(&#39;1&#39;)&quot;&gt;&amp;');
    assert.equal(app.escapeHtml(null), '');
    assert.equal(app.escapeHtml(undefined), '');
    assert.equal(app.escapeHtml(0), '0');
    assert.equal(app.escapeHtml('Línea 60 – Constitución'), 'Línea 60 – Constitución');
});

test('safeCssColor acepta hex/rgb/hsl y rechaza inyecciones', () => {
    for (const color of ['#fff', '#4f46e5', '#4f46e5cc', 'rgb(1, 2, 3)', 'rgba(1,2,3,0.5)', 'hsl(120, 65%, 45%)', ' #abc ']) {
        assert.equal(app.safeCssColor(color), color.trim(), color);
    }
    for (const color of ['red;background:url(x)', '#fff" onmouseover="x', 'url(javascript:alert(1))', 'expression(1)', '#ggg', 'rgb(1,2)']) {
        assert.equal(app.safeCssColor(color), '#64748b', color);
    }
    assert.equal(app.safeCssColor('', '#000'), '#000');
    assert.equal(app.safeCssColor(null, '#000'), '#000');
});

test('haversineMeters: distancias conocidas', () => {
    assert.equal(app.haversineMeters(-34.6, -58.4, -34.6, -58.4), 0);
    // 1° de latitud ≈ 111.19 km con R = 6371 km.
    assert.ok(Math.abs(app.haversineMeters(-34, -58, -35, -58) - 111195) < 5);
    // Obelisco -> Plaza de Mayo ≈ 1.15 km.
    const obeliscoPlaza = app.haversineMeters(-34.60373, -58.38157, -34.60837, -58.37215);
    assert.ok(obeliscoPlaza > 950 && obeliscoPlaza < 1050, String(obeliscoPlaza));
    // Simétrica.
    assert.equal(app.haversineMeters(1, 2, 3, 4), app.haversineMeters(3, 4, 1, 2));
});

test('formatEtaMinutes', () => {
    const now = 1_700_000_000;
    assert.equal(app.formatEtaMinutes(0, now), '-');
    assert.equal(app.formatEtaMinutes(null, now), '-');
    assert.equal(app.formatEtaMinutes(now - 120, now), 'Próximo');
    assert.equal(app.formatEtaMinutes(now + 20, now), 'Próximo');
    assert.equal(app.formatEtaMinutes(now + 60, now), 'En 1 min');
    assert.equal(app.formatEtaMinutes(now + 89, now), 'En 1 min');
    assert.equal(app.formatEtaMinutes(now + 600, now), 'En 10 min');
});
