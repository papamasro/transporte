#!/usr/bin/env python3
"""Genera recorridos estáticos de colectivos (data/routes/) a partir del GTFS estático del GCBA.

Reemplaza las consultas a D1 de /buscar-linea e /info-trayecto: el frontend lee estos JSON
directo de GitHub Pages (gzip) y solo vuelve al worker si falta un archivo.

Uso:
    python3 scripts/build-static-routes.py --gtfs colectivos-gtfs.zip [--out data/routes]
        [--tolerance 7] [--realtime-sample vehiclePositionsSimple.json]

--gtfs acepta el .zip o una carpeta con los .txt. El zip se descarga con las credenciales
de la API (no se guardan en ningún lado):
    curl -L -o /tmp/colectivos-gtfs.zip \
      "https://apitransporte.buenosaires.gob.ar/colectivos/feed-gtfs?client_id=$GCBA_CLIENT_ID&client_secret=$GCBA_CLIENT_SECRET"

Salida:
- data/routes/index.json: { lines: { "<route_short_name>": { file, variants: [...] } },
  routes: { "<route_id>": "<file>" } }
- data/routes/<file>.json: un archivo por línea "base" (dígitos iniciales: 60A, 60B... -> 60.json)
  con variantes (shape simplificado con Douglas-Peucker y codificado como polyline de Google,
  precisión 5), paradas por variante y el mapa route_id + direction_id -> variante que usan las
  posiciones en tiempo real (vehiclePositionsSimple trae route_id y direction del GTFS vigente).

--realtime-sample imprime el porcentaje de vehículos de una muestra de vehiclePositionsSimple
con variante exacta (route_id + direction) en la salida generada; con --min-exact-pct sale con
error si ese porcentaje queda por debajo del mínimo.
"""

import argparse
import csv
import io
import json
import math
import os
import re
import sys
import time
import unicodedata
import zipfile
from collections import Counter, defaultdict

SCHEMA_VERSION = 1
MAX_STOP_CANDIDATE_TRIPS = 3


# ─── Lectura del GTFS ────────────────────────────────────────────────────────

class GtfsSource:
    def __init__(self, path):
        self.path = path
        self.zip = zipfile.ZipFile(path) if os.path.isfile(path) else None
        if self.zip:
            self.names = {os.path.basename(name): name for name in self.zip.namelist()}

    def has(self, name):
        if self.zip:
            return name in self.names
        return os.path.exists(os.path.join(self.path, name))

    def rows(self, name):
        if self.zip:
            raw = self.zip.open(self.names[name])
            text = io.TextIOWrapper(raw, encoding='utf-8-sig', errors='replace', newline='')
        else:
            text = open(os.path.join(self.path, name), encoding='utf-8-sig', errors='replace', newline='')
        with text:
            for row in csv.DictReader(text):
                yield {(key or '').strip(): (value or '').strip() for key, value in row.items()}


def fix_mojibake(value):
    """Textos UTF-8 leídos como Latin-1 ("EstaciÃ³n" -> "Estación")."""
    if not value or not re.search('[ÃÂ]', value):
        return value
    try:
        return value.encode('latin-1').decode('utf-8')
    except (UnicodeEncodeError, UnicodeDecodeError):
        return value


def normalize_line_token(value):
    """Igual que normalizeLineToken del frontend/worker."""
    text = unicodedata.normalize('NFD', str(value or ''))
    text = ''.join(ch for ch in text if not unicodedata.combining(ch)).lower()
    return re.sub('[^a-z0-9]+', '', text)


def line_file_base(short_name):
    token = normalize_line_token(short_name)
    match = re.match(r'\d+', token)
    return match.group(0) if match else (token or '_')


# ─── Geometría ───────────────────────────────────────────────────────────────

def simplify_douglas_peucker(points, tolerance_m):
    """points: [(lat, lon)]. Proyección equirectangular local (error despreciable a escala AMBA)."""
    if len(points) <= 2:
        return points
    lat0 = math.radians(sum(p[0] for p in points) / len(points))
    kx = 111_320.0 * math.cos(lat0)
    ky = 110_540.0
    xy = [(p[1] * kx, p[0] * ky) for p in points]
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    tol2 = tolerance_m * tolerance_m
    while stack:
        start, end = stack.pop()
        ax, ay = xy[start]
        bx, by = xy[end]
        dx, dy = bx - ax, by - ay
        seg2 = dx * dx + dy * dy
        best_index, best_dist2 = -1, tol2
        for i in range(start + 1, end):
            px, py = xy[i]
            if seg2 == 0:
                dist2 = (px - ax) ** 2 + (py - ay) ** 2
            else:
                t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / seg2))
                qx, qy = ax + t * dx, ay + t * dy
                dist2 = (px - qx) ** 2 + (py - qy) ** 2
            if dist2 > best_dist2:
                best_index, best_dist2 = i, dist2
        if best_index >= 0:
            keep[best_index] = True
            stack.append((start, best_index))
            stack.append((best_index, end))
    return [p for p, k in zip(points, keep) if k]


