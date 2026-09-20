"""Generate candidate routes, measure them, and rank them.

Routing engines do point-to-point routing. They cannot be asked for "8 km with
250 m of climb", so the only honest approach is to generate many candidates,
measure each one's real distance and ascent, and rank by how close they came.

Loop pass 1 is ORS round trips, which pick their direction at random and so hit
a high climb target only by luck. Pass 2 is the correction: it spends the rest
of the budget either rescaling the requested length (when distance was the main
error) or building explicit waypoint loops aimed using the terrain store (when
ascent was the main error).
"""
from __future__ import annotations

import random
from dataclasses import dataclass, field
from typing import Any, Protocol, Sequence

import config
from ascent import ascent_descent_from_coords
from ors_client import (
    BudgetExhausted,
    ORSError,
    QuotaExceededError,
    RateLimitError,
    parse_route,
)
from terrain import TerrainStore


class DirectionsClient(Protocol):
    remaining: int

    def directions(
        self, coordinates: Sequence[Sequence[float]], round_trip: dict | None = ...
    ) -> dict: ...


@dataclass
class Candidate:
    coords: list[list[float]]          # [lon, lat, elevation]
    distance_m: float
    ascent_m: float
    descent_m: float
    target_distance_m: float
    target_ascent_m: float
    strategy: str
    shape: str
    length_requested_m: float | None = None
    meta: dict[str, Any] = field(default_factory=dict)

    @property
    def distance_error_m(self) -> float:
        return self.distance_m - self.target_distance_m

    @property
    def ascent_error_m(self) -> float:
        return self.ascent_m - self.target_ascent_m

    @property
    def relative_distance_error(self) -> float:
        return abs(self.distance_error_m) / max(self.target_distance_m, 1.0)

    @property
    def relative_ascent_error(self) -> float:
        return abs(self.ascent_error_m) / max(self.target_ascent_m, 1.0)

    @property
    def score(self) -> float:
        return (
            config.W_DIST * self.relative_distance_error
            + config.W_ASC * self.relative_ascent_error
        )

    @property
    def within_tolerance(self) -> bool:
        return (
            self.relative_distance_error <= config.DISTANCE_TOLERANCE
            and self.relative_ascent_error <= config.ASCENT_TOLERANCE
        )

    def as_dict(self) -> dict[str, Any]:
        return {
            "coords": [[c[1], c[0]] for c in self.coords],  # Leaflet wants lat, lon
            "distance_km": round(self.distance_m / 1000.0, 2),
            "ascent_m": round(self.ascent_m),
            "descent_m": round(self.descent_m),
            "target_distance_km": round(self.target_distance_m / 1000.0, 2),
            "target_ascent_m": round(self.target_ascent_m),
            "distance_error_km": round(self.distance_error_m / 1000.0, 2),
            "ascent_error_m": round(self.ascent_error_m),
            "distance_error_pct": round(100 * self.relative_distance_error, 1),
            "ascent_error_pct": round(100 * self.relative_ascent_error, 1),
            "within_tolerance": self.within_tolerance,
            "score": round(self.score, 4),
            "strategy": self.strategy,
            "shape": self.shape,
        }


@dataclass
class SearchResult:
    candidates: list[Candidate] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    requests_used: int = 0
    cache_hits: int = 0
    stopped_early: str | None = None


def build_candidate(
    coords: list[list[float]],
    distance_m: float,
    target_distance_m: float,
    target_ascent_m: float,
    strategy: str,
    shape: str,
    length_requested_m: float | None = None,
    meta: dict[str, Any] | None = None,
) -> Candidate:
    ascent, descent = ascent_descent_from_coords(coords)
    return Candidate(
        coords=coords,
        distance_m=distance_m,
        ascent_m=ascent,
        descent_m=descent,
        target_distance_m=target_distance_m,
        target_ascent_m=target_ascent_m,
        strategy=strategy,
        shape=shape,
        length_requested_m=length_requested_m,
        meta=meta or {},
    )


def _prefer_for(candidate: Candidate) -> str:
    """Does this candidate need hillier waypoints, or flatter ones?"""
    return "high" if candidate.ascent_m < candidate.target_ascent_m else "flat"


def _waypoint_loop_coords(
    start: tuple[float, float],
    store: TerrainStore,
    target_distance_m: float,
    prefer: str,
    base_bearing: float,
) -> tuple[list[list[float]], bool]:
    """start, w1, w2, w3, start as [lon, lat] pairs, plus whether the store helped."""
    lat, lon = start
    leg = config.LOOP_WAYPOINT_FACTOR * target_distance_m
    spread = 360.0 / config.LOOP_WAYPOINT_COUNT
    coords = [[lon, lat]]
    used_store = False
    for i in range(config.LOOP_WAYPOINT_COUNT):
        bearing = (base_bearing + i * spread) % 360.0
        (wlat, wlon), used = store.pick_waypoint(lat, lon, bearing, leg, prefer)
        used_store = used_store or used
        coords.append([wlon, wlat])
    coords.append([lon, lat])
    return coords, used_store


