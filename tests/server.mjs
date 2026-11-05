// Servidor estático mínimo para los tests: sirve la raíz del repo bajo /transporte/ (igual que
// GitHub Pages en https://papamasro.github.io/transporte/). Uso: node tests/server.mjs [puerto]
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = '/transporte/';
const PORT = Number(process.argv[2] || process.env.PORT || 8141);

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.webmanifest': 'application/manifest+json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.woff2': 'font/woff2',
    '.txt': 'text/plain; charset=utf-8',
    '.map': 'application/json; charset=utf-8'
};

// Nada fuera del sitio publicado (dependencias, worker, tests, git).
const BLOCKED = /^(node_modules|worker|tests|\.git|scripts|tickets)(\/|$)/;

const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/' || url.pathname === '/transporte') {
        res.writeHead(302, { Location: BASE });
        res.end();
        return;
    }
    if (!url.pathname.startsWith(BASE)) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
        return;
    }

    let relative = decodeURIComponent(url.pathname.slice(BASE.length));
    if (relative === '' || relative.endsWith('/')) relative += 'index.html';
    const filePath = path.resolve(ROOT, relative);
    if (!filePath.startsWith(ROOT + path.sep) || BLOCKED.test(relative)) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
        return;
    }

    try {
        const info = await stat(filePath);
        if (!info.isFile()) throw new Error('not a file');
        const body = await readFile(filePath);
        res.writeHead(200, {
            'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
            'Content-Length': body.length,
            'Cache-Control': 'no-cache'
        });
        res.end(req.method === 'HEAD' ? undefined : body);
    } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
    }
});

server.listen(PORT, '127.0.0.1', () => {
    console.log(`Sirviendo ${ROOT} en http://127.0.0.1:${PORT}${BASE}`);
});
