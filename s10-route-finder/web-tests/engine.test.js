/* Tests for the ported engine. Run with: node --test web-tests/
 * No dependencies and no network: fetch is replaced with a fake throughout. */
import test from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG, SHAPE_LOOP, SHAPE_OUT_AND_BACK } from '../web/config.js';
import {
  BudgetExhausted, Candidate, OrsClient, RateLimitError, TerrainStore,
  ascentDescent, haversineM, makeRng, parseRoute, rank, recentRequestCount,
  resetRateLimit, search,
} from '../web/routefinder.js';

const START = { lat: 53.3736, lon: -1.5040 };

// --- helpers ---------------------------------------------------------------
function fakeStorage() {
  const data = new Map();
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, v),
    removeItem: (k) => data.delete(k),
  };
}

/* A synthetic response that climbs `ascentM` and comes back down. */
function fakeRoute(distanceM, ascentM, points = 401) {
  const coords = [];
  const half = Math.floor(points / 2);
  for (let i = 0; i < points; i += 1) {
    const frac = i / (points - 1);
    const ele = i <= half
      ? 150 + ascentM * (i / half)
      : 150 + ascentM * (1 - (i - half) / (points - 1 - half));
    coords.push([START.lon + 0.010 * frac, START.lat + 0.004 * frac, ele]);
  }
  return {
    features: [{
      geometry: { type: 'LineString', coordinates: coords },
      properties: { summary: { distance: distanceM, duration: 0 } },
    }],
  };
}

/* An outbound leg that climbs steadily and never comes back down. */
function oneWayClimb(distanceM, climbM, points = 401) {
  const coords = [];
  for (let i = 0; i < points; i += 1) {
    const frac = i / (points - 1);
    coords.push([START.lon + 0.010 * frac, START.lat + 0.004 * frac, 150 + climbM * frac]);
  }
  return {
    features: [{
      geometry: { type: 'LineString', coordinates: coords },
      properties: { summary: { distance: distanceM, duration: 0 } },
    }],
  };
}

/* Stands in for OrsClient: records every call, never touches the network. */
class FakeORS {
  constructor(responder, budget = CONFIG.REQUEST_BUDGET) {
    this.responder = responder;
    this.budget = budget;
    this.requestsUsed = 0;
    this.cacheHits = 0;
    this.calls = [];
  }

  get remaining() { return Math.max(0, this.budget - this.requestsUsed); }

  async directions(coordinates, roundTrip = null) {
    if (this.requestsUsed >= this.budget) throw new BudgetExhausted('Request budget spent.');
    this.requestsUsed += 1;
    this.calls.push({ coordinates: coordinates.map((c) => c.slice()), roundTrip });
    return this.responder(this.calls.length, coordinates, roundTrip);
  }
}

const constant = (distanceM, ascentM) => () => fakeRoute(distanceM, ascentM);
const newStore = () => new TerrainStore({ storage: fakeStorage() });

function runLoop(client, opts = {}) {
  return search({
    start: START,
    targetDistanceM: opts.distanceM ?? 5000,
    targetAscentM: opts.ascentM ?? 300,
    shape: SHAPE_LOOP,
    client,
    store: opts.store || newStore(),
    rng: makeRng(opts.seed ?? 42),
  });
}

// --- ascent ----------------------------------------------------------------
test('a noisy flat line gives near zero ascent', () => {
  const rng = makeRng(1);
  const series = Array.from({ length: 500 }, () => 100 + (rng() * 4 - 2));
  const { ascent, descent } = ascentDescent(series);
  assert.ok(ascent < 5, `ascent was ${ascent}`);
  assert.ok(descent < 5, `descent was ${descent}`);
});

test('a steady 100 m climb gives about 100 m', () => {
  const series = Array.from({ length: 200 }, (_, i) => (i * 100) / 199);
  const { ascent, descent } = ascentDescent(series);
  assert.ok(ascent >= 95 && ascent <= 105, `ascent was ${ascent}`);
  assert.ok(descent < 1);
});

test('a 100 m climb with 2 m noise still gives about 100 m', () => {
  const rng = makeRng(7);
  const series = Array.from({ length: 200 }, (_, i) => (i * 100) / 199 + (rng() * 4 - 2));
  const { ascent, descent } = ascentDescent(series);
  assert.ok(ascent >= 90 && ascent <= 115, `ascent was ${ascent}`);
  assert.ok(descent < 15, `descent was ${descent}`);
});

