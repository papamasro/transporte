        async function toggleAlertPanel() {
            isAlertsOpen = !isAlertsOpen;
            const panel = document.getElementById('alerts-panel');
            const container = document.getElementById('alerts-container');
            
            if (isAlertsOpen) {
                panel.style.display = 'flex';
                container.innerHTML = `
                    <div class="text-[10px] text-slate-500 text-center py-4 flex flex-col items-center gap-1">
                        <i data-lucide="loader-2" class="w-4 h-4 animate-spin text-amber-500"></i>
                        Cargando alertas...
                    </div>`;
                lucide.createIcons();
                
                try {
                    const [subteRes, coleRes] = await Promise.allSettled([
                        fetch(`${BACKEND_URL}/subtes/serviceAlerts`).then(r => r.text()),
                        fetch(`${BACKEND_URL}/colectivos/serviceAlerts`).then(r => r.text())
                    ]);

                    const allAlerts = [];
                    if (subteRes.status === 'fulfilled') {
                        allAlerts.push(...parseServiceAlerts(subteRes.value, 'Subte'));
                    }
                    if (coleRes.status === 'fulfilled') {
                        allAlerts.push(...parseColectivoAlerts(coleRes.value));
                    }

                    renderAlertsContent(allAlerts);
                } catch (e) {
                    container.innerHTML = '<div class="text-[10px] text-red-500 font-bold text-center py-2">Error al cargar alertas</div>';
                }
            } else {
                panel.style.display = 'none';
            }
        }

        function parseServiceAlerts(rawText, source) {
            const alerts = [];
            const regex = /=([^=]+?)(?:\x12\x02es|\u0012\u0002es)/g;
            let match;
            while ((match = regex.exec(rawText)) !== null) {
                const cleanMessage = match[1].trim();
                if (cleanMessage) alerts.push({ text: cleanMessage, source });
            }
            return alerts;
        }

        function parseColectivoAlerts(rawText) {
            const codes = Array.from(new Set((rawText.match(/\b\d{5,10}\b/g) || [])));
            if (codes.length === 0) {
                return [{
                    source: 'Colectivo',
                    text: 'Sin alertas reportadas en este momento.'
                }];
            }

            return [{
                source: 'Colectivo',
                text: `La API reporta ${codes.length} alertas activas, pero no publica texto legible del detalle.`
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
