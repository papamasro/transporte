-- Índices para encontrar paradas cercanas y viajes que sirven esas paradas.
-- Aplicar después de cargar las tablas GTFS.
CREATE INDEX IF NOT EXISTS idx_stops_lat_lon ON stops(stop_lat, stop_lon);
CREATE INDEX IF NOT EXISTS idx_stop_times_stop_id ON stop_times(stop_id);

PRAGMA optimize;
