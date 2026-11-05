        let isAlertsOpen = false;
        let isAlertsLoading = false;
        let alertsRequestId = 0;

        function getAlertPath(pathKey, fallback) {
            return (globalThis.APP_CONFIG?.PATHS?.[pathKey] || fallback || '').toString();
        }

        function renderAlertsLoadingState(container) {
            const row = '<div class="skeleton-row is-text"><span class="skeleton-lines"><span></span><span></span><span></span></span></div>';
            container.setAttribute('aria-busy', 'true');
            container.innerHTML = `<div class="skeleton-list" aria-hidden="true">${row.repeat(3)}</div><p class="sr-only">Cargando alertas…</p>`;
        }

        async function fetchAlertText(path) {
            const response = await fetch(`${BACKEND_URL}${path}`);
            if (!response.ok) throw new Error(`HTTP ${response.status} en ${path}`);
            return response.text();
        }

        // Primero el JSON que decodifica el worker (/…/serviceAlertsJson). Si esa ruta todavía no
        // está desplegada (404, se recuerda en la sesión) o falla, se lee el feed crudo como texto.
        const alertsJsonUnsupported = new Set();

        function getAlertSourceLabel(source, alert) {
            if (source !== 'Subte') return source;
            const lines = Array.from(new Set((alert.informed_entity || [])
                .map(entity => /^Linea([A-Z0-9]+)$/i.exec(entity?.route_id || '')?.[1]?.toUpperCase())
                .filter(Boolean)));
            return lines.length > 0 ? `Subte · Línea ${lines.join(', ')}` : source;
        }

        function parseAlertsJson(payload, source) {
            if (!payload || !Array.isArray(payload.alerts)) return null;
            return payload.alerts
                .map(alert => {
                    const header = (alert?.header_text || '').toString().trim();
                    const description = (alert?.description_text || '').toString().trim();
                    let text = description || header;
                    if (header && description && !description.startsWith(header)) text = `${header}: ${description}`;
                    return { text, source: getAlertSourceLabel(source, alert || {}) };
                })
                .filter(item => item.text);
        }

        async function fetchSourceAlerts(jsonPathKey, jsonFallback, rawPath, source, parseRaw) {
            const jsonPath = getAlertPath(jsonPathKey, jsonFallback);
            if (jsonPath && !alertsJsonUnsupported.has(jsonPath)) {
                const response = await fetchAPI(jsonPath);
                const parsed = response.success ? parseAlertsJson(response.data, source) : null;
                if (parsed) return parsed;
                if (response.status === 404) alertsJsonUnsupported.add(jsonPath);
            }
            return parseRaw(await fetchAlertText(rawPath));
        }

        async function fetchAlertsData() {
            const subteServiceAlertsPath = getAlertPath('subteServiceAlerts', '/subtes/serviceAlerts');
            const busServiceAlertsPath = getAlertPath('busServiceAlerts', '/colectivos/serviceAlerts');
            const subteEnabled = isFeatureEnabled('subteServiceAlerts');
            const busEnabled = isFeatureEnabled('busServiceAlerts');
            const [subteRes, coleRes] = await Promise.allSettled([
                subteEnabled
                    ? fetchSourceAlerts('subteServiceAlertsJson', '/subtes/serviceAlertsJson', subteServiceAlertsPath, 'Subte',
                        rawText => parseServiceAlerts(rawText, 'Subte'))
                    : Promise.resolve(null),
                busEnabled
                    ? fetchSourceAlerts('busServiceAlertsJson', '/colectivos/serviceAlertsJson', busServiceAlertsPath, 'Colectivo',
                        rawText => parseColectivoAlerts(rawText))
                    : Promise.resolve(null)
            ]);

            const requestedResults = [subteEnabled && subteRes, busEnabled && coleRes].filter(Boolean);
            if (requestedResults.length > 0 && requestedResults.every(res => res.status === 'rejected')) {
                throw new Error('No se pudo obtener ninguna fuente de alertas');
            }

            const allAlerts = [];
            if (subteRes.status === 'fulfilled') {
                allAlerts.push(...(subteRes.value || []));
            }
            if (coleRes.status === 'fulfilled') {
                allAlerts.push(...(coleRes.value || []));
            }

            return allAlerts;
        }

        async function openAlertPanel(panel, container) {
            if (!isFeatureEnabled('alertsPanel')) return;

            const requestId = ++alertsRequestId;
            panel.classList.add('is-open');
            if (typeof setStatus === 'function') setStatus('CARGANDO');
            renderAlertsLoadingState(container);
            isAlertsLoading = true;

            try {
                const allAlerts = await fetchAlertsData();
                if (requestId !== alertsRequestId || !isAlertsOpen) return;
                renderAlertsContent(allAlerts);
                if (typeof setStatus === 'function') setStatus('LIVE');
            } catch {
                if (requestId !== alertsRequestId || !isAlertsOpen) return;
                if (typeof setStatus === 'function') setStatus('ERROR');
                container.innerHTML = `
                    <div class="nearby-empty-state is-error">
                        <p class="nearby-empty-title">Error al cargar alertas</p>
                        <p class="nearby-empty-text">No pudimos consultar las alertas del servicio.</p>
                        <button type="button" class="chip" data-alerts-action="retry">Reintentar</button>
                    </div>`;
                if (container.dataset.retryReady !== 'true') {
                    container.dataset.retryReady = 'true';
                    container.addEventListener('click', event => {
                        if (!event.target.closest('[data-alerts-action="retry"]') || !isAlertsOpen) return;
                        // El botón desaparece con el estado de carga: el foco no puede quedar en el body.
                        document.getElementById('alerts-back')?.focus({ preventScroll: true });
                        openAlertPanel(panel, container);
                    });
                }
            } finally {
                container.removeAttribute('aria-busy');
                if (requestId === alertsRequestId) isAlertsLoading = false;
            }
        }

        async function toggleAlertPanel() {
            if (!isFeatureEnabled('alertsPanel')) {
                isAlertsOpen = false;
                return;
            }

            const willOpen = !isAlertsOpen;
            if (willOpen && typeof closeNearbyPanel === 'function') {
                closeNearbyPanel();
            }

            isAlertsOpen = willOpen;
            if (typeof setDashboardActionActive === 'function') {
                setDashboardActionActive('alerts', isAlertsOpen);
            }
            const panel = document.getElementById('alerts-panel');
            const container = document.getElementById('alerts-container');
            if (!panel || !container) return;
            
            if (isAlertsOpen) {
                await openAlertPanel(panel, container);
                return;
            }

            panel.classList.remove('is-open');
            alertsRequestId += 1;
            if (isAlertsLoading) {
                isAlertsLoading = false;
                if (typeof setStatus === 'function') setStatus('LIVE');
            }
        }

        // El feed es GTFS-RT (protobuf) leído como texto: cada traducción es `0x0A <largo varint> <texto>`
        // antes de `0x12 0x02 "es"`. Un primer byte de varint >= 0x80 llega como U+FFFD (EF BF BD).
        function extractTranslationText(chunk) {
            const bytes = new TextEncoder().encode(chunk);
            for (let start = bytes.length - 1; start >= 2; start -= 1) {
                const textLength = bytes.length - start;
                const isShortPrefix = textLength < 128 && bytes[start - 1] === textLength && bytes[start - 2] === 0x0a;
                const isLongPrefix = textLength >= 128 && start >= 5 && bytes[start - 1] === (textLength >> 7)
                    && bytes[start - 2] === 0xbd && bytes[start - 3] === 0xbf && bytes[start - 4] === 0xef && bytes[start - 5] === 0x0a;
                if (isShortPrefix || isLongPrefix) return new TextDecoder().decode(bytes.subarray(start));
            }
            return null;
        }

        function parseServiceAlerts(rawText, source) {
            const alerts = [];
            const marker = `${String.fromCodePoint(0x12)}${String.fromCodePoint(0x02)}es`;
            const chunks = String(rawText || '').split(marker);
            for (let i = 0; i < chunks.length - 1; i += 1) {
                const cleanMessage = (extractTranslationText(chunks[i]) ?? (chunks[i].split('=').pop() || '')).trim();
                if (cleanMessage) alerts.push({ text: cleanMessage, source });
            }
            return alerts;
        }

        function parseColectivoAlerts(rawText) {
            const readableAlerts = parseServiceAlerts(rawText, 'Colectivo');
            if (readableAlerts.length > 0) {
                return readableAlerts;
            }

            const codes = Array.from(new Set((rawText.match(/\b\d{5,10}\b/g) || [])));
            if (codes.length === 0) {
                return [{
                    source: 'Colectivo',
                    text: 'Sin alertas reportadas en este momento.'
                }];
            }

            return [{
                source: 'Colectivo',
                text: `Hay ${codes.length} alertas activas de colectivos, pero el feed llega en formato binario y no trae detalle textual legible en esta fuente.`
            }];
        }

        function getAlertSourceKind(source) {
            const normalized = normalizeText(source);
            if (normalized.startsWith('subte')) return 'subte';
            if (normalized.startsWith('colectivo')) return 'bus';
            return 'other';
        }

        function renderAlertsContent(alertsData) {
            const container = document.getElementById('alerts-container');
            const seen = new Set();
            const cards = [];

            alertsData.forEach(item => {
                const msg = item.text;
                if (!msg || seen.has(msg) || msg.length <= 5) return;
                seen.add(msg);
                const sourceTag = item.source ? `<span class="alert-card-source">${escapeHtml(item.source)}</span>` : '';
                cards.push(`<li class="alert-card is-${getAlertSourceKind(item.source)}">${sourceTag}<p class="alert-card-text">${escapeHtml(msg)}</p></li>`);
            });

            container.innerHTML = cards.length > 0
                ? `<p class="nearby-summary">${cards.length} ${cards.length === 1 ? 'alerta activa' : 'alertas activas'}</p><ul class="alerts-cards">${cards.join('')}</ul>`
                : '<div class="nearby-empty-state"><p class="nearby-empty-title">Todo en orden</p><p class="nearby-empty-text">No hay alertas reportadas en este momento.</p></div>';
        }
