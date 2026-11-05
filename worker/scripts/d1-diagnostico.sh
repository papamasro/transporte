#!/usr/bin/env bash
# Diagnóstico de D1 de SOLO LECTURA (SELECT / EXPLAIN). Costo: unas filas leídas por los
# COUNT(*) (una lectura completa de cada tabla, una sola vez).
#   ./scripts/d1-diagnostico.sh <NOMBRE_DB>            # remoto
#   ./scripts/d1-diagnostico.sh <NOMBRE_DB> --local    # base local de wrangler dev
set -euo pipefail

DB="${1:?Uso: $0 <NOMBRE_DB> [--local]}"
MODE="${2:---remote}"
cd "$(dirname "$0")/.."

run() {
    echo "── $1"
    npx wrangler d1 execute "$DB" "$MODE" --json --command "$1" \
        | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const r of JSON.parse(s)){console.log(JSON.stringify(r.results));console.log("   rows_read:",r.meta?.rows_read,"rows_written:",r.meta?.rows_written)}})'
}

run "SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY tbl_name, type"
for t in routes trips shapes stops stop_times; do
    run "SELECT '$t' AS tabla, COUNT(*) AS filas FROM $t"
done

run "EXPLAIN QUERY PLAN SELECT r.route_id, t.shape_id FROM routes r JOIN trips t ON t.route_id = r.route_id WHERE r.route_short_name LIKE '60%' GROUP BY t.shape_id"
run "EXPLAIN QUERY PLAN SELECT shape_id, shape_pt_lat, shape_pt_lon FROM shapes WHERE shape_id IN ('12770') ORDER BY shape_id, shape_pt_sequence"
run "EXPLAIN QUERY PLAN SELECT t.trip_id FROM trips t JOIN routes r ON r.route_id = t.route_id WHERE t.trip_id IN ('1277DI0', '1277DI0') LIMIT 1"
run "EXPLAIN QUERY PLAN SELECT s.stop_name FROM stop_times st JOIN stops s ON s.stop_id = st.stop_id WHERE st.trip_id = '1277DI0' ORDER BY st.stop_sequence"

# Costo real (rows_read) de una consulta típica de cada tipo:
run "SELECT COUNT(*) AS puntos FROM shapes WHERE shape_id = '12770'"
run "SELECT COUNT(*) AS paradas FROM stop_times WHERE trip_id = '1277DI0'"
# Consulta VIEJA de info-trayecto (REPLACE impide usar índices => recorre toda la tabla):
run "SELECT COUNT(*) FROM stop_times st WHERE st.trip_id = '1277DI0' OR REPLACE(st.trip_id, '-', '') = '1277DI0'"
