# Contours

A route planner for running, where climb matters as much as distance.

Ask for eight kilometres with two hundred metres of ascent and it will generate
candidate routes, measure what each one actually is, and show you the closest
three. Or draw your own by hand and have it tell you honestly what you have
drawn.

Live at **<https://mitzdakitz.github.io/Run-Map/>**. Personal, single user, no
accounts.

It runs entirely in your browser: no server, no build step, no framework. Four
files in `s10-route-finder/web`, Leaflet from a CDN, OpenRouteService for
routing, and free elevation tiles for the shape of the ground.

## Why it works the way it does

Routing engines do point-to-point routing. There is no way to ask one for "8 km
with 250 m of climb". So the app generates many candidates, measures each one's
true distance and ascent from the 3D geometry that comes back, and ranks them.
Nothing is shown as a match unless it really is one, and when nothing matches it
says so and shows you the closest anyway, with the error on the card.

## Two ways to build a route

**Find me a route.** Give it a start, a distance and a climb target. It spends
up to twelve routing requests, measures every candidate, and returns the best
three to compare side by side.

**Plot my own.** Drag the map so the crosshair sits where you want and let go;
the point lands there, snapped to real paths. Drag a point to move it, tap the
line to insert one, tap a point to remove it. Distance and climb update as you
go.

The two are separate workspaces. Switching between them clears the map and puts
your work away, and switching back brings it out again unchanged.

## Getting started

1. Get a free key at <https://openrouteservice.org/dev/#/signup>.
2. Open the app and paste it into Settings. It is kept in that browser only and
   is only ever sent to OpenRouteService. It is never in this repository.
3. Set a start by tapping the map, searching a place, or pressing Locate.
4. Choose a mode at the top of the page and go.

On an iPhone, open it in Safari, then Share, then **Add to Home Screen** for an
icon that opens without Safari's chrome.

## What is in here

```
s10-route-finder/
  web/                the whole app
    index.html        one page, all the styling
    config.js         every tunable number in one place
    routefinder.js    the engine: routing, measuring, scoring, elevation
    app.js            the interface
  web-tests/          128 tests, no dependencies, no network
  README.md           the detailed guide: how to run it, tune it, and what it cannot do
.github/workflows/
  pages.yml           publishes to GitHub Pages on every push to main, gated on the tests
```

The folder is still called `s10-route-finder`, from when this only covered
Sheffield S10. The app itself works anywhere.

## Running it locally

ES modules will not load from a `file://` URL, so use a static server. Use one
that refuses to cache, because browsers hold on to module files and will serve
you yesterday's JavaScript alongside today's HTML:

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

Then open <http://127.0.0.1:8081>. If you ever doubt which version you are
looking at, it is printed at the bottom of Settings.

## Tests

```bash
cd s10-route-finder
node --test web-tests/*.test.js
```

No dependencies to install and no network access. They cover the ascent
measurement against deliberately noisy data, the terrain store at five
latitudes from the equator to northern Scotland, the request budget and rate
limiting, both generation shapes, scoring and tolerances, the elevation profile
and its statistics, hand-plotted routes and their editing, the saved route
library and its storage failures, and the elevation tile decoding, pinned
against real bytes from the live service.

## Known limits

The honest ones are in
[`s10-route-finder/README.md`](s10-route-finder/README.md). The one worth
knowing before you trust a number:

**The climb presets are not calibrated.** Low, Medium and High are 5, 15 and
30 metres of ascent per kilometre, and those are placeholders. Every route
generated so far has overshot its climb target by 36 to 53%, which is either
the presets being set too low for the terrain or the ascent measurement
inflating. Both fit the evidence equally well and they have opposite fixes, so
neither has been applied. Comparing one route's reported climb against a watch
figure for the same run settles it.
