# Contours

A route planner for running, where climb matters as much as distance. Give it a
start point, a distance and an amount of ascent; it generates candidate routes,
measures what each one actually is, and shows you the closest three. Or draw
your own and have it tell you honestly what you have drawn.

It runs entirely in the browser. There is no server, no build step and no
framework: four files, Leaflet from a CDN, OpenRouteService for routing, and
free elevation tiles for the shape of the ground.

The folder is still called `s10-route-finder`, from when this only covered
Sheffield S10. The app works anywhere.

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

ES modules will not load from a `file://` URL, so use a static server. Use this
one rather than a plain `http.server`, because browsers cache module files
aggressively and will happily serve you yesterday's JavaScript while showing
you today's HTML:

```bash
cd s10-route-finder/web
python3 -c "
import http.server
class H(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, max-age=0')
        super().end_headers()
http.server.test(HandlerClass=H, port=8081, bind='127.0.0.1')
"
```

Then open <http://127.0.0.1:8081>. Any Python 3 will do.

If you ever doubt whether you are looking at the current code, the version is
printed at the bottom of Settings and matches `APP_VERSION` in
`web/config.js`.

## Publishing it, and using it on an iPhone

`.github/workflows/pages.yml` publishes `s10-route-finder/web` to GitHub Pages
on every push to `main`, gated on the tests so a broken build is never
published. It needs two things set once:

1. The repository must be public, or on a plan that allows Pages from private
   repositories.
2. Settings, then Pages, then Source: **GitHub Actions**.

The app then lives at `https://<user>.github.io/Run-Map/`. On the iPhone, open
that in Safari, paste your key into Settings, then Share, then **Add to Home
Screen** for an icon that opens without Safari's chrome.

## The two modes

The switch at the top of the page chooses between them. They are separate
workspaces: switching clears the map and puts the other mode's work away, and
switching back brings it out again unchanged. Neither switch costs a request.

### Find me a route

1. **Set your start.** Tap the map, drag the pin, search for a place by name,
   or press Locate to use where you are. Save the starts you use often and they
   become one-tap chips.
2. **Set your targets.** Distance (1 to 30 km), Low / Medium / High climb or
   exact metres of ascent, and Loop or Out and back. The one-line summary at
   the top always shows what you are about to search for.
3. **Press Search.** Each search first reads the shape of the ground around
   your start from elevation tiles, which costs no routing requests, then
   spends up to `REQUEST_BUDGET` (default 12) routing requests. It takes around
   20 seconds, because requests are spaced out to stay under the free tier's
   40 per minute.
4. **Find your start.** The chequered disc marks where the route begins and
   ends, which on a loop is otherwise invisible because the line closes on
   itself. Drag it to move your start. On an out and back, a second marker
   shows where you turn round and how far in that is.
5. **Compare.** All the candidates are drawn at once, the selected one solid
   with direction arrows and the rest faint. Tap either a card or a faint line
   to switch. Cards are ranked best first and share one elevation scale, so
   their sparklines are genuinely comparable rather than each stretched to fill
   its own box.
6. **Inspect.** The detail panel gives the longest sustained climb and the
   steepest 200 m, which say more about whether a route is nasty than the total
   ascent does. The elevation profile below it is coloured by gradient: blue
   where you descend, warm where you climb. Drag across it and a marker follows
   the route on the map, so you can see exactly where the hill is.
7. **Reverse direction** to see the same route run the other way. The distance
   does not change but the shape of the effort does, which in hilly country is
   most of the decision.
8. **Search again** spends a fresh budget with new seeds and keeps the previous
   results below, so you can compare across searches.

### Plot my own

Drag the map so the crosshair sits where you want to go, then let go: the point
lands there, snapped to real paths by the routing service, so the line stays
something you could actually run and the elevation is measured rather than
guessed. Your finger never covers the spot you are aiming at, which is what
made tapping guesswork on a phone. Tapping the map still works, which is what a
mouse wants.

- **Drag a point** to move it. **Tap the line** to insert one where you tapped.
  **Tap a point** to remove it.
- **Close the loop** returns the route to its first point.
- **Undo** steps back through your edits.
- **The padlock** suspends placing, so you can look further along without
  committing to going there. Moving, inserting and removing points all still
  work while it is off.

