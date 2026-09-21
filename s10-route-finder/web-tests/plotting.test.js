/* Tests for hand plotted routes and the saved route library.
 * Run with: node --test web-tests/*.test.js — no dependencies, no network. */
import test from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../web/config.js';
import {
  MIN_PLOTTED_POINTS, OrsClient, RouteLibrary, distanceToSegmentM, haversineM,
  insertWaypoint, insertionIndex, moveWaypoint, nearestCoordIndex, packRoute,
  removeWaypoint, resetRateLimit, routeThrough, unpackRoute,
} from '../web/routefinder.js';

const A = { lat: 53.3736, lon: -1.5040 };

/* A routing stub that answers with a straight line through whatever was asked
 * for, and reports where each requested point landed in the geometry. */
function orsStub({ ascentPerPoint = 0, perLeg = 20 } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    const asked = body.coordinates;
    calls.push(asked);
    const coords = [];
    const wayPoints = [];
    for (let leg = 0; leg < asked.length - 1; leg += 1) {
      wayPoints.push(coords.length);
      for (let i = 0; i < perLeg; i += 1) {
        const f = i / perLeg;
        coords.push([
          asked[leg][0] + (asked[leg + 1][0] - asked[leg][0]) * f,
          asked[leg][1] + (asked[leg + 1][1] - asked[leg][1]) * f,
          100 + ascentPerPoint * (leg * perLeg + i),
        ]);
      }
    }
    coords.push([...asked[asked.length - 1], 100]);
    wayPoints.push(coords.length - 1);
    let distance = 0;
    for (let i = 1; i < coords.length; i += 1) {
      distance += haversineM(coords[i - 1][1], coords[i - 1][0], coords[i][1], coords[i][0]);
    }
    return {
      status: 200,
      headers: { get: () => null },
      json: async () => ({
        features: [{
          geometry: { coordinates: coords },
          properties: { summary: { distance }, way_points: wayPoints },
        }],
      }),
    };
  };
  return { calls, fetchImpl };
}

function client(fetchImpl) {
  resetRateLimit();
  return new OrsClient({
    apiKey: 'k', budget: 50, fetchImpl, sleep: async () => {}, now: () => Date.now(),
  });
}

// --- routing through your own points ---------------------------------------
test('a plotted route goes through the points in the order they were placed', async () => {
  const { calls, fetchImpl } = orsStub();
  const points = [A, { lat: 53.3760, lon: -1.4990 }, { lat: 53.3790, lon: -1.4950 }];
  const route = await routeThrough(client(fetchImpl), points);
  assert.deepEqual(calls[0], points.map((p) => [p.lon, p.lat]));
  assert.equal(route.waypoints.length, 3);
  assert.ok(route.distanceM > 0);
  assert.equal(route.closeLoop, false);
});

test('closing the loop returns to the first point', async () => {
  const { calls, fetchImpl } = orsStub();
  const points = [A, { lat: 53.3760, lon: -1.4990 }, { lat: 53.3790, lon: -1.4950 }];
  const route = await routeThrough(client(fetchImpl), points, { closeLoop: true });
  assert.equal(calls[0].length, 4, 'the start is asked for again at the end');
  assert.deepEqual(calls[0][3], [A.lon, A.lat]);
  assert.equal(route.waypoints.length, 3, 'but it is still three points you placed');
  assert.equal(route.closeLoop, true);
});

test('a plotted route measures its own climb from the elevation that comes back', async () => {
  const { fetchImpl } = orsStub({ ascentPerPoint: 2 });
  const route = await routeThrough(client(fetchImpl), [A, { lat: 53.3800, lon: -1.4900 }]);
  assert.ok(route.ascentM > 0, `ascent was ${route.ascentM}`);
  assert.equal(typeof route.descentM, 'number');
});

test('fewer than two points is refused before a request is spent', async () => {
  const { calls, fetchImpl } = orsStub();
  const c = client(fetchImpl);
  await assert.rejects(() => routeThrough(c, [A]), /at least two points/);
  assert.equal(calls.length, 0);
  assert.equal(c.requestsUsed, 0);
  assert.equal(MIN_PLOTTED_POINTS, 2);
});

test('points that are not real positions are dropped, not sent', async () => {
  const { calls, fetchImpl } = orsStub();
  const messy = [A, { lat: NaN, lon: -1.5 }, null, { lat: 53.38, lon: -1.49 }];
  await routeThrough(client(fetchImpl), messy);
  assert.equal(calls[0].length, 2);
});