test('descent is counted separately', () => {
  const up = Array.from({ length: 100 }, (_, i) => (i * 50) / 99);
  const down = Array.from({ length: 100 }, (_, i) => 50 - (i * 50) / 99);
  const { ascent, descent } = ascentDescent(up.concat(down));
  assert.ok(ascent >= 45 && ascent <= 52, `ascent was ${ascent}`);
  assert.ok(descent >= 45 && descent <= 52, `descent was ${descent}`);
});

test('the ported maths matches the Python version on the same input', () => {
  // The server version measures this exact profile as 296.7 m of ascent.
  const coords = fakeRoute(5000, 300).features[0].geometry.coordinates;
  const { ascent } = ascentDescent(coords.map((c) => c[2]));
  assert.ok(Math.abs(ascent - 296.7) < 0.5, `ascent was ${ascent}, expected about 296.7`);
});

test('a short or empty series is zero', () => {
  assert.deepEqual(ascentDescent([]), { ascent: 0, descent: 0 });
  assert.deepEqual(ascentDescent([12]), { ascent: 0, descent: 0 });
});

// --- terrain store ---------------------------------------------------------
test('points are deduplicated onto the grid', () => {
  const store = newStore();
  const added = store.addCoords([
    [-1.5040, 53.3736, 180], [-1.50402, 53.37362, 181], [-1.50398, 53.37358, 179],
  ]);
  assert.equal(added, 1);
  assert.equal(store.size, 1);
  assert.equal(store.addCoords([[-1.4980, 53.3736, 210]]), 1);
  assert.equal(store.size, 2);
});

test('the store survives a round trip through local storage', () => {
  const storage = fakeStorage();
  const store = new TerrainStore({ storage });
  store.addCoords([[-1.5040, 53.3736, 180]]);
  assert.equal(store.save(), true);

  const reloaded = new TerrainStore({ storage });
  assert.equal(reloaded.size, 1);
  assert.equal(reloaded.elevationAt(53.3736, -1.5040), 180);
});

test('a full or blocked local storage does not break the store', () => {
  const store = new TerrainStore({
    storage: { getItem: () => null, setItem: () => { throw new Error('QuotaExceededError'); } },
  });
  store.addCoords([[-1.5040, 53.3736, 180]]);
  assert.equal(store.save(), false, 'save reports failure rather than throwing');
  assert.equal(store.size, 1, 'the search still has its data in memory');
});

test('an empty store falls back to bearing only', () => {
  const { point, usedStore } = newStore().pickWaypoint(53.3736, -1.5040, 90, 1000, 'high');
  assert.equal(usedStore, false);
  assert.ok(Math.abs(point.lat - 53.3736) < 1e-3);
  assert.ok(point.lon > -1.5040, 'due east of the start');
});

test('a high target picks the biggest elevation difference, a flat one the smallest', () => {
  const store = newStore();
  store.addCoords([[-1.5040, 53.3736, 180]]);
  store.addCoords([
    [-1.4890, 53.3736, 185], [-1.4880, 53.3740, 320], [-1.4900, 53.3730, 175],
  ]);
  const high = store.pickWaypoint(53.3736, -1.5040, 90, 1000, 'high');
  assert.equal(high.usedStore, true);
  assert.equal(store.elevationAt(high.point.lat, high.point.lon), 320);

  const flat = store.pickWaypoint(53.3736, -1.5040, 90, 1000, 'flat');
  assert.equal(store.elevationAt(flat.point.lat, flat.point.lon), 185);
});

// --- ORS client ------------------------------------------------------------
test('identical requests are served from cache without spending budget', async () => {
  const client = new OrsClient({
    apiKey: 'test-key',
    budget: 1,
    sleepImpl: async () => {},
    fetchImpl: async () => ({
      status: 200,
      headers: { get: () => null },
      json: async () => fakeRoute(5000, 300),
    }),
  });
  for (let i = 0; i < 3; i += 1) {
    await client.directions([[-1.504, 53.3736]], { length: 5000, points: 4, seed: 1 });
  }
  assert.equal(client.requestsUsed, 1);
  assert.equal(client.cacheHits, 2);
});

test('the budget is never exceeded silently', async () => {
  const client = new OrsClient({
    apiKey: 'k',
    budget: 0,
    fetchImpl: async () => { throw new Error('should never be called'); },
  });
  await assert.rejects(() => client.directions([[-1.504, 53.3736]]), BudgetExhausted);
  assert.equal(client.requestsUsed, 0);
});

