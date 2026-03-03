#!/usr/bin/env python3
import argparse
import json
import ssl
import sys
import time
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


@dataclass
class StationNode:
    station_id: int
    name: Optional[str] = None
    lat: Optional[float] = None
    lon: Optional[float] = None
    included_ramales: Set[int] = field(default_factory=set)
    operative_ramales: Set[int] = field(default_factory=set)
    neighbors: Set[int] = field(default_factory=set)
    seen_in_arribos: int = 0
    processed: bool = False


class SofseCrawler:
    def __init__(
        self,
        base_url: str,
        output_path: Path,
        seed_query: str,
        seed_station_ids: List[int],
        seed_station_names: List[str],
        max_retries: int,
        retry_delay_ms: int,
        retry_403_delay_ms: int,
        max_stations: int,
        insecure: bool,
        save_every: int,
        sleep_ms: int,
        seed_all_ramales: bool,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.output_path = output_path
        self.seed_query = seed_query
        self.seed_station_ids = seed_station_ids
        self.seed_station_names = seed_station_names
        self.max_retries = max_retries
        self.retry_delay_ms = retry_delay_ms
        self.retry_403_delay_ms = retry_403_delay_ms
        self.max_stations = max_stations
        self.insecure = insecure
        self.save_every = save_every
        self.sleep_ms = sleep_ms
        self.seed_all_ramales = seed_all_ramales
        self.ssl_context = ssl._create_unverified_context() if insecure else None

        self.stations: Dict[int, StationNode] = {}
        self.pending: deque[int] = deque()
        self.pending_set: Set[int] = set()
        self.processed_order: List[int] = []
        self.ramales_seen: Set[int] = set()
        self.ramales_expanded: Set[int] = set()
        self.arribos_calls = 0
        self.search_calls = 0
        self.ramal_calls = 0
        self.gerencia_calls = 0

    def _request_json(self, path: str, query: Optional[Dict[str, Any]] = None) -> Any:
        query = query or {}
        url = f"{self.base_url}/{path.lstrip('/')}"
        if query:
            url = f"{url}?{urlencode({k: v for k, v in query.items() if v is not None})}"

        last_error: Optional[Exception] = None
        attempts = 0
        while attempts < self.max_retries:
            attempts += 1
            try:
                req = Request(url, headers={"Accept": "application/json"})
                with urlopen(req, timeout=30, context=self.ssl_context) as res:
                    body = res.read().decode("utf-8", errors="replace")
                    return json.loads(body)
            except HTTPError as exc:
                last_error = exc
                if attempts < self.max_retries:
                    if exc.code == 403:
                        time.sleep(self.retry_403_delay_ms / 1000)
                    else:
                        time.sleep(self.retry_delay_ms / 1000)
                    continue
                break
            except (URLError, TimeoutError, json.JSONDecodeError) as exc:
                last_error = exc
                if attempts < self.max_retries:
                    time.sleep(self.retry_delay_ms / 1000)
                    continue
                break

        raise RuntimeError(f"Falló request {url}: {last_error}")

    @staticmethod
    def _as_list(payload: Any) -> List[Any]:
        if isinstance(payload, list):
            return payload
        if isinstance(payload, dict):
            if isinstance(payload.get("results"), list):
                return payload["results"]
            if isinstance(payload.get("data"), list):
                return payload["data"]
        return []

    @staticmethod
    def _to_int(value: Any) -> Optional[int]:
        try:
            if value is None or value == "":
                return None
            return int(float(value))
        except (TypeError, ValueError):
            return None

    @staticmethod
    def _to_float(value: Any) -> Optional[float]:
        try:
            if value is None or value == "":
                return None
            return float(value)
        except (TypeError, ValueError):
            return None

    def _upsert_station(self, station_id: int, info: Optional[Dict[str, Any]] = None) -> StationNode:
        node = self.stations.get(station_id)
        if node is None:
            node = StationNode(station_id=station_id)
            self.stations[station_id] = node

        if info:
            name = info.get("nombre") or info.get("name")
            if name and not node.name:
                node.name = str(name)

            lat = self._to_float(info.get("latitud") if "latitud" in info else info.get("lat"))
            lon = self._to_float(info.get("longitud") if "longitud" in info else info.get("lon"))
            if lat is not None and node.lat is None:
                node.lat = lat
            if lon is not None and node.lon is None:
                node.lon = lon

            for rid in info.get("incluida_en_ramales", []) or []:
                rid_int = self._to_int(rid)
                if rid_int is not None:
                    node.included_ramales.add(rid_int)

            for rid in info.get("operativa_en_ramales", []) or []:
                rid_int = self._to_int(rid)
                if rid_int is not None:
                    node.operative_ramales.add(rid_int)

        return node

    def _enqueue(self, station_id: int) -> None:
        if station_id in self.pending_set:
            return
        if station_id in self.stations and self.stations[station_id].processed:
            return
        self.pending.append(station_id)
        self.pending_set.add(station_id)

    def seed(self) -> None:
        for sid in self.seed_station_ids:
            self._upsert_station(sid)
            self._enqueue(sid)

        for station_name in self.seed_station_names:
            payload = self._request_json("infraestructura/estaciones", {"nombre": station_name})
            self.search_calls += 1
            for item in self._as_list(payload):
                sid = self._to_int(item.get("id_estacion") or item.get("id") or item.get("idEstacion"))
                if sid is None:
                    continue
                self._upsert_station(sid, item)
                self._enqueue(sid)

        if self.seed_query:
            payload = self._request_json("infraestructura/estaciones", {"nombre": self.seed_query})
            self.search_calls += 1
            for item in self._as_list(payload):
                sid = self._to_int(item.get("id_estacion") or item.get("id") or item.get("idEstacion"))
                if sid is None:
                    continue
                self._upsert_station(sid, item)
                self._enqueue(sid)

        if self.seed_all_ramales:
            self._seed_from_all_ramales()

    def _seed_from_all_ramales(self) -> None:
        payload = self._request_json("infraestructura/gerencias", {"idEmpresa": 1})
        self.gerencia_calls += 1
        gerencias = self._as_list(payload)

        for gerencia in gerencias:
            gerencia_id = self._to_int(gerencia.get("id") or gerencia.get("id_gerencia"))
            if gerencia_id is None:
                continue

            ramales_payload = self._request_json("infraestructura/ramales", {"idGerencia": gerencia_id})
            self.ramal_calls += 1
            ramales = self._as_list(ramales_payload)

            for ramal in ramales:
                ramal_id = self._to_int(ramal.get("id") or ramal.get("id_ramal"))
                if ramal_id is None:
                    continue

                self.ramales_seen.add(ramal_id)

                estaciones_payload = self._request_json("infraestructura/estaciones", {"idRamal": ramal_id})
                self.ramal_calls += 1
                for item in self._as_list(estaciones_payload):
                    sid = self._to_int(item.get("id_estacion") or item.get("id") or item.get("idEstacion"))
                    if sid is None:
                        continue
                    self._upsert_station(sid, item)
                    self._enqueue(sid)

    def _fetch_arribos(self, station_id: int) -> List[Dict[str, Any]]:
        payload = self._request_json(f"arribos/estacion/{station_id}", {"cantidad": 30, "paraApp": "true"})
        self.arribos_calls += 1
        return self._as_list(payload)

    def _expand_from_arribos(self, station_id: int, arrivals: List[Dict[str, Any]]) -> None:
        current = self._upsert_station(station_id)

        for item in arrivals:
            arribo = item.get("arribo") or {}
            servicio = item.get("servicio") or {}

            rid = self._to_int((servicio.get("ramal") or {}).get("id"))
            if rid is not None:
                self.ramales_seen.add(rid)
                current.included_ramales.add(rid)

            current_name = arribo.get("nombre")
            if current_name and not current.name:
                current.name = str(current_name)

            estaciones = servicio.get("estaciones") or []
            for est in estaciones:
                next_id = self._to_int(est.get("idElemento") or est.get("id_estacion") or est.get("id"))
                if next_id is None:
                    continue

                next_info = {
                    "nombre": est.get("nombre"),
                }
                next_node = self._upsert_station(next_id, next_info)
                next_node.seen_in_arribos += 1

                if next_id != station_id:
                    current.neighbors.add(next_id)

                self._enqueue(next_id)

    def _expand_from_ramales(self) -> None:
        pending_ramales = sorted(self.ramales_seen - self.ramales_expanded)
        for rid in pending_ramales:
            payload = self._request_json("infraestructura/estaciones", {"idRamal": rid})
            self.ramal_calls += 1
            for item in self._as_list(payload):
                sid = self._to_int(item.get("id_estacion") or item.get("id") or item.get("idEstacion"))
                if sid is None:
                    continue
                self._upsert_station(sid, item)
                self._enqueue(sid)
            self.ramales_expanded.add(rid)

    def _snapshot(self) -> Dict[str, Any]:
        stations_json: Dict[str, Any] = {}
        for sid, node in sorted(self.stations.items(), key=lambda kv: kv[0]):
            stations_json[str(sid)] = {
                "id": sid,
                "name": node.name,
                "lat": node.lat,
                "lon": node.lon,
                "includedRamales": sorted(node.included_ramales),
                "operativeRamales": sorted(node.operative_ramales),
                "neighbors": sorted(node.neighbors),
                "seenInArribos": node.seen_in_arribos,
                "processed": node.processed,
            }

        return {
            "generatedAt": datetime.now(timezone.utc).isoformat(),
            "baseUrl": self.base_url,
            "seed": {
                "query": self.seed_query,
                "stationIds": self.seed_station_ids,
            },
            "stats": {
                "totalStations": len(self.stations),
                "pending": len(self.pending),
                "processed": len(self.processed_order),
                "arribosCalls": self.arribos_calls,
                "searchCalls": self.search_calls,
                "gerenciaCalls": self.gerencia_calls,
                "ramalCalls": self.ramal_calls,
                "ramalesSeen": len(self.ramales_seen),
                "ramalesExpanded": len(self.ramales_expanded),
            },
            "processedOrder": self.processed_order,
            "stations": stations_json,
        }

    def save(self) -> None:
        payload = self._snapshot()
        self.output_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    def run(self) -> None:
        self.seed()
        processed_since_save = 0

        print(
            f"[INFO] Inicio crawler | seeds={len(self.pending)} | max_stations={self.max_stations or 'sin límite'}",
            flush=True,
        )

        while self.pending:
            if 0 < self.max_stations <= len(self.processed_order):
                break

            station_id = self.pending.popleft()
            self.pending_set.discard(station_id)

            node = self._upsert_station(station_id)
            if node.processed:
                continue

            try:
                arrivals = self._fetch_arribos(station_id)
            except Exception as exc:
                print(f"[WARN] Falló arribos para {station_id}: {exc}", file=sys.stderr)
                continue

            self._expand_from_arribos(station_id, arrivals)
            node.processed = True
            self.processed_order.append(station_id)
            processed_since_save += 1

            if len(self.processed_order) % 5 == 0:
                print(
                    (
                        f"[INFO] Progreso | processed={len(self.processed_order)} "
                        f"| discovered={len(self.stations)} | pending={len(self.pending)} "
                        f"| arribosCalls={self.arribos_calls}"
                    ),
                    flush=True,
                )

            if self.sleep_ms > 0:
                time.sleep(self.sleep_ms / 1000)

            if processed_since_save >= self.save_every:
                self._expand_from_ramales()
                self.save()
                processed_since_save = 0

        self._expand_from_ramales()
        self.save()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Descubre IDs de estaciones SOFSE recorriendo arribos de forma incremental.")
    parser.add_argument("--base-url", default="https://ariedro.dev/api-trenes", help="Base URL de la API SOFSE")
    parser.add_argument("--seed-query", default="A", help="Consulta inicial por nombre de estación")
    parser.add_argument("--seed-station-id", action="append", default=[], help="ID de estación inicial adicional (repetible)")
    parser.add_argument("--seed-missing-from", default="", help="Archivo train-stations-v2.json para sembrar faltantes (sofseStationId null)")
    parser.add_argument("--seed-missing-limit", type=int, default=0, help="Límite de faltantes a sembrar (0 = todos)")
    parser.add_argument("--output", default="./scripts/sofse-stations-discovered.json", help="Archivo JSON de salida")
    parser.add_argument("--max-retries", type=int, default=3, help="Reintentos por request")
    parser.add_argument("--retry-delay-ms", type=int, default=500, help="Espera entre reintentos")
    parser.add_argument("--retry-403-delay-ms", type=int, default=3000, help="Espera entre reintentos cuando hay 403")
    parser.add_argument("--max-stations", type=int, default=0, help="Máximo de estaciones a procesar (0 = sin límite)")
    parser.add_argument("--save-every", type=int, default=20, help="Guardar snapshot cada N estaciones procesadas")
    parser.add_argument("--sleep-ms", type=int, default=0, help="Pausa entre estaciones")
    parser.add_argument("--seed-all-ramales", action="store_true", help="Semilla inicial completa desde gerencias/ramales/estaciones")
    parser.add_argument("--insecure", action="store_true", help="Desactiva validación TLS")
    return parser.parse_args()


def load_missing_station_names(train_stations_path: Path, limit: int = 0) -> List[str]:
    if not train_stations_path.exists():
        return []

    try:
        payload = json.loads(train_stations_path.read_text(encoding="utf-8"))
    except Exception:
        return []

    stations = payload.get("stations") if isinstance(payload, dict) else None
    if not isinstance(stations, dict):
        return []

    seen: Set[str] = set()
    names: List[str] = []
    for station in stations.values():
        if not isinstance(station, dict):
            continue
        if station.get("sofseStationId") is not None:
            continue
        name = (station.get("name") or "").strip()
        if not name:
            continue
        key = name.lower()
        if key in seen:
            continue
        seen.add(key)
        names.append(name)

    if limit > 0:
        return names[:limit]
    return names


def main() -> int:
    args = parse_args()
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    seed_ids = []
    for raw in args.seed_station_id:
        try:
            seed_ids.append(int(raw))
        except ValueError:
            print(f"[WARN] seed inválido ignorado: {raw}", file=sys.stderr)

    seed_names: List[str] = []
    if args.seed_missing_from:
        missing_path = Path(args.seed_missing_from)
        seed_names = load_missing_station_names(missing_path, max(0, args.seed_missing_limit))
        print(f"[INFO] Faltantes sembrados por nombre: {len(seed_names)}")

    crawler = SofseCrawler(
        base_url=args.base_url,
        output_path=output_path,
        seed_query=args.seed_query,
        seed_station_ids=seed_ids,
        seed_station_names=seed_names,
        max_retries=max(1, args.max_retries),
        retry_delay_ms=max(0, args.retry_delay_ms),
        retry_403_delay_ms=max(0, args.retry_403_delay_ms),
        max_stations=max(0, args.max_stations),
        insecure=args.insecure,
        save_every=max(1, args.save_every),
        sleep_ms=max(0, args.sleep_ms),
        seed_all_ramales=args.seed_all_ramales,
    )

    try:
        crawler.run()
    except KeyboardInterrupt:
        print("\n[WARN] Interrumpido por usuario. Guardando snapshot parcial...", file=sys.stderr, flush=True)
        try:
            crawler._expand_from_ramales()
            crawler.save()
            print(f"[INFO] Snapshot parcial guardado en: {output_path}", flush=True)
        except Exception as exc:
            print(f"[ERROR] No se pudo guardar snapshot parcial: {exc}", file=sys.stderr, flush=True)
        return 130

    print(f"✅ Listo. Archivo generado: {output_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
