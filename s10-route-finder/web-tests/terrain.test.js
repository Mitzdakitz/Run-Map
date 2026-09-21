/* Tests for the terrain store away from Sheffield. The store was built when the
 * app covered one city, and three of its assumptions only break once routes are
 * plotted elsewhere, which is exactly where field testing will not reach.
 * Run with: node --test web-tests/*.test.js — no dependencies, no network. */
import test from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../web/config.js';
import { TerrainStore, haversineM } from '../web/routefinder.js';

const store = (over = {}) => new TerrainStore({ storage: null, ...over });

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    raw: map,
  };
}

// --- cells stay square wherever you are ------------------------------------
const PLACES = [
  { name: 'Sheffield', lat: 53.3736, lon: -1.5040 },
  { name: 'far north Scotland', lat: 58.6373, lon: -3.0689 },
  { name: 'Cornwall', lat: 50.1000, lon: -5.5000 },
  { name: 'equator', lat: 0.0, lon: 32.5825 },
  { name: 'southern hemisphere', lat: -33.9249, lon: 18.4241 },
];

test('a grid cell is about the configured size at every latitude', () => {
  const s = store();
  PLACES.forEach(({ name, lat, lon }) => {
    const here = s.key(lat, lon);
    const [row, col] = here.split(',').map(Number);
    const a = s.decodeKey(`${row},${col}`);
    const eastNeighbour = s.decodeKey(`${row},${col + 1}`);
    const gap = haversineM(a.lat, a.lon, eastNeighbour.lat, eastNeighbour.lon);
    // Before this was latitude aware, a nominally 50 m cell measured 83.8 m at
    // the equator, 53.8 m in Cornwall and 43.6 m in the far north of Scotland.
    assert.ok(Math.abs(gap - CONFIG.TERRAIN_GRID_M) < CONFIG.TERRAIN_GRID_M * 0.1,
      `${name}: east-west cell size was ${gap.toFixed(1)} m, wanted about ${CONFIG.TERRAIN_GRID_M}`);
  });
});

test('a point always decodes back to within half a cell of itself', () => {
  const s = store();
  PLACES.forEach(({ name, lat, lon }) => {
    const back = s.decodeKey(s.key(lat, lon));
    const drift = haversineM(lat, lon, back.lat, back.lon);
    assert.ok(drift <= CONFIG.TERRAIN_GRID_M,
      `${name}: drifted ${drift.toFixed(1)} m on the round trip`);
  });
});

test('places far apart never share a cell', () => {
  const s = store();
  const keys = PLACES.map((p) => s.key(p.lat, p.lon));
  assert.equal(new Set(keys).size, PLACES.length);
});

// --- lookups find the neighbours, wherever they are ------------------------
test('within finds nearby cells at every latitude, and excludes far ones', () => {
  PLACES.forEach(({ name, lat, lon }) => {
    const s = store();
    s.addCoords([
      [lon, lat, 100],
      [lon + 0.0010, lat, 110],          // roughly 70 m east at UK latitudes
      [lon, lat + 0.0009, 120],          // roughly 100 m north
      [lon + 0.05, lat, 130],            // kilometres away, must not appear
    ]);
    const near = s.within(lat, lon, 300);
    assert.ok(near.length >= 2, `${name}: found ${near.length} cells within 300 m`);
    near.forEach((p) => {
      assert.ok(haversineM(lat, lon, p[0], p[1]) <= 300,
        `${name}: returned a cell ${haversineM(lat, lon, p[0], p[1]).toFixed(0)} m away`);
      assert.notEqual(p[2], 130, `${name}: returned the far cell`);
    });
  });
});

