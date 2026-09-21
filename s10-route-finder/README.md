# S10 route finder

A personal route planner for running around Sheffield S10, where climb matters
as much as distance. Give it a start point, a distance and an amount of ascent;
it generates candidate routes, measures what each one actually is, and shows
you the closest three on a map.

It runs entirely in the browser. There is no server, no build step and no
framework: four files, Leaflet from a CDN, and OpenRouteService for routing.

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

## Your API key

Get a free key at <https://openrouteservice.org/dev/#/signup>.

The key is not in this repository and never should be. You paste it into the
Settings panel on the page once, and it is kept in that browser's local
storage. It is only ever sent to OpenRouteService. Clearing website data or
using Private Browsing loses it, and the page tells you when it cannot save.

## Running it locally

ES modules will not load from a `file://` URL, so use any static server:

```bash
cd s10-route-finder/web
python3 -m http.server 8081
```

Then open <http://127.0.0.1:8081>. Any Python 3 will do; nothing here needs a
particular version.

## Publishing it, and using it on an iPhone

`.github/workflows/pages.yml` publishes `s10-route-finder/web` to GitHub Pages
on every push to `main`, gated on the engine tests so a broken build is never
published. It needs two things set once:

1. The repository must be public, or on a plan that allows Pages from private
   repositories.
2. Settings, then Pages, then Source: **GitHub Actions**.

The app then lives at `https://<user>.github.io/Run-Map/`. On the iPhone, open
that in Safari, paste your key into Settings, then Share, then **Add to Home
Screen** for an icon that opens without Safari's chrome.

## Using it

1. Tap the map to set your start. Starts outside the Sheffield bounding box in
   `web/config.js` are rejected.
2. Set distance (1 to 30 km), pick Low / Medium / High climb or type exact
   metres of ascent, and choose Loop or Out and back.
3. Press Search. Each search spends up to `REQUEST_BUDGET` (default 12) routing
   requests and takes around 20 seconds, because requests are spaced out to
   stay under the free tier's 40 per minute.
4. Cards are ranked best first, each showing distance, ascent, descent, the
   error against each target, and whether it is within tolerance (5% on
   distance, 15% on ascent). Tap a card to draw that route.
5. Search again spends a fresh budget with new seeds and keeps the previous
   results in the list, so you can compare.

## Recalibrating the climb presets

`CLIMB_PRESETS` in `web/config.js` maps each preset to **metres of ascent per
km**:

```js
CLIMB_PRESETS: { low: 5, medium: 15, high: 30 },
```

Target ascent = preset value x distance in km. So Medium over 8 km asks for
120 m. These three numbers are placeholders. To recalibrate, take a handful of
runs you already know around S10, work out metres of ascent per km for each
(your watch's climb figure divided by the distance), and set the presets to the
values that match how a Low, Medium or High day actually feels to you. A flat
canal run is likely 5 or under; a Rivelin or Porter valley loop with real
climbing is likely 25 to 40.

Other knobs worth touching, all in `web/config.js`:

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
thousands of elevation points at no extra cost. Those are deduplicated onto a
roughly 50 m grid and kept in local storage. Only the elevation is stored: the
grid cell key encodes the position, which keeps a whole city inside a phone's
storage budget.

The store is then used to aim waypoints. For a high-ascent target it picks
waypoints whose stored elevation differs most from the start, which is what
sends a route up towards Crookes, Ringinglow or the Rivelin valley sides
instead of along the flat. For a low-ascent target it picks the points closest
in elevation to the start, keeping to the contour.

On a cold start the store is empty and waypoints are placed by bearing alone,
which is no better than the naive approach; the app says so in a warning. After
a few searches around the same start, the store has real coverage and the
ascent-correction pass has something to aim at. Clear terrain store in Settings
resets it.

Note that each browser builds its own store. The phone and the laptop do not
share, so using both means each improves at its own pace.

## Tests

```bash
cd s10-route-finder
node --test web-tests/*.test.js
```

31 tests, no dependencies to install, no network access. They cover the ascent
hysteresis against noisy data, the terrain store and its storage failure modes,
the request budget and rate limit handling, both generation shapes, and the
scoring and tolerance rules.

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
- **The request cache is per session.** Route geometries are large and local
  storage is limited, so repeating a search in a new tab costs requests again.
- **Free tier limits.** 40 directions requests per minute (HTTP 429) and 2000
  per day (HTTP 403). Both are reported in plain English in the app and stop
  the search rather than hammering the service. Verify the numbers against your
  own account page and correct them in `web/config.js` if they differ.
- **It depends on OpenRouteService permitting direct browser requests.** Their
  own web map works this way, so it should be fine, but if a search fails with
  a CORS error in the browser console, that is the cause, and this approach
  cannot work without a proxy or a server in front of it.
- **No accounts, no saved routes, no GPX export.** Plan a route, look at it,
  go for your run.
