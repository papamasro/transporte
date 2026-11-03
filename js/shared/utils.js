function formatLineName(name) {
    if (!name) return "??";
    return name.toString().replace(/^0+/, '') || name;
}

function getVehicleShortName(vehicle) {
    const candidates = [
        vehicle?.route_short_name,
        vehicle?.routeShortName,
        vehicle?.short_name,
        vehicle?.shortName,
        vehicle?.vehicle?.trip?.route_short_name,
        vehicle?.vehicle?.trip?.routeShortName,
        vehicle?.trip?.route_short_name,
        vehicle?.trip?.routeShortName
    ];

    for (const candidate of candidates) {
        const value = (candidate || '').toString().trim();
        if (value) return value;
    }

    return '';
}

function getBusDisplayLine(vehicle) {
    const candidates = [
        getVehicleShortName(vehicle),
        vehicle?.route_id,
        vehicle?.trip_headsign
    ];

    for (const candidate of candidates) {
        const str = (candidate || '').toString().trim();
        if (!str) continue;

        // Extraer identificador limpio de la línea (ej: "140", "140H", "60", "152")
        // Ignora descripciones largas posteriores como "140h - Estación Villa Urquiza" o "140hEstacion..."
        const match = str.match(/^(?:linea\s*)?(\d{1,4}\s*[a-zA-Z]?)/i);
        if (match && match[1]) {
            const cleaned = match[1].replaceAll(/\s+/g, '').toUpperCase();
            if (cleaned.length <= 5) return cleaned;
        }

        const innerDigits = str.match(/\b(\d{1,4}[a-zA-Z]?)\b/);
        if (innerDigits && innerDigits[1]) {
            const cleaned = innerDigits[1].toUpperCase();
            if (cleaned.length <= 5) return cleaned;
        }
    }

    const fallback = formatLineName(getVehicleShortName(vehicle) || vehicle?.route_id || '??');
    return fallback.slice(0, 5).toUpperCase();
}

function getColor(type, line) {
    if (type === 'bike') return '#10b981';
    const safeLine = (line || 'default').toString();
    if (lineColors[safeLine]) return lineColors[safeLine];
    let hash = 0;
    for (let i = 0; i < safeLine.length; i++) hash = (safeLine.codePointAt(i) || 0) + ((hash << 5) - hash);
    lineColors[safeLine] = `hsl(${Math.abs(hash % 360)}, 65%, 45%)`;
    return lineColors[safeLine];
}

function normalizeText(value) {
    return (value || '')
        .toString()
        .normalize('NFD')
        .replaceAll(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .trim();
}

function normalizeLineToken(value) {
    return normalizeText(value).replaceAll(/[^a-z0-9]+/g, '');
}

function formatTimestamp(ts) {
    if (!ts || ts <= 0) return '--:--';
    return new Date(ts * 1000).toLocaleTimeString('es-AR', {
        timeZone: 'America/Argentina/Buenos_Aires',
        hour12: false,
        hour: '2-digit',
        minute: '2-digit'
    });
}

function formatDelay(delaySeconds) {
    const minutes = Math.round((delaySeconds || 0) / 60);
    if (minutes === 0) return 'A tiempo';
    if (minutes < 0) return `${minutes} min (adelantado)`;
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
