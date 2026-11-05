#!/usr/bin/env bash
# Plan de ejecución + "Fullscan Steps"/"Autoindex Inserts" (sqlite3 .stats) de consultas viejas y
# nuevas sobre copias de la base local: sin índices / con 0001 / con 0001+0002+0003.
set -uo pipefail

declare -a NAMES=(
    "VIEJA trip lookup"
    "NUEVA trip lookup"
    "VIEJA stops"
    "NUEVA stops (=)"
    "NUEVA stops (rangos)"
    "shape 1 recorrido (=)"
    "shape 1 recorrido (rangos)"
    "VIEJA buscar-linea"
    "NUEVA buscar-linea"
)
declare -a SQLS=(
    "SELECT t.trip_id FROM trips t JOIN routes r ON t.route_id = r.route_id WHERE (REPLACE(t.trip_id, '-', '') = '549551' OR t.trip_id = '54955-1' OR t.trip_id = '549551') AND r.route_short_name = '152' LIMIT 1;"
    "SELECT t.trip_id FROM trips t JOIN routes r ON r.route_id = t.route_id WHERE t.trip_id IN ('54955-1', '549551') ORDER BY (r.route_short_name = '152') DESC, (t.direction_id = 1) DESC LIMIT 1;"
    "SELECT s.stop_name FROM stop_times st JOIN stops s ON st.stop_id = s.stop_id WHERE st.trip_id = '1277DI0' OR st.trip_id = '1277DI0' OR REPLACE(st.trip_id, '-', '') = '1277DI0' ORDER BY st.stop_sequence;"
    "SELECT s.stop_name FROM stop_times st JOIN stops s ON s.stop_id = st.stop_id WHERE st.trip_id = '1277DI0' ORDER BY st.stop_sequence;"
    "SELECT s.stop_name FROM trip_stop_ranges g JOIN stop_times st ON st.rowid BETWEEN g.lo AND g.hi AND st.trip_id = g.trip_id JOIN stops s ON s.stop_id = st.stop_id WHERE g.trip_id = '1277DI0' ORDER BY st.stop_sequence;"
    "SELECT shape_pt_lat FROM shapes WHERE shape_id IN ('12770') ORDER BY shape_id, shape_pt_sequence;"
    "SELECT s.shape_pt_lat FROM shape_ranges g JOIN shapes s ON s.rowid BETWEEN g.lo AND g.hi AND s.shape_id = g.shape_id WHERE g.shape_id IN ('12770') ORDER BY s.shape_id, s.shape_pt_sequence;"
    "SELECT t.shape_id FROM routes r JOIN trips t ON r.route_id = t.route_id WHERE r.route_short_name = '60' OR r.route_short_name LIKE '60%' GROUP BY t.shape_id;"
    "SELECT t.shape_id FROM routes r JOIN trips t ON t.route_id = r.route_id WHERE r.route_short_name LIKE '60%' ESCAPE '\\' GROUP BY t.shape_id;"
)

for db in "$@"; do
    echo "════ $(basename "$db")"
    for i in "${!SQLS[@]}"; do
        out=$(printf '.stats on\n%s\n' "${SQLS[$i]}" | sqlite3 "$db" 2>&1)
        if grep -q "no such table" <<<"$out"; then printf '  %-28s (sin tablas de rangos)\n' "${NAMES[$i]}"; continue; fi
        full=$(grep -i "Fullscan Steps" <<<"$out" | awk -F: '{gsub(/ /,"",$2); print $2}')
        auto=$(grep -i "Autoindex Inserts" <<<"$out" | awk -F: '{gsub(/ /,"",$2); print $2}')
        vm=$(grep -i "Virtual Machine Steps" <<<"$out" | awk -F: '{gsub(/ /,"",$2); print $2}')
        plan=$(sqlite3 "$db" "EXPLAIN QUERY PLAN ${SQLS[$i]}" 2>&1 | sed -E 's/^[0-9|]+//' | tr '\n' ';' | cut -c1-110)
        printf '  %-28s fullscan=%-7s autoindex=%-6s vmsteps=%-9s %s\n' "${NAMES[$i]}" "$full" "$auto" "$vm" "$plan"
    done
done
