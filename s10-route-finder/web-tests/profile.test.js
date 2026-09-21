/* Tests for the elevation profile, climb statistics, pace and place search.
 * Run with: node --test web-tests/*.test.js — no dependencies, no network. */
import test from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../web/config.js';
import {
  estimateSeconds, formatDuration, geocode, gradientAt, gradientBand,
  longestClimb, parsePace, profile, reverseProfile, steepestWindow,
} from '../web/routefinder.js';

const START = { lat: 53.3736, lon: -1.5040 };

/* ORS-shaped [lon, lat, elevation] coordinates running due east. */
function coordsEast(points, elevationAt) {
  return Array.from({ length: points }, (_, i) => {
    const frac = i / (points - 1);
    return [START.lon + 0.030 * frac, START.lat, elevationAt(frac, i)];
  });
}

// --- profile ---------------------------------------------------------------
test('profile returns cumulative distance, elevation and position', () => {
  const points = profile(coordsEast(50, (f) => 100 + 50 * f), 2000);
  assert.equal(points.length, 50);
  assert.equal(points[0].km, 0);
  assert.ok(Math.abs(points[points.length - 1].km - 2) < 1e-6, 'ends at the summary distance');
  assert.ok(points[10].lat === START.lat && points[10].lon > START.lon);
});

test('profile scales its distances to the distance ORS reported', () => {
  // Summing great-circle hops gives a slightly different total from the routing
  // engine's own figure; the chart axis has to agree with the number shown.
  const coords = coordsEast(40, () => 150);
  const unscaled = profile(coords, null);
  const scaled = profile(coords, 5000);
  assert.ok(unscaled[unscaled.length - 1].km > 0);
  assert.equal(scaled[scaled.length - 1].km, 5);
});

test('profile smooths elevation, so the chart agrees with the climb figure', () => {
  const noisy = coordsEast(200, (f, i) => 100 + 50 * f + (i % 2 ? 4 : -4));
  const points = profile(noisy, 3000);
  const raw = noisy.map((c) => c[2]);
  const spread = (values) => {
    let worst = 0;
    for (let i = 1; i < values.length; i += 1) worst = Math.max(worst, Math.abs(values[i] - values[i - 1]));
    return worst;
  };
  assert.ok(spread(points.map((p) => p.ele)) < spread(raw) / 2, 'sample-to-sample jitter is reduced');
});

test('profile copes with missing elevation and short input', () => {
  assert.deepEqual(profile([], 100), []);
  assert.deepEqual(profile([[-1.5, 53.3, 100]], 100), []);
  const mixed = [[-1.5, 53.3, 100], [-1.49, 53.3, null], [-1.48, 53.3, 120]];
  assert.equal(profile(mixed, 500).length, 2);
});

// --- gradient --------------------------------------------------------------
test('gradient is averaged over a window rather than taken per sample', () => {
  // Sawtooth noise on a flat trend: per-sample gradient would swing wildly,
  // the windowed one should stay near zero.
  const points = profile(coordsEast(400, (f, i) => 200 + (i % 2 ? 3 : -3)), 4000);
  let worst = 0;
  for (let i = 0; i < points.length; i += 1) worst = Math.max(worst, Math.abs(gradientAt(points, i)));
  assert.ok(worst < 4, `windowed gradient stayed at ${worst.toFixed(1)}% on flat ground`);
});

test('gradient reports a real slope with the right sign', () => {
  const up = profile(coordsEast(200, (f) => 100 + 100 * f), 2000);   // 100 m over 2 km = 5%
  const mid = gradientAt(up, 100);
  assert.ok(mid > 4 && mid < 6, `expected about 5%, got ${mid.toFixed(2)}`);

  const down = profile(coordsEast(200, (f) => 200 - 100 * f), 2000);
  assert.ok(gradientAt(down, 100) < -4, 'descending gradient is negative');
});

test('bands tell climbing and descending apart', () => {
  // The regression that matters: a descent must never be banded as a climb.
  assert.equal(gradientBand(-12), 0);
  assert.equal(gradientBand(-4), 1);
  assert.equal(gradientBand(0), 2);
  assert.equal(gradientBand(4), 3);
  assert.equal(gradientBand(8), 4);
  assert.equal(gradientBand(12), 5);
  assert.notEqual(gradientBand(-12), gradientBand(12));
  assert.notEqual(gradientBand(-4), gradientBand(4));
});

test('band boundaries follow config rather than being hardcoded', () => {
  const [d2, d1, u1, u2, u3] = CONFIG.GRADIENT_BANDS;
  assert.equal(gradientBand(d2 - 0.1), 0);
  assert.equal(gradientBand(d1 + 0.1), 2);
  assert.equal(gradientBand(u1 + 0.1), 3);
  assert.equal(gradientBand(u2 + 0.1), 4);
  assert.equal(gradientBand(u3 + 0.1), 5);
});

// --- climb statistics ------------------------------------------------------
test('longest climb measures to the peak, not to wherever it flattened out', () => {
  // 1 km of climbing, then 3 km of flat. The climb is 1 km long, not 4.
  const points = profile(coordsEast(400, (f) => (f < 0.25 ? 100 + 200 * (f / 0.25) : 300)), 4000);
  const climb = longestClimb(points);
  assert.ok(Math.abs(climb.gain - 200) < 6, `gain was ${climb.gain.toFixed(1)}`);
  assert.ok(climb.km < 1.3, `length was ${climb.km.toFixed(2)} km, should be about 1`);
  const gradient = (climb.gain / (climb.km * 1000)) * 100;
  assert.ok(gradient > 14, `gradient came out at ${gradient.toFixed(1)}%, should be about 20%`);
});

