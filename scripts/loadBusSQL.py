import csv
import os

def procesar_archivo(nombre_archivo, tabla, columnas, batch_size=500):
    if not os.path.exists(nombre_archivo):
        print(f"⚠️ No se encontró {nombre_archivo}, saltando...")
        return

    archivo_salida = nombre_archivo.replace('.txt', '.sql')
    
    with open(nombre_archivo, mode='r', encoding='utf-8') as f:
        # Algunos archivos GTFS pueden tener caracteres extraños al inicio (BOM)
        content = f.read().lstrip('\ufeff')
        reader = csv.DictReader(content.splitlines())
        
        with open(archivo_salida, mode='w', encoding='utf-8') as out:
            out.write(f"-- Carga de {tabla}\n")
            rows = []
            for row in reader:
                valores = []
                for col in columnas:
                    val = row.get(col, '')
                    if val is None or val == '':
                        valores.append("NULL")
                    # NUEVO: agregamos 'stop_sequence' a la lista de campos numéricos
                    elif col in ['stop_lat', 'stop_lon', 'shape_pt_lat', 'shape_pt_lon', 'shape_dist_traveled', 'route_type', 'direction_id', 'stop_sequence']:
                        # Valores numéricos
                        valores.append(val)
                    else:
                        # Texto (escapando comillas simples)
                        texto = val.replace("'", "''")
                        valores.append(f"'{texto}'")
                
                rows.append(f"({', '.join(valores)})")
                
                if len(rows) == batch_size:
                    out.write(f"INSERT INTO {tabla} ({', '.join(columnas)}) VALUES\n" + ",\n".join(rows) + ";\n\n")
                    rows = []
            
            if rows:
                out.write(f"INSERT INTO {tabla} ({', '.join(columnas)}) VALUES\n" + ",\n".join(rows) + ";\n\n")

    print(f"✅ {archivo_salida} generado.")

# Configuración de tablas según tus archivos
config = {
    'stops.txt': ('stops', ['stop_id', 'stop_code', 'stop_name', 'stop_lat', 'stop_lon']),
    'routes.txt': ('routes', ['route_id', 'agency_id', 'route_short_name', 'route_long_name', 'route_type']),
    'trips.txt': ('trips', ['trip_id', 'route_id', 'service_id', 'trip_headsign', 'direction_id', 'shape_id']),
    'shapes.txt': ('shapes', ['shape_id', 'shape_pt_sequence', 'shape_pt_lat', 'shape_pt_lon']),
    # NUEVO: Agregamos stop_times
    'stop_times.txt': ('stop_times', ['trip_id', 'arrival_time', 'departure_time', 'stop_id', 'stop_sequence'])
}

for archivo, params in config.items():
    procesar_archivo(archivo, params[0], params[1])