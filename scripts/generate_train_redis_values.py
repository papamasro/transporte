#!/usr/bin/env python3
import json
import math
import re
import unicodedata
from datetime import datetime, timezone
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
LINES_PATH = BASE_DIR / "train-lines-v2.json"
STATIONS_PATH = BASE_DIR / "train-stations-v2.json"
DISCOVERED_PATH = BASE_DIR / "sofse-stations-discovered.json"
OUT_LINES = BASE_DIR / "train-lines-redis.json"
OUT_STATIONS = BASE_DIR / "train-stations-redis.json"


def normalize(text: str) -> str:
    if not text:
        return ""
    text = unicodedata.normalize("NFKD", text)
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    text = text.lower()
    text = re.sub(r"[^a-z0-9\s]", " ", text)
    text = re.sub(r"\b(estacion|est|gral|general|dr|ing|pto|pte|av|jr|km|kilometro|kilometros|cabina|oeste)\b", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def approx_distance_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    x = math.radians(lon2 - lon1) * math.cos(math.radians((lat1 + lat2) / 2.0))
    y = math.radians(lat2 - lat1)
    return 6371.0 * math.sqrt(x * x + y * y)


def main() -> int:
    lines_data = json.loads(LINES_PATH.read_text(encoding="utf-8"))
    stations_data = json.loads(STATIONS_PATH.read_text(encoding="utf-8"))
    discovered_data = json.loads(DISCOVERED_PATH.read_text(encoding="utf-8"))

    lines = lines_data.get("lines", {})
    stations = stations_data.get("stations", {})
    discovered = discovered_data.get("stations", {})

    discovered_by_name = {}
    for station in discovered.values():
        key = normalize(station.get("name") or "")
        if key:
            discovered_by_name.setdefault(key, []).append(station)

    newly_filled = 0
    with_sofse = 0
    merged_stations = {}

    for station_id, station in stations.items():
        name = station.get("name")
        lat = station.get("lat")
        lon = station.get("lon")
        line_id = station.get("lineId")
        sofse_id = station.get("sofseStationId")

        if sofse_id is None:
            candidates = discovered_by_name.get(normalize(name or ""), [])
            best = None
            best_dist = None

            for candidate in candidates:
                clat = candidate.get("lat")
                clon = candidate.get("lon")
                if None in (lat, lon, clat, clon):
                    continue
                distance = approx_distance_km(lat, lon, clat, clon)
                if best is None or distance < best_dist:
                    best = candidate
                    best_dist = distance

            if best is not None and best_dist is not None and best_dist <= 4.0:
                sofse_id = best.get("id")
                newly_filled += 1

        if sofse_id is not None:
            with_sofse += 1

        merged_stations[station_id] = {
            "id": station_id,
            "name": name,
            "lat": lat,
            "lon": lon,
            "lineId": line_id,
            "sofseStationId": sofse_id,
        }

    minimal_lines = {}
    for line_id, line in lines.items():
        minimal_lines[line_id] = {
            "id": line_id,
            "name": line.get("name"),
            "short": line.get("short"),
            "color": line.get("color"),
            "stationIds": line.get("stationIds", []),
        }

    generated_at = datetime.now(timezone.utc).isoformat()

    payload_lines = {
        "version": 3,
        "generatedAt": generated_at,
        "lines": minimal_lines,
    }

    payload_stations = {
        "version": 3,
        "generatedAt": generated_at,
        "stations": merged_stations,
    }

    OUT_LINES.write_text(json.dumps(payload_lines, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    OUT_STATIONS.write_text(json.dumps(payload_stations, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    print(f"✅ Generado: {OUT_LINES}")
    print(f"✅ Generado: {OUT_STATIONS}")
    print(f"lines={len(minimal_lines)}")
    print(f"stations={len(merged_stations)}")
    print(f"with_sofse={with_sofse}")
    print(f"newly_filled={newly_filled}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
