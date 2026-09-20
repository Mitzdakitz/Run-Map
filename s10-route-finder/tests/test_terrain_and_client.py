import json

import pytest

from ors_client import BudgetExhausted, ORSClient, ORSError, parse_route
from terrain import TerrainStore


def _store(tmp_path):
    return TerrainStore(path=tmp_path / "terrain.json", grid_m=50.0)


def test_points_are_deduplicated_onto_the_grid(tmp_path):
    store = _store(tmp_path)
    # Three points a few metres apart collapse into one ~50 m cell.
    added = store.add_coords(
        [
            [-1.5040, 53.3736, 180.0],
            [-1.50402, 53.37362, 181.0],
            [-1.50398, 53.37358, 179.0],
        ]
    )
    assert added == 1
    assert len(store) == 1

    # A point ~400 m away is a separate cell.
    assert store.add_coords([[-1.4980, 53.3736, 210.0]]) == 1
    assert len(store) == 2


def test_store_survives_a_round_trip_to_disk(tmp_path):
    store = _store(tmp_path)
    store.add_coords([[-1.5040, 53.3736, 180.0]])
    store.save()

    reloaded = TerrainStore(path=tmp_path / "terrain.json", grid_m=50.0)
    assert len(reloaded) == 1
    assert reloaded.elevation_at(53.3736, -1.5040) == 180.0


def test_empty_store_falls_back_to_bearing_only(tmp_path):
    store = _store(tmp_path)
    (lat, lon), used_store = store.pick_waypoint(53.3736, -1.5040, 90.0, 1000.0, "high")
    assert used_store is False
    assert lat == pytest.approx(53.3736, abs=1e-3)
    assert lon > -1.5040  # due east of the start


def test_high_target_picks_the_biggest_elevation_difference(tmp_path):
    store = _store(tmp_path)
    store.add_coords([[-1.5040, 53.3736, 180.0]])  # the start itself
    # Three candidates roughly 1 km due east, at different heights.
    store.add_coords(
        [
            [-1.4890, 53.3736, 185.0],
            [-1.4880, 53.3740, 320.0],
            [-1.4900, 53.3730, 175.0],
        ]
    )
    (lat, lon), used_store = store.pick_waypoint(53.3736, -1.5040, 90.0, 1000.0, "high")
    assert used_store is True
    assert store.elevation_at(lat, lon) == 320.0

    (lat, lon), used_store = store.pick_waypoint(53.3736, -1.5040, 90.0, 1000.0, "flat")
    assert used_store is True
    assert store.elevation_at(lat, lon) == 185.0


def _fake_response(distance=5000.0):
    return {
        "features": [
            {
                "geometry": {"coordinates": [[-1.504, 53.3736, 180.0], [-1.503, 53.3740, 200.0]]},
                "properties": {"summary": {"distance": distance, "duration": 3600.0}},
            }
        ]
    }


def test_parse_route_extracts_coords_and_distance():
    coords, distance = parse_route(_fake_response(4321.0))
    assert distance == 4321.0
    assert coords[0][2] == 180.0


def test_parse_route_complains_clearly_when_empty():
    with pytest.raises(ORSError):
        parse_route({"features": []})


def test_cache_hits_do_not_spend_budget(tmp_path):
    cache = tmp_path / "cache.json"
    cache.write_text(json.dumps({}))
    client = ORSClient(api_key="test-key", budget=1, cache_path=cache)
    key = client._cache_key(client.profile, {
        "coordinates": [[-1.504, 53.3736]],
        "elevation": True,
        "instructions": False,
        "units": "m",
        "options": {"round_trip": {"length": 5000, "points": 4, "seed": 1}},
    })
    client._cache[key] = _fake_response()

    for _ in range(3):
        data = client.directions(
            [[-1.504, 53.3736]],
            round_trip={"length": 5000, "points": 4, "seed": 1},
        )
        assert parse_route(data)[1] == 5000.0

    assert client.requests_used == 0
    assert client.cache_hits == 3


def test_budget_is_never_exceeded_silently(tmp_path):
    client = ORSClient(api_key="test-key", budget=0, cache_path=tmp_path / "cache.json")
    with pytest.raises(BudgetExhausted):
        client.directions([[-1.504, 53.3736]], round_trip={"length": 5000, "points": 4})
    assert client.requests_used == 0


def test_missing_api_key_is_reported_before_any_network_call(tmp_path):
    client = ORSClient(api_key="", budget=5, cache_path=tmp_path / "cache.json")
    with pytest.raises(ORSError, match="ORS_API_KEY"):
        client.directions([[-1.504, 53.3736]], round_trip={"length": 5000, "points": 4})
