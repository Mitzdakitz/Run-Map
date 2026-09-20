# S10 route finder

A personal, single-user, local web app for planning runs around Sheffield S10,
where climb matters as much as distance. You give it a start point, a distance
and an amount of ascent; it generates candidate routes, measures what each one
actually is, and shows you the closest three on a map.

## Why it works the way it does

Routing engines do point-to-point routing. There is no way to ask one for
"8 km with 250 m of climb". So the app generates many candidates, measures each
one's true distance and ascent from the returned 3D geometry, and ranks them.
Nothing is presented as a match unless it really is one.

OpenRouteService round trips pick their overall direction from a random seed,
which means a high-climb target is hit mostly by luck. The second pass is the
counter to that: it looks at whichever error dominates and either re-asks with
a rescaled length (distance miss) or builds an explicit waypoint loop aimed
using the terrain store (ascent miss).

## Setup

Requires Python 3.11 or newer.

```bash
cd s10-route-finder
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cp .env.example .env          # then paste your key into .env
```

Get a free OpenRouteService key at <https://openrouteservice.org/dev/#/signup>.
Sign up, confirm the email, and copy the token from your dashboard into `.env`
as `ORS_API_KEY=...`. The key is never hardcoded and `.env` is gitignored.

## Run

```bash
.venv/bin/python -m uvicorn main:app --reload --port 8000
```

Then open <http://127.0.0.1:8000>.

Tests:

```bash
.venv/bin/python -m pytest
```

No test makes a network call.

## Using it

1. Click the map to move the start marker. Starts outside the Sheffield
   bounding box in `config.py` are rejected.
2. Set distance (1 to 30 km), pick Low / Medium / High climb or type exact
   metres of ascent, and choose Loop or Out and back.
3. Press Search. Each search spends up to `REQUEST_BUDGET` (default 12) routing
   requests and takes a few seconds, because requests are throttled to stay
   under the free tier's 40 per minute.
4. Cards are ranked best first, each showing distance, ascent, descent, the
   error against each target, and whether it is within tolerance (5% on
   distance, 15% on ascent). Click a card to draw that route.
5. Search again spends a fresh budget with new seeds and keeps the previous
   results in the list, so you can compare.

## Recalibrating the climb presets

`CLIMB_PRESETS` in `config.py` maps each preset to **metres of ascent per km**:

```python
CLIMB_PRESETS = {"low": 5.0, "medium": 15.0, "high": 30.0}
```

Target ascent = preset value x distance in km. So Medium over 8 km asks for
120 m. These three numbers are placeholders. To recalibrate, take a handful of
runs you already know around S10, work out metres of ascent per km for each
(your watch's climb figure divided by the distance), and set the presets to the
values that match how a Low, Medium or High day actually feels to you. A flat
canal run is likely 5 or under; a Rivelin or Porter valley loop with real
climbing is likely 25 to 40.

Other knobs worth touching, all in `config.py`:

- `ASCENT_THRESHOLD_M` (default 3) how much cumulative gain is needed before a
  climb counts. Raise it if reported ascent looks inflated against your watch.
- `W_DIST` and `W_ASC` (default 0.5 each) how the score trades distance error
  against ascent error. Raise `W_ASC` if hitting the climb matters more.
- `DISTANCE_TOLERANCE` and `ASCENT_TOLERANCE` what counts as a match.
- `OUT_AND_BACK_FACTOR` (default 0.38) how far out the turning point is placed,
  as a fraction of total target distance. See the known limits below.
- `REQUEST_BUDGET` how many routing requests a single search may spend.
- `ORS_PROFILE` (default `foot-walking`).

## How the terrain store improves results over time

Every OpenRouteService response is 3D, so every route you generate comes with
thousands of (lat, lon, elevation) points at no extra cost. Those points are
deduplicated onto a roughly 50 m grid and saved in `terrain.json`.

The store is then used to aim waypoints. For a high-ascent target it picks
waypoints whose stored elevation differs most from the start, which is what
sends a route up towards Crookes, Ringinglow or the Rivelin valley sides
instead of along the flat. For a low-ascent target it picks the points closest
in elevation to the start, keeping to the contour.

On a cold start the store is empty and waypoints are placed by bearing alone,
which is no better than the naive approach; the app says so in a warning. After
a few searches around the same start, the store has real coverage and the
ascent-correction pass has something to aim at. Delete `terrain.json` to reset
it. It only ever grows, and it costs nothing.

## Known limits

- **The first few searches are weak.** The terrain store needs data before it
  can aim anything. Expect the ascent-correction pass to be guessing until you
  have run several searches from the same area.
- **`round_trip.length` is a hint, not a contract.** The ORS docs say so
  explicitly. On a hilly, footpath-heavy area like S10, round trips regularly
  come back 10 to 20% off the requested length, which is exactly why the app
  measures and ranks rather than trusting the request.
- **Expect outside-tolerance results.** 5% on distance is tight. When nothing
  meets both tolerances the app still returns the best three, clearly flagged
  with how far off they are. That is the tool being honest, not failing.
- **`OUT_AND_BACK_FACTOR` is likely to need lowering.** It places the turning
  point at 0.38 x the total target distance in a straight line, but real paths
  are not straight, so the routed leg tends to come back longer than half the
  target. If out-and-back results consistently overshoot, try 0.30.
- **Ascent is computed from ORS elevation data**, not from a survey. It is
  smoothed and hysteresis-filtered to behave like a running watch, but it will
  not match your watch exactly, and two watches do not match each other either.
- **Free tier limits.** 40 directions requests per minute (HTTP 429) and 2000
  per day (HTTP 403). Both are reported in plain English in the UI and stop the
  search rather than hammering the service. Verify the numbers against your own
  account page and correct them in `config.py` if they differ.
- **Single user, local only.** No accounts, no database, no saved routes, no
  GPX export. Identical requests are cached in `ors_cache.json`, so repeating a
  search is free; delete that file to force fresh routing.
