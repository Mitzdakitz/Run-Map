"""Local single-user web app: FastAPI backend plus a static Leaflet page."""
from __future__ import annotations

import random
from typing import Any, Literal

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

import config
from generate import search
from ors_client import ORSClient
from terrain import TerrainStore

app = FastAPI(title="S10 route finder")
app.mount("/static", StaticFiles(directory=config.BASE_DIR / "static"), name="static")


class SearchRequest(BaseModel):
    lat: float
    lon: float
    distance_km: float = Field(..., ge=config.MIN_DISTANCE_KM, le=config.MAX_DISTANCE_KM)
    shape: Literal["loop", "out_and_back"] = config.SHAPE_LOOP
    climb_preset: str | None = None      # "low" | "medium" | "high"
    climb_m: float | None = None         # total metres of ascent, overrides the preset


@app.exception_handler(RequestValidationError)
def validation_error(request: Request, exc: RequestValidationError) -> JSONResponse:
    """Turn FastAPI's field errors into something a person can act on."""
    problems = []
    for err in exc.errors():
        field = err.get("loc", ["field"])[-1]
        if field == "distance_km":
            problems.append(
                f"Distance must be a number between {config.MIN_DISTANCE_KM} and "
                f"{config.MAX_DISTANCE_KM} km."
            )
        elif field == "shape":
            problems.append("Shape must be either a loop or an out and back.")
        else:
            problems.append(f"{field}: {err.get('msg', 'is not valid')}.")
    return JSONResponse({"error": " ".join(problems)}, status_code=400)


@app.get("/")
def index() -> FileResponse:
    return FileResponse(config.BASE_DIR / "static" / "index.html")


@app.get("/api/config")
def client_config() -> dict[str, Any]:
    return {
        "default_start": {"lat": config.DEFAULT_START_LAT, "lon": config.DEFAULT_START_LON},
        "zoom": config.DEFAULT_ZOOM,
        "bbox": {
            "min_lat": config.BBOX_MIN_LAT,
            "max_lat": config.BBOX_MAX_LAT,
            "min_lon": config.BBOX_MIN_LON,
            "max_lon": config.BBOX_MAX_LON,
        },
        "distance": {"min_km": config.MIN_DISTANCE_KM, "max_km": config.MAX_DISTANCE_KM},
        "climb_presets": config.CLIMB_PRESETS,
        "profile": config.ORS_PROFILE,
        "request_budget": config.REQUEST_BUDGET,
        "tolerance": {
            "distance_pct": round(100 * config.DISTANCE_TOLERANCE),
            "ascent_pct": round(100 * config.ASCENT_TOLERANCE),
        },
        "has_api_key": bool(config.ORS_API_KEY),
    }


def _target_ascent_m(body: SearchRequest) -> tuple[float, str] | JSONResponse:
    if body.climb_m is not None:
        if body.climb_m < 0:
            return _error("Climb must be zero or more metres.")
        return float(body.climb_m), f"{round(body.climb_m)} m"
    preset = (body.climb_preset or "medium").lower()
    if preset not in config.CLIMB_PRESETS:
        return _error(
            f"Unknown climb preset '{preset}'. Choose one of: "
            + ", ".join(config.CLIMB_PRESETS)
        )
    per_km = config.CLIMB_PRESETS[preset]
    return per_km * body.distance_km, f"{preset} ({round(per_km)} m per km)"


def _error(message: str, status: int = 400) -> JSONResponse:
    return JSONResponse({"error": message}, status_code=status)


@app.post("/api/search")
def run_search(body: SearchRequest):
    if not config.ORS_API_KEY:
        return _error(
            "No OpenRouteService API key. Copy .env.example to .env, add your key "
            "from openrouteservice.org/dev/#/signup, and restart the app.",
            status=503,
        )
    if not (config.BBOX_MIN_LAT <= body.lat <= config.BBOX_MAX_LAT) or not (
        config.BBOX_MIN_LON <= body.lon <= config.BBOX_MAX_LON
    ):
        return _error(
            "That start point is outside the Sheffield area this app covers. "
            "Click somewhere closer to S10."
        )

    target = _target_ascent_m(body)
    if isinstance(target, JSONResponse):
        return target
    target_ascent_m, climb_label = target
    target_distance_m = body.distance_km * 1000.0

    client = ORSClient()
    store = TerrainStore()
    result = search(
        (body.lat, body.lon),
        target_distance_m,
        target_ascent_m,
        body.shape,
        client,
        store,
        random.Random(),
    )
    store.save()
    client.save_cache()

    return {
        "results": [c.as_dict() for c in result.candidates],
        "target": {
            "distance_km": body.distance_km,
            "ascent_m": round(target_ascent_m),
            "climb_label": climb_label,
            "shape": body.shape,
        },
        "budget": {
            "spent": result.requests_used,
            "total": config.REQUEST_BUDGET,
            "remaining": max(0, config.REQUEST_BUDGET - result.requests_used),
            "cache_hits": result.cache_hits,
        },
        "quota": client.quota,
        "terrain_points": len(store),
        "warnings": result.warnings,
        "stopped_early": result.stopped_early,
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=config.HOST, port=config.PORT)
