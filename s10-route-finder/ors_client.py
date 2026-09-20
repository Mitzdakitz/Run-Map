"""Minimal OpenRouteService directions client.

Confirmed against the ORS docs and source before writing:
  * POST /v2/directions/{profile}/geojson returns a FeatureCollection whose
    geometry coordinates are [lon, lat, elevation] when "elevation": true.
  * Round trips use options.round_trip = {length (m), points, seed}. The docs
    are explicit that `length` is a preference, not a promise, which is the
    whole reason this app measures what comes back.
  * Free tier: 40 directions requests per minute (sliding window, HTTP 429 on
    breach) and 2000 per day (HTTP 403 on breach).
"""
from __future__ import annotations

import hashlib
import json
import time
from pathlib import Path
from typing import Any, Sequence

import httpx

import config


class ORSError(RuntimeError):
    """Any ORS failure we want to show the user in plain English."""


class RateLimitError(ORSError):
    """Per-minute limit hit (HTTP 429)."""


class QuotaExceededError(ORSError):
    """Daily quota hit (HTTP 403)."""


class BudgetExhausted(ORSError):
    """This search has spent its REQUEST_BUDGET."""


class ORSClient:
    def __init__(
        self,
        api_key: str | None = None,
        budget: int | None = None,
        cache_path: Path | None = None,
        profile: str | None = None,
    ):
        self.api_key = api_key if api_key is not None else config.ORS_API_KEY
        self.budget = budget if budget is not None else config.REQUEST_BUDGET
        self.profile = profile or config.ORS_PROFILE
        self.cache_path = Path(cache_path) if cache_path is not None else config.CACHE_FILE
        self.requests_used = 0
        self.cache_hits = 0
        self.quota: dict[str, str] = {}
        self._cache: dict[str, Any] = {}
        self._cache_dirty = False
        self._last_request_at = 0.0
        self._load_cache()

    # --- budget ------------------------------------------------------------
    @property
    def remaining(self) -> int:
        return max(0, self.budget - self.requests_used)

    # --- cache -------------------------------------------------------------
    def _load_cache(self) -> None:
        if not self.cache_path.exists():
            return
        try:
            data = json.loads(self.cache_path.read_text())
        except (json.JSONDecodeError, OSError):
            return
        if isinstance(data, dict):
            self._cache = data

    def save_cache(self) -> None:
        if not self._cache_dirty:
            return
        try:
            self.cache_path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.cache_path.with_suffix(self.cache_path.suffix + ".tmp")
            tmp.write_text(json.dumps(self._cache))
            tmp.replace(self.cache_path)
            self._cache_dirty = False
        except OSError:
            pass  # A cache that cannot be written is not worth failing a search over.

    @staticmethod
    def _cache_key(profile: str, body: dict) -> str:
        blob = json.dumps({"profile": profile, "body": body}, sort_keys=True)
        return hashlib.sha256(blob.encode()).hexdigest()

    # --- requests ----------------------------------------------------------
    def _throttle(self) -> None:
        gap = time.monotonic() - self._last_request_at
        wait = config.ORS_MIN_REQUEST_INTERVAL_S - gap
        if wait > 0:
            time.sleep(wait)

    def directions(
        self,
        coordinates: Sequence[Sequence[float]],
        round_trip: dict | None = None,
    ) -> dict:
        """One directions call. `coordinates` are [lon, lat] pairs."""
        body: dict[str, Any] = {
            "coordinates": [[float(c[0]), float(c[1])] for c in coordinates],
            "elevation": True,
            "instructions": False,
            "units": "m",
        }
        if round_trip:
            body["options"] = {"round_trip": round_trip}

        key = self._cache_key(self.profile, body)
        if key in self._cache:
            self.cache_hits += 1
            return self._cache[key]

        if self.requests_used >= self.budget:
            raise BudgetExhausted(
                f"Request budget of {self.budget} ORS requests is spent for this search."
            )
        if not self.api_key:
            raise ORSError(
                "No ORS_API_KEY found. Copy .env.example to .env and add your key."
            )

        url = f"{config.ORS_BASE_URL}/v2/directions/{self.profile}/geojson"
        headers = {
            "Authorization": self.api_key,
            "Content-Type": "application/json; charset=utf-8",
            "Accept": "application/geo+json",
        }

        self._throttle()
        self.requests_used += 1
        try:
            response = httpx.post(
                url, json=body, headers=headers, timeout=config.ORS_TIMEOUT_S
            )
        except httpx.HTTPError as exc:
            raise ORSError(f"Could not reach OpenRouteService: {exc}") from exc
        finally:
            self._last_request_at = time.monotonic()

        self._record_quota(response.headers)

        if response.status_code == 429:
            raise RateLimitError(
                "OpenRouteService rate limit hit (40 requests per minute). "
                "Wait a minute and search again."
            )
        if response.status_code == 403:
            raise QuotaExceededError(
                "OpenRouteService daily quota exhausted (HTTP 403). "
                "It resets 24 hours after your first request of the day."
            )
        if response.status_code >= 400:
            raise ORSError(
                f"OpenRouteService returned HTTP {response.status_code}: "
                f"{_short_error(response)}"
            )

        data = response.json()
        self._cache[key] = data
        self._cache_dirty = True
        return data

    def _record_quota(self, headers) -> None:
        for name in (
            "x-ratelimit-limit",
            "x-ratelimit-remaining",
            "x-ratelimit-reset",
        ):
            value = headers.get(name)
            if value is not None:
                self.quota[name] = str(value)


def _short_error(response: httpx.Response) -> str:
    try:
        payload = response.json()
    except ValueError:
        return response.text[:200]
    error = payload.get("error", payload)
    if isinstance(error, dict):
        return str(error.get("message", error))[:200]
    return str(error)[:200]


def parse_route(feature_collection: dict) -> tuple[list[list[float]], float]:
    """Pull ([lon, lat, ele] coordinates, distance in metres) out of a response."""
    features = feature_collection.get("features") or []
    if not features:
        raise ORSError("OpenRouteService returned no route for that request.")
    feature = features[0]
    coords = feature.get("geometry", {}).get("coordinates") or []
    if not coords:
        raise ORSError("OpenRouteService returned a route with no geometry.")
    summary = feature.get("properties", {}).get("summary") or {}
    distance = summary.get("distance")
    if distance is None:
        raise ORSError("OpenRouteService returned a route with no distance summary.")
    return [list(c) for c in coords], float(distance)