test('a missing key is reported before any network call', async () => {
  let called = false;
  const client = new OrsClient({ apiKey: '', fetchImpl: async () => { called = true; } });
  await assert.rejects(() => client.directions([[-1.504, 53.3736]]), /API key/);
  assert.equal(called, false);
});

test('429 and 403 are told apart', async () => {
  const make = (status) => new OrsClient({
    apiKey: 'k',
    sleepImpl: async () => {},
    fetchImpl: async () => ({ status, headers: { get: () => null }, json: async () => ({}) }),
  });
  await assert.rejects(() => make(429).directions([[-1.5, 53.37]]), /rate limit/i);
  await assert.rejects(() => make(403).directions([[-1.5, 53.37]]), /daily quota/i);
});

test('parseRoute complains clearly when there is nothing to parse', () => {
  assert.throws(() => parseRoute({ features: [] }), /no route/);
  assert.equal(parseRoute(fakeRoute(4321, 100)).distanceM, 4321);
});

// --- loop generation -------------------------------------------------------
test('pass one asks for round trips with varied seeds and points', async () => {
  const client = new FakeORS(constant(5000, 300));
  await runLoop(client);

  const passOne = client.calls.slice(0, CONFIG.LOOP_PASS1_REQUESTS);
  assert.equal(passOne.length, CONFIG.LOOP_PASS1_REQUESTS);
  for (const call of passOne) {
    assert.equal(call.roundTrip.length, 5000);
    assert.ok([3, 4, 5].includes(call.roundTrip.points));
    assert.equal(call.coordinates.length, 1, 'round trips take a single point');
  }
  assert.equal(new Set(passOne.map((c) => c.roundTrip.seed)).size, CONFIG.LOOP_PASS1_REQUESTS);
  assert.equal(new Set(passOne.map((c) => c.roundTrip.points)).size, 3);
});

test('the ascent error path selects waypoint loops', async () => {
  // Distance spot on, ascent nowhere near: pass 2 must build waypoint loops.
  const client = new FakeORS(constant(5000, 20));
  await runLoop(client, { distanceM: 5000, ascentM: 300 });

  const passTwo = client.calls.slice(CONFIG.LOOP_PASS1_REQUESTS);
  assert.equal(passTwo.length, CONFIG.REFINE_TOP_N);
  for (const call of passTwo) {
    assert.equal(call.roundTrip, null, 'should not be another random round trip');
    assert.equal(call.coordinates.length, CONFIG.LOOP_WAYPOINT_COUNT + 2);
    assert.deepEqual(call.coordinates[0], call.coordinates[call.coordinates.length - 1]);
    for (const [lon, lat] of call.coordinates.slice(1, -1)) {
      const d = haversineM(START.lat, START.lon, lat, lon);
      const expected = CONFIG.LOOP_WAYPOINT_FACTOR * 5000;
      assert.ok(Math.abs(d - expected) / expected < 0.05, `waypoint ${d} m from start`);
    }
  }
});

test('the distance error path rescales the requested length', async () => {
  const client = new FakeORS(constant(4000, 300));
  await runLoop(client, { distanceM: 5000, ascentM: 300 });

  const passTwo = client.calls.slice(CONFIG.LOOP_PASS1_REQUESTS);
  assert.equal(passTwo.length, CONFIG.REFINE_TOP_N);
  // asked 5000, got 4000, so ask for 5000 * 5000/4000 = 6250
  for (const call of passTwo) assert.equal(call.roundTrip.length, 6250);
});

test('the budget is respected across both passes', async () => {
  const client = new FakeORS(constant(5000, 300), 4);
  const result = await runLoop(client);
  assert.equal(client.requestsUsed, 4);
  assert.equal(result.requestsUsed, 4);
});

// --- scoring and tolerance -------------------------------------------------
test('within tolerance needs both distance and ascent', () => {
  const make = (distance, ascent) => new Candidate({
    coords: fakeRoute(distance, ascent).features[0].geometry.coordinates,
    distanceM: distance,
    targetDistanceM: 5000,
    targetAscentM: 300,
    strategy: 'round_trip',
    shape: SHAPE_LOOP,
  });
  assert.equal(make(5100, 300).withinTolerance, true);    // 2% and about 0%
  assert.equal(make(5400, 300).withinTolerance, false);   // 8% distance
  assert.equal(make(5000, 200).withinTolerance, false);   // 33% ascent
});