Points appear the instant you release, but the routing request behind them
waits `PLOT_ROUTE_DEBOUNCE_MS`, so several points placed in quick succession
cost one request rather than one each. Plotting has its own budget
(`PLOT_BUDGET`, default 60) separate from a search's, because editing is the
most request-hungry thing the app can do.

### Saved routes

Either kind of route can be named and saved. Saved routes live in that browser
only, up to `SAVED_ROUTES_LIMIT` (default 60). A route that was plotted by hand
comes back editable, with its points intact; a route from a search comes back
to look at.

Coordinates are rounded to about a metre and stored flat, which roughly halves
what a route costs to keep. Every save reports whether it worked: browser
storage fills up and refuses silently, and a save button that quietly does
nothing is worse than one that says it could not.

## Estimated times

Times appear only once you have entered your average flat pace, under Edit.
Leave it blank and no time is shown anywhere, because a time derived from a
pace nobody gave is a fabrication.

The model is flat pace plus `CLIMB_SECONDS_PER_METRE` (default 4) per metre of
ascent. Naismith's walking rule works out at 6 s per metre, which is far too
slow for running, so 4 is a placeholder. Recalibrate it the same way as the
climb presets: run a route the app produced, compare its estimate against your
actual time, and adjust.

## Recalibrating the climb presets

**This is the most important unfinished thing in the app.** Every route
generated so far has overshot its climb target by 36 to 53%. There are two
explanations, they fit the evidence equally well, and they have opposite fixes:

- the terrain genuinely delivers more ascent per km than the presets assume, so
  `CLIMB_PRESETS` is set too low; or
- the ascent measurement inflates, so the hysteresis in `ascentDescent` needs
  changing.

Neither has been applied, because guessing wrong would bake the error into
every number the app reports. What settles it is one comparison: run a route
the app produced and put its reported climb next to what your watch recorded.

`CLIMB_PRESETS` in `web/config.js` maps each preset to **metres of ascent per
km**:

```js
CLIMB_PRESETS: { low: 5, medium: 15, high: 30 },
```

