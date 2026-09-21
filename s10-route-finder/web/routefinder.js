/* The search engine, ported from the Python server version.
 *
 * Routing engines do point-to-point routing and cannot be asked for "8 km with
 * 250 m of climb", so this generates many candidates, measures each one's real
 * distance and ascent from the 3D geometry, and ranks them. Nothing is called a
 * match unless it is one.
 *
 * Kept free of DOM and browser globals so it can be unit tested under node.
 */
import { CONFIG, SHAPE_LOOP, SHAPE_OUT_AND_BACK } from './config.js';

const EARTH_RADIUS_M = 6371000;
const M_PER_DEG_LAT = 111320;
const M_PER_DEG_LON = 111320 * Math.cos((CONFIG.DEFAULT_START.lat * Math.PI) / 180);

// --- geometry --------------------------------------------------------------
export function haversineM(lat1, lon1, lat2, lon2) {
  const p1 = (lat1 * Math.PI) / 180;
  const p2 = (lat2 * Math.PI) / 180;
  const dp = p2 - p1;
  const dl = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

export function destination(lat, lon, bearingDeg, distanceM) {
  const d = distanceM / EARTH_RADIUS_M;
  const b = (bearingDeg * Math.PI) / 180;
  const p1 = (lat * Math.PI) / 180;
  const l1 = (lon * Math.PI) / 180;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 = l1 + Math.atan2(
    Math.sin(b) * Math.sin(d) * Math.cos(p1),
    Math.cos(d) - Math.sin(p1) * Math.sin(p2),
  );
  return { lat: (p2 * 180) / Math.PI, lon: (((l2 * 180) / Math.PI + 540) % 360) - 180 };
}

// --- ascent ----------------------------------------------------------------
export function smooth(values, window) {
  if (window <= 1 || values.length <= 2) return values.slice();
  const half = Math.floor(window / 2);
  const out = [];
  for (let i = 0; i < values.length; i += 1) {
    const lo = Math.max(0, i - half);
    const hi = Math.min(values.length, i + half + 1);
    let sum = 0;
    for (let j = lo; j < hi; j += 1) sum += values[j];
    out.push(sum / (hi - lo));
  }
  return out;
}

/* Raw elevation jitters, and summing every upward step inflates climb badly.
 * Smooth lightly, then only bank a climb once the series reverses by more than
 * the threshold, the way a running watch does. */
export function ascentDescent(elevations, threshold = CONFIG.ASCENT_THRESHOLD_M,
                              window = CONFIG.ELEVATION_SMOOTHING_WINDOW) {
  const raw = elevations.filter((e) => e !== null && e !== undefined && !Number.isNaN(e));
  if (raw.length < 2) return { ascent: 0, descent: 0 };
  const series = smooth(raw, window);

  let gain = 0;
  let loss = 0;
  let high = series[0];
  let low = series[0];
  let direction = 0;       // 0 undecided, 1 climbing, -1 descending

  for (let i = 1; i < series.length; i += 1) {
    const e = series[i];
    if (direction === 1) {
      if (e > high) high = e;
      else if (high - e >= threshold) { gain += high - low; direction = -1; low = e; }
    } else if (direction === -1) {
      if (e < low) low = e;
      else if (e - low >= threshold) { loss += high - low; direction = 1; high = e; }
    } else if (e - low >= threshold) { direction = 1; high = e; }
    else if (high - e >= threshold) { direction = -1; low = e; }
    else { high = Math.max(high, e); low = Math.min(low, e); }
  }

  if (direction === 1) gain += high - low;
  else if (direction === -1) loss += high - low;
  return { ascent: gain, descent: loss };
}

export function ascentDescentFromCoords(coords) {
  return ascentDescent(coords.filter((c) => c.length >= 3).map((c) => c[2]));
}

// --- terrain store ---------------------------------------------------------
/* Every ORS response is 3D, so every search donates thousands of elevation
 * points for free. Deduplicated onto a ~50 m grid they become a rough terrain
 * model of wherever you run, used to aim waypoints uphill or along a contour.
 *
 * Only the elevation is stored: the grid cell key encodes the position, which
 * keeps the whole store small enough for a phone's local storage. */
const TERRAIN_KEY = 's10.terrain.v1';

export class TerrainStore {
  constructor({ storage = null, gridM = CONFIG.TERRAIN_GRID_M } = {}) {
    this.storage = storage;
    this.gridM = gridM;
    this.cells = new Map();      // "row,col" -> elevation
    this.decoded = [];           // [lat, lon, elevation], rebuilt lazily
    this.dirty = false;
    this.capped = false;
    this.load();
  }

  load() {
    if (!this.storage) return;
    let raw = null;
    try { raw = this.storage.getItem(TERRAIN_KEY); } catch { return; }
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      if (parsed.gridM !== this.gridM) return;   // old keys mean something else
      this.cells = new Map(Object.entries(parsed.cells || {}));
      this.decoded = [];
    } catch { /* a corrupt store is simply an empty one */ }
  }

  save() {
    if (!this.storage || !this.dirty) return true;
    const payload = JSON.stringify({ gridM: this.gridM, cells: Object.fromEntries(this.cells) });
    try {
      this.storage.setItem(TERRAIN_KEY, payload);
      this.dirty = false;
      return true;
    } catch {
      return false;   // storage full or blocked: the search still worked
    }
  }

  clear() {
    this.cells = new Map();
    this.decoded = [];
    this.dirty = true;
    this.save();
  }

  get size() { return this.cells.size; }

  key(lat, lon) {
    const row = Math.round((lat * M_PER_DEG_LAT) / this.gridM);
    const col = Math.round((lon * M_PER_DEG_LON) / this.gridM);
    return `${row},${col}`;
  }

  static decodeKey(key, gridM) {
    const [row, col] = key.split(',').map(Number);
    return {
      lat: (row * gridM) / M_PER_DEG_LAT,
      lon: (col * gridM) / M_PER_DEG_LON,
    };
  }

  /* coords are ORS [lon, lat, elevation] triples. Returns cells added. */
  addCoords(coords) {
    let added = 0;
    for (const c of coords) {
      if (c.length < 3 || c[2] === null || c[2] === undefined) continue;
      if (this.cells.size >= CONFIG.MAX_TERRAIN_POINTS) { this.capped = true; break; }
      const key = this.key(c[1], c[0]);
      if (!this.cells.has(key)) { this.cells.set(key, Math.round(c[2])); added += 1; }
    }
    if (added) { this.dirty = true; this.decoded = []; }
    return added;
  }

  points() {
    if (this.decoded.length !== this.cells.size) {
      this.decoded = [];
      for (const [key, ele] of this.cells) {
        const { lat, lon } = TerrainStore.decodeKey(key, this.gridM);
        this.decoded.push([lat, lon, ele]);
      }
    }
    return this.decoded;
  }

  within(lat, lon, radiusM) {
    const dlat = radiusM / M_PER_DEG_LAT;
    const dlon = radiusM / M_PER_DEG_LON;
    const out = [];
    for (const p of this.points()) {
      if (p[0] >= lat - dlat && p[0] <= lat + dlat && p[1] >= lon - dlon && p[1] <= lon + dlon) {
        if (haversineM(lat, lon, p[0], p[1]) <= radiusM) out.push(p);
      }
    }
    return out;
  }

  elevationAt(lat, lon, radiusM = 150) {
    const nearby = this.within(lat, lon, radiusM);
    if (!nearby.length) return null;
    let best = nearby[0];
    let bestD = haversineM(lat, lon, best[0], best[1]);
    for (const p of nearby) {
      const d = haversineM(lat, lon, p[0], p[1]);
      if (d < bestD) { best = p; bestD = d; }
    }
    return best[2];
  }

  /* Aim a waypoint along a bearing, nudged by stored terrain.
   * prefer "high": elevation as different from the start as possible, for
   * climb-hungry targets. prefer "flat": as close to the start as possible. */
  pickWaypoint(startLat, startLon, bearingDeg, distanceM, prefer) {
    const ideal = destination(startLat, startLon, bearingDeg, distanceM);
    const startEle = this.elevationAt(startLat, startLon);
    if (startEle === null) return { point: ideal, usedStore: false };

    const radius = Math.max(distanceM * CONFIG.TERRAIN_SEARCH_RADIUS_FRACTION, this.gridM * 2);
    const candidates = this.within(ideal.lat, ideal.lon, radius);
    if (!candidates.length) return { point: ideal, usedStore: false };

    let best = candidates[0];
    for (const p of candidates) {
      const better = prefer === 'high'
        ? Math.abs(p[2] - startEle) > Math.abs(best[2] - startEle)
        : Math.abs(p[2] - startEle) < Math.abs(best[2] - startEle);
      if (better) best = p;
    }
    return { point: { lat: best[0], lon: best[1] }, usedStore: true };
  }
}