def _rescaled_length(candidate: Candidate, target_distance_m: float) -> float:
    """Ask for a length scaled by how far off the last attempt came back."""
    asked = candidate.length_requested_m or target_distance_m
    actual = max(candidate.distance_m, 1.0)
    scaled = asked * (target_distance_m / actual)
    # Keep the ask sane: ORS treats length as a hint, not a contract.
    return max(500.0, min(scaled, target_distance_m * 2.0))


class _StopSearch(Exception):
    """Raised when the whole search must end: budget spent, or ORS said stop."""

    def __init__(self, message: str | None = None):
        super().__init__(message or "")
        self.message = message


def _attempt(
    client: DirectionsClient,
    result: SearchResult,
    coordinates: Sequence[Sequence[float]],
    round_trip: dict | None = None,
) -> tuple[list[list[float]], float] | None:
    """One request. None means skip this candidate; _StopSearch means stop dead."""
    if client.remaining <= 0:
        raise _StopSearch()
    try:
        data = client.directions(coordinates, round_trip=round_trip)
    except BudgetExhausted:
        raise _StopSearch() from None
    except (RateLimitError, QuotaExceededError) as exc:
        raise _StopSearch(str(exc)) from None
    except ORSError as exc:
        result.warnings.append(str(exc))
        return None
    try:
        return parse_route(data)
    except ORSError as exc:
        result.warnings.append(str(exc))
        return None


def search_loop(
    start: tuple[float, float],
    target_distance_m: float,
    target_ascent_m: float,
    client: DirectionsClient,
    store: TerrainStore,
    rng: random.Random,
    result: SearchResult,
) -> list[Candidate]:
    lat, lon = start
    candidates: list[Candidate] = []
    bearing_only_used = False

    try:
        # --- pass 1: random round trips -----------------------------------
        for i in range(config.LOOP_PASS1_REQUESTS):
            attempt = _attempt(
                client,
                result,
                [[lon, lat]],
                round_trip={
                    "length": round(target_distance_m),
                    "points": 3 + (i % 3),
                    "seed": rng.randint(1, 10_000_000),
                },
            )
            if attempt is None:
                continue
            coords, distance = attempt
            store.add_coords(coords)
            candidates.append(
                build_candidate(
                    coords,
                    distance,
                    target_distance_m,
                    target_ascent_m,
                    strategy="round_trip",
                    shape=config.SHAPE_LOOP,
                    length_requested_m=float(round(target_distance_m)),
                )
            )

        # --- pass 2: correct whichever error dominates ---------------------
        for candidate in sorted(candidates, key=lambda c: c.score)[: config.REFINE_TOP_N]:
            distance_dominates = (
                candidate.relative_distance_error >= candidate.relative_ascent_error
            )
            if distance_dominates:
                length = _rescaled_length(candidate, target_distance_m)
                attempt = _attempt(
                    client,
                    result,
                    [[lon, lat]],
                    round_trip={
                        "length": round(length),
                        "points": rng.choice([3, 4, 5]),
                        "seed": rng.randint(1, 10_000_000),
                    },
                )
                strategy = "round_trip_rescaled"
                asked: float | None = float(round(length))
            else:
                request_coords, used_store = _waypoint_loop_coords(
                    start,
                    store,
                    target_distance_m,
                    _prefer_for(candidate),
                    rng.uniform(0, 360),
                )
                bearing_only_used = bearing_only_used or not used_store
                attempt = _attempt(client, result, request_coords)
                strategy = "waypoint_loop"
                asked = None
            if attempt is None:
                continue
            coords, distance = attempt
            store.add_coords(coords)
            candidates.append(
                build_candidate(
                    coords,
                    distance,
                    target_distance_m,
                    target_ascent_m,
                    strategy=strategy,
                    shape=config.SHAPE_LOOP,
                    length_requested_m=asked,
                )
            )
    except _StopSearch as stop:
        if stop.message:
            result.stopped_early = stop.message

    if bearing_only_used:
        result.warnings.append(
            "The terrain store is still sparse near this start, so some waypoints "
            "were placed by bearing alone. Results improve as you run more searches here."
        )
    return candidates


def rank(candidates: Sequence[Candidate], limit: int | None = None) -> list[Candidate]:
    """Best first. Ties broken by distance error so the list is stable."""
    limit = config.RESULTS_RETURNED if limit is None else limit
    ordered = sorted(candidates, key=lambda c: (c.score, c.relative_distance_error))
    return ordered[:limit]


