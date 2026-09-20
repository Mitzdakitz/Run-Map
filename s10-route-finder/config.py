"""Configuration for the S10 route finder.

Everything you are likely to want to recalibrate lives here. Nothing in this
file is a secret: the ORS API key is read from .env at runtime.
"""
import os
from pathlib import Path

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent

load_dotenv(BASE_DIR / ".env")

# --- Credentials -----------------------------------------------------------
# Never hardcode this. Put ORS_API_KEY in .env (see .env.example).
ORS_API_KEY = os.getenv("ORS_API_KEY", "").strip()

# --- OpenRouteService ------------------------------------------------------
ORS_BASE_URL = "https://api.openrouteservice.org"
# POST /v2/directions/{profile}/geojson returns explicit 3D coordinates when
# "elevation": true is set. The plain /json variant packs elevation into an
# encoded polyline, which would need a custom decoder.
ORS_PROFILE = "foot-walking"
ORS_TIMEOUT_S = 40.0

# Free-tier limits for the directions endpoint, confirmed from the ORS docs.
# The minutely limit is a sliding 60 second window and returns HTTP 429.
# The daily limit returns HTTP 403, not 429.
# Verify these against your own account page and correct them if they differ.
ORS_RATE_LIMIT_PER_MINUTE = 40
ORS_RATE_LIMIT_PER_DAY = 2000
# Minimum spacing between live requests, with a little headroom under 40/min.
ORS_MIN_REQUEST_INTERVAL_S = 1.6

# --- Search budget ---------------------------------------------------------
# Hard ceiling on live ORS directions requests per search. Cache hits are free
# and do not count. The search stops and reports rather than exceeding this.
REQUEST_BUDGET = 12
# Loop search: how many of the budget go to pass 1 (random round trips).
LOOP_PASS1_REQUESTS = 6
# How many of the best pass 1 candidates get a pass 2 refinement.
REFINE_TOP_N = 2
# Explicit waypoint loops: 3 waypoints roughly 120 degrees apart.
LOOP_WAYPOINT_COUNT = 3
# Straight-line distance of each loop waypoint from the start, as a fraction
# of the target route distance.
LOOP_WAYPOINT_FACTOR = 0.25
# Out-and-back: how many destinations to try in pass 1, and how far away each
# sits in a straight line as a fraction of the total target distance.
OUT_AND_BACK_DESTINATIONS = 7
OUT_AND_BACK_FACTOR = 0.38

# --- Start point and bounds ------------------------------------------------
# Roughly Broomhill / Crookes, Sheffield S10.
DEFAULT_START_LAT = 53.3736
DEFAULT_START_LON = -1.5040
DEFAULT_ZOOM = 14

# Starts outside this box are rejected.
BBOX_MIN_LAT = 53.28
BBOX_MAX_LAT = 53.47
BBOX_MIN_LON = -1.78
BBOX_MAX_LON = -1.35

# --- Inputs ----------------------------------------------------------------
MIN_DISTANCE_KM = 1.0
MAX_DISTANCE_KM = 30.0

# Metres of ascent per km. Placeholders: recalibrate against your own runs.
CLIMB_PRESETS = {
    "low": 5.0,
    "medium": 15.0,
    "high": 30.0,
}

SHAPE_LOOP = "loop"
SHAPE_OUT_AND_BACK = "out_and_back"
SHAPES = (SHAPE_LOOP, SHAPE_OUT_AND_BACK)

# --- Ascent measurement ----------------------------------------------------
# Raw elevation jitters, so smooth lightly and then only count a climb once it
# exceeds the hysteresis threshold, the way a running watch does.
ASCENT_THRESHOLD_M = 3.0
ELEVATION_SMOOTHING_WINDOW = 5

# --- Scoring ---------------------------------------------------------------
W_DIST = 0.5
W_ASC = 0.5
DISTANCE_TOLERANCE = 0.05   # within 5 per cent
ASCENT_TOLERANCE = 0.15     # within 15 per cent
RESULTS_RETURNED = 3

# --- Terrain store ---------------------------------------------------------
# Every ORS response is 3D, so every search feeds this store for free.
TERRAIN_FILE = BASE_DIR / "terrain.json"
TERRAIN_GRID_M = 50.0
# How much slack around the ideal waypoint position the store may be searched
# within, as a fraction of the ideal straight-line distance.
TERRAIN_SEARCH_RADIUS_FRACTION = 0.35

# --- Request cache ---------------------------------------------------------
CACHE_FILE = BASE_DIR / "ors_cache.json"

# --- Server ----------------------------------------------------------------
HOST = "127.0.0.1"
PORT = 8000
