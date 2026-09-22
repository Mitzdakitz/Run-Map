/* Everything worth recalibrating. Mirrors config.py in the server version. */
// Bumped whenever the app changes, and shown in Settings. If the version on
// screen is not the one you expect, the browser is serving you cached files.
export const APP_VERSION = '2026-09-23.6';

export const CONFIG = {
  // --- OpenRouteService ---------------------------------------------------
  ORS_BASE_URL: 'https://api.openrouteservice.org',
  ORS_PROFILE: 'foot-walking',
  // Free tier: 40 directions requests a minute (HTTP 429) and 2000 a day
  // (HTTP 403). Space requests out to stay under the minute limit.
  ORS_MIN_REQUEST_INTERVAL_MS: 1600,
  ORS_RATE_LIMIT_PER_MINUTE: 40,
  ORS_RATE_LIMIT_PER_DAY: 2000,

  // --- Search budget ------------------------------------------------------
  REQUEST_BUDGET: 12,
  LOOP_PASS1_REQUESTS: 6,
  REFINE_TOP_N: 2,
  LOOP_WAYPOINT_COUNT: 3,
  LOOP_WAYPOINT_FACTOR: 0.25,
  OUT_AND_BACK_DESTINATIONS: 7,
  OUT_AND_BACK_FACTOR: 0.38,

  // --- Start point and bounds --------------------------------------------
  DEFAULT_START: { lat: 53.3736, lon: -1.5040 },   // Broomhill / Crookes, S10
  DEFAULT_ZOOM: 14,

  // --- Inputs -------------------------------------------------------------
  MIN_DISTANCE_KM: 1,
  MAX_DISTANCE_KM: 30,
  // Metres of ascent per km. Placeholders: recalibrate against your own runs.
  CLIMB_PRESETS: { low: 5, medium: 15, high: 30 },

  // --- Ascent measurement -------------------------------------------------
  ASCENT_THRESHOLD_M: 3,
  ELEVATION_SMOOTHING_WINDOW: 5,

  // --- Elevation profile --------------------------------------------------
  // Real elevation data is noisy at roughly 30 m posting, so gradient is
  // averaged over a window before it is banded. Per-sample banding would be
  // confetti rather than readable bands.
  GRADIENT_WINDOW_M: 100,
  // Band boundaries in per cent. Negative is descending.
  GRADIENT_BANDS: [-6, -3, 3, 6, 10],

  // --- Time estimate ------------------------------------------------------
  // Only used when you have entered a flat pace. Naismith's walking rule works
  // out at 6 s per metre of climb, which is far too slow for running, so this
  // is a placeholder. Recalibrate it against your own runs, like the presets.
  CLIMB_SECONDS_PER_METRE: 4,

  // --- Map presentation ---------------------------------------------------
  ROUTE_ARROWS: 4,

  // --- Geocoding ----------------------------------------------------------
  // Same key as directions, but a separate endpoint and a separate quota.
  GEOCODE_RESULTS: 5,

  // --- Scoring ------------------------------------------------------------
  W_DIST: 0.5,
  W_ASC: 0.5,
  DISTANCE_TOLERANCE: 0.05,
  ASCENT_TOLERANCE: 0.15,
  RESULTS_RETURNED: 3,
  /* How many past searches stay on screen. Each is about 0.9 MB of coordinates
   * and profiles, and every one of its routes gets a card and a sparkline
   * rebuilt whenever the selection changes. */
  GROUPS_KEPT: 6,
  ROUTE_CACHE_LIMIT: 12,         // recent route responses kept to avoid re-asking
  PLOT_BUDGET: 60,               // routing requests one plotting session may spend
  /* Releasing a pan drops a point straight away. The points appear at once, but
   * the routing request behind them waits a moment, so panning out several in
   * quick succession costs one request rather than one each. */
  PLOT_ROUTE_DEBOUNCE_MS: 550,
  /* A pan shorter than this is a jitter or a tap, not an attempt to move the
   * crosshair somewhere, and must not drop a point. */
  PLOT_PAN_THRESHOLD_PX: 24,
  SAVED_ROUTES_LIMIT: 60,
  COORD_PRECISION: 5,            // about 1 m, and roughly halves what a route costs to store

  // --- Terrain store ------------------------------------------------------
  TERRAIN_GRID_M: 50,
  TERRAIN_SEARCH_RADIUS_FRACTION: 0.35,
  // A phone's local storage is about 5 MB. Each cell costs roughly 20 bytes,
  // so this cap leaves plenty of room and still covers a whole city.
  /* Lowered from 150,000 when elevation started arriving by the tile. Route
   * scavenging added a few hundred cells at a time, so a large cap cost
   * nothing; a harvest adds about 16,000, and at the old cap the store could
   * have taken three megabytes of the few a browser allows and crowded out the
   * saved routes. */
  MAX_TERRAIN_POINTS: 80000,
  TERRAIN_EVICT_FRACTION: 0.2,   // how much of a full store to drop to make room

  /* Free global elevation tiles, no key, on AWS Open Data. Used to aim
   * waypoints at real hills and to draw the hills layer. The distance and
   * climb this app reports still come from OpenRouteService: these tiles are
   * a blended global product whose peaks read low, and swapping the reported
   * numbers onto them would change every figure without evidence it improved
   * one. Zoom 12 is the finest that carries real detail; 13 and above return
   * the same values upsampled. */
  TERRAIN_TILE_URL: 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',
  TERRAIN_TILE_ZOOM: 12,
  TERRAIN_TILE_MAX: 9,           // tiles one harvest may fetch
  /* Tiles are read at a coarser spacing than the store's own grid. A waypoint
   * is chosen from ground within a few hundred metres of an ideal point, so
   * 100 m is ample for aiming, and sampling every 50 m instead would put four
   * times as much in a store that has to share a browser's few megabytes with
   * your saved routes. */
  TERRAIN_TILE_SAMPLE_M: 100,
  TERRAIN_TILE_ATTRIBUTION: 'Elevation: Terrarium tiles, AWS Open Data',
};

// Browser storage keys.
export const STORAGE = {
  key: 's10.orsKey',
  pace: 's10.pace',
  starts: 's10.savedStarts',
  startName: 's10.startName',
  routes: 's10.savedRoutes',
  plotLock: 's10.plotLock',
};

export const SHAPE_LOOP = 'loop';
export const SHAPE_OUT_AND_BACK = 'out_and_back';
