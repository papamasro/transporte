        function formatLineName(name) {
            if (!name) return "??";
            return name.toString().replace(/^0+/, '') || name;
        }

        function getBusDisplayLine(vehicle) {
            const headsign = (vehicle?.trip_headsign || '').toString();
            const headsignMatch = headsign.match(/^\s*(\d{1,4})\b/);
            if (headsignMatch) return headsignMatch[1];

            const shortName = (vehicle?.route_short_name || '').toString();
            const shortNameMatch = shortName.match(/^0*(\d{1,4})/);
            if (shortNameMatch) return shortNameMatch[1];

            return formatLineName(vehicle?.route_short_name || vehicle?.route_id || '??');
        }

        function getColor(type, line) {
            if (type === 'bike') return '#10b981';
            if (lineColors[line]) return lineColors[line];
            let hash = 0;
            for (let i = 0; i < line.length; i++) hash = (line.codePointAt(i) || 0) + ((hash << 5) - hash);
            lineColors[line] = `hsl(${Math.abs(hash % 360)}, 65%, 45%)`;
            return lineColors[line];
        }
        function normalizeText(value) {
            return (value || '')
                .toString()
                .normalize('NFD')
                .replaceAll(/[\u0300-\u036f]/g, '')
                .toLowerCase()
                .trim();
        }

        function formatTimestamp(ts) {
            if (!ts) return '--:--';
            return new Date(ts * 1000).toLocaleTimeString('es-AR', {
                hour12: false,
                hour: '2-digit',
                minute: '2-digit'
            });
        }

        function formatDelay(delaySeconds) {
            const minutes = Math.round((delaySeconds || 0) / 60);
            if (minutes <= 0) return 'A tiempo';
            return `+${minutes} min`;
        }

        function formatEtaMinutes(arrivalTime, referenceTs) {
            if (!arrivalTime) return '-';
            const minToArrival = Math.round((arrivalTime - referenceTs) / 60);
            if (minToArrival <= 0) return 'Próximo';
            if (minToArrival === 1) return 'En 1 min';
            return `En ${minToArrival} min`;
        }

        function isSuspiciousTripRealtime(estaciones, headerTs) {
            if (!Array.isArray(estaciones) || estaciones.length < 6 || !headerTs) return false;
            let sameAsHeader = 0;
            estaciones.forEach(est => {
                if ((est?.arrival?.time || 0) === headerTs) sameAsHeader += 1;
            });
            return (sameAsHeader / estaciones.length) >= 0.6;
        }

        function getDelayTone(delaySeconds) {
            const minutes = Math.round((delaySeconds || 0) / 60);
            if (minutes <= 1) {
                return {
                    textClass: 'text-emerald-600',
                    badgeClass: 'bg-emerald-50 border-emerald-200 text-emerald-700',
                    borderColor: '#34d399'
                };
            }
            if (minutes <= 4) {
                return {
                    textClass: 'text-amber-600',
                    badgeClass: 'bg-amber-50 border-amber-200 text-amber-700',
                    borderColor: '#fbbf24'
                };
            }
            return {
                textClass: 'text-rose-600',
                badgeClass: 'bg-rose-50 border-rose-200 text-rose-700',
                borderColor: '#fb7185'
            };
        }

        function getBaseStopId(stopId) {
            if (!stopId) return '';
            return stopId.toString().replace(/[NSEO]$/, '');
        }

        function formatSubteDataStatus(stationHasDynamicData) {
            const ts = globalThis.cache.subteTimestamp;
            if (stationHasDynamicData && ts) {
                return `Dinámico API • ${new Date(ts * 1000).toLocaleTimeString('es-AR', { hour12: false })}`;
            }
            return 'Sin dinámico • solo estático GTFS';
        }