def search(
    start: tuple[float, float],
    target_distance_m: float,
    target_ascent_m: float,
    shape: str,
    client: DirectionsClient,
    store: TerrainStore,
    rng: random.Random | None = None,
) -> SearchResult:
    """Run one search. Never spends more than the client's remaining budget."""
    rng = rng or random.Random()
    result = SearchResult()
    if shape == config.SHAPE_LOOP:
        candidates = search_loop(
            start, target_distance_m, target_ascent_m, client, store, rng, result
        )
    elif shape == config.SHAPE_OUT_AND_BACK:
        candidates = search_out_and_back(
            start, target_distance_m, target_ascent_m, client, store, rng, result
        )
    else:
        raise ValueError(f"Unknown shape: {shape}")

    result.candidates = rank(candidates)
    result.requests_used = getattr(client, "requests_used", 0)
    result.cache_hits = getattr(client, "cache_hits", 0)
    if candidates and not any(c.within_tolerance for c in result.candidates):
        result.warnings.append(
            "No candidate met both tolerances. The routes below are the closest found, "
            "with their errors shown."
        )
    return result


def _mirror(coords: list[list[float]]) -> list[list[float]]:
    """Out and back: walk the outbound leg, then retrace it.

    Mirroring the geometry means the hysteresis measurement gives the right
    totals for free: the return leg's ascent is the outbound leg's descent.
    """
    return coords + list(reversed(coords[:-1]))


def _out_and_back_prefer(target_distance_m: float, target_ascent_m: float) -> str:
    """Hilly target, or a flat one? Decides how waypoints are chosen."""
    per_km = target_ascent_m / max(target_distance_m / 1000.0, 0.001)
    return "high" if per_km >= config.CLIMB_PRESETS["medium"] else "flat"


def _clamped_factor(factor: float) -> float:
    return max(0.05, min(factor, 0.9))


def search_out_and_back(
    start: tuple[float, float],
    target_distance_m: float,
    target_ascent_m: float,
    client: DirectionsClient,
    store: TerrainStore,
    rng: random.Random,
    result: SearchResult,
) -> list[Candidate]:
    lat, lon = start
    candidates: list[Candidate] = []
    bearing_only_used = False
    prefer = _out_and_back_prefer(target_distance_m, target_ascent_m)
    base_bearing = rng.uniform(0, 360)
    spread = 360.0 / config.OUT_AND_BACK_DESTINATIONS

    def leg(factor: float, bearing: float, prefer_mode: str):
        """Route one way to a destination, returning a mirrored candidate."""
        nonlocal bearing_only_used
        distance_out = _clamped_factor(factor) * target_distance_m
        (dlat, dlon), used_store = store.pick_waypoint(
            lat, lon, bearing, distance_out, prefer_mode
        )
        bearing_only_used = bearing_only_used or not used_store
        return _attempt(client, result, [[lon, lat], [dlon, dlat]]), _clamped_factor(factor)

    try:
        # --- pass 1: destinations on varied bearings -----------------------
        for i in range(config.OUT_AND_BACK_DESTINATIONS):
            bearing = (base_bearing + i * spread) % 360.0
            attempt, factor = leg(config.OUT_AND_BACK_FACTOR, bearing, prefer)
            if attempt is None:
                continue
            coords, one_way_distance = attempt
            store.add_coords(coords)
            candidates.append(
                build_candidate(
                    _mirror(coords),
                    2 * one_way_distance,
                    target_distance_m,
                    target_ascent_m,
                    strategy="out_and_back",
                    shape=config.SHAPE_OUT_AND_BACK,
                    meta={"bearing": bearing, "factor": factor, "prefer": prefer},
                )
            )

        # --- pass 2: correct whichever error dominates ---------------------
        for candidate in sorted(candidates, key=lambda c: c.score)[: config.REFINE_TOP_N]:
            bearing = candidate.meta["bearing"]
            factor = candidate.meta["factor"]
            distance_dominates = (
                candidate.relative_distance_error >= candidate.relative_ascent_error
            )
            if distance_dominates:
                factor = factor * (target_distance_m / max(candidate.distance_m, 1.0))
                mode = candidate.meta["prefer"]
                strategy = "out_and_back_rescaled"
            else:
                # Same length, different terrain: re-aim between two bearings.
                mode = _prefer_for(candidate)
                bearing = (bearing + spread / 2.0) % 360.0
                strategy = "out_and_back_terrain"
            attempt, factor = leg(factor, bearing, mode)
            if attempt is None:
                continue
            coords, one_way_distance = attempt
            store.add_coords(coords)
            candidates.append(
                build_candidate(
                    _mirror(coords),
                    2 * one_way_distance,
                    target_distance_m,
                    target_ascent_m,
                    strategy=strategy,
                    shape=config.SHAPE_OUT_AND_BACK,
                    meta={"bearing": bearing, "factor": factor, "prefer": mode},
                )
            )
    except _StopSearch as stop:
        if stop.message:
            result.stopped_early = stop.message

    if bearing_only_used:
        result.warnings.append(
            "The terrain store is still sparse near this start, so some destinations "
            "were placed by bearing alone. Results improve as you run more searches here."
        )
    return candidates
