/* UI: map, form, ranked cards. All the search logic lives in routefinder.js. */
import { CONFIG, SHAPE_LOOP } from './config.js';
import { OrsClient, TerrainStore, search } from './routefinder.js';

const KEY_STORAGE = 's10.orsKey';
const $ = (id) => document.getElementById(id);

let map;
let startMarker;
let routeLayer;
let start = { ...CONFIG.DEFAULT_START };
let store;
let searchCount = 0;
const groups = [];          // every search's results, newest first

// --- storage helpers (Safari private mode can throw on both) ---------------
function readKey() {
  try { return localStorage.getItem(KEY_STORAGE) || ''; } catch { return ''; }
}
function writeKey(value) {
  try { localStorage.setItem(KEY_STORAGE, value); return true; } catch { return false; }
}
function safeLocalStorage() {
  try {
    localStorage.setItem('s10.probe', '1');
    localStorage.removeItem('s10.probe');
    return localStorage;
  } catch { return null; }
}

// --- boot ------------------------------------------------------------------
function boot() {
  store = new TerrainStore({ storage: safeLocalStorage() });

  map = L.map('map').setView([start.lat, start.lon], CONFIG.DEFAULT_ZOOM);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors. '
      + 'Routing by <a href="https://openrouteservice.org/">openrouteservice</a>.',
  }).addTo(map);

  startMarker = L.marker([start.lat, start.lon], { draggable: true }).addTo(map);
  startMarker.on('dragend', () => {
    const p = startMarker.getLatLng();
    setStart(p.lat, p.lng);
  });
  map.on('click', (e) => setStart(e.latlng.lat, e.latlng.lng));
  // Safari's toolbar changes the viewport height as you scroll.
  window.addEventListener('resize', () => map.invalidateSize());

  buildPresets();
  setStart(start.lat, start.lon);
  refreshTerrainNote();

  $('api-key').value = readKey();
  if (!readKey()) {
    $('settings').open = true;
    message('warn', 'Add your OpenRouteService key in Settings above before searching. '
      + 'It stays in this browser and is only ever sent to OpenRouteService.');
  }

  $('save-key').addEventListener('click', onSaveKey);
  $('clear-terrain').addEventListener('click', onClearTerrain);
  $('search').addEventListener('click', runSearch);
  $('search-again').addEventListener('click', runSearch);

  $('budget-note').textContent =
    `Each search spends up to ${CONFIG.REQUEST_BUDGET} routing requests and takes around `
    + `${Math.round((CONFIG.REQUEST_BUDGET * CONFIG.ORS_MIN_REQUEST_INTERVAL_MS) / 1000)} seconds, `
    + `because requests are spaced out to stay inside the free tier. Tolerance: `
    + `${Math.round(100 * CONFIG.DISTANCE_TOLERANCE)}% on distance, `
    + `${Math.round(100 * CONFIG.ASCENT_TOLERANCE)}% on climb. Profile: ${CONFIG.ORS_PROFILE}.`;
}

function buildPresets() {
  const wrap = $('climb-presets');
  Object.entries(CONFIG.CLIMB_PRESETS).forEach(([name, perKm], i) => {
    const label = document.createElement('label');
    label.innerHTML = `<input type="radio" name="preset" value="${name}"${i === 1 ? ' checked' : ''}>`
      + `<span>${name[0].toUpperCase()}${name.slice(1)}<br><small style="color:#666">${perKm}/km</small></span>`;
    wrap.appendChild(label);
  });
}

function refreshTerrainNote() {
  $('terrain-note').textContent = store.size
    ? `Terrain store holds ${store.size.toLocaleString('en-GB')} points. `
    : 'Terrain store is empty, so the first few searches aim by bearing alone. ';
}

function onSaveKey() {
  const value = $('api-key').value.trim();
  clearMessages();
  if (!value) { message('error', 'Paste your key first.'); return; }
  if (!writeKey(value)) {
    message('error', 'This browser refused to save the key, which happens in Private Browsing. '
      + 'The key will work for this session but you will have to paste it again next time.');
    return;
  }
  $('settings').open = false;
  message('info', 'Key saved in this browser.');
}

function onClearTerrain() {
  store.clear();
  refreshTerrainNote();
  clearMessages();
  message('info', 'Terrain store cleared. It will rebuild as you search.');
}

// --- start point -----------------------------------------------------------
function setStart(lat, lon) {
  start = { lat, lon };
  startMarker.setLatLng([lat, lon]);
  const b = CONFIG.BBOX;
  const inside = lat >= b.minLat && lat <= b.maxLat && lon >= b.minLon && lon <= b.maxLon;
  $('start-readout').innerHTML = `${lat.toFixed(5)}, ${lon.toFixed(5)}`
    + (inside ? '' : ' <strong style="color:#a33">outside the Sheffield area</strong>');
  $('search').disabled = !inside;
}

// --- messages --------------------------------------------------------------
function message(kind, text) {
  const div = document.createElement('div');
  div.className = `msg ${kind}`;
  div.textContent = text;
  $('messages').appendChild(div);
}
function clearMessages() { $('messages').innerHTML = ''; }