// --- where a tap on the line belongs ---------------------------------------
test('a tap inserts between the two points whose leg it falls on', async () => {
  const { fetchImpl } = orsStub();
  const points = [
    { lat: 53.3700, lon: -1.5000 },
    { lat: 53.3700, lon: -1.4900 },
    { lat: 53.3700, lon: -1.4800 },
  ];
  const route = await routeThrough(client(fetchImpl), points);
  // Between the second and third points.
  assert.equal(insertionIndex(route, 53.3700, -1.4850), 2);
  // Between the first and second.
  assert.equal(insertionIndex(route, 53.3700, -1.4950), 1);
});

test('a route that doubles back still picks the leg the tap is actually on', async () => {
  // Out east then back along nearly the same line. Straight line geometry would
  // be ambiguous here because both legs pass within metres of the tap; the
  // geometry indices are what settle it.
  const { fetchImpl } = orsStub();
  const points = [
    { lat: 53.3700, lon: -1.5000 },
    { lat: 53.3700, lon: -1.4800 },
    { lat: 53.3701, lon: -1.5000 },
  ];
  const route = await routeThrough(client(fetchImpl), points);
  const outward = route.wayPoints[0] + 5;
  const back = route.wayPoints[1] + 5;
  const onOutward = route.coords[outward];
  const onBack = route.coords[back];
  assert.equal(insertionIndex(route, onOutward[1], onOutward[0]), 1);
  assert.equal(insertionIndex(route, onBack[1], onBack[0]), 2);
});

test('insertion falls back to straight legs when no geometry indices came back', () => {
  const route = {
    waypoints: [
      { lat: 53.3700, lon: -1.5000 },
      { lat: 53.3700, lon: -1.4900 },
      { lat: 53.3700, lon: -1.4800 },
    ],
    wayPoints: [],
    coords: [],
  };
  assert.equal(insertionIndex(route, 53.3700, -1.4850), 2);
});

test('a tap on a route with one point goes on the end', () => {
  assert.equal(insertionIndex({ waypoints: [A], wayPoints: [], coords: [] }, 53.4, -1.5), 1);
  assert.equal(insertionIndex({ waypoints: [], wayPoints: [], coords: [] }, 53.4, -1.5), 0);
});

test('distance to a segment is zero on it and correct beside it', () => {
  const a = { lat: 53.3700, lon: -1.5000 };
  const b = { lat: 53.3700, lon: -1.4900 };
  assert.ok(distanceToSegmentM({ lat: 53.3700, lon: -1.4950 }, a, b) < 1);
  const beside = distanceToSegmentM({ lat: 53.3709, lon: -1.4950 }, a, b);
  assert.ok(Math.abs(beside - 100) < 12, `expected about 100 m, got ${beside.toFixed(1)}`);
  // Past the end, the nearest point is the endpoint itself.
  const past = distanceToSegmentM({ lat: 53.3700, lon: -1.4800 }, a, b);
  assert.ok(Math.abs(past - haversineM(53.37, -1.48, b.lat, b.lon)) < 1);
});

test('nearest point on the line is found', () => {
  const coords = [[-1.50, 53.37, 100], [-1.49, 53.37, 110], [-1.48, 53.37, 120]];
  assert.equal(nearestCoordIndex(coords, 53.37, -1.4899).index, 1);
});

// --- editing the list ------------------------------------------------------
test('insert, move and remove leave the original alone', () => {
  const points = [A, { lat: 53.38, lon: -1.49 }];
  const inserted = insertWaypoint(points, 1, { lat: 53.375, lon: -1.495 });
  assert.equal(points.length, 2, 'the input was not modified');
  assert.equal(inserted.length, 3);
  assert.equal(inserted[1].lat, 53.375);

  const moved = moveWaypoint(inserted, 0, { lat: 53.30, lon: -1.60 });
  assert.equal(inserted[0].lat, A.lat);
  assert.equal(moved[0].lat, 53.30);

  const removed = removeWaypoint(moved, 1);
  assert.equal(removed.length, 2);
});

test('editing an index that does not exist changes nothing', () => {
  const points = [A];
  assert.deepEqual(moveWaypoint(points, 9, { lat: 1, lon: 1 }), points);
  assert.deepEqual(removeWaypoint(points, -1), points);
  assert.equal(insertWaypoint(points, 99, { lat: 1, lon: 1 }).length, 2);
});

// --- saving ----------------------------------------------------------------
function memoryStorage(failWrites = false) {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => {
      if (failWrites) throw new Error('QuotaExceededError');
      map.set(k, String(v));
    },
    removeItem: (k) => map.delete(k),
    bytes: () => [...map.values()].reduce((n, v) => n + v.length, 0),
  };
}

