import random

import pytest

import config
from fakes import START, FakeORS, constant, fake_route
from generate import build_candidate, rank, search
from ors_client import RateLimitError
from terrain import TerrainStore


def store(tmp_path):
    return TerrainStore(path=tmp_path / "terrain.json", grid_m=50.0)


def run(client, tmp_path, distance_m=5000.0, ascent_m=300.0, seed=42):
    return search(
        START,
        distance_m,
        ascent_m,
        config.SHAPE_LOOP,
        client,
        store(tmp_path),
        random.Random(seed),
    )


# --- pass 1 ---------------------------------------------------------------
def test_pass_one_asks_for_round_trips_with_varied_seeds_and_points(tmp_path):
    client = FakeORS(constant(5000.0, 300.0))
    run(client, tmp_path)

    pass_one = client.calls[: config.LOOP_PASS1_REQUESTS]
    assert len(pass_one) == config.LOOP_PASS1_REQUESTS
    for call in pass_one:
        assert call["round_trip"]["length"] == 5000
        assert call["round_trip"]["points"] in (3, 4, 5)
        assert len(call["coordinates"]) == 1  # round trips take a single point
    seeds = {c["round_trip"]["seed"] for c in pass_one}
    assert len(seeds) == config.LOOP_PASS1_REQUESTS
    assert {c["round_trip"]["points"] for c in pass_one} == {3, 4, 5}


def test_budget_is_never_exceeded(tmp_path):
    client = FakeORS(constant(5000.0, 300.0), budget=4)
    result = run(client, tmp_path)
    assert client.requests_used == 4
    assert result.requests_used == 4


# --- pass 2 routing decision ---------------------------------------------
def test_ascent_error_path_selects_waypoint_loops(tmp_path):
    """Distance spot on, ascent nowhere near: pass 2 must build waypoint loops."""
    client = FakeORS(constant(5000.0, 20.0))  # target ascent is 300 m
    run(client, tmp_path, distance_m=5000.0, ascent_m=300.0)

    pass_two = client.calls[config.LOOP_PASS1_REQUESTS :]
    assert len(pass_two) == config.REFINE_TOP_N
    for call in pass_two:
        assert call["round_trip"] is None, "should not be another random round trip"
        # start, three waypoints, back to start
        assert len(call["coordinates"]) == config.LOOP_WAYPOINT_COUNT + 2
        assert call["coordinates"][0] == call["coordinates"][-1]


def test_waypoint_loops_are_placed_at_the_configured_radius_and_spread(tmp_path):
    from geo import haversine_m

    client = FakeORS(constant(5000.0, 20.0))
    run(client, tmp_path, distance_m=5000.0, ascent_m=300.0)

    call = client.calls[config.LOOP_PASS1_REQUESTS]
    expected = config.LOOP_WAYPOINT_FACTOR * 5000.0
    for lon, lat in call["coordinates"][1:-1]:
        assert haversine_m(START[0], START[1], lat, lon) == pytest.approx(expected, rel=0.05)


def test_distance_error_path_rescales_the_requested_length(tmp_path):
    """Ascent spot on, distance short: pass 2 must re-ask with a scaled length."""
    client = FakeORS(constant(4000.0, 300.0))
    run(client, tmp_path, distance_m=5000.0, ascent_m=300.0)

    pass_two = client.calls[config.LOOP_PASS1_REQUESTS :]
    assert len(pass_two) == config.REFINE_TOP_N
    for call in pass_two:
        assert call["round_trip"] is not None
        # asked 5000, got 4000, so ask for 5000 * 5000/4000 = 6250
        assert call["round_trip"]["length"] == 6250


# --- scoring and tolerance ------------------------------------------------
def test_score_weights_distance_and_ascent_error():
    candidate = build_candidate(
        fake_route(5500.0, 300.0)["features"][0]["geometry"]["coordinates"],
        5500.0,
        5000.0,
        300.0,
        strategy="round_trip",
        shape=config.SHAPE_LOOP,
    )
    # 10 per cent distance error, near-zero ascent error
    assert candidate.relative_distance_error == pytest.approx(0.10)
    assert candidate.score == pytest.approx(config.W_DIST * 0.10, abs=0.02)


def test_within_tolerance_needs_both_distance_and_ascent():
    def make(distance, ascent):
        coords = fake_route(distance, ascent)["features"][0]["geometry"]["coordinates"]
        return build_candidate(coords, distance, 5000.0, 300.0, "round_trip", config.SHAPE_LOOP)

    assert make(5100.0, 300.0).within_tolerance is True      # 2% and ~0%
    assert make(5400.0, 300.0).within_tolerance is False     # 8% distance
    assert make(5000.0, 200.0).within_tolerance is False     # 33% ascent


def test_results_are_ranked_best_first_and_capped(tmp_path):
    distances = iter([9000.0, 5050.0, 7000.0, 5200.0, 4000.0, 6000.0])

    def responder(call_number, coordinates, round_trip):
        return fake_route(next(distances, 5000.0), 300.0)

    client = FakeORS(responder, budget=config.LOOP_PASS1_REQUESTS)
    result = run(client, tmp_path)

    assert len(result.candidates) == config.RESULTS_RETURNED
    scores = [c.score for c in result.candidates]
    assert scores == sorted(scores)
    assert result.candidates[0].distance_m == 5050.0


def test_misses_are_returned_but_flagged_never_presented_as_matches(tmp_path):
    client = FakeORS(constant(9000.0, 20.0))  # miles off both targets
    result = run(client, tmp_path)

    assert len(result.candidates) == config.RESULTS_RETURNED
    assert all(c.within_tolerance is False for c in result.candidates)
    assert any("No candidate met both tolerances" in w for w in result.warnings)
    payload = result.candidates[0].as_dict()
    assert payload["within_tolerance"] is False
    assert payload["distance_error_km"] == 4.0
    assert payload["ascent_error_m"] < 0


def test_rank_returns_empty_when_nothing_was_generated():
    assert rank([]) == []


# --- stopping conditions --------------------------------------------------
def test_rate_limit_stops_the_search_and_keeps_what_was_found(tmp_path):
    def responder(call_number, coordinates, round_trip):
        if call_number > 2:
            raise RateLimitError("OpenRouteService rate limit hit (40 requests per minute).")
        return fake_route(5100.0, 300.0)

    client = FakeORS(responder)
    result = run(client, tmp_path)

    assert client.requests_used == 3  # the third call raised, nothing after it
    assert result.stopped_early is not None
    assert "rate limit" in result.stopped_early.lower()
    assert len(result.candidates) == 2


def test_terrain_store_is_fed_by_every_response(tmp_path):
    terrain = store(tmp_path)
    client = FakeORS(constant(5000.0, 300.0))
    search(START, 5000.0, 300.0, config.SHAPE_LOOP, client, terrain, random.Random(1))
    assert len(terrain) > 0