def encode_polyline(points):
    """Polyline de Google, precisión 1e5 (las coordenadas quedan redondeadas a 5 decimales)."""
    out = []
    prev_lat = prev_lon = 0
    for lat, lon in points:
        ilat, ilon = round(lat * 1e5), round(lon * 1e5)
        for delta in (ilat - prev_lat, ilon - prev_lon):
            value = ~(delta << 1) if delta < 0 else (delta << 1)
            while value >= 0x20:
                out.append(chr((0x20 | (value & 0x1F)) + 63))
                value >>= 5
            out.append(chr(value + 63))
        prev_lat, prev_lon = ilat, ilon
    return ''.join(out)


def in_bbox(point, bbox):
    min_lat, min_lon, max_lat, max_lon = bbox
    return min_lat <= point[0] <= max_lat and min_lon <= point[1] <= max_lon


def parse_bbox(value):
    if not value or value.lower() == 'none':
        return None
    parts = [float(part) for part in value.split(',')]
    if len(parts) != 4:
        raise argparse.ArgumentTypeError('bbox: min_lat,min_lon,max_lat,max_lon')
    return parts


def parse_float(value):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def parse_int(value, default=None):
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return default


# ─── Pipeline ────────────────────────────────────────────────────────────────

def log(message):
    print(message, file=sys.stderr, flush=True)


