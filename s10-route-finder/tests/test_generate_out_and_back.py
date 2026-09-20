import random

import pytest

import config
from ascent import ascent_descent_from_coords
from fakes import START, FakeORS, constant
from generate import search
from geo import haversine_m
from terrain import TerrainStore


def one_way_climb(distance_m: float, climb_m: float, points: int = 401) -> dict:
    """An outbound leg that climbs steadily and never comes back down."""
    coords = []
    for i in range(points):
        frac = i / (points - 1)
        coords.append([START[1] + 0.010 * frac, START[0] + 0.004 * frac, 150.0 + climb_m * frac])
    return {
        "features": [
            {
                "geometry": {"type": "LineString", "coordinates": coords},
                "properties": {"summary": {"distance": distance_m, "duration": 0.0}},
            }
        ]
    }


def run(client, tmp_path, distance_m=8000.0, ascent_m=240.0, seed=3):
    return search(
        START,
        distance_m,
        ascent_m,
        config.SHAPE_OUT_AND_BACK,
        client,
        TerrainStore(path=tmp_path / "terrain.json", grid_m=50.0),
        random.Random(seed),
    )


def test_pass_one_routes_to_destinations_on_varied_bearings(tmp_path):
    client = FakeORS(lambda n, c, rt: one_way_climb(3040.0, 120.0))
    run(client, tmp_path)

    pass_one = client.calls[: config.OUT_AND_BACK_DESTINATIONS]
    assert len(pass_one) == config.OUT_AND_BACK_DESTINATIONS
    bearings_seen = []
    for call in pass_one:
        assert call["round_trip"] is None
        assert len(call["coordinates"]) == 2       # start, destination
        (lon0, lat0), (lon1, lat1) = call["coordinates"]
        assert (lat0, lon0) == pytest.approx(START)
        # Destination sits at the configured fraction of the total target.
        assert haversine_m(lat0, lon0, lat1, lon1) == pytest.approx(
            config.OUT_AND_BACK_FACTOR * 8000.0, rel=0.02
        )
        bearings_seen.append((lat1, lon1))
    assert len({(round(la, 4), round(lo, 4)) for la, lo in bearings_seen}) == len(bearings_seen)


def test_total_is_twice_the_leg_and_ascent_includes_the_return(tmp_path):
    # Outbound: 3 km climbing 120 m and never descending.
    client = FakeORS(lambda n, c, rt: one_way_climb(3000.0, 120.0), budget=1)
    result = run(client, tmp_path, distance_m=6000.0, ascent_m=120.0)

    best = result.candidates[0]
    assert best.distance_m == 6000.0                      # 2 x 3000
    assert best.ascent_m == pytest.approx(120.0, abs=3)   # up on the way out
    assert best.descent_m == pytest.approx(120.0, abs=3)  # down on the way back
    assert best.coords[0] == best.coords[-1]              # returns to the start


def test_budget_is_respected_across_both_passes(tmp_path):
    client = FakeORS(constant(3040.0, 60.0), budget=config.REQUEST_BUDGET)
    result = run(client, tmp_path)
    assert client.requests_used <= config.REQUEST_BUDGET
    assert client.requests_used == config.OUT_AND_BACK_DESTINATIONS + config.REFINE_TOP_N
    assert result.requests_used == client.requests_used


def test_distance_error_rescales_the_destination_distance(tmp_path):
    # Every leg comes back at 2 km, so the total is 4 km against an 8 km target.
    client = FakeORS(lambda n, c, rt: one_way_climb(2000.0, 120.0))
    run(client, tmp_path, distance_m=8000.0, ascent_m=120.0)

    pass_two = client.calls[config.OUT_AND_BACK_DESTINATIONS :]
    assert len(pass_two) == config.REFINE_TOP_N
    for call in pass_two:
        (lon0, lat0), (lon1, lat1) = call["coordinates"]
        # factor 0.38 scaled by 8000/4000 = 0.76 of the target
        assert haversine_m(lat0, lon0, lat1, lon1) == pytest.approx(
            2 * config.OUT_AND_BACK_FACTOR * 8000.0, rel=0.02
        )


def test_ascent_error_re_aims_rather_than_rescaling(tmp_path):
    # Distance spot on, ascent far short: keep the length, change the terrain.
    client = FakeORS(lambda n, c, rt: one_way_climb(4000.0, 5.0))
    run(client, tmp_path, distance_m=8000.0, ascent_m=400.0)

    pass_two = client.calls[config.OUT_AND_BACK_DESTINATIONS :]
    assert len(pass_two) == config.REFINE_TOP_N
    for call in pass_two:
        (lon0, lat0), (lon1, lat1) = call["coordinates"]
        assert haversine_m(lat0, lon0, lat1, lon1) == pytest.approx(
            config.OUT_AND_BACK_FACTOR * 8000.0, rel=0.02
        )


def test_hilly_targets_prefer_high_ground_when_the_store_has_data(tmp_path):
    store = TerrainStore(path=tmp_path / "terrain.json", grid_m=50.0)
    store.add_coords([[START[1], START[0], 180.0]])
    # A ridge and a flat area, both about 3 km out.
    store.add_coords(
        [
            [START[1] + 0.045, START[0] + 0.000, 420.0],
            [START[1] + 0.044, START[0] + 0.002, 182.0],
        ]
    )
    client = FakeORS(lambda n, c, rt: one_way_climb(4000.0, 240.0))
    search(START, 8000.0, 8000.0 / 1000 * config.CLIMB_PRESETS["high"],
           config.SHAPE_OUT_AND_BACK, client, store, random.Random(0))

    # At least one destination should have landed on the ridge, not the flat.
    hits = [
        c for c in client.calls
        if store.elevation_at(c["coordinates"][1][1], c["coordinates"][1][0], 60.0) == 420.0
    ]
    assert hits, "a high-climb target should aim at the highest stored ground nearby"


def test_mirrored_geometry_measures_as_a_closed_route(tmp_path):
    client = FakeORS(lambda n, c, rt: one_way_climb(3000.0, 90.0), budget=1)
    result = run(client, tmp_path, distance_m=6000.0, ascent_m=90.0)
    gain, loss = ascent_descent_from_coords(result.candidates[0].coords)
    assert gain == pytest.approx(loss, abs=1.0)