test('results are ranked best first and capped at three', async () => {
  const distances = [9000, 5050, 7000, 5200, 4000, 6000];
  const client = new FakeORS(
    (n) => fakeRoute(distances[n - 1] ?? 5000, 300),
    CONFIG.LOOP_PASS1_REQUESTS,
  );
  const result = await runLoop(client);

  assert.equal(result.candidates.length, CONFIG.RESULTS_RETURNED);
  const scores = result.candidates.map((c) => c.score);
  assert.deepEqual(scores, scores.slice().sort((a, b) => a - b));
  assert.equal(result.candidates[0].distanceM, 5050);
});

test('misses are returned but flagged, never presented as matches', async () => {
  const client = new FakeORS(constant(9000, 20));
  const result = await runLoop(client);

  assert.equal(result.candidates.length, CONFIG.RESULTS_RETURNED);
  assert.ok(result.candidates.every((c) => c.withinTolerance === false));
  assert.ok(result.warnings.some((w) => w.includes('No candidate met both tolerances')));
  const payload = result.candidates[0].toResult();
  assert.equal(payload.withinTolerance, false);
  assert.equal(payload.distanceErrorKm, 4);
  assert.ok(payload.ascentErrorM < 0);
});

test('rank returns empty when nothing was generated', () => {
  assert.deepEqual(rank([]), []);
});

test('a rate limit stops the search and keeps what was found', async () => {
  const client = new FakeORS((n) => {
    if (n > 2) throw new RateLimitError('OpenRouteService rate limit hit (40 per minute).');
    return fakeRoute(5100, 300);
  });
  const result = await runLoop(client);

  assert.equal(client.requestsUsed, 3, 'the third call raised, nothing after it');
  assert.ok(/rate limit/i.test(result.stoppedEarly));
  assert.equal(result.candidates.length, 2);
});

test('every response feeds the terrain store', async () => {
  const store = newStore();
  await runLoop(new FakeORS(constant(5000, 300)), { store });
  assert.ok(store.size > 0);
});

// --- out and back ----------------------------------------------------------
function runOutAndBack(client, opts = {}) {
  return search({
    start: START,
    targetDistanceM: opts.distanceM ?? 8000,
    targetAscentM: opts.ascentM ?? 240,
    shape: SHAPE_OUT_AND_BACK,
    client,
    store: opts.store || newStore(),
    rng: makeRng(opts.seed ?? 3),
  });
}

test('pass one routes to destinations on varied bearings', async () => {
  const client = new FakeORS(() => oneWayClimb(3040, 120));
  await runOutAndBack(client);

  const passOne = client.calls.slice(0, CONFIG.OUT_AND_BACK_DESTINATIONS);
  assert.equal(passOne.length, CONFIG.OUT_AND_BACK_DESTINATIONS);
  const seen = new Set();
  for (const call of passOne) {
    assert.equal(call.roundTrip, null);
    assert.equal(call.coordinates.length, 2, 'start and destination');
    const [[lon0, lat0], [lon1, lat1]] = call.coordinates;
    assert.ok(Math.abs(lat0 - START.lat) < 1e-9 && Math.abs(lon0 - START.lon) < 1e-9);
    const d = haversineM(lat0, lon0, lat1, lon1);
    const expected = CONFIG.OUT_AND_BACK_FACTOR * 8000;
    assert.ok(Math.abs(d - expected) / expected < 0.02, `destination ${d} m out`);
    seen.add(`${lat1.toFixed(4)},${lon1.toFixed(4)}`);
  }
  assert.equal(seen.size, passOne.length, 'destinations should all differ');
});

test('the total is twice the leg and the ascent includes the return', async () => {
  const client = new FakeORS(() => oneWayClimb(3000, 120), 1);
  const result = await runOutAndBack(client, { distanceM: 6000, ascentM: 120 });

  const best = result.candidates[0];
  assert.equal(best.distanceM, 6000);                       // 2 x 3000
  assert.ok(Math.abs(best.ascentM - 120) < 3, `ascent ${best.ascentM}`);
  assert.ok(Math.abs(best.descentM - 120) < 3, `descent ${best.descentM}`);
  assert.deepEqual(best.coords[0], best.coords[best.coords.length - 1]);
});

test('out and back respects the budget across both passes', async () => {
  const client = new FakeORS(constant(3040, 60));
  const result = await runOutAndBack(client);
  assert.ok(client.requestsUsed <= CONFIG.REQUEST_BUDGET);
  assert.equal(client.requestsUsed, CONFIG.OUT_AND_BACK_DESTINATIONS + CONFIG.REFINE_TOP_N);
  assert.equal(result.requestsUsed, client.requestsUsed);
});