Target ascent = preset value x distance in km. So Medium over 8 km asks for
120 m. To recalibrate, take a handful of runs you already know, work out metres
of ascent per km for each (your watch's climb figure divided by the distance),
and set the presets to the values that match how a Low, Medium or High day
actually feels to you. A flat canal run is likely 5 or under; a valley loop
with real climbing is likely 25 to 40.

If instead the measurement is at fault, `ASCENT_THRESHOLD_M` (default 3) is the
knob: it is how far the elevation series must reverse before a climb is banked,
which is what stops noise accumulating into fictional ascent. Raise it if
reported climb looks consistently high against your watch.

## Where elevation comes from

Two sources, doing two different jobs.

**OpenRouteService** returns 3D geometry with every route, and that is what the
app reports. Every distance and climb figure you see comes from there.

**Terrarium elevation tiles** on AWS Open Data, free and without a key, are
used to aim waypoints and to draw the hills layer. One tile carries tens of
thousands of samples against the few hundred a single route donates, so the app
can know the shape of an area before it has ever run there. Before this, climb
targeting could only aim at ground earlier routes had crossed, which made your
first search anywhere your worst one.

They are deliberately not interchangeable. The tiles are a blended global
product: they read peaks low, Higger Tor by about 50 m and Win Hill by about
57 m, and they include sea floor, so open water reads below zero. Moving the
reported figures onto them would change every number on screen without evidence
that it improved one.

Tile samples are folded into the same terrain store as route elevation,
deduplicated onto a grid whose spacing is latitude-aware, and capped at
`MAX_TERRAIN_POINTS` (default 80,000, about 1.6 MB) so the store cannot crowd
out your saved routes. When it fills, the oldest fifth is dropped, so it
follows you as you move rather than freezing on the first area it saw.

Each browser builds its own store. The phone and the laptop do not share.
**Clear terrain store** in Settings resets it.

## When something goes wrong

A failed request tells the page almost nothing. An exhausted allowance, a
rejected key and a dropped connection all arrive as the same bare failure,
because an error response comes back without the headers a browser needs. On a
phone there is no Network tab to fall back on.

**Test the connection** in Settings sends three requests chosen to fail in
different ways: place search, routing with a deliberately invalid key, and
routing with yours. The middle one carries the argument. If a knowingly wrong
key comes back readable, then refusals are visible from your device, so a
failure that is not readable cannot be one.

## Tuning

Everything lives in `web/config.js`.

| Setting | Default | What it does |
|---|---|---|
| `REQUEST_BUDGET` | 12 | routing requests one search may spend |
| `PLOT_BUDGET` | 60 | routing requests one plotting session may spend |
| `CLIMB_PRESETS` | 5 / 15 / 30 | metres of ascent per km, per preset. Placeholders |
| `ASCENT_THRESHOLD_M` | 3 | how far the profile must reverse before a climb is banked |
| `CLIMB_SECONDS_PER_METRE` | 4 | the climb penalty in the time estimate. A placeholder |
| `W_DIST` / `W_ASC` | 0.5 / 0.5 | how the score trades distance error against ascent error |
| `DISTANCE_TOLERANCE` / `ASCENT_TOLERANCE` | 0.05 / 0.15 | what counts as a match |
| `OUT_AND_BACK_FACTOR` | 0.38 | how far out the turning point goes. See the limits below |
| `GRADIENT_WINDOW_M` | 100 | the window gradient is averaged over before banding |
| `GRADIENT_BANDS` | -6 -3 3 6 10 | the gradient percentages the six colour bands split at |
| `TERRAIN_TILE_ZOOM` | 12 | the finest zoom that carries real detail. Higher is upsampled |
| `TERRAIN_TILE_SAMPLE_M` | 100 | how finely tiles are read into the store |
| `MAX_TERRAIN_POINTS` | 80000 | the cap on the terrain store |
| `SAVED_ROUTES_LIMIT` | 60 | how many routes a browser will hold |
| `PLOT_PAN_THRESHOLD_PX` | 24 | a shorter pan is a wobble, not an aim, and places nothing |
| `ORS_PROFILE` | `foot-walking` | the routing profile |

## Tests

```bash
cd s10-route-finder
node --test web-tests/*.test.js
```

128 tests, no dependencies to install, no network access. They cover the ascent
hysteresis against noisy data, the terrain store at five latitudes from the
equator to northern Scotland, its eviction under a full store and its lookup
cost, the request budget and rate limit handling, both generation shapes, the
scoring and tolerance rules, the elevation profile and its distance scaling,
gradient smoothing and banding, the climb statistics, pace parsing, the place
search, hand-plotted routes and their editing, the saved route library and its
storage failures, the connection diagnosis in every combination of outcomes,
and the elevation tile decoding, pinned against seven real pixels read out of
the live service.

## Known limits

- **The climb presets are uncalibrated**, as above. This is the one that
  affects every number the app gives you.
- **`round_trip.length` is a hint, not a contract.** The ORS docs say so
  explicitly. On hilly, footpath-heavy ground, round trips regularly come back
  10 to 20% off the requested length, which is exactly why the app measures and
  ranks rather than trusting the request.
- **Expect outside-tolerance results.** 5% on distance is tight. When nothing
  meets both tolerances the app still returns the best three, clearly flagged
  with how far off they are. That is the tool being honest, not failing.
- **`OUT_AND_BACK_FACTOR` is likely to need lowering.** It places the turning
  point at 0.38 x the total target distance in a straight line, but real paths
  are not straight, so the routed leg tends to come back longer than half the
  target. If out-and-back results consistently overshoot, try 0.30.
- **Plot mode places a point every time you release a pan.** That is
  deliberate, and it means you cannot look around without leaving points
  behind. The padlock is the answer; Undo is the other one.
- **Elevation tiles are a blended global product**, not a survey. Peaks read
  low and open water reads below zero. They aim waypoints and draw hills; they
  are not what the app reports.
- **The request cache is per session.** Route geometries are large, so
  repeating a search in a new tab costs requests again.
- **Free tier limits.** 40 routing requests per minute (HTTP 429) and 2000 per
  day (HTTP 403). Both are reported in plain English and stop the search rather
  than hammering the service. Verify the numbers against your own account page
  and correct them in `web/config.js` if they differ.
- **Place search has its own quota**, separate from routing, so it never eats
  the search budget. Results are biased towards wherever the map is looking
  rather than restricted to it.
- **Everything is per browser.** The key, your pace, saved starts, saved routes
  and the terrain store all live in one browser and nothing syncs between
  devices.
- **No accounts, no GPX export.** Plan a route, look at it, go for your run.
