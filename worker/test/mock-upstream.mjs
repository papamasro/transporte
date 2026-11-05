// Upstream falso para `wrangler dev`: sirve fixtures capturados y cuenta los hits por ruta.
// GET /__stats -> { hits }, GET /__fail?on=1|0 -> fuerza 500 en todas las rutas.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

const PORT = Number(process.env.MOCK_PORT || 8799);
const BUS_DELAY_MS = Number(process.env.BUS_DELAY_MS || 1500);
const fixture = name => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));

const routes = {
    '/colectivos/vehiclePositionsSimple': { file: 'bus.json', type: 'application/json', delay: BUS_DELAY_MS, gcba: true },
    '/subtes/forecastGTFS': { file: 'subte.json', type: 'application/json', gcba: true },
    '/ecobici/gbfs/stationStatus': { file: 'bike-status.json', type: 'application/json', gcba: true },
    '/ecobici/gbfs/stationInformation': { file: 'bike-info.json', type: 'application/json', gcba: true },
    '/subtes/serviceAlerts': { file: 'alerts.bin', type: 'application/octet-stream', gcba: true },
    '/colectivos/serviceAlerts': { file: 'alerts.bin', type: 'application/x-protobuf', gcba: true },
    '/ciclovias.geojson': { file: 'bicisenda.json', type: 'application/json' },
};

const hits = {};
let failing = false;

createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    if (url.pathname === '/__stats') return send(res, 200, 'application/json', JSON.stringify({ hits, failing }));
    if (url.pathname === '/__reset') { Object.keys(hits).forEach(key => delete hits[key]); return send(res, 200, 'text/plain', 'ok'); }
    if (url.pathname === '/__fail') { failing = url.searchParams.get('on') === '1'; return send(res, 200, 'text/plain', String(failing)); }

    hits[url.pathname] = (hits[url.pathname] || 0) + 1;
    if (failing) return send(res, 500, 'text/plain', 'upstream caído (simulado)');

    const arrivals = url.pathname.match(/^\/arribos\/estacion\/(\d+)$/);
    if (arrivals) {
        if (arrivals[1] === '403') return send(res, 403, 'text/html', '<h1>403 Forbidden</h1>');
        return send(res, 200, 'application/json', JSON.stringify({ timestamp: Math.floor(Date.now() / 1000), results: [{ arribo: { segundos: 120 }, servicio: { numero: url.searchParams.get('ramal') || 'x' } }] }));
    }

    const spec = routes[url.pathname];
    if (!spec) return send(res, 404, 'text/plain', 'no existe');
    if (spec.gcba && (!url.searchParams.get('client_id') || !url.searchParams.get('client_secret'))) {
        return send(res, 401, 'application/json', '{"error":"sin credenciales"}');
    }
    if (spec.delay) await new Promise(resolve => setTimeout(resolve, spec.delay));
    send(res, 200, spec.type, fixture(spec.file));
}).listen(PORT, '127.0.0.1', () => console.log(`mock upstream en http://127.0.0.1:${PORT}`));

function send(res, status, type, body) {
    res.writeHead(status, { 'Content-Type': type });
    res.end(body);
}