// --- search ----------------------------------------------------------------
function targetAscent(distanceKm) {
  const exact = $('climb-m').value.trim();
  if (exact !== '') {
    const metres = Number(exact);
    if (!Number.isFinite(metres) || metres < 0) return { error: 'Climb must be zero or more metres.' };
    return { metres, label: `${Math.round(metres)} m` };
  }
  const preset = document.querySelector('input[name=preset]:checked').value;
  const perKm = CONFIG.CLIMB_PRESETS[preset];
  return { metres: perKm * distanceKm, label: `${preset} (${perKm} m per km)` };
}

async function runSearch() {
  clearMessages();
  const apiKey = $('api-key').value.trim() || readKey();
  if (!apiKey) {
    $('settings').open = true;
    message('error', 'Add your OpenRouteService key in Settings first.');
    return;
  }

  const distanceKm = Number($('distance').value);
  if (!(distanceKm >= CONFIG.MIN_DISTANCE_KM && distanceKm <= CONFIG.MAX_DISTANCE_KM)) {
    message('error', `Distance must be between ${CONFIG.MIN_DISTANCE_KM} and ${CONFIG.MAX_DISTANCE_KM} km.`);
    return;
  }
  const ascent = targetAscent(distanceKm);
  if (ascent.error) { message('error', ascent.error); return; }

  const shape = $('shape').value;
  setBusy(true);
  message('info', 'Generating candidate routes and measuring each one. This takes a few seconds '
    + 'because requests are throttled to stay inside the free tier.');

  const client = new OrsClient({ apiKey });
  try {
    const result = await search({
      start: { ...start },
      targetDistanceM: distanceKm * 1000,
      targetAscentM: ascent.metres,
      shape,
      client,
      store,
    });
    const saved = store.save();
    clearMessages();
    handleResult(result, {
      distanceKm, ascentM: ascent.metres, climbLabel: ascent.label, shape,
    }, client, saved);
  } catch (err) {
    clearMessages();
    message('error', err.message || 'The search failed.');
  } finally {
    setBusy(false);
  }
}

function setBusy(busy) {
  $('search').disabled = busy;
  $('search-again').disabled = busy || searchCount === 0;
  $('search').textContent = busy ? 'Searching…' : 'Search';
}

function handleResult(result, target, client, storeSaved) {
  searchCount += 1;
  $('search-again').disabled = false;
  refreshTerrainNote();

  if (result.stoppedEarly) message('error', result.stoppedEarly);
  result.warnings.forEach((w) => message('warn', w));
  if (!storeSaved) {
    message('warn', 'The terrain store could not be saved in this browser, so it will not carry '
      + 'over to your next visit. This happens in Private Browsing or when storage is full.');
  }

  const quotaLeft = client.quota['x-ratelimit-remaining'];
  message('info',
    `Search ${searchCount}: spent ${result.requestsUsed} of ${CONFIG.REQUEST_BUDGET} requests`
    + (result.cacheHits ? `, ${result.cacheHits} served from cache` : '')
    + `. Terrain store holds ${store.size.toLocaleString('en-GB')} points.`
    + (quotaLeft ? ` ORS reports ${quotaLeft} requests left in this quota window.` : ''));

  if (!result.candidates.length) {
    message('warn', 'No routes came back from this search. Try a different start point or distance.');
    return;
  }
  groups.unshift({
    number: searchCount,
    target,
    results: result.candidates.map((c) => c.toResult()),
  });
  renderGroups();
  select(0, 0);
}

// --- results ---------------------------------------------------------------
function renderGroups() {
  const wrap = $('results');
  wrap.innerHTML = '';
  groups.forEach((group, gi) => {
    const heading = document.createElement('div');
    heading.className = 'group-heading';
    heading.textContent = `Search ${group.number}: ${group.target.distanceKm} km, `
      + `${Math.round(group.target.ascentM)} m climb (${group.target.climbLabel}), `
      + `${group.target.shape === SHAPE_LOOP ? 'loop' : 'out and back'}`;
    wrap.appendChild(heading);
    group.results.forEach((route, ri) => wrap.appendChild(card(route, gi, ri)));
  });
}

function card(route, gi, ri) {
  const el = document.createElement('div');
  el.className = 'card';
  el.dataset.key = `${gi}-${ri}`;
  const badge = route.withinTolerance
    ? '<span class="badge good">within tolerance</span>'
    : '<span class="badge bad">outside tolerance</span>';
  const sign = (v, unit) => `${v > 0 ? '+' : ''}${v}${unit}`;
  el.innerHTML =
    `<h3>#${ri + 1} &middot; ${route.distanceKm} km ${badge}</h3>`
    + `<div class="stat"><span>climb</span> ${route.ascentM} m &middot; <span>descent</span> ${route.descentM} m</div>`
    + `<div class="err">${sign(route.distanceErrorKm, ' km')} on distance (${route.distanceErrorPct}%), `
    + `${sign(route.ascentErrorM, ' m')} on climb (${route.ascentErrorPct}%)</div>`
    + `<div class="err">found by: ${route.strategy.replace(/_/g, ' ')}</div>`;
  el.addEventListener('click', () => select(gi, ri));
  return el;
}

function select(gi, ri) {
  const route = groups[gi].results[ri];
  document.querySelectorAll('.card').forEach((c) => {
    c.classList.toggle('selected', c.dataset.key === `${gi}-${ri}`);
  });
  if (routeLayer) map.removeLayer(routeLayer);
  routeLayer = L.polyline(route.latLngs, { color: '#1b4fa3', weight: 4, opacity: 0.85 }).addTo(map);
  map.fitBounds(routeLayer.getBounds(), { padding: [25, 25] });
}

boot();