function fakeRoute(points = 600) {
  const coords = [];
  for (let i = 0; i < points; i += 1) {
    coords.push([-1.5040 + i * 0.00002, 53.3736 + i * 0.00001, 100 + (i % 50)]);
  }
  return {
    coords, distanceM: 10123.4, ascentM: 204.6, descentM: 199.2, closeLoop: true,
    waypoints: [{ lat: 53.3736, lon: -1.5040 }, { lat: 53.3800, lon: -1.4900 }],
  };
}

test('a saved route comes back with its shape and figures intact', () => {
  const lib = new RouteLibrary({ storage: memoryStorage() });
  const result = lib.save(fakeRoute(), 'Rivelin loop');
  assert.equal(result.ok, true);

  const back = lib.get(result.id);
  assert.equal(back.name, 'Rivelin loop');
  assert.equal(back.coords.length, 600);
  assert.equal(back.distanceM, 10123);
  assert.equal(back.ascentM, 205);
  assert.equal(back.closeLoop, true);
  assert.equal(back.waypoints.length, 2);
  assert.ok(Math.abs(back.coords[0][1] - 53.3736) < 1e-4, 'position survived rounding');
});

test('a saved route survives a reload', () => {
  const storage = memoryStorage();
  const a = new RouteLibrary({ storage });
  a.save(fakeRoute(), 'Porter valley');
  const b = new RouteLibrary({ storage });
  assert.equal(b.size, 1);
  assert.equal(b.list()[0].name, 'Porter valley');
});

test('rounding keeps a route small enough to be worth saving', () => {
  const storage = memoryStorage();
  const lib = new RouteLibrary({ storage });
  lib.save(fakeRoute(1000), 'Long one');
  const perRoute = storage.bytes();
  // Full precision would be roughly double. The point is that a browser's few
  // megabytes hold a useful number of these alongside the terrain store.
  assert.ok(perRoute < 40000, `a 1000 point route took ${perRoute} bytes`);
});

test('saving under a name that exists replaces it rather than duplicating', () => {
  const lib = new RouteLibrary({ storage: memoryStorage() });
  lib.save(fakeRoute(), 'Tuesday');
  const second = lib.save({ ...fakeRoute(200), distanceM: 5000 }, 'Tuesday');
  assert.equal(second.ok, true);
  assert.equal(second.replaced, true);
  assert.equal(lib.size, 1);
  assert.equal(lib.list()[0].distanceM, 5000);
});

test('a storage that refuses the write says so, and nothing is half saved', () => {
  const lib = new RouteLibrary({ storage: memoryStorage(true) });
  const result = lib.save(fakeRoute(), 'Will not fit');
  assert.equal(result.ok, false);
  assert.match(result.reason, /storage is full/i);
  assert.match(result.reason, /terrain store/i, 'and says what to clear');
  assert.equal(lib.size, 0, 'the list was rolled back, so it matches what is stored');
});

test('saving nothing is refused with a reason', () => {
  const lib = new RouteLibrary({ storage: memoryStorage() });
  const result = lib.save({ coords: [] }, 'Empty');
  assert.equal(result.ok, false);
  assert.match(result.reason, /no route/i);
});

test('the library stops at its limit rather than growing without end', () => {
  const lib = new RouteLibrary({ storage: memoryStorage(), limit: 3 });
  ['a', 'b', 'c'].forEach((n) => assert.equal(lib.save(fakeRoute(10), n).ok, true));
  const overflow = lib.save(fakeRoute(10), 'd');
  assert.equal(overflow.ok, false);
  assert.match(overflow.reason, /Delete one first/);
  // Replacing an existing one is still allowed at the limit.
  assert.equal(lib.save(fakeRoute(10), 'b').ok, true);
});

test('deleting removes it from storage as well as from the list', () => {
  const storage = memoryStorage();
  const lib = new RouteLibrary({ storage });
  const id = lib.save(fakeRoute(10), 'Gone soon').id;
  assert.equal(lib.remove(id).removed, true);
  assert.equal(new RouteLibrary({ storage }).size, 0);
});

test('a corrupt or foreign store reads as empty rather than throwing', () => {
  const storage = memoryStorage();
  storage.setItem(CONFIG.SAVED_ROUTES_LIMIT ? 's10.savedRoutes' : 'x', '{not json');
  assert.equal(new RouteLibrary({ storage }).size, 0);
  storage.setItem('s10.savedRoutes', JSON.stringify({ routes: [{ v: 99, pts: [] }] }));
  assert.equal(new RouteLibrary({ storage }).size, 0, 'a future version is not guessed at');
});

test('packing and unpacking round trips', () => {
  const route = fakeRoute(50);
  const back = unpackRoute(packRoute(route, { name: 'Round trip' }));
  assert.equal(back.coords.length, 50);
  assert.equal(back.name, 'Round trip');
  assert.equal(back.coords[0].length, 3, 'elevation is kept');
});
