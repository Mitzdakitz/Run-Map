"""Fake ORS responses and client. No test in this suite touches the network."""
from __future__ import annotations

import config
from ors_client import BudgetExhausted

START = (53.3736, -1.5040)


def fake_route(distance_m: float, ascent_m: float, points: int = 401) -> dict:
    """A synthetic geojson response that climbs `ascent_m` and comes back down."""
    coords = []
    half = points // 2
    for i in range(points):
        frac = i / (points - 1)
        lon = START[1] + 0.010 * frac
        lat = START[0] + 0.004 * frac
        if i <= half:
            ele = 150.0 + ascent_m * (i / half)
        else:
            ele = 150.0 + ascent_m * (1 - (i - half) / (points - 1 - half))
        coords.append([lon, lat, ele])
    return {
        "features": [
            {
                "geometry": {"type": "LineString", "coordinates": coords},
                "properties": {"summary": {"distance": distance_m, "duration": 0.0}},
            }
        ]
    }


class FakeORS:
    """Records every call and returns whatever the responder gives back."""

    def __init__(self, responder, budget: int = config.REQUEST_BUDGET):
        self.responder = responder
        self.budget = budget
        self.requests_used = 0
        self.cache_hits = 0
        self.calls: list[dict] = []

    @property
    def remaining(self) -> int:
        return max(0, self.budget - self.requests_used)

    def directions(self, coordinates, round_trip=None):
        if self.requests_used >= self.budget:
            raise BudgetExhausted("Request budget spent.")
        self.requests_used += 1
        self.calls.append(
            {
                "coordinates": [list(c) for c in coordinates],
                "round_trip": round_trip,
            }
        )
        return self.responder(len(self.calls), coordinates, round_trip)


def constant(distance_m: float, ascent_m: float):
    def responder(call_number, coordinates, round_trip):
        return fake_route(distance_m, ascent_m)

    return responder
