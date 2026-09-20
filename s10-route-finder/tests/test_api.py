"""End-to-end tests of the web app. httpx is stubbed, so nothing leaves the box."""
import json

import pytest
from fastapi.testclient import TestClient

import config
import main
import ors_client
from fakes import fake_route


class StubResponse:
    def __init__(self, payload, status_code=200):
        self._payload = payload
        self.status_code = status_code
        self.headers = {"x-ratelimit-remaining": "1994", "x-ratelimit-limit": "2000"}
        self.text = json.dumps(payload)

    def json(self):
        return self._payload


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "ORS_API_KEY", "test-key")
    monkeypatch.setattr(config, "TERRAIN_FILE", tmp_path / "terrain.json")
    monkeypatch.setattr(config, "CACHE_FILE", tmp_path / "cache.json")
    monkeypatch.setattr(config, "ORS_MIN_REQUEST_INTERVAL_S", 0.0)
    return TestClient(main.app)


@pytest.fixture
def stub_ors(monkeypatch):
    calls = []

    def fake_post(url, json=None, headers=None, timeout=None):
        calls.append(json)
        return StubResponse(fake_route(5040.0, 74.0))

    monkeypatch.setattr(ors_client.httpx, "post", fake_post)
    return calls


def test_config_endpoint_describes_the_app(client):
    body = client.get("/api/config").json()
    assert body["climb_presets"] == config.CLIMB_PRESETS
    assert body["request_budget"] == config.REQUEST_BUDGET
    assert body["profile"] == config.ORS_PROFILE


def test_index_is_served(client):
    response = client.get("/")
    assert response.status_code == 200
    assert "S10 route finder" in response.text


def test_a_search_returns_ranked_results_and_budget(client, stub_ors):
    response = client.post(
        "/api/search",
        json={"lat": 53.3736, "lon": -1.5040, "distance_km": 5,
              "climb_preset": "medium", "shape": "loop"},
    )
    assert response.status_code == 200
    body = response.json()

    assert body["target"]["ascent_m"] == 75          # medium (15 m/km) x 5 km
    assert len(body["results"]) == config.RESULTS_RETURNED
    assert body["results"][0]["within_tolerance"] is True
    assert body["budget"]["spent"] <= config.REQUEST_BUDGET
    assert body["quota"]["x-ratelimit-remaining"] == "1994"
    assert body["terrain_points"] > 0
    # Leaflet needs lat, lon pairs.
    lat, lon = body["results"][0]["coords"][0]
    assert 53 < lat < 54 and -2 < lon < -1


def test_exact_metres_override_the_preset(client, stub_ors):
    body = client.post(
        "/api/search",
        json={"lat": 53.3736, "lon": -1.5040, "distance_km": 5,
              "climb_preset": "low", "climb_m": 300, "shape": "loop"},
    ).json()
    assert body["target"]["ascent_m"] == 300


def test_start_outside_sheffield_is_rejected_in_plain_english(client, stub_ors):
    response = client.post(
        "/api/search",
        json={"lat": 51.5072, "lon": -0.1276, "distance_km": 5,
              "climb_preset": "medium", "shape": "loop"},
    )
    assert response.status_code == 400
    assert "outside the Sheffield area" in response.json()["error"]
    assert stub_ors == [], "no ORS request should be made for a rejected start"


def test_distance_out_of_range_is_rejected_in_plain_english(client, stub_ors):
    response = client.post(
        "/api/search",
        json={"lat": 53.3736, "lon": -1.5040, "distance_km": 99,
              "climb_preset": "medium", "shape": "loop"},
    )
    assert response.status_code == 400
    assert "between 1.0 and 30.0 km" in response.json()["error"]


def test_missing_api_key_is_explained_not_crashed(client, monkeypatch):
    monkeypatch.setattr(config, "ORS_API_KEY", "")
    response = client.post(
        "/api/search",
        json={"lat": 53.3736, "lon": -1.5040, "distance_km": 5,
              "climb_preset": "medium", "shape": "loop"},
    )
    assert response.status_code == 503
    assert "ORS_API_KEY" in response.json()["error"] or ".env" in response.json()["error"]


def test_rate_limit_is_surfaced_and_stops_the_search(client, monkeypatch):
    calls = []

    def fake_post(url, json=None, headers=None, timeout=None):
        calls.append(json)
        if len(calls) > 2:
            return StubResponse({"error": {"message": "rate limit"}}, status_code=429)
        return StubResponse(fake_route(5040.0, 74.0))

    monkeypatch.setattr(ors_client.httpx, "post", fake_post)
    body = client.post(
        "/api/search",
        json={"lat": 53.3736, "lon": -1.5040, "distance_km": 5,
              "climb_preset": "medium", "shape": "loop"},
    ).json()

    assert len(calls) == 3
    assert "rate limit" in body["stopped_early"].lower()
    assert len(body["results"]) == 2


def test_out_and_back_search_runs_end_to_end(client, stub_ors):
    body = client.post(
        "/api/search",
        json={"lat": 53.3736, "lon": -1.5040, "distance_km": 10,
              "climb_preset": "high", "shape": "out_and_back"},
    ).json()
    assert body["target"]["ascent_m"] == 300         # high (30 m/km) x 10 km
    assert body["results"][0]["shape"] == "out_and_back"
    assert body["budget"]["spent"] <= config.REQUEST_BUDGET
