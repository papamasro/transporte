-- Índices baratos para las consultas de /buscar-linea e /info-trayecto.
-- Costo único en "rows written" ≈ 2 × filas(routes) + 2 × filas(trips). Plan Free: 100.000/día.
-- Revisar antes con scripts/d1-diagnostico.sh (conteos y si route_id/trip_id ya son PRIMARY KEY:
-- en ese caso el índice correspondiente sobra y se puede borrar de este archivo).
-- Aplicar con: npx wrangler d1 migrations apply <DB> --remote

CREATE INDEX IF NOT EXISTS idx_routes_route_id ON routes(route_id);
CREATE INDEX IF NOT EXISTS idx_routes_short_name ON routes(route_short_name);
CREATE INDEX IF NOT EXISTS idx_trips_trip_id ON trips(trip_id);
CREATE INDEX IF NOT EXISTS idx_trips_route_id ON trips(route_id);

PRAGMA optimize;
