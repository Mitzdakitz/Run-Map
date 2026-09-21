/* Everything worth recalibrating. Mirrors config.py in the server version. */
// Bumped whenever the app changes, and shown in Settings. If the version on
// screen is not the one you expect, the browser is serving you cached files.
export const APP_VERSION = '2026-09-22.2';

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
  PLOT_BUDGET: 60,               // routing requests one plotting session may spend
  SAVED_ROUTES_LIMIT: 60,
  COORD_PRECISION: 5,            // about 1 m, and roughly halves what a route costs to store

  // --- Terrain store ------------------------------------------------------
  TERRAIN_GRID_M: 50,
  TERRAIN_SEARCH_RADIUS_FRACTION: 0.35,
  // A phone's local storage is about 5 MB. Each cell costs roughly 20 bytes,
  // so this cap leaves plenty of room and still covers a whole city.
  MAX_TERRAIN_POINTS: 150000,
  TERRAIN_EVICT_FRACTION: 0.2,   // how much of a full store to drop to make room
};

// Browser storage keys.
export const STORAGE = {
  key: 's10.orsKey',
  pace: 's10.pace',
  starts: 's10.savedStarts',
  startName: 's10.startName',
  routes: 's10.savedRoutes',
};

export const SHAPE_LOOP = 'loop';
export const SHAPE_OUT_AND_BACK = 'out_and_back';
