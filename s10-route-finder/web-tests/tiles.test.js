/* Tests for the free elevation tiles. The fixture below is real data: seven
 * pixels read out of the actual Sheffield tile (zoom 12, 2030/1327), with the
 * heights they decode to. That pins the decoding against the service rather
 * than against my idea of it, without the tests needing a network.
 * Run with: node --test web-tests/*.test.js */
import test from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../web/config.js';
import {
  TILE_SIZE, TerrainStore, TerrainTiles, decodeTerrarium, haversineM, latToTileY,
  lonToTileX, sampleTile, tilePixelMetres, tileUrl, tileXToLon, tileYToLat, tilesCovering,
} from '../web/routefinder.js';

const REAL = {
  z: 12, x: 2030, y: 1327,
  samples: [
    { px: 0, py: 0, rgb: [129, 32, 87], metres: 288.3398 },
    { px: 64, py: 64, rgb: [129, 21, 166], metres: 277.6484 },
    { px: 128, py: 128, rgb: [128, 227, 157], metres: 227.6133 },
    { px: 200, py: 50, rgb: [128, 158, 176], metres: 158.6875 },
    { px: 255, py: 255, rgb: [128, 167, 8], metres: 167.0312 },
    { px: 10, py: 240, rgb: [129, 121, 9], metres: 377.0352 },
    { px: 180, py: 200, rgb: [128, 179, 238], metres: 179.9297 },
  ],
};

// --- decoding --------------------------------------------------------------
test('real tile bytes decode to the heights the service means', () => {
  REAL.samples.forEach(({ rgb, metres }) => {
    const got = decodeTerrarium(rgb[0], rgb[1], rgb[2]);
    assert.ok(Math.abs(got - metres) < 0.001, `${rgb} gave ${got}, expected ${metres}`);
  });
});

test('the Sheffield tile decodes to Sheffield-shaped ground', () => {
  const heights = REAL.samples.map((s) => s.metres);
  assert.ok(Math.min(...heights) > 100, 'nothing below the valley floor');
  assert.ok(Math.max(...heights) < 600, 'nothing above the moors');
});

test('water decodes below zero, because the dataset carries sea floor as well', () => {
  // 128,0,0 is the zero point of the encoding.
  assert.equal(decodeTerrarium(128, 0, 0), 0);
  assert.ok(decodeTerrarium(127, 200, 0) < 0);
});

// --- tile maths ------------------------------------------------------------
test('a position maps into the tile that really covers it', () => {
  const x = Math.floor(lonToTileX(-1.5040, REAL.z));
  const y = Math.floor(latToTileY(53.3736, REAL.z));
  assert.equal(x, REAL.x, 'the tile the fixture was taken from');
  assert.equal(y, REAL.y);
});

test('tile corners round trip back to the same place', () => {
  [[53.3736, -1.5040], [0, 0], [-33.9249, 18.4241], [58.6373, -3.0689]].forEach(([lat, lon]) => {
    const z = 12;
    const back = {
      lat: tileYToLat(latToTileY(lat, z), z),
      lon: tileXToLon(lonToTileX(lon, z), z),
    };
    assert.ok(Math.abs(back.lat - lat) < 1e-9, `lat drifted at ${lat}`);
    assert.ok(Math.abs(back.lon - lon) < 1e-9, `lon drifted at ${lon}`);
  });
});

test('pixel size shrinks towards the poles, as the projection requires', () => {
  const equator = tilePixelMetres(0, 12);
  const sheffield = tilePixelMetres(53.37, 12);
  const scotland = tilePixelMetres(58.64, 12);
  assert.ok(equator > sheffield && sheffield > scotland);
  assert.ok(Math.abs(sheffield - 22.8) < 0.5, `Sheffield pixel was ${sheffield.toFixed(1)} m`);
});

test('the url template is filled in', () => {
  assert.equal(
    tileUrl('https://example/{z}/{x}/{y}.png', 12, 2030, 1327),
    'https://example/12/2030/1327.png',
  );
  assert.ok(CONFIG.TERRAIN_TILE_URL.includes('{z}'));
});

