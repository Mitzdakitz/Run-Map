"""A local elevation store built for free out of ORS responses.

Every directions response is 3D, so every search donates a few thousand
(lat, lon, elevation) points. Deduplicated onto a ~50 m grid they accumulate
into a rough terrain model of wherever you run, which is then used to aim
waypoints uphill or along the contour instead of guessing.
"""
from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Iterable, Sequence

import config
from geo import destination, haversine_m

# Metres per degree, taken at the Sheffield reference latitude so that grid
# keys stay stable across the whole bounding box.
_M_PER_DEG_LAT = 111320.0
_M_PER_DEG_LON = 111320.0 * math.cos(math.radians(config.DEFAULT_START_LAT))


class TerrainStore:
    def __init__(self, path: Path | None = None, grid_m: float | None = None):
        self.path = Path(path) if path is not None else config.TERRAIN_FILE
        self.grid_m = grid_m if grid_m is not None else config.TERRAIN_GRID_M
        self.points: dict[str, list[float]] = {}
        self._dirty = False
        self.load()

    # --- persistence -------------------------------------------------------
    def load(self) -> None:
        if not self.path.exists():
            return
        try:
            raw = json.loads(self.path.read_text())
        except (json.JSONDecodeError, OSError):
            return
        stored_grid = raw.get("grid_m")
        if stored_grid and abs(float(stored_grid) - self.grid_m) > 1e-6:
            # Grid size changed: the old keys mean something else now.
            return
        points = raw.get("points", {})
        if isinstance(points, dict):
            self.points = {k: list(v) for k, v in points.items()}

    def save(self) -> None:
        if not self._dirty:
            return
        self.path.parent.mkdir(parents=True, exist_ok=True)
        payload = {"grid_m": self.grid_m, "points": self.points}
        tmp = self.path.with_suffix(self.path.suffix + ".tmp")
        tmp.write_text(json.dumps(payload))
        tmp.replace(self.path)
        self._dirty = False

    # --- writing -----------------------------------------------------------
    def _key(self, lat: float, lon: float) -> str:
        row = round(lat * _M_PER_DEG_LAT / self.grid_m)
        col = round(lon * _M_PER_DEG_LON / self.grid_m)
        return f"{row},{col}"

    def add_coords(self, coords: Iterable[Sequence[float]]) -> int:
        """Add ORS [lon, lat, elevation] triples. Returns new cells added."""
        added = 0
        for c in coords:
            if len(c) < 3 or c[2] is None:
                continue
            lon, lat, ele = float(c[0]), float(c[1]), float(c[2])
            key = self._key(lat, lon)
            if key not in self.points:
                self.points[key] = [lat, lon, ele]
                added += 1
        if added:
            self._dirty = True
        return added

    def __len__(self) -> int:
        return len(self.points)

    # --- reading -----------------------------------------------------------
    def _within(self, lat: float, lon: float, radius_m: float) -> list[list[float]]:
        dlat = radius_m / _M_PER_DEG_LAT
        dlon = radius_m / _M_PER_DEG_LON
        lat_lo, lat_hi = lat - dlat, lat + dlat
        lon_lo, lon_hi = lon - dlon, lon + dlon
        out = []
        for p in self.points.values():
            if lat_lo <= p[0] <= lat_hi and lon_lo <= p[1] <= lon_hi:
                if haversine_m(lat, lon, p[0], p[1]) <= radius_m:
                    out.append(p)
        return out

    def elevation_at(self, lat: float, lon: float, radius_m: float = 150.0) -> float | None:
        """Elevation of the nearest stored point, or None if the store is bare here."""
        nearby = self._within(lat, lon, radius_m)
        if not nearby:
            return None
        return min(nearby, key=lambda p: haversine_m(lat, lon, p[0], p[1]))[2]

    def pick_waypoint(
        self,
        start_lat: float,
        start_lon: float,
        bearing_deg: float,
        distance_m: float,
        prefer: str,
    ) -> tuple[tuple[float, float], bool]:
        """Aim a waypoint along `bearing_deg`, nudged by stored terrain.

        `prefer` is "high" (elevation as different from the start as possible,
        for climb-hungry targets) or "flat" (elevation closest to the start).
        Returns ((lat, lon), used_terrain_store).
        """
        ideal_lat, ideal_lon = destination(start_lat, start_lon, bearing_deg, distance_m)
        start_ele = self.elevation_at(start_lat, start_lon)
        if start_ele is None:
            return (ideal_lat, ideal_lon), False

        radius = max(distance_m * config.TERRAIN_SEARCH_RADIUS_FRACTION, self.grid_m * 2)
        candidates = self._within(ideal_lat, ideal_lon, radius)
        if not candidates:
            return (ideal_lat, ideal_lon), False

        if prefer == "high":
            best = max(candidates, key=lambda p: abs(p[2] - start_ele))
        else:
            best = min(candidates, key=lambda p: abs(p[2] - start_ele))
        return (best[0], best[1]), True
