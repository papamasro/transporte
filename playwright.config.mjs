import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT || 8141);

export default defineConfig({
    testDir: './tests/e2e',
    timeout: 45_000,
    expect: { timeout: 10_000 },
    fullyParallel: true,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 1 : 0,
    workers: process.env.CI ? 2 : undefined,
    reporter: process.env.CI
        ? [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]]
        : [['list']],
    use: {
        baseURL: `http://127.0.0.1:${PORT}/transporte/`,
        // Los mocks (page.route) no ven requests atendidos por un SW: se activa solo en su test.
        serviceWorkers: 'block',
        locale: 'es-AR',
        timezoneId: 'America/Argentina/Buenos_Aires',
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure'
    },
    projects: [
        {
            name: 'mobile',
            use: {
                ...devices['Pixel 7'],
                browserName: 'chromium',
                viewport: { width: 390, height: 844 },
                hasTouch: true,
                isMobile: true
            }
        },
        {
            name: 'desktop',
            use: {
                ...devices['Desktop Chrome'],
                viewport: { width: 1440, height: 900 }
            }
        }
    ],
    webServer: {
        command: `node tests/server.mjs ${PORT}`,
        url: `http://127.0.0.1:${PORT}/transporte/`,
        reuseExistingServer: !process.env.CI,
        timeout: 15_000
    }
});
