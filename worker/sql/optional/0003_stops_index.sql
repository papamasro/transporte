-- Solo si stops.stop_id NO es PRIMARY KEY (ver sqlite_master en scripts/d1-diagnostico.sh).
-- Sin índice, cada JOIN con stops arma un índice automático leyendo toda la tabla.
-- Costo único: rows written ≈ filas(stops).
--
--   npx wrangler d1 execute <DB> --remote --file sql/optional/0003_stops_index.sql

CREATE INDEX IF NOT EXISTS idx_stops_stop_id ON stops(stop_id);