// --- ORS client ------------------------------------------------------------
export class OrsError extends Error {}
export class RateLimitError extends OrsError {}
export class QuotaExceededError extends OrsError {}
export class BudgetExhausted extends OrsError {}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* The per minute limit is a sliding 60 second window on ORS's side, so the
 * throttle has to be shared by every client this page makes. It used to live on
 * the client instance, and a new client is made for each search, which meant two
 * searches in quick succession could put more than the limit into one window.
 * The refusal that follows arrives without CORS headers, so the browser reports
 * it as an ordinary network failure and the real cause is invisible. */
const rateLimit = {
  recent: [],
  reset() { this.recent = []; },
  async take(now, pause) {
    const windowMs = 60000;
    const ceiling = Math.max(1, CONFIG.ORS_RATE_LIMIT_PER_MINUTE - 2);
    this.recent = this.recent.filter((t) => now() - t < windowMs);
    if (this.recent.length >= ceiling) {
      const waitMs = windowMs - (now() - this.recent[0]) + 50;
      if (waitMs > 0) await pause(waitMs);
      this.recent = this.recent.filter((t) => now() - t < windowMs);
    }
    if (this.recent.length) {
      const gap = CONFIG.ORS_MIN_REQUEST_INTERVAL_MS - (now() - this.recent[this.recent.length - 1]);
      if (gap > 0) await pause(gap);
    }
    this.recent.push(now());
  },
};