// --- which tiles ------------------------------------------------------------
test('the tiles covering a circle actually cover it', () => {
  const lat = 53.3736; const lon = -1.5040; const radius = 3000; const z = 12;
  const tiles = tilesCovering(lat, lon, radius, z);
  assert.ok(tiles.length >= 1);
  // Every point on the compass at that radius must fall inside one of them.
  for (let bearing = 0; bearing < 360; bearing += 15) {
    const r = (bearing * Math.PI) / 180;
    const pLat = lat + (radius * Math.cos(r)) / 111320;
    const pLon = lon + (radius * Math.sin(r)) / (111320 * Math.cos((lat * Math.PI) / 180));
    const tx = Math.floor(lonToTileX(pLon, z));
    const ty = Math.floor(latToTileY(pLat, z));
    assert.ok(tiles.some((t) => t.x === tx && t.y === ty),
      `bearing ${bearing} landed in tile ${tx}/${ty}, which was not fetched`);
  }
});

test('tiles come back nearest first, so a truncated list keeps the closest ground', () => {
  const tiles = tilesCovering(53.3736, -1.5040, 9000, 12);
  const centre = { x: lonToTileX(-1.5040, 12), y: latToTileY(53.3736, 12) };
  const distances = tiles.map((t) => Math.hypot(t.x + 0.5 - centre.x, t.y + 0.5 - centre.y));
  for (let i = 1; i < distances.length; i += 1) {
    assert.ok(distances[i] >= distances[i - 1] - 1e-9, 'not sorted by distance');
  }
});

test('a tiny radius still asks for the one tile it is in', () => {
  const tiles = tilesCovering(53.3736, -1.5040, 50, 12);
  assert.equal(tiles.length, 1);
  assert.equal(tiles[0].x, REAL.x);
});

// --- reading a tile ---------------------------------------------------------
/* A synthetic tile whose height rises with the pixel row, so positions and
 * values can both be checked. */
function fakePixels(channels = 4, fn = (px, py) => 100 + py) {
  const data = new Uint8ClampedArray(TILE_SIZE * TILE_SIZE * channels);
  for (let py = 0; py < TILE_SIZE; py += 1) {
    for (let px = 0; px < TILE_SIZE; px += 1) {
      const v = fn(px, py) + 32768;
      const i = (py * TILE_SIZE + px) * channels;
      data[i] = Math.floor(v / 256);
      data[i + 1] = Math.floor(v) % 256;
      data[i + 2] = Math.round((v - Math.floor(v)) * 256);
      if (channels === 4) data[i + 3] = 255;
    }
  }
  return { data, width: TILE_SIZE, height: TILE_SIZE };
}

test('a tile is read at a spacing, not pixel by pixel', () => {
  const tile = { x: REAL.x, y: REAL.y, z: REAL.z };
  // Pixels are about 22.8 m here, so a 50 m spacing wants every other one.
  assert.equal(sampleTile(tile, fakePixels(), 50).length, (TILE_SIZE / 2) ** 2);
  // And the spacing the app actually uses is coarser again, because the store
  // shares a browser's storage with the saved routes.
  const used = sampleTile(tile, fakePixels(), CONFIG.TERRAIN_TILE_SAMPLE_M).length;
  assert.ok(used < (TILE_SIZE / 2) ** 2 / 3, `read ${used} points at the spacing in use`);
  assert.ok(used > 1000, 'but still enough to describe the ground');
});

test('read points land inside the tile they came from', () => {
  const tile = { x: REAL.x, y: REAL.y, z: REAL.z };
  const north = tileYToLat(tile.y, tile.z);
  const south = tileYToLat(tile.y + 1, tile.z);
  const west = tileXToLon(tile.x, tile.z);
  const east = tileXToLon(tile.x + 1, tile.z);
  sampleTile(tile, fakePixels(), 50).forEach(([lon, lat]) => {
    assert.ok(lat <= north && lat >= south, `lat ${lat} outside ${south}..${north}`);
    assert.ok(lon >= west && lon <= east, `lon ${lon} outside ${west}..${east}`);
  });
});

test('heights are read the right way up', () => {
  const tile = { x: REAL.x, y: REAL.y, z: REAL.z };
  const points = sampleTile(tile, fakePixels(4, (px, py) => 100 + py), 50);
  const north = points.reduce((a, b) => (a[1] > b[1] ? a : b));
  const south = points.reduce((a, b) => (a[1] < b[1] ? a : b));
  assert.ok(south[2] > north[2], 'row zero is the north edge and was the lowest here');
});

