// Genera assets/icons/icon-maskable-{192,512}.png a partir del dibujo de assets/icons/icon.svg:
// fondo a sangre (color de theme_color/fondo del ícono) y el pin dentro de la zona segura de
// maskable (círculo central del 80%). Uso: node scripts/build-maskable-icons.mjs
import { chromium } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BACKGROUND = '#4f46e5';

// Mismos paths que icon.svg sin el rect redondeado. El pin ocupa y 112..496 (centro 304, radio
// máximo 192 desde el centro de su caja); escala 0.9 => radio 173 px < 204.8 (40% de 512).
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="100%" height="100%">
  <rect width="512" height="512" fill="${BACKGROUND}"/>
  <g transform="translate(256 256) scale(0.9) translate(-256 -304)">
    <circle cx="256" cy="184" r="80" fill="#ffffff"/>
    <path d="M256 496c-16-22-128-179-128-256 0-70.7 57.3-128 128-128s128 57.3 128 128c0 77-112 234-128 256z" fill="#ffffff" fill-opacity="0.95"/>
    <circle cx="256" cy="184" r="44" fill="${BACKGROUND}"/>
  </g>
</svg>`;

const browser = await chromium.launch();
try {
    for (const size of [192, 512]) {
        const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
        await page.setContent(`<!doctype html><html><body style="margin:0;width:${size}px;height:${size}px;overflow:hidden">${svg}</body></html>`);
        const file = path.join(root, 'assets', 'icons', `icon-maskable-${size}.png`);
        await page.screenshot({ path: file, clip: { x: 0, y: 0, width: size, height: size } });
        await page.close();
        console.log(`OK ${path.relative(root, file)}`);
    }
} finally {
    await browser.close();
}