/* Tests need a clean window; nothing else should call this. */
export function resetRateLimit() { rateLimit.reset(); }
export function recentRequestCount() { return rateLimit.recent.length; }

export class OrsClient {
  constructor({ apiKey, budget = CONFIG.REQUEST_BUDGET, profile = CONFIG.ORS_PROFILE,
                fetchImpl = null, sleepImpl = sleep, now = () => Date.now() } = {}) {
    this.apiKey = apiKey;
    this.budget = budget;
    this.profile = profile;
    this.fetch = fetchImpl || ((...args) => globalThis.fetch(...args));
    this.sleep = sleepImpl;
    this.now = now;
    this.requestsUsed = 0;
    this.cacheHits = 0;
    this.quota = {};
    this.cache = new Map();      // this session only: route geometries are large
  }

  get remaining() { return Math.max(0, this.budget - this.requestsUsed); }

  async directions(coordinates, roundTrip = null) {
    const body = {
      coordinates: coordinates.map((c) => [Number(c[0]), Number(c[1])]),
      elevation: true,
      instructions: false,
      units: 'm',
    };
    if (roundTrip) body.options = { round_trip: roundTrip };

    const key = JSON.stringify([this.profile, body]);
    if (this.cache.has(key)) { this.cacheHits += 1; return this.cache.get(key); }
    if (this.requestsUsed >= this.budget) {
      throw new BudgetExhausted(`Request budget of ${this.budget} routing requests is spent.`);
    }
    if (!this.apiKey) {
      throw new OrsError('No OpenRouteService API key set. Add one in Settings.');
    }

    await rateLimit.take(this.now, this.sleep);

    this.requestsUsed += 1;
    let response;
    try {
      response = await this.fetch(
        `${CONFIG.ORS_BASE_URL}/v2/directions/${this.profile}/geojson`,
        {
          method: 'POST',
          headers: {
            Authorization: this.apiKey,
            'Content-Type': 'application/json; charset=utf-8',
            Accept: 'application/geo+json',
          },
          body: JSON.stringify(body),
        },
      );
    } catch (err) {
      /* A fetch that never completes hides its reason. It is not always the
       * connection: an error response from ORS carries no CORS headers, so a
       * rate limit, an exhausted quota or a refused key all reach the browser
       * looking exactly like being offline. Say so rather than guess. */
      throw new OrsError(
        'Could not reach OpenRouteService, and the browser will not say why. '
        + 'The usual causes are a dropped connection, the per minute or daily '
        + 'limit being reached, or a key that was refused. A refusal arrives '
        + 'without the headers a browser needs, which makes it look identical '
        + 'to being offline. Check your usage on your openrouteservice.org '
        + 'dashboard.',
      );
    }

    for (const name of ['x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset']) {
      const value = response.headers && response.headers.get && response.headers.get(name);
      if (value) this.quota[name] = String(value);
    }

    if (response.status === 429) {
      throw new RateLimitError(
        'OpenRouteService rate limit hit (40 requests per minute). Wait a minute and search again.',
      );
    }
    if (response.status === 403) {
      throw new QuotaExceededError(
        'OpenRouteService daily quota exhausted. It resets 24 hours after your first request of the day.',
      );
    }
    if (response.status >= 400) {
      let detail = '';
      try {
        const payload = await response.json();
        detail = (payload.error && (payload.error.message || payload.error)) || '';
      } catch { detail = ''; }
      throw new OrsError(`OpenRouteService returned HTTP ${response.status}. ${detail}`.trim());
    }

    const data = await response.json();
    this.cache.set(key, data);
    return data;
  }
}