test('three channel data is read as well as four', () => {
  const tile = { x: REAL.x, y: REAL.y, z: REAL.z };
  const rgba = sampleTile(tile, fakePixels(4), 50);
  const rgb = sampleTile(tile, fakePixels(3), 50);
  assert.equal(rgb.length, rgba.length);
  assert.ok(Math.abs(rgb[100][2] - rgba[100][2]) < 0.01);
});

test('impossible heights are dropped rather than stored', () => {
  const tile = { x: REAL.x, y: REAL.y, z: REAL.z };
  const points = sampleTile(tile, fakePixels(4, () => 40000), 50);
  assert.equal(points.length, 0, 'nothing on earth is 40 km up');
});

// --- harvesting -------------------------------------------------------------
function tileLoader({ fail = false, fn } = {}) {
  const asked = [];
  return {
    asked,
    load: async (url, tile) => {
      asked.push(url);
      if (fail) throw new TypeError('Load failed');
      return fakePixels(4, fn);
    },
  };
}

test('harvesting fills the store with ground it has never seen', async () => {
  const store = new TerrainStore({ storage: null });
  const loader = tileLoader();
  const tiles = new TerrainTiles({ loadTile: loader.load, maxTiles: 4 });
  assert.equal(store.size, 0);

  const result = await tiles.harvest(store, 53.3736, -1.5040, 3000);
  assert.ok(result.fetched > 0, 'fetched nothing');
  assert.ok(result.added > 1000, `only added ${result.added} cells`);
  assert.equal(result.failed, 0);
  assert.ok(store.size > 1000);
  assert.ok(store.elevationAt(53.3736, -1.5040) !== null, 'the middle has a height now');
});

test('the same tile is not fetched twice', async () => {
  const store = new TerrainStore({ storage: null });
  const loader = tileLoader();
  const tiles = new TerrainTiles({ loadTile: loader.load, maxTiles: 4 });
  await tiles.harvest(store, 53.3736, -1.5040, 500);
  const first = loader.asked.length;
  const again = await tiles.harvest(store, 53.3736, -1.5040, 500);
  assert.equal(loader.asked.length, first, 'asked for a tile it already had');
  assert.ok(again.skipped > 0);
});

test('a tile that will not load does not stop the rest', async () => {
  const store = new TerrainStore({ storage: null });
  const tiles = new TerrainTiles({ loadTile: tileLoader({ fail: true }).load, maxTiles: 3 });
  const result = await tiles.harvest(store, 53.3736, -1.5040, 3000);
  assert.ok(result.failed > 0);
  assert.equal(result.added, 0);
  assert.equal(store.size, 0, 'and the store is simply no better off than before');
});

test('harvesting is capped, and says when it held back', async () => {
  const store = new TerrainStore({ storage: null });
  const loader = tileLoader();
  const tiles = new TerrainTiles({ loadTile: loader.load, maxTiles: 2 });
  const result = await tiles.harvest(store, 53.3736, -1.5040, 20000);
  assert.equal(result.fetched, 2, 'took more tiles than it was allowed');
  assert.equal(result.truncated, true);
});

test('with no way to load tiles, harvesting is a no-op rather than an error', async () => {
  const store = new TerrainStore({ storage: null });
  const tiles = new TerrainTiles({ loadTile: null });
  const result = await tiles.harvest(store, 53.3736, -1.5040, 3000);
  assert.equal(result.fetched, 0);
  assert.equal(store.size, 0);
});

test('harvested ground is dense enough to aim a waypoint with', async () => {
  const store = new TerrainStore({ storage: null });
  const tiles = new TerrainTiles({ loadTile: tileLoader().load, maxTiles: 4 });
  await tiles.harvest(store, 53.3736, -1.5040, 2500);
  // A waypoint 2 km out looks within a few hundred metres of its ideal point.
  const near = store.within(53.3900, -1.5040, 400);
  assert.ok(near.length > 20, `only ${near.length} samples near a candidate waypoint`);
  near.forEach((p) => {
    assert.ok(haversineM(53.3900, -1.5040, p[0], p[1]) <= 400);
  });
});
