import csv
import math
import os
import re
import sys

# Campos que se escriben sin comillas en el SQL: se validan antes de emitirlos.
CAMPOS_FLOAT = {'stop_lat', 'stop_lon', 'shape_pt_lat', 'shape_pt_lon', 'shape_dist_traveled'}
CAMPOS_INT = {'route_type', 'direction_id', 'stop_sequence'}

PATRON_FLOAT = re.compile(r'^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$')
PATRON_INT = re.compile(r'^[+-]?\d+$')


def valor_numerico(col, val):
    """Devuelve el literal SQL del número o lanza ValueError si no es válido."""
    texto = val.strip()
    if col in CAMPOS_INT:
        if not PATRON_INT.match(texto):
            raise ValueError(f"{col}={val!r} no es un entero")
        int(texto)
        return texto
    if not PATRON_FLOAT.match(texto) or not math.isfinite(float(texto)):
        raise ValueError(f"{col}={val!r} no es un número")
    return texto


def valor_texto(val):
    # SQL estándar: comillas simples duplicadas. NUL no es válido dentro de un literal.
    return "'" + val.replace('\x00', '').replace("'", "''") + "'"


def escribir_lote(out, tabla, columnas, rows):
    out.write(f"INSERT INTO {tabla} ({', '.join(columnas)}) VALUES\n" + ",\n".join(rows) + ";\n\n")


def procesar_archivo(nombre_archivo, tabla, columnas, batch_size=500):
    if not os.path.exists(nombre_archivo):
        print(f"⚠️ No se encontró {nombre_archivo}, saltando...")
        return

    archivo_salida = nombre_archivo.replace('.txt', '.sql')
    omitidas = 0

    # utf-8-sig descarta el BOM que traen algunos GTFS; el CSV se lee en streaming.
    with open(nombre_archivo, mode='r', encoding='utf-8-sig', newline='') as f, \
            open(archivo_salida, mode='w', encoding='utf-8') as out:
        reader = csv.DictReader(f)
        out.write(f"-- Carga de {tabla}\n")
        rows = []
        for row in reader:
            valores = []
            try:
                for col in columnas:
                    val = row.get(col, '')
                    if val is None or val == '':
                        valores.append("NULL")
                    elif col in CAMPOS_FLOAT or col in CAMPOS_INT:
                        valores.append(valor_numerico(col, val))
                    else:
                        valores.append(valor_texto(val))
            except ValueError as error:
                omitidas += 1
                print(f"⚠️ {nombre_archivo}:{reader.line_num}: {error}; fila omitida.", file=sys.stderr)
                continue

            rows.append(f"({', '.join(valores)})")

            if len(rows) == batch_size:
                escribir_lote(out, tabla, columnas, rows)
                rows = []

        if rows:
            escribir_lote(out, tabla, columnas, rows)

    sufijo = f" ({omitidas} filas omitidas)" if omitidas else ""
    print(f"✅ {archivo_salida} generado{sufijo}.")


# Configuración de tablas según tus archivos
CONFIG = {
    'stops.txt': ('stops', ['stop_id', 'stop_code', 'stop_name', 'stop_lat', 'stop_lon']),
    'routes.txt': ('routes', ['route_id', 'agency_id', 'route_short_name', 'route_long_name', 'route_type']),
    'trips.txt': ('trips', ['trip_id', 'route_id', 'service_id', 'trip_headsign', 'direction_id', 'shape_id']),
    'shapes.txt': ('shapes', ['shape_id', 'shape_pt_sequence', 'shape_pt_lat', 'shape_pt_lon']),
    'stop_times.txt': ('stop_times', ['trip_id', 'arrival_time', 'departure_time', 'stop_id', 'stop_sequence'])
}


# Esquema con claves primarias: shapes/stop_times son WITHOUT ROWID para que la PK sea el único
# árbol (indexar después una tabla cargada cuesta 1 fila escrita por fila en D1).
# Las consultas del worker (worker/index.js) filtran por estas columnas.
ESQUEMA = """\
CREATE TABLE IF NOT EXISTS routes (
    route_id TEXT PRIMARY KEY, agency_id TEXT, route_short_name TEXT, route_long_name TEXT, route_type INTEGER
);
CREATE TABLE IF NOT EXISTS trips (
    trip_id TEXT PRIMARY KEY, route_id TEXT, service_id TEXT, trip_headsign TEXT, direction_id INTEGER, shape_id TEXT
);
CREATE TABLE IF NOT EXISTS stops (
    stop_id TEXT PRIMARY KEY, stop_code TEXT, stop_name TEXT, stop_lat REAL, stop_lon REAL
);
CREATE TABLE IF NOT EXISTS shapes (
    shape_id TEXT NOT NULL, shape_pt_sequence INTEGER NOT NULL, shape_pt_lat REAL, shape_pt_lon REAL,
    PRIMARY KEY (shape_id, shape_pt_sequence)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS stop_times (
    trip_id TEXT NOT NULL, arrival_time TEXT, departure_time TEXT, stop_id TEXT, stop_sequence INTEGER NOT NULL,
    PRIMARY KEY (trip_id, stop_sequence)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_routes_short_name ON routes(route_short_name);
CREATE INDEX IF NOT EXISTS idx_trips_route_id ON trips(route_id);
"""


def main():
    with open('schema.sql', mode='w', encoding='utf-8') as out:
        out.write(ESQUEMA)
    print("✅ schema.sql generado (aplicarlo antes de los INSERT en una base nueva).")
    for archivo, (tabla, columnas) in CONFIG.items():
        procesar_archivo(archivo, tabla, columnas)


if __name__ == '__main__':
    main()
