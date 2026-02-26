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

        function getSubteStaticFallback(station) {
            const lineTable = SUBTE_STATIC_TIMETABLE[station.routeId] || {};
            const baseId = getBaseStopId(station.id);
            const stationKeys = Object.keys(lineTable).filter(stopId => getBaseStopId(stopId) === baseId);
            if (stationKeys.length === 0) return [];

            const lineDef = SUBTE_STATIC.lines[station.routeId];
            const toStartStopId = lineDef?.stations?.[0];
            const toEndStopId = lineDef?.stations?.[lineDef.stations.length - 1];
            const toStartName = SUBTE_STATIC.stations[toStartStopId]?.name || 'Terminal';
            const toEndName = SUBTE_STATIC.stations[toEndStopId]?.name || 'Terminal';

            const result = { toStart: null, toEnd: null };
            stationKeys.forEach(key => {
                const row = lineTable[key] || {};
                if (!result.toStart && row.toStart) result.toStart = row.toStart;
                if (!result.toEnd && row.toEnd) result.toEnd = row.toEnd;
            });

            const entries = [];
            if (result.toStart) {
                entries.push({
                    routeShort: lineDef.short,
                    destination: toStartName,
                    staticTime: result.toStart,
                    delay: 0,
                    isStatic: true
                });
            }
            if (result.toEnd) {
                entries.push({
                    routeShort: lineDef.short,
                    destination: toEndName,
                    staticTime: result.toEnd,
                    delay: 0,
                    isStatic: true
                });
            }

            return entries;
        }