export function parseRoute(featureCollection) {
  const features = (featureCollection && featureCollection.features) || [];
  if (!features.length) throw new OrsError('OpenRouteService returned no route for that request.');
  const coords = (features[0].geometry && features[0].geometry.coordinates) || [];
  if (!coords.length) throw new OrsError('OpenRouteService returned a route with no geometry.');
  const summary = (features[0].properties && features[0].properties.summary) || {};
  if (summary.distance === undefined) {
    throw new OrsError('OpenRouteService returned a route with no distance summary.');
  }
  return { coords, distanceM: Number(summary.distance) };
}

// --- candidates and scoring ------------------------------------------------
export class Candidate {
  constructor({ coords, distanceM, targetDistanceM, targetAscentM, strategy, shape,
                lengthRequestedM = null, meta = {} }) {
    this.coords = coords;
    this.distanceM = distanceM;
    this.targetDistanceM = targetDistanceM;
    this.targetAscentM = targetAscentM;
    this.strategy = strategy;
    this.shape = shape;
    this.lengthRequestedM = lengthRequestedM;
    this.meta = meta;
    const { ascent, descent } = ascentDescentFromCoords(coords);
    this.ascentM = ascent;
    this.descentM = descent;
  }

  get distanceErrorM() { return this.distanceM - this.targetDistanceM; }
  get ascentErrorM() { return this.ascentM - this.targetAscentM; }
  get relativeDistanceError() {
    return Math.abs(this.distanceErrorM) / Math.max(this.targetDistanceM, 1);
  }
  get relativeAscentError() {
    return Math.abs(this.ascentErrorM) / Math.max(this.targetAscentM, 1);
  }
  get score() {
    return CONFIG.W_DIST * this.relativeDistanceError + CONFIG.W_ASC * this.relativeAscentError;
  }
  get withinTolerance() {
    return this.relativeDistanceError <= CONFIG.DISTANCE_TOLERANCE
      && this.relativeAscentError <= CONFIG.ASCENT_TOLERANCE;
  }

  toResult() {
    return {
      latLngs: this.coords.map((c) => [c[1], c[0]]),      // Leaflet wants lat, lon
      distanceKm: Math.round(this.distanceM / 10) / 100,
      ascentM: Math.round(this.ascentM),
      descentM: Math.round(this.descentM),
      targetDistanceKm: Math.round(this.targetDistanceM / 10) / 100,
      targetAscentM: Math.round(this.targetAscentM),
      distanceErrorKm: Math.round(this.distanceErrorM / 10) / 100,
      ascentErrorM: Math.round(this.ascentErrorM),
      distanceErrorPct: Math.round(1000 * this.relativeDistanceError) / 10,
      ascentErrorPct: Math.round(1000 * this.relativeAscentError) / 10,
      withinTolerance: this.withinTolerance,
      score: this.score,
      strategy: this.strategy,
      shape: this.shape,
    };
  }
}

export function rank(candidates, limit = CONFIG.RESULTS_RETURNED) {
  return candidates
    .slice()
    .sort((a, b) => (a.score - b.score) || (a.relativeDistanceError - b.relativeDistanceError))
    .slice(0, limit);
}