test('within does not slow down as the store fills with distant terrain', () => {
  const s = store();
  const here = { lat: 53.3736, lon: -1.5040 };
  s.addCoords([[here.lon, here.lat, 180], [here.lon + 0.0005, here.lat, 190]]);
  const before = s.within(here.lat, here.lon, 200).length;

  // 40,000 cells in a different part of the country.
  const far = [];
  for (let i = 0; i < 200; i += 1) {
    for (let j = 0; j < 200; j += 1) {
      far.push([-3.0 + j * 0.0008, 57.0 + i * 0.0005, 300]);
    }
  }
  s.addCoords(far);
  assert.ok(s.size > 30000, `store holds ${s.size} cells`);

  const started = Date.now();
  for (let i = 0; i < 200; i += 1) s.within(here.lat, here.lon, 200);
  const elapsed = Date.now() - started;

  assert.equal(s.within(here.lat, here.lon, 200).length, before, 'same answer');
  // A scan of every cell would be 200 x 40,000 comparisons here.
  assert.ok(elapsed < 500, `200 lookups over a ${s.size} cell store took ${elapsed} ms`);
});

// --- a full store keeps learning -------------------------------------------
test('a full store drops its oldest cells rather than refusing new ground', () => {
  const s = store();
  const cap = CONFIG.MAX_TERRAIN_POINTS;
  const first = [];
  for (let i = 0; i < 50; i += 1) first.push([-1.5 + i * 0.001, 53.37, 100 + i]);
  s.addCoords(first);
  const firstKey = s.key(53.37, -1.5);
  assert.ok(s.cells.has(firstKey));

  // Fill it to the cap, then offer ground it has never seen.
  const filler = [];
  for (let i = s.size; i < cap; i += 1) {
    filler.push([-2.0 + (i % 1000) * 0.0008, 54.0 + Math.floor(i / 1000) * 0.0005, 200]);
  }
  s.addCoords(filler);
  assert.equal(s.size, cap, `expected a full store, got ${s.size}`);

  const newGround = [[-4.1426, 50.3755, 40], [-4.1420, 50.3755, 45]];
  const added = s.addCoords(newGround);
  assert.equal(added, 2, 'a full store still took the new cells');
  assert.ok(s.cells.has(s.key(50.3755, -4.1426)), 'the new ground is actually stored');
  assert.ok(s.size <= cap, `store grew past its cap to ${s.size}`);
  assert.ok(!s.cells.has(firstKey), 'the oldest cells were the ones dropped');
});

test('eviction never takes the store above its cap', () => {
  const s = store();
  const cap = CONFIG.MAX_TERRAIN_POINTS;
  const batch = [];
  for (let i = 0; i < cap + 5000; i += 1) {
    batch.push([-1.0 + (i % 1200) * 0.0008, 53.0 + Math.floor(i / 1200) * 0.0005, 150]);
  }
  s.addCoords(batch);
  assert.ok(s.size <= cap, `store holds ${s.size}, cap is ${cap}`);
  assert.ok(s.size > cap * 0.5, `store emptied itself down to ${s.size}`);
});

// --- stored data from the old grid is not read as if it were the new one ---
test('a store written by the old latitude-fixed grid is discarded, not misread', () => {
  const storage = memoryStorage();
  storage.setItem('s10.terrain.v1', JSON.stringify({
    gridM: CONFIG.TERRAIN_GRID_M,
    cells: { '118843,-2534': 180 },          // no version: pre-dates the change
  }));
  const s = new TerrainStore({ storage });
  assert.equal(s.size, 0, 'old keys would decode to the wrong place, so they are dropped');
});

test('a store this version wrote is read back', () => {
  const storage = memoryStorage();
  const a = new TerrainStore({ storage });
  a.addCoords([[-1.5040, 53.3736, 180], [-1.5030, 53.3736, 190]]);
  assert.equal(a.save(), true);

  const b = new TerrainStore({ storage });
  assert.equal(b.size, a.size);
  assert.equal(b.elevationAt(53.3736, -1.5040), 180);
});

test('a storage that refuses to write is reported rather than swallowed', () => {
  const storage = memoryStorage();
  storage.setItem = () => { throw new Error('QuotaExceededError'); };
  const s = new TerrainStore({ storage });
  s.addCoords([[-1.5040, 53.3736, 180]]);
  assert.equal(s.save(), false, 'save reports the failure so a caller can surface it');
});
