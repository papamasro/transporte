"""Test de build-static-routes.py con un GTFS sintético (sin red, solo stdlib).

    python3 scripts/test_build_static_routes.py
"""
import csv
import json
import os
import subprocess
import sys
import tempfile
import unittest
import zipfile

SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'build-static-routes.py')


def decode_polyline(encoded):
    points, index, lat, lon = [], 0, 0, 0
    while index < len(encoded):
        values = []
        for _ in range(2):
            shift = result = 0
            while True:
                byte = ord(encoded[index]) - 63
                index += 1
                result |= (byte & 0x1F) << shift
                shift += 5
                if byte < 0x20:
                    break
            values.append(~(result >> 1) if result & 1 else result >> 1)
        lat += values[0]
        lon += values[1]
        points.append((lat / 1e5, lon / 1e5))
    return points


def write_csv(zf, name, header, rows):
    import io
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(header)
    writer.writerows(rows)
    zf.writestr(name, '\ufeff' + buf.getvalue())


def make_gtfs(path):
    with zipfile.ZipFile(path, 'w') as zf:
        write_csv(zf, 'agency.txt', ['agency_id', 'agency_name', 'agency_url', 'agency_timezone'],
                  [['1', 'Empresa Ã\x81guila', 'http://x', 'America/Argentina/Buenos_Aires']])
        write_csv(zf, 'routes.txt', ['route_id', 'agency_id', 'route_short_name', 'route_type'], [
            ['100', '1', '60A', '3'],
            ['101', '1', '60A', '3'],
            ['200', '1', '152', '3'],
            ['300', '1', 'SUBTE', '1'],
            ['400', '1', '999', '3'],
        ])
        write_csv(zf, 'trips.txt', ['route_id', 'service_id', 'trip_id', 'trip_headsign', 'direction_id', 'shape_id'], [
            ['100', 'S', '100-1', 'a Constitución', '0', '100'],
            ['100', 'S', '100-2', 'a Constitución', '0', '100'],
            ['101', 'S', '101-1', 'a Escobar', '1', '101'],
            ['200', 'S', '200-1', 'a Olivos', '0', '200'],
            ['300', 'S', '300-1', 'subte', '0', '300'],
            ['400', 'S', '400-1', 'fuera AMBA', '0', '400'],
        ])
        shapes = []
        # 101 puntos colineales: deben simplificarse a 2
        for i in range(101):
            shapes.append(['100', -34.60 + i * 0.001, -58.40, i])
        shapes += [['101', -34.50, -58.40, 1], ['101', -34.55, -58.45, 2], ['101', -34.60, -58.40, 3]]
        shapes += [['200', -34.55, -58.50, 1], ['200', -34.56, -58.51, 2]]
        shapes += [['300', -34.60, -58.38, 1], ['300', -34.61, -58.39, 2]]
        shapes += [['400', -31.40, -64.18, 1], ['400', -31.41, -64.19, 2]]
        write_csv(zf, 'shapes.txt', ['shape_id', 'shape_pt_lat', 'shape_pt_lon', 'shape_pt_sequence'], shapes)
        write_csv(zf, 'stops.txt', ['stop_id', 'stop_name', 'stop_lat', 'stop_lon'], [
            ['A', 'Parada A', '-34.6', '-58.4'],
            ['B', 'Parada B', '-34.55', '-58.4'],
            ['C', 'Parada C', '-34.5', '-58.4'],
        ])
        write_csv(zf, 'stop_times.txt', ['trip_id', 'arrival_time', 'departure_time', 'stop_id', 'stop_sequence'], [
            ['100-1', '08:00:00', '08:00:00', 'A', '1'],
            ['100-2', '09:00:00', '09:00:00', 'A', '1'],
            ['100-2', '09:10:00', '09:10:00', 'B', '2'],
            ['100-2', '09:20:00', '09:20:00', 'C', '3'],
            ['101-1', '10:00:00', '10:00:00', 'C', '1'],
        ])


class BuildStaticRoutesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        gtfs = os.path.join(cls.tmp.name, 'gtfs.zip')
        cls.out = os.path.join(cls.tmp.name, 'routes')
        os.makedirs(cls.out)
        with open(os.path.join(cls.out, 'stale.json'), 'w') as f:
            f.write('{}')
        make_gtfs(gtfs)
        sample = os.path.join(cls.tmp.name, 'sample.json')
        with open(sample, 'w') as f:
            json.dump([
                {'route_id': '100', 'route_short_name': '60A', 'direction': 0, 'tip_id': '100-1'},
                {'route_id': '101', 'route_short_name': '152', 'direction': 1, 'tip_id': 'x'},
            ], f)
        cls.proc = subprocess.run([sys.executable, SCRIPT, '--gtfs', gtfs, '--out', cls.out,
                                   '--realtime-sample', sample], capture_output=True, text=True)
        with open(os.path.join(cls.out, 'index.json')) as f:
            cls.index = json.load(f)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def load(self, name):
        with open(os.path.join(self.out, name)) as f:
            return json.load(f)

    def test_exit_ok_and_files(self):
        self.assertEqual(self.proc.returncode, 0, self.proc.stderr)
        self.assertEqual(sorted(os.listdir(self.out)), ['152.json', '60.json', 'index.json'])

    def test_index_routes_and_filters(self):
        self.assertEqual(self.index['routes'], {'100': '60', '101': '60', '200': '152'})
        self.assertEqual(self.index['lines']['60A']['file'], '60')
        self.assertIn('60A', self.index['lines'])
        self.assertNotIn('999', self.index['lines'])
        self.assertNotIn('SUBTE', self.index['lines'])

    def test_variant_shape_stops_and_mapping(self):
        data = self.load('60.json')
        self.assertEqual(data['routes']['100']['dirs'], {'0': '100'})
        self.assertEqual(data['routes']['101']['dirs'], {'1': '101'})
        variant = data['variants']['100']
        self.assertEqual(variant['route_id'], '100')
        self.assertEqual(variant['trip_id'], '100-2')
        self.assertEqual(variant['stops'], ['A', 'B', 'C'])
        self.assertEqual(variant['headsign'], 'a Constitución')
        self.assertEqual(data['agencies']['1'], 'Empresa Águila')
        points = decode_polyline(variant['shape'])
        self.assertEqual(points, [(-34.6, -58.4), (-34.5, -58.4)])
        self.assertEqual(len(decode_polyline(data['variants']['101']['shape'])), 3)
        self.assertEqual(data['stops']['B'], ['Parada B', -34.55, -58.4])

    def test_realtime_report(self):
        report = json.loads(self.proc.stdout[self.proc.stdout.index('{'):])
        self.assertEqual(report['exact_route_id_direction'], 1)
        self.assertEqual(report['route_id_other_line_feed_version_mismatch'], 1)
        self.assertEqual(report['tip_id_equals_gtfs_trip_id'], 1)

    def test_min_exact_pct(self):
        sample = os.path.join(self.tmp.name, 'sample.json')
        gtfs = os.path.join(self.tmp.name, 'gtfs.zip')
        out = os.path.join(self.tmp.name, 'routes-min')
        base = [sys.executable, SCRIPT, '--gtfs', gtfs, '--out', out, '--realtime-sample', sample]
        self.assertEqual(subprocess.run(base + ['--min-exact-pct', '50'], capture_output=True).returncode, 0)
        self.assertNotEqual(subprocess.run(base + ['--min-exact-pct', '90'], capture_output=True).returncode, 0)


if __name__ == '__main__':
    unittest.main()