test('longest climb ignores dips smaller than the threshold', () => {
  const points = profile(coordsEast(400, (f, i) => 100 + 200 * f + (i % 20 === 0 ? -2 : 0)), 4000);
  assert.ok(longestClimb(points).gain > 180, 'a 2 m wobble should not break the climb in two');
});

test('longest climb returns nothing on flat ground', () => {
  const points = profile(coordsEast(100, () => 150), 2000);
  assert.equal(longestClimb(points).gain, 0);
});

test('steepest window finds the hardest stretch and where it starts', () => {
  // Flat, then a sharp 40 m ramp over 200 m at the 2 km mark, then flat.
  const points = profile(coordsEast(400, (f) => {
    if (f < 0.5) return 100;
    if (f < 0.55) return 100 + 40 * ((f - 0.5) / 0.05);
    return 140;
  }), 4000);
  const steep = steepestWindow(points, 200);
  assert.ok(steep.gain > 30, `gain was ${steep.gain.toFixed(1)} m`);
  assert.ok(steep.atKm > 1.7 && steep.atKm < 2.3, `found at ${steep.atKm.toFixed(2)} km`);
});

// --- direction -------------------------------------------------------------
test('reversing keeps the distance and flips where the climbs fall', () => {
  const points = profile(coordsEast(200, (f) => 100 + 150 * f), 3000);
  const back = reverseProfile(points);
  assert.equal(back.length, points.length);
  assert.ok(Math.abs(back[back.length - 1].km - 3) < 1e-6, 'same total distance');
  assert.ok(back[0].ele > back[back.length - 1].ele, 'now starts high and ends low');
  assert.equal(back[0].lat, points[points.length - 1].lat);
});

test('reversing an empty profile is empty', () => {
  assert.deepEqual(reverseProfile([]), []);
});

// --- pace and time ---------------------------------------------------------
test('pace parses the ways a runner would type it', () => {
  assert.equal(parsePace('5:40'), 340);
  assert.equal(parsePace('5.40'), 340);
  assert.equal(parsePace(' 6:05 '), 365);
  assert.equal(parsePace('6'), 360);
  assert.equal(parsePace('5:3'), 330, 'a single digit after the colon means tens of seconds');
});

test('pace refuses what it cannot read', () => {
  assert.equal(parsePace(''), null);
  assert.equal(parsePace(null), null);
  assert.equal(parsePace('quickly'), null);
  assert.equal(parsePace('5:99'), null);
  assert.equal(parsePace('-4'), null);
});

test('no pace means no time, rather than a time built on a guess', () => {
  assert.equal(estimateSeconds(10000, 200, null), null);
  assert.equal(estimateSeconds(10000, 200, 0), null);
});

test('time is flat pace plus the climb penalty', () => {
  // 10 km at 6:00/km is 3600 s, plus 200 m of climb at the configured rate.
  const expected = 3600 + 200 * CONFIG.CLIMB_SECONDS_PER_METRE;
  assert.equal(estimateSeconds(10000, 200, 360), expected);
  assert.ok(estimateSeconds(10000, 400, 360) > estimateSeconds(10000, 200, 360),
    'a hillier route of the same length takes longer');
});

test('durations read the way a person would say them', () => {
  assert.equal(formatDuration(1800), '30 min');
  assert.equal(formatDuration(3600), '1h 00m');
  assert.equal(formatDuration(4380), '1h 13m');
});

// --- geocoding -------------------------------------------------------------
function geocodeStub(features, status = 200) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return { status, json: async () => ({ features }) };
  };
  return { calls, fetchImpl };
}

test('place search is constrained to the Sheffield bounding box', async () => {
  const { calls, fetchImpl } = geocodeStub([]);
  await geocode('crookes', 'test-key', fetchImpl);
  const url = calls[0];
  assert.ok(url.includes(`boundary.rect.min_lat=${CONFIG.BBOX.minLat}`));
  assert.ok(url.includes(`boundary.rect.max_lon=${CONFIG.BBOX.maxLon}`));
  assert.ok(url.includes('focus.point.lat='), 'results are biased towards the default start');
  assert.ok(url.includes('api_key=test-key'));
});

test('place search returns label and position', async () => {
  const { fetchImpl } = geocodeStub([
    { properties: { label: 'Crookes, Sheffield', locality: 'Sheffield' }, geometry: { coordinates: [-1.51, 53.38] } },
  ]);
  const hits = await geocode('crookes', 'k', fetchImpl);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].label, 'Crookes, Sheffield');
  assert.equal(hits[0].lat, 53.38);
  assert.equal(hits[0].lon, -1.51);
});

test('place search does not fire on a one-character query', async () => {
  const { calls, fetchImpl } = geocodeStub([]);
  assert.deepEqual(await geocode('c', 'k', fetchImpl), []);
  assert.equal(calls.length, 0, 'no request is spent on a single letter');
});

test('place search explains a quota refusal in plain English', async () => {
  const { fetchImpl } = geocodeStub([], 403);
  await assert.rejects(() => geocode('crookes', 'k', fetchImpl), /quota/i);
});

test('place search needs a key before it calls anything', async () => {
  const { calls, fetchImpl } = geocodeStub([]);
  await assert.rejects(() => geocode('crookes', '', fetchImpl), /API key/);
  assert.equal(calls.length, 0);
});
