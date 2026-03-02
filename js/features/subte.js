        function buildSubteForecastIndex(forecastData) {
            const byStop = {};
            const byBaseStop = {};
            const byName = {};
            const headerTs = forecastData?.Header?.timestamp || 0;

            (forecastData?.Entity || []).forEach(entity => {
                const linea = entity?.Linea;
                if (!linea) return;
                if (isSuspiciousTripRealtime(linea.Estaciones || [], headerTs)) return;

                const routeId = linea.Route_Id || 'Subte';
                const routeShort = routeId.replace('Linea', '');
                const tripId = linea.Trip_Id || '-';
                const directionId = Number(linea.Direction_ID);
                const destination = (linea.Estaciones || []).slice(-1)[0]?.stop_name || '-';

                (linea.Estaciones || []).forEach(est => {
                    const row = {
                        routeId,
                        routeShort,
                        tripId,
                        directionId,
                        destination,
                        stopId: est.stop_id,
                        stopName: est.stop_name,
                        arrivalTime: est.arrival?.time || 0,
                        delay: est.arrival?.delay || 0
                    };

                    if (!byStop[row.stopId]) byStop[row.stopId] = [];
                    byStop[row.stopId].push(row);

                    const baseStopId = getBaseStopId(row.stopId);
                    if (!byBaseStop[baseStopId]) byBaseStop[baseStopId] = [];
                    byBaseStop[baseStopId].push(row);

                    const normalizedName = normalizeText(row.stopName);
                    if (!byName[normalizedName]) byName[normalizedName] = [];
                    byName[normalizedName].push(row);
                });
            });

            Object.values(byStop).forEach(list => list.sort((a, b) => a.arrivalTime - b.arrivalTime));
            Object.values(byBaseStop).forEach(list => list.sort((a, b) => a.arrivalTime - b.arrivalTime));
            Object.values(byName).forEach(list => list.sort((a, b) => a.arrivalTime - b.arrivalTime));

            globalThis.cache.subteForecastByStop = byStop;
            globalThis.cache.subteForecastByBaseStop = byBaseStop;
            globalThis.cache.subteForecastByName = byName;
        }

        function getSubteStationForecast(station) {
            const byBaseStop = globalThis.cache.subteForecastByBaseStop[getBaseStopId(station.id)] || [];
            const byName = byBaseStop.length === 0
                ? (globalThis.cache.subteForecastByName[normalizeText(station.name)] || [])
                : [];

            const merged = [...byBaseStop, ...byName]
                .filter(item => item.routeId === station.routeId)
                .sort((a, b) => a.arrivalTime - b.arrivalTime);

            if (merged.length === 0) {
                return (globalThis.cache.subteForecastByStop[station.id] || [])
                    .filter(item => item.routeId === station.routeId)
                    .sort((a, b) => a.arrivalTime - b.arrivalTime);
            }

            return merged;
        }

