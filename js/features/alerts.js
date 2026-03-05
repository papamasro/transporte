        let isAlertsOpen = false;

        function getAlertPath(pathKey, fallback) {
            return (globalThis.APP_CONFIG?.PATHS?.[pathKey] || fallback || '').toString();
        }

        function renderAlertsLoadingState(container) {
            container.innerHTML = `
                <div class="text-[10px] text-slate-500 text-center py-4 flex flex-col items-center gap-1">
                    <i data-lucide="loader-2" class="w-4 h-4 animate-spin text-amber-500"></i>
                    Cargando alertas...
                </div>`;
            lucide.createIcons();
        }

        async function fetchAlertsData() {
            const subteServiceAlertsPath = getAlertPath('subteServiceAlerts', '/subtes/serviceAlerts');
            const busServiceAlertsPath = getAlertPath('busServiceAlerts', '/colectivos/serviceAlerts');
            const [subteRes, coleRes] = await Promise.allSettled([
                fetch(`${BACKEND_URL}${subteServiceAlertsPath}`).then(r => r.text()),
                fetch(`${BACKEND_URL}${busServiceAlertsPath}`).then(r => r.text())
            ]);

            const allAlerts = [];
            if (subteRes.status === 'fulfilled') {
                allAlerts.push(...parseServiceAlerts(subteRes.value, 'Subte'));
            }
            if (coleRes.status === 'fulfilled') {
                allAlerts.push(...parseColectivoAlerts(coleRes.value));
            }

            return allAlerts;
        }

        async function openAlertPanel(panel, container) {
            panel.classList.add('is-open');
            if (typeof setStatus === 'function') setStatus('CARGANDO');
            renderAlertsLoadingState(container);

            try {
                const allAlerts = await fetchAlertsData();
                renderAlertsContent(allAlerts);
                if (typeof setStatus === 'function') setStatus('LIVE');
            } catch {
                if (typeof setStatus === 'function') setStatus('ERROR');
                container.innerHTML = '<div class="text-[10px] text-red-500 font-bold text-center py-2">Error al cargar alertas</div>';
            }
        }

        async function toggleAlertPanel() {
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
        }

        function parseServiceAlerts(rawText, source) {
            const alerts = [];
            const marker = `${String.fromCodePoint(0x12)}${String.fromCodePoint(0x02)}es`;
            const chunks = String(rawText || '').split(marker);
            for (let i = 0; i < chunks.length - 1; i += 1) {
                const cleanMessage = (chunks[i].split('=').pop() || '').trim();
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

        // CAMBIO 2: Lógica adaptada a la nueva estructura parseada
        function renderAlertsContent(alertsData) {
            const container = document.getElementById('alerts-container');
            container.innerHTML = '';
            const seen = new Set();
            let count = 0;
            
            alertsData.forEach(item => {
                const msg = item.text;
                if (msg && !seen.has(msg) && msg.length > 5) {
                    seen.add(msg); count++;
                    const el = document.createElement('div');
                    el.className = 'bg-amber-50/50 p-2.5 rounded-xl border-l-4 border-amber-400 shadow-sm mx-0.5 mt-1';
                    const sourceTag = item.source ? `<span class="text-[8px] font-black uppercase text-slate-400">${item.source}</span>` : '';
                    el.innerHTML = `<div class="mb-0.5">${sourceTag}</div><p class="text-[10px] text-slate-700 font-medium leading-tight">${msg}</p>`;
                    container.appendChild(el);
                }
            });
            
            if (count === 0) {
                container.innerHTML = '<div class="text-[10px] text-slate-500 text-center py-4 font-medium">No hay alertas reportadas en este momento.</div>';
            }
        }