test('a distance error rescales the destination distance', async () => {
  // Every leg is 2 km, so the total is 4 km against an 8 km target.
  const client = new FakeORS(() => oneWayClimb(2000, 120));
  await runOutAndBack(client, { distanceM: 8000, ascentM: 120 });

  const passTwo = client.calls.slice(CONFIG.OUT_AND_BACK_DESTINATIONS);
  assert.equal(passTwo.length, CONFIG.REFINE_TOP_N);
  for (const call of passTwo) {
    const [[lon0, lat0], [lon1, lat1]] = call.coordinates;
    const d = haversineM(lat0, lon0, lat1, lon1);
    const expected = 2 * CONFIG.OUT_AND_BACK_FACTOR * 8000;
    assert.ok(Math.abs(d - expected) / expected < 0.02, `destination ${d} m out`);
  }
});

test('an ascent error re-aims rather than rescaling', async () => {
  const client = new FakeORS(() => oneWayClimb(4000, 5));
  await runOutAndBack(client, { distanceM: 8000, ascentM: 400 });

  const passTwo = client.calls.slice(CONFIG.OUT_AND_BACK_DESTINATIONS);
  assert.equal(passTwo.length, CONFIG.REFINE_TOP_N);
  for (const call of passTwo) {
    const [[lon0, lat0], [lon1, lat1]] = call.coordinates;
    const d = haversineM(lat0, lon0, lat1, lon1);
    const expected = CONFIG.OUT_AND_BACK_FACTOR * 8000;
    assert.ok(Math.abs(d - expected) / expected < 0.02, 'length unchanged, terrain changed');
  }
});

// --- shared rate limiting --------------------------------------------------
/* A new client is made for each search. The per minute limit is a sliding
 * window on the service's side, so the throttle has to span them: when it lived
 * on the client, two searches in a row could put more than the limit into one
 * window, and the refusal that follows is indistinguishable from being offline. */
function clockedClient(clock, sleeps, budget = 100) {
  return new OrsClient({
    apiKey: 'test-key',
    budget,
    now: () => clock.t,
    sleepImpl: async (ms) => { sleeps.push(ms); clock.t += ms; },
    fetchImpl: async () => ({
      status: 200, headers: { get: () => null }, json: async () => fakeRoute(5000, 300),
    }),
  });
}

test('the minimum gap between requests is kept across separate clients', async () => {
  resetRateLimit();
  const clock = { t: 1_000_000 };
  const sleeps = [];

  const first = clockedClient(clock, sleeps);
  await first.directions([[-1.5, 53.37]], { length: 1000 });
  await first.directions([[-1.5, 53.37]], { length: 1001 });

  // A second search builds a brand new client, as the app does.
  const second = clockedClient(clock, sleeps);
  await second.directions([[-1.5, 53.37]], { length: 2000 });

  assert.equal(recentRequestCount(), 3, 'the window counts requests from both clients');
  assert.equal(sleeps.length, 2, 'the new client still waited its turn');
  sleeps.forEach((ms) => assert.ok(ms >= 1, `waited ${ms}ms`));
});

test('no sixty second window ever holds more requests than the limit allows', async () => {
  resetRateLimit();
  const clock = { t: 5_000_000 };
  const sleeps = [];
  const sent = [];
  const client = new OrsClient({
    apiKey: 'test-key',
    budget: 500,
    now: () => clock.t,
    sleepImpl: async (ms) => { sleeps.push(ms); clock.t += ms; },
    fetchImpl: async () => {
      sent.push(clock.t);
      return { status: 200, headers: { get: () => null }, json: async () => fakeRoute(5000, 300) };
    },
  });

  const limit = CONFIG.ORS_RATE_LIMIT_PER_MINUTE;
  // Three searches back to back, which is what breached the limit before.
  for (let i = 0; i < limit * 2; i += 1) {
    await client.directions([[-1.5, 53.37]], { length: 3000 + i });
  }

  // Slide a real sixty second window over every request that was sent.
  let worst = 0;
  sent.forEach((from) => {
    const inWindow = sent.filter((t) => t >= from && t < from + 60000).length;
    worst = Math.max(worst, inWindow);
  });
  assert.ok(worst <= limit,
    `a sixty second window held ${worst} requests, and the limit is ${limit}`);
  assert.equal(sent.length, limit * 2, 'every request was still sent, just spaced out');
});

test('the first request of a session is not made to wait', async () => {
  resetRateLimit();
  const clock = { t: 9_000_000 };
  const sleeps = [];
  await clockedClient(clock, sleeps).directions([[-1.5, 53.37]], { length: 4242 });
  assert.equal(sleeps.length, 0);
});
