// Reporta errores JS no capturados al worker (POST /client-errors). Funcional, no analytics: no
// depende del consentimiento, pero nunca manda coordenadas, query strings ni datos del usuario.
// Se carga justo después de config.js para cubrir el resto de los scripts.
(() => {
    const appConfig = globalThis.APP_CONFIG || {};
    const settings = appConfig.ERROR_REPORTING || {};
    if (settings.enabled === false) return;

    const { hostname, protocol } = globalThis.location;
    const isLocal = protocol === 'file:' || hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '';
    if (isLocal && !settings.allowLocalhost) return;

    const backendUrl = (appConfig.API?.backendBaseUrl || '').toString().replace(/\/+$/, '');
    const path = (appConfig.PATHS?.clientErrors || '/client-errors').toString();
    if (!backendUrl) return;
    const endpoint = `${backendUrl}${path}`;

    const maxPerSession = Math.max(0, Number(settings.maxPerSession ?? 5));
    const storageKey = 'radar-error-reports';
    const seen = new Set();

    const readSentCount = () => {
        try {
            return Number(sessionStorage.getItem(storageKey)) || 0;
        } catch {
            return 0;
        }
    };
    const writeSentCount = count => {
        try {
            sessionStorage.setItem(storageKey, String(count));
        } catch {
            // sessionStorage bloqueado: queda el límite en memoria.
        }
    };
    let sentCount = readSentCount();

    // Sin query/hash en URLs y sin números con muchos decimales (coordenadas).
    const scrub = (value, max) => String(value ?? '')
        .replaceAll(/([a-z][a-z0-9+.-]*:\/\/[^\s?#)'"]*)[?#][^\s)'"]*/gi, '$1')
        .replaceAll(/-?\d{1,3}\.\d{4,}/g, '<num>')
        .slice(0, max);

    function send(report) {
        const body = JSON.stringify(report);
        try {
            const blob = new Blob([body], { type: 'text/plain;charset=UTF-8' });
            if (navigator.sendBeacon?.(endpoint, blob)) return;
        } catch {
            // Se intenta con fetch.
        }
        fetch(endpoint, { method: 'POST', body, keepalive: true, mode: 'cors', credentials: 'omit', headers: { 'Content-Type': 'text/plain;charset=UTF-8' } })
            .catch(() => {});
    }

    function report(kind, message, source, line, col, stack) {
        if (sentCount >= maxPerSession) return;
        const cleanMessage = scrub(message || 'Error sin mensaje', 500);
        const key = `${kind}|${cleanMessage}|${scrub(source, 300)}|${line || 0}`;
        if (seen.has(key)) return;
        seen.add(key);
        sentCount += 1;
        writeSentCount(sentCount);

        send({
            kind,
            message: cleanMessage,
            source: scrub(source, 300) || null,
            line: Number.isInteger(line) ? line : null,
            col: Number.isInteger(col) ? col : null,
            stack: stack ? scrub(stack, 1500) : null,
            url: scrub(`${globalThis.location.origin}${globalThis.location.pathname}`, 300),
            ua: String(navigator.userAgent || '').slice(0, 300),
            appVersion: String(settings.appVersion || '').slice(0, 40) || null,
            ts: Date.now()
        });
    }

    globalThis.addEventListener('error', event => {
        // Errores de carga de recursos (img/script) llegan sin message: no son excepciones JS.
        if (!event.message && !event.error) return;
        report('error', event.message || event.error?.message, event.filename, event.lineno, event.colno, event.error?.stack);
    });

    globalThis.addEventListener('unhandledrejection', event => {
        const reason = event.reason;
        const message = reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason ?? 'Promesa rechazada');
        report('unhandledrejection', message, null, null, null, reason instanceof Error ? reason.stack : null);
    });
})();
