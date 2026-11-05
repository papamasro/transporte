-- Alternativa barata a indexar shapes/stop_times (tablas de cientos de miles o millones de
-- filas): un índice sobre esas tablas cuesta 1 fila escrita por fila existente y no entra en
-- las 100.000 escrituras/día del plan Free.
--
-- Estas tablas guardan el rango de rowid de cada shape/trip (los GTFS vienen agrupados por
-- shape_id / trip_id, así que quedan contiguos). El worker las usa si existen y si no, cae a
-- la consulta normal.
--
-- Costo único: rows written ≈ cantidad de shapes + cantidad de trips (miles);
--              rows read    ≈ filas(shapes) + filas(stop_times) (una sola lectura completa).
-- Correr SOLO si scripts/d1-diagnostico.sh muestra "SCAN shapes" / "SCAN stop_times" y las
-- tablas tienen rowid (no son WITHOUT ROWID). Si la suma de filas supera ~4,5 M, correr cada
-- bloque en un día UTC distinto.
--
--   npx wrangler d1 execute <DB> --remote --file sql/optional/0002_row_ranges.sql

CREATE TABLE IF NOT EXISTS shape_ranges (
    shape_id TEXT PRIMARY KEY,
    lo INTEGER NOT NULL,
    hi INTEGER NOT NULL,
    n INTEGER NOT NULL
) WITHOUT ROWID;

INSERT OR REPLACE INTO shape_ranges (shape_id, lo, hi, n)
SELECT shape_id, MIN(rowid), MAX(rowid), COUNT(*) FROM shapes GROUP BY shape_id;

CREATE TABLE IF NOT EXISTS trip_stop_ranges (
    trip_id TEXT PRIMARY KEY,
    lo INTEGER NOT NULL,
    hi INTEGER NOT NULL,
    n INTEGER NOT NULL
) WITHOUT ROWID;

INSERT OR REPLACE INTO trip_stop_ranges (trip_id, lo, hi, n)
SELECT trip_id, MIN(rowid), MAX(rowid), COUNT(*) FROM stop_times GROUP BY trip_id;