def build(args):
    started = time.time()
    gtfs = GtfsSource(args.gtfs)
    for required in ('routes.txt', 'trips.txt', 'shapes.txt', 'stops.txt', 'stop_times.txt'):
        if not gtfs.has(required):
            sys.exit(f'Falta {required} en {args.gtfs}')

    agencies = {}
    if gtfs.has('agency.txt'):
        for row in gtfs.rows('agency.txt'):
            agencies[row.get('agency_id', '')] = fix_mojibake(row.get('agency_name', ''))

    routes = {}
    for row in gtfs.rows('routes.txt'):
        route_type = parse_int(row.get('route_type'), 3)
        # 3 = bus; 700-799 = extended bus types.
        if route_type != 3 and not (700 <= route_type < 800):
            continue
        short_name = row.get('route_short_name') or row.get('route_long_name') or row['route_id']
        routes[row['route_id']] = {
            'short': fix_mojibake(short_name),
            'agency_id': row.get('agency_id', ''),
        }
    log(f'routes: {len(routes)}')

    # shape_id -> datos de la variante; (route_id, direction) -> Counter(shape_id)
    variants = {}
    shape_by_route_dir = defaultdict(Counter)
    headsigns = defaultdict(Counter)
    stop_candidates = defaultdict(list)
    trip_ids_sample = set()
    trip_count = 0
    for row in gtfs.rows('trips.txt'):
        route = routes.get(row.get('route_id'))
        shape_id = row.get('shape_id')
        if not route or not shape_id:
            continue
        trip_count += 1
        direction = parse_int(row.get('direction_id'), 0)
        route_id = row['route_id']
        key = shape_id
        if key not in variants:
            variants[key] = {'route_id': route_id, 'direction': direction, 'trips': 0}
        variants[key]['trips'] += 1
        shape_by_route_dir[(route_id, direction)][key] += 1
        headsign = fix_mojibake(row.get('trip_headsign', ''))
        if headsign:
            headsigns[key][headsign] += 1
        if len(stop_candidates[key]) < MAX_STOP_CANDIDATE_TRIPS:
            stop_candidates[key].append(row['trip_id'])
        if args.realtime_sample and len(trip_ids_sample) < 2_000_000:
            trip_ids_sample.add(row['trip_id'])
    log(f'trips: {trip_count}, variantes (shapes): {len(variants)}')

    shape_points = defaultdict(list)
    for row in gtfs.rows('shapes.txt'):
        shape_id = row.get('shape_id')
        if shape_id not in variants:
            continue
        lat, lon = parse_float(row.get('shape_pt_lat')), parse_float(row.get('shape_pt_lon'))
        if lat is None or lon is None:
            continue
        shape_points[shape_id].append((parse_int(row.get('shape_pt_sequence'), 0), lat, lon))
    log(f'shapes con puntos: {len(shape_points)}')

    candidate_trip_to_shape = {trip: shape for shape, trips in stop_candidates.items() for trip in trips}
    trip_stops = defaultdict(list)
    used_stop_ids = set()
    rows_seen = 0
    for row in gtfs.rows('stop_times.txt'):
        rows_seen += 1
        trip_id = row.get('trip_id')
        if trip_id in candidate_trip_to_shape:
            trip_stops[trip_id].append((parse_int(row.get('stop_sequence'), 0), row.get('stop_id', '')))
        if rows_seen % 5_000_000 == 0:
            log(f'  stop_times: {rows_seen} filas...')
    log(f'stop_times: {rows_seen} filas')

    variant_stop_ids = {}
    variant_trip_ids = {}
    for shape_id, trips in stop_candidates.items():
        best = max(trips, key=lambda trip: len(trip_stops.get(trip, [])))
        ordered = [stop_id for _, stop_id in sorted(trip_stops.get(best, []))]
        variant_stop_ids[shape_id] = ordered
        variant_trip_ids[shape_id] = best
        used_stop_ids.update(ordered)

    stops = {}
    for row in gtfs.rows('stops.txt'):
        stop_id = row.get('stop_id')
        if stop_id not in used_stop_ids:
            continue
        lat, lon = parse_float(row.get('stop_lat')), parse_float(row.get('stop_lon'))
        if lat is None or lon is None:
            continue
        stops[stop_id] = [fix_mojibake(row.get('stop_name', '')) or 'Parada', round(lat, 5), round(lon, 5)]
    log(f'paradas usadas: {len(stops)}')

    # ── Armado por archivo de línea ──
    files = defaultdict(lambda: {'v': SCHEMA_VERSION, 'agencies': {}, 'routes': {}, 'variants': {}, 'stops': {}})
    index_lines = defaultdict(lambda: {'file': '', 'variants': []})
    index_routes = {}
    original_points = simplified_points = skipped_outside = 0

    for shape_id, variant in sorted(variants.items(), key=lambda item: (routes[item[1]['route_id']]['short'], item[1]['direction'], item[0])):
        raw = [(lat, lon) for _, lat, lon in sorted(shape_points.get(shape_id, []))]
        if len(raw) < 2:
            continue
        if args.bbox and not any(in_bbox(point, args.bbox) for point in raw):
            skipped_outside += 1
            continue
        simplified = simplify_douglas_peucker(raw, args.tolerance)
        original_points += len(raw)
        simplified_points += len(simplified)

        route = routes[variant['route_id']]
        base = line_file_base(route['short'])
        data = files[base]
        data['line'] = base
        agency_name = agencies.get(route['agency_id'], '')
        if route['agency_id']:
            data['agencies'][route['agency_id']] = agency_name
        headsign = headsigns[shape_id].most_common(1)[0][0] if headsigns[shape_id] else ''
        variant_stops = [stop_id for stop_id in variant_stop_ids.get(shape_id, []) if stop_id in stops]
        for stop_id in variant_stops:
            data['stops'][stop_id] = stops[stop_id]

        data['variants'][shape_id] = {
            'route_id': variant['route_id'],
            'short': route['short'],
            'direction': variant['direction'],
            'headsign': headsign,
            'agency_id': route['agency_id'],
            'trip_id': variant_trip_ids.get(shape_id) or stop_candidates[shape_id][0],
            'trips': variant['trips'],
            'shape': encode_polyline(simplified),
            'stops': variant_stops,
        }

        index_lines[route['short']]['file'] = base
        index_lines[route['short']]['variants'].append({
            'route_id': variant['route_id'],
            'shape_id': shape_id,
            'direction': variant['direction'],
            'headsign': headsign,
            'agency': agency_name,
        })
        index_routes[variant['route_id']] = base

    # route_id + direction_id -> variante principal (la shape con más trips); join del tiempo real.
    for (route_id, direction), counter in shape_by_route_dir.items():
        base = index_routes.get(route_id)
        if not base:
            continue
        ranked = [shape for shape, _ in counter.most_common() if shape in files[base]['variants']]
        if not ranked:
            continue
        entry = files[base]['routes'].setdefault(route_id, {'short': routes[route_id]['short'], 'dirs': {}})
        entry['dirs'][str(direction)] = ranked[0]
        if len(ranked) > 1:
            entry.setdefault('alt', {})[str(direction)] = ranked[1:]

    os.makedirs(args.out, exist_ok=True)
    for name in os.listdir(args.out):
        if name.endswith('.json'):
            os.remove(os.path.join(args.out, name))

    generated_at = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
    total_bytes = 0
    for base, data in files.items():
        data['generatedAt'] = generated_at
        total_bytes += write_json(os.path.join(args.out, f'{base}.json'), data)

    index = {
        'v': SCHEMA_VERSION,
        'generatedAt': generated_at,
        'toleranceMeters': args.tolerance,
        'source': os.path.basename(args.gtfs),
        'lines': dict(sorted(index_lines.items())),
        'routes': dict(sorted(index_routes.items())),
    }
    index_bytes = write_json(os.path.join(args.out, 'index.json'), index)
    total_bytes += index_bytes

    gzip_total = gzip_size_of_dir(args.out)
    if skipped_outside:
        log(f'variantes fuera del bbox descartadas: {skipped_outside}')
    log(f'puntos de shape: {original_points} -> {simplified_points} (tolerancia {args.tolerance} m)')
    log(f'archivos: {len(files) + 1}, total {total_bytes / 1024:.0f} KiB, gzip ~{gzip_total / 1024:.0f} KiB '
        f'(index {index_bytes / 1024:.0f} KiB) en {time.time() - started:.0f} s')

    if args.realtime_sample:
        exact_pct = report_realtime_match(args.realtime_sample, files, index_routes, trip_ids_sample)
        if args.min_exact_pct is not None and exact_pct < args.min_exact_pct:
            sys.exit(f'match exacto {exact_pct:.1f}% por debajo del mínimo {args.min_exact_pct:.1f}%')


