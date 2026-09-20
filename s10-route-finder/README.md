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

## Two versions in this folder

There are now two implementations of the same app:

- **`web/`** the static version. Runs entirely in the browser, calls
  OpenRouteService directly, needs no server. This is the one that works on an
  iPhone, and the one published to GitHub Pages.
- **the Python files in this folder** the original server version. FastAPI plus
  the same logic in Python, run locally on a laptop.

They share no code, so **a change to one does not reach the other**. That is a
real maintenance cost and it was an accepted trade of going server-free. If you
settle on the static version, the Python files and their tests can be deleted;
say so and they will be removed in one go.

The rest of this README covers the server version first, then the static one.

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

## The static version, and using it on an iPhone

`web/` holds a self-contained app: `index.html`, `app.js` for the interface,
`routefinder.js` for the search engine and `config.js` for the settings. No
build step, no framework, no server.

### Your key on the phone

The key is not in the code and not in this repo. You paste it into the Settings
panel on the page once, and it is kept in that browser's local storage. It is
only ever sent to OpenRouteService. Clearing Safari's website data or using
Private Browsing loses it, and the page says so when it cannot save.

### Previewing it locally

ES modules will not load from a `file://` URL, so use any static server:

```bash
cd s10-route-finder/web
python3 -m http.server 8080
```

Then open <http://127.0.0.1:8080>.

### Publishing it to GitHub Pages

Once the repository is public and Pages is switched on, the app lives at a URL
you can open on the phone. On the iPhone, open that URL in Safari, then Share,
then **Add to Home Screen** for an icon that opens without Safari's chrome.

### Tests

The engine has its own tests, with no dependencies to install:

```bash
cd s10-route-finder
node --test web-tests/*.test.js
```

They cover the same ground as the Python suite, including a check that the
ported ascent maths returns the same number as the Python version on identical
input. Nothing in them touches the network.

### What differs from the server version

- **The terrain store lives in the browser**, not in `terrain.json`, so the
  phone and the laptop build separate stores that never merge. To keep the
  store small enough for a phone, only the elevation is kept per grid cell and
  the position is derived from the cell key, which is accurate to about 50 m.
- **The request cache is per session only.** Route geometries are large and
  local storage is limited to a few megabytes, so repeating a search in a new
  tab costs requests again.
- **It depends on OpenRouteService permitting direct browser requests.** Their
  own web map works this way, so it should be fine, but if a search fails with
  a CORS error in the browser console, that is the cause, and the static
  version cannot work without a proxy or a server.