/* Deterministic RNG so tests can pin behaviour down. */
export function makeRng(seed) {
  let t = seed >>> 0;
  return () => {
    t += 0x6D2B79F5;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

// --- generation ------------------------------------------------------------
class StopSearch extends Error {
  constructor(message = null) { super(message || ''); this.stopMessage = message; }
}

async function attempt(client, result, coordinates, roundTrip = null) {
  if (client.remaining <= 0) throw new StopSearch();
  let data;
  try {
    data = await client.directions(coordinates, roundTrip);
  } catch (err) {
    if (err instanceof BudgetExhausted) throw new StopSearch();
    if (err instanceof RateLimitError || err instanceof QuotaExceededError) {
      throw new StopSearch(err.message);
    }
    if (err instanceof OrsError) { result.warnings.push(err.message); return null; }
    throw err;
  }
  try {
    return parseRoute(data);
  } catch (err) {
    result.warnings.push(err.message);
    return null;
  }
}

function preferFor(candidate) {
  return candidate.ascentM < candidate.targetAscentM ? 'high' : 'flat';
}

function rescaledLength(candidate, targetDistanceM) {
  const asked = candidate.lengthRequestedM || targetDistanceM;
  const scaled = asked * (targetDistanceM / Math.max(candidate.distanceM, 1));
  // ORS treats length as a hint, not a contract, so keep the ask sane.
  return Math.max(500, Math.min(scaled, targetDistanceM * 2));
}

function waypointLoopCoords(start, store, targetDistanceM, prefer, baseBearing) {
  const leg = CONFIG.LOOP_WAYPOINT_FACTOR * targetDistanceM;
  const spread = 360 / CONFIG.LOOP_WAYPOINT_COUNT;
  const coords = [[start.lon, start.lat]];
  let usedStore = false;
  for (let i = 0; i < CONFIG.LOOP_WAYPOINT_COUNT; i += 1) {
    const bearing = (baseBearing + i * spread) % 360;
    const picked = store.pickWaypoint(start.lat, start.lon, bearing, leg, prefer);
    usedStore = usedStore || picked.usedStore;
    coords.push([picked.point.lon, picked.point.lat]);
  }
  coords.push([start.lon, start.lat]);
  return { coords, usedStore };
}

/* Loop pass 1 is ORS round trips, which pick their direction from a random
 * seed and so hit a high climb target mostly by luck. Pass 2 is the counter:
 * rescale the requested length when distance is the main error, or build
 * explicit terrain-aimed waypoint loops when ascent is. */
async function searchLoop(start, targetDistanceM, targetAscentM, client, store, rng, result) {
  const candidates = [];
  let bearingOnlyUsed = false;

  try {
    for (let i = 0; i < CONFIG.LOOP_PASS1_REQUESTS; i += 1) {
      const got = await attempt(client, result, [[start.lon, start.lat]], {
        length: Math.round(targetDistanceM),
        points: 3 + (i % 3),
        seed: Math.floor(rng() * 10000000) + 1,
      });
      if (!got) continue;
      store.addCoords(got.coords);
      candidates.push(new Candidate({
        coords: got.coords,
        distanceM: got.distanceM,
        targetDistanceM,
        targetAscentM,
        strategy: 'round_trip',
        shape: SHAPE_LOOP,
        lengthRequestedM: Math.round(targetDistanceM),
      }));
    }

    const toRefine = candidates.slice().sort((a, b) => a.score - b.score)
      .slice(0, CONFIG.REFINE_TOP_N);
    for (const candidate of toRefine) {
      let got;
      let strategy;
      let asked = null;
      if (candidate.relativeDistanceError >= candidate.relativeAscentError) {
        const length = rescaledLength(candidate, targetDistanceM);
        got = await attempt(client, result, [[start.lon, start.lat]], {
          length: Math.round(length),
          points: [3, 4, 5][Math.floor(rng() * 3)],
          seed: Math.floor(rng() * 10000000) + 1,
        });
        strategy = 'round_trip_rescaled';
        asked = Math.round(length);
      } else {
        const built = waypointLoopCoords(
          start, store, targetDistanceM, preferFor(candidate), rng() * 360,
        );
        bearingOnlyUsed = bearingOnlyUsed || !built.usedStore;
        got = await attempt(client, result, built.coords);
        strategy = 'waypoint_loop';
      }
      if (!got) continue;
      store.addCoords(got.coords);
      candidates.push(new Candidate({
        coords: got.coords,
        distanceM: got.distanceM,
        targetDistanceM,
        targetAscentM,
        strategy,
        shape: SHAPE_LOOP,
        lengthRequestedM: asked,
      }));
    }
  } catch (err) {
    if (!(err instanceof StopSearch)) throw err;
    if (err.stopMessage) result.stoppedEarly = err.stopMessage;
  }

  if (bearingOnlyUsed) {
    result.warnings.push(
      'The terrain store is still sparse near this start, so some waypoints were placed '
      + 'by bearing alone. Results improve as you run more searches here.',
    );
  }
  return candidates;
}

/* Out and back: route one leg and retrace it. Mirroring the geometry means the
 * measurement gives the right totals for free, because the return leg's ascent
 * is the outbound leg's descent. */
function mirror(coords) {
  return coords.concat(coords.slice(0, -1).reverse());
}

function outAndBackPrefer(targetDistanceM, targetAscentM) {
  const perKm = targetAscentM / Math.max(targetDistanceM / 1000, 0.001);
  return perKm >= CONFIG.CLIMB_PRESETS.medium ? 'high' : 'flat';
}

const clampFactor = (f) => Math.max(0.05, Math.min(f, 0.9));

async function searchOutAndBack(start, targetDistanceM, targetAscentM, client, store, rng, result) {
  const candidates = [];
  let bearingOnlyUsed = false;
  const prefer = outAndBackPrefer(targetDistanceM, targetAscentM);
  const baseBearing = rng() * 360;
  const spread = 360 / CONFIG.OUT_AND_BACK_DESTINATIONS;

  const leg = async (factor, bearing, mode) => {
    const clamped = clampFactor(factor);
    const picked = store.pickWaypoint(
      start.lat, start.lon, bearing, clamped * targetDistanceM, mode,
    );
    bearingOnlyUsed = bearingOnlyUsed || !picked.usedStore;
    const got = await attempt(client, result, [
      [start.lon, start.lat], [picked.point.lon, picked.point.lat],
    ]);
    return { got, factor: clamped };
  };

  try {
    for (let i = 0; i < CONFIG.OUT_AND_BACK_DESTINATIONS; i += 1) {
      const bearing = (baseBearing + i * spread) % 360;
      const { got, factor } = await leg(CONFIG.OUT_AND_BACK_FACTOR, bearing, prefer);
      if (!got) continue;
      store.addCoords(got.coords);
      candidates.push(new Candidate({
        coords: mirror(got.coords),
        distanceM: 2 * got.distanceM,
        targetDistanceM,
        targetAscentM,
        strategy: 'out_and_back',
        shape: SHAPE_OUT_AND_BACK,
        meta: { bearing, factor, prefer },
      }));
    }

    const toRefine = candidates.slice().sort((a, b) => a.score - b.score)
      .slice(0, CONFIG.REFINE_TOP_N);
    for (const candidate of toRefine) {
      let { bearing, factor } = candidate.meta;
      let mode;
      let strategy;
      if (candidate.relativeDistanceError >= candidate.relativeAscentError) {
        factor *= targetDistanceM / Math.max(candidate.distanceM, 1);
        mode = candidate.meta.prefer;
        strategy = 'out_and_back_rescaled';
      } else {
        // Same length, different terrain: re-aim between two bearings.
        mode = preferFor(candidate);
        bearing = (bearing + spread / 2) % 360;
        strategy = 'out_and_back_terrain';
      }
      const attemptResult = await leg(factor, bearing, mode);
      if (!attemptResult.got) continue;
      store.addCoords(attemptResult.got.coords);
      candidates.push(new Candidate({
        coords: mirror(attemptResult.got.coords),
        distanceM: 2 * attemptResult.got.distanceM,
        targetDistanceM,
        targetAscentM,
        strategy,
        shape: SHAPE_OUT_AND_BACK,
        meta: { bearing, factor: attemptResult.factor, prefer: mode },
      }));
    }
  } catch (err) {
    if (!(err instanceof StopSearch)) throw err;
    if (err.stopMessage) result.stoppedEarly = err.stopMessage;
  }

  if (bearingOnlyUsed) {
    result.warnings.push(
      'The terrain store is still sparse near this start, so some destinations were placed '
      + 'by bearing alone. Results improve as you run more searches here.',
    );
  }
  return candidates;
}

/* One search. Never spends more than the client's remaining budget. */
export async function search({ start, targetDistanceM, targetAscentM, shape, client, store,
                               rng = Math.random }) {
  const result = { candidates: [], warnings: [], stoppedEarly: null, requestsUsed: 0, cacheHits: 0 };
  let candidates;
  if (shape === SHAPE_LOOP) {
    candidates = await searchLoop(start, targetDistanceM, targetAscentM, client, store, rng, result);
  } else if (shape === SHAPE_OUT_AND_BACK) {
    candidates = await searchOutAndBack(
      start, targetDistanceM, targetAscentM, client, store, rng, result,
    );
  } else {
    throw new Error(`Unknown shape: ${shape}`);
  }

  result.candidates = rank(candidates);
  result.requestsUsed = client.requestsUsed;
  result.cacheHits = client.cacheHits;
  if (candidates.length && !result.candidates.some((c) => c.withinTolerance)) {
    result.warnings.push(
      'No candidate met both tolerances. The routes below are the closest found, '
      + 'with their errors shown.',
    );
  }
  return result;
}

// --- elevation profile -----------------------------------------------------
/* Turn a route's [lon, lat, elevation] coordinates into [[km, metres], ...]
 * against cumulative distance along the route.
 *
 * Two details that matter. The elevation series is the SMOOTHED one, the same
 * series the ascent figure is computed from, so a chart drawn from this agrees
 * with the number beside it. And the cumulative distance is scaled so its total
 * matches the distance ORS reported, rather than the slightly different total
 * you get by summing great-circle hops between points. */
export function profile(coords, summaryDistanceM = null) {
  const usable = coords.filter((c) => c.length >= 3 && c[2] !== null && c[2] !== undefined);
  if (usable.length < 2) return [];

  const smoothed = smooth(usable.map((c) => c[2]), CONFIG.ELEVATION_SMOOTHING_WINDOW);

  const cumulative = [0];
  for (let i = 1; i < usable.length; i += 1) {
    cumulative.push(
      cumulative[i - 1] + haversineM(usable[i - 1][1], usable[i - 1][0], usable[i][1], usable[i][0]),
    );
  }
  const measured = cumulative[cumulative.length - 1];
  const scale = summaryDistanceM && measured > 0 ? summaryDistanceM / measured : 1;

  return usable.map((c, i) => ({
    km: (cumulative[i] * scale) / 1000,
    ele: smoothed[i],
    lat: c[1],
    lon: c[0],
  }));
}

/* Gradient per cent at a point, averaged over GRADIENT_WINDOW_M. */
export function gradientAt(points, index, windowM = CONFIG.GRADIENT_WINDOW_M) {
  if (points.length < 2) return 0;
  const halfKm = windowM / 2000;
  let lo = index;
  let hi = index;
  while (lo > 0 && points[index].km - points[lo].km < halfKm) lo -= 1;
  while (hi < points.length - 1 && points[hi].km - points[index].km < halfKm) hi += 1;
  const runM = (points[hi].km - points[lo].km) * 1000;
  return runM <= 0 ? 0 : ((points[hi].ele - points[lo].ele) / runM) * 100;
}

/* Which of the six bands a gradient falls in. 0 is the steepest descent and 5
 * the steepest climb, so the index orders by severity from downhill to uphill. */
export function gradientBand(pct) {
  const [d2, d1, u1, u2, u3] = CONFIG.GRADIENT_BANDS;
  if (pct <= d2) return 0;
  if (pct <= d1) return 1;
  if (pct < u1) return 2;
  if (pct < u2) return 3;
  if (pct < u3) return 4;
  return 5;
}

/* The longest run of continuous climbing, ignoring dips under the threshold.
 * Length is measured to the PEAK, not to the current point, so a climb that
 * flattens out at the top does not keep inflating its own length. */
export function longestClimb(points, threshold = CONFIG.ASCENT_THRESHOLD_M) {
  if (points.length < 2) return { km: 0, gain: 0, fromKm: 0 };
  let best = { km: 0, gain: 0, fromKm: 0 };
  let startIndex = 0;
  let peak = points[0].ele;
  let peakKm = points[0].km;

  for (let i = 1; i < points.length; i += 1) {
    const e = points[i].ele;
    if (e >= peak - threshold) {
      if (e > peak) { peak = e; peakKm = points[i].km; }
      const gain = peak - points[startIndex].ele;
      if (gain > best.gain) {
        best = { km: peakKm - points[startIndex].km, gain, fromKm: points[startIndex].km };
      }
    } else {
      startIndex = i;
      peak = e;
      peakKm = points[i].km;
    }
  }
  return best;
}

/* The steepest stretch of a given length. Total ascent hides whether a route is
 * one wall or a lot of rollers; this is the number that answers that. */
export function steepestWindow(points, windowM = 200) {
  const windowKm = windowM / 1000;
  let best = { gain: 0, atKm: 0 };
  let j = 0;
  for (let i = 0; i < points.length; i += 1) {
    if (j < i) j = i;
    while (j < points.length - 1 && points[j].km - points[i].km < windowKm) j += 1;
    if (points[j].km - points[i].km >= windowKm * 0.85) {
      const gain = points[j].ele - points[i].ele;
      if (gain > best.gain) best = { gain, atKm: points[i].km };
    }
  }
  return best;
}

/* Run the route the other way round. The distance is unchanged, but where the
 * climbs fall is not, which in Sheffield is most of the decision. */
export function reverseProfile(points) {
  if (!points.length) return [];
  const total = points[points.length - 1].km;
  return points.slice().reverse().map((p) => ({ ...p, km: total - p.km }));
}

// --- time estimate ---------------------------------------------------------
/* Minutes per km as seconds, from "5:40", "5.40" or "5.67". Null if unusable. */
export function parsePace(text) {
  if (text === null || text === undefined) return null;
  const trimmed = String(text).trim();
  if (!trimmed) return null;
  const clock = trimmed.match(/^(\d{1,2})[:.,](\d{1,2})$/);
  if (clock) {
    const seconds = Number(clock[2]) * (clock[2].length === 1 ? 10 : 1);
    if (seconds >= 60) return null;
    return Number(clock[1]) * 60 + seconds;
  }
  const decimal = Number(trimmed);
  return Number.isFinite(decimal) && decimal > 0 ? decimal * 60 : null;
}

/* Flat pace plus a climb penalty. Returns null when no pace is set, so the UI
 * can show nothing rather than a number built on a guess. */
export function estimateSeconds(distanceM, ascentM, paceSecondsPerKm) {
  if (!paceSecondsPerKm) return null;
  return (distanceM / 1000) * paceSecondsPerKm + ascentM * CONFIG.CLIMB_SECONDS_PER_METRE;
}

export function formatDuration(seconds) {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

// --- geocoding -------------------------------------------------------------
/* Place search, constrained to the Sheffield bounding box so you get Crookes in
 * S10 rather than Crookes in Queensland. This is a separate ORS endpoint with
 * its own quota, so it never spends the routing budget. */
export async function geocode(text, apiKey, fetchImpl = null) {
  const query = String(text || '').trim();
  if (query.length < 2) return [];
  if (!apiKey) throw new OrsError('No OpenRouteService API key set. Add one in Settings.');

  const b = CONFIG.BBOX;
  const url = `${CONFIG.ORS_BASE_URL}/geocode/search`
    + `?api_key=${encodeURIComponent(apiKey)}`
    + `&text=${encodeURIComponent(query)}`
    + `&boundary.rect.min_lon=${b.minLon}&boundary.rect.min_lat=${b.minLat}`
    + `&boundary.rect.max_lon=${b.maxLon}&boundary.rect.max_lat=${b.maxLat}`
    + `&focus.point.lon=${CONFIG.DEFAULT_START.lon}&focus.point.lat=${CONFIG.DEFAULT_START.lat}`
    + `&size=${CONFIG.GEOCODE_RESULTS}`;

  const doFetch = fetchImpl || ((...args) => globalThis.fetch(...args));
  let response;
  try {
    response = await doFetch(url, { method: 'GET' });
  } catch (err) {
    throw new OrsError(`Could not reach the place search: ${err.message}`);
  }
  if (response.status === 429 || response.status === 403) {
    throw new OrsError('Place search quota reached. Tap the map to set a start instead.');
  }
  if (response.status >= 400) {
    throw new OrsError(`Place search failed (HTTP ${response.status}).`);
  }
  const data = await response.json();
  return (data.features || []).map((f) => ({
    label: (f.properties && (f.properties.label || f.properties.name)) || 'Unnamed place',
    locality: (f.properties && (f.properties.locality || f.properties.county)) || '',
    lat: f.geometry.coordinates[1],
    lon: f.geometry.coordinates[0],
  }));
}
