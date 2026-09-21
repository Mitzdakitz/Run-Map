/* Tests for the connection diagnosis. The point of this code is to tell apart
 * failures that look identical from inside a browser, so the tests drive every
 * combination of probe outcomes and check the verdict follows.
 * Run with: node --test web-tests/*.test.js — no dependencies, no network. */
import test from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../web/config.js';
import { diagnose, readDiagnosis } from '../web/routefinder.js';

/* A fetch stub that answers by URL shape and by which key was sent. */
function stub(plan) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const isRouting = url.includes('/v2/directions/');
    const key = init && init.headers && init.headers.Authorization;
    const which = isRouting
      ? (key && key.startsWith('ors-diagnostic-control') ? 'refused' : 'routing')
      : 'place';
    calls.push({ which, url, key });
    const answer = plan[which];
    if (answer === 'blocked') throw new TypeError('Load failed');
    return { status: answer, json: async () => ({}) };
  };
  return { calls, fetchImpl };
}

const noPause = async () => {};

async function run(plan) {
  const { calls, fetchImpl } = stub(plan);
  const results = await diagnose('real-key', fetchImpl, noPause);
  return { calls, results, ...readDiagnosis(results) };
}

// --- the probes themselves -------------------------------------------------
test('all three probes are sent, and the control uses a key that cannot work', async () => {
  const { calls } = await run({ place: 200, refused: 403, routing: 200 });
  assert.equal(calls.length, 3);
  assert.equal(calls[0].which, 'place');
  assert.equal(calls[1].which, 'refused');
  assert.equal(calls[2].which, 'routing');
  assert.notEqual(calls[1].key, 'real-key', 'the control must not use the real key');
  assert.equal(calls[2].key, 'real-key');
});

test('the control probe never sends the real key anywhere', async () => {
  const { calls } = await run({ place: 200, refused: 403, routing: 'blocked' });
  const control = calls.find((c) => c.which === 'refused');
  assert.ok(!String(control.key).includes('real-key'));
});

test('the routing probes use the same shape as a real search', async () => {
  const { calls } = await run({ place: 200, refused: 403, routing: 200 });
  const routing = calls.find((c) => c.which === 'routing');
  assert.ok(routing.url.includes(`/v2/directions/${CONFIG.ORS_PROFILE}/geojson`));
});

test('a blocked probe is recorded rather than thrown', async () => {
  const { results } = await run({ place: 'blocked', refused: 'blocked', routing: 'blocked' });
  assert.equal(results.length, 3);
  results.forEach((r) => {
    assert.equal(r.outcome, 'blocked');
    assert.match(r.detail, /Load failed/);
  });
});

test('probes are spaced so the diagnosis cannot itself trip the limit', async () => {
  const waits = [];
  const { fetchImpl } = stub({ place: 200, refused: 403, routing: 200 });
  await diagnose('real-key', fetchImpl, async (ms) => { waits.push(ms); });
  assert.equal(waits.length, 2, 'a gap between each pair, none after the last');
  waits.forEach((ms) => assert.ok(ms >= CONFIG.ORS_MIN_REQUEST_INTERVAL_MS));
});

// --- the verdicts ----------------------------------------------------------
test('routing answering normally is reported as working', async () => {
  const { verdict } = await run({ place: 200, refused: 403, routing: 200 });
  assert.equal(verdict, 'working');
});

test('a readable 403 on routing is named as quota or key, not as the connection', async () => {
  const { verdict, text } = await run({ place: 200, refused: 403, routing: 403 });
  assert.equal(verdict, 'refused');
  assert.match(text, /allowance|key/i);
  assert.doesNotMatch(text, /check your connection/i);
});

test('a readable 429 is named as the per minute limit', async () => {
  const { verdict } = await run({ place: 200, refused: 403, routing: 429 });
  assert.equal(verdict, 'rate-limited');
});

test('the control answering proves an invisible failure is not a refusal', async () => {
  // This is the case the whole diagnostic exists for.
  const { verdict, text } = await run({ place: 200, refused: 403, routing: 'blocked' });
  assert.equal(verdict, 'not-a-refusal');
  assert.match(text, /not being refused/i);
});

test('the control being blocked too, with place search fine, points at the routing allowance', async () => {
  const { verdict, text } = await run({ place: 200, refused: 'blocked', routing: 'blocked' });
  assert.equal(verdict, 'likely-quota');
  assert.match(text, /separate allowances/i);
});

test('everything blocked is reported as not reaching the service at all', async () => {
  const { verdict, text } = await run({ place: 'blocked', refused: 'blocked', routing: 'blocked' });
  assert.equal(verdict, 'unreachable');
  assert.match(text, /connection|blocking/i);
});

test('a refused place search with routing blocked points at the key', async () => {
  const { verdict, text } = await run({ place: 403, refused: 'blocked', routing: 'blocked' });
  assert.equal(verdict, 'key');
  assert.match(text, /key/i);
});

test('a readable routing error that is neither quota nor limit is owned as a bug', async () => {
  const { verdict, text } = await run({ place: 200, refused: 403, routing: 400 });
  assert.equal(verdict, 'error');
  assert.match(text, /bug in the app/i);
});

test('every verdict says something, and never blames the connection without evidence', async () => {
  const plans = [
    { place: 200, refused: 403, routing: 200 },
    { place: 200, refused: 403, routing: 403 },
    { place: 200, refused: 403, routing: 'blocked' },
    { place: 200, refused: 'blocked', routing: 'blocked' },
    { place: 'blocked', refused: 'blocked', routing: 'blocked' },
    { place: 403, refused: 'blocked', routing: 'blocked' },
  ];
  for (const plan of plans) {
    const { verdict, text } = await run(plan);
    assert.ok(verdict && text.length > 40, `thin verdict for ${JSON.stringify(plan)}`);
    if (plan.place === 200 && plan.routing !== 'blocked') {
      assert.doesNotMatch(text, /your connection/i,
        'the connection is only blamed when nothing answered');
    }
  }
});