def write_json(path, payload):
    text = json.dumps(payload, ensure_ascii=False, separators=(',', ':'))
    with open(path, 'w', encoding='utf-8', newline='\n') as out:
        out.write(text)
    return len(text.encode('utf-8'))


def gzip_size_of_dir(path):
    import gzip
    total = 0
    for name in os.listdir(path):
        if name.endswith('.json'):
            with open(os.path.join(path, name), 'rb') as file:
                total += len(gzip.compress(file.read(), 9))
    return total


def report_realtime_match(sample_path, files, index_routes, trip_ids):
    with open(sample_path, encoding='utf-8') as file:
        vehicles = json.load(file)
    if isinstance(vehicles, dict):
        vehicles = vehicles.get('current', {}).get('data') or vehicles.get('data') or []
    total = len(vehicles)
    exact = route_only = renumbered = by_short = trip_hits = trip_hits_clean = 0
    misses = Counter()
    for vehicle in vehicles:
        route_id = str(vehicle.get('route_id', ''))
        direction = str(vehicle.get('direction', vehicle.get('direction_id', '')))
        base = index_routes.get(route_id)
        entry = files[base]['routes'].get(route_id) if base else None
        # El GCBA renumera route_id entre versiones del feed: si la línea no coincide, no es match.
        same_line = entry and normalize_line_token(entry['short']) == normalize_line_token(vehicle.get('route_short_name', ''))
        if entry and not same_line:
            renumbered += 1
            misses[f"{vehicle.get('route_short_name')}:{route_id}"] += 1
        elif entry and direction in entry['dirs']:
            exact += 1
        elif entry:
            route_only += 1
        else:
            misses[f"{vehicle.get('route_short_name')}:{route_id}"] += 1
            short_base = line_file_base(vehicle.get('route_short_name', ''))
            if short_base in files:
                by_short += 1
        tip = str(vehicle.get('tip_id') or vehicle.get('trip_id') or '')
        if tip in trip_ids:
            trip_hits += 1
        elif tip.replace('-', '') in trip_ids:
            trip_hits_clean += 1
    pct = (lambda n: f'{(100 * n / total) if total else 0:.1f}%')
    print(json.dumps({
        'vehicles': total,
        'exact_route_id_direction': exact, 'exact_pct': pct(exact),
        'route_id_without_direction': route_only,
        'route_id_other_line_feed_version_mismatch': renumbered,
        'unmatched_route_id_but_line_file_exists': by_short,
        'unmatched': total - exact - route_only - renumbered,
        'tip_id_equals_gtfs_trip_id': trip_hits,
        'tip_id_without_dash_equals_trip_id': trip_hits_clean,
        'top_unmatched': misses.most_common(15),
    }, ensure_ascii=False, indent=2))
    return (100 * exact / total) if total else 0.0


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--gtfs', required=True, help='GTFS .zip o carpeta con los .txt')
    parser.add_argument('--out', default=os.path.join(os.path.dirname(__file__), '..', 'data', 'routes'))
    parser.add_argument('--tolerance', type=float, default=7.0, help='tolerancia Douglas-Peucker en metros')
    parser.add_argument('--bbox', type=parse_bbox, default=parse_bbox('-35.4,-59.6,-34.0,-57.7'),
                        help="descarta variantes sin puntos dentro de min_lat,min_lon,max_lat,max_lon (default AMBA; 'none' = todo)")
    parser.add_argument('--realtime-sample', help='JSON de /colectivos/vehiclePositionsSimple para medir el match')
    parser.add_argument('--min-exact-pct', type=float,
                        help='con --realtime-sample: sale con error si el match exacto queda por debajo')
    build(parser.parse_args())


if __name__ == '__main__':
    main()
