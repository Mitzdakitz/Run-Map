/* S10 route finder: map, search form, ranked result cards. Leaflet only. */

let CONFIG = null;
let map, startMarker, routeLayer;
let start = null;
let searchCount = 0;
const groups = [];   // every search's results, newest first

const $ = (id) => document.getElementById(id);

async function boot() {
  CONFIG = await (await fetch('/api/config')).json();
  start = { lat: CONFIG.default_start.lat, lon: CONFIG.default_start.lon };

  map = L.map('map').setView([start.lat, start.lon], CONFIG.zoom);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors. Routing by <a href="https://openrouteservice.org/">openrouteservice</a>.'
  }).addTo(map);

  startMarker = L.marker([start.lat, start.lon], { draggable: true }).addTo(map);
  startMarker.on('dragend', () => {
    const p = startMarker.getLatLng();
    setStart(p.lat, p.lng);
  });
  map.on('click', (e) => setStart(e.latlng.lat, e.latlng.lng));

  buildPresets();
  setStart(start.lat, start.lon);

  $('search').addEventListener('click', () => runSearch());
  $('search-again').addEventListener('click', () => runSearch());

  if (!CONFIG.has_api_key) {
    message('error', 'No OpenRouteService API key is configured. Copy .env.example to .env, add your key, and restart the app.');
  }
  $('budget-note').textContent =
    `Each search spends up to ${CONFIG.request_budget} routing requests. ` +
    `Tolerance: ${CONFIG.tolerance.distance_pct}% on distance, ${CONFIG.tolerance.ascent_pct}% on climb. ` +
    `Profile: ${CONFIG.profile}.`;
}

function buildPresets() {
  const wrap = $('climb-presets');
  Object.entries(CONFIG.climb_presets).forEach(([name, perKm], i) => {
    const label = document.createElement('label');
    label.innerHTML =
      `<input type="radio" name="preset" value="${name}"${i === 1 ? ' checked' : ''}>` +
      `${name[0].toUpperCase()}${name.slice(1)} <span style="color:#666">(${perKm}/km)</span>`;
    wrap.appendChild(label);
  });
}

function setStart(lat, lon) {
  start = { lat, lon };
  startMarker.setLatLng([lat, lon]);
  const b = CONFIG.bbox;
  const inside = lat >= b.min_lat && lat <= b.max_lat && lon >= b.min_lon && lon <= b.max_lon;
  $('start-readout').innerHTML = `${lat.toFixed(5)}, ${lon.toFixed(5)}` +
    (inside ? '' : ' <strong style="color:#a33">outside the Sheffield area</strong>');
  $('search').disabled = !inside;
}

function message(kind, text) {
  const div = document.createElement('div');
  div.className = `msg ${kind}`;
  div.textContent = text;
  $('messages').appendChild(div);
}

function clearMessages() { $('messages').innerHTML = ''; }

async function runSearch() {
  clearMessages();
  const climbM = $('climb-m').value.trim();
  const body = {
    lat: start.lat,
    lon: start.lon,
    distance_km: parseFloat($('distance').value),
    shape: $('shape').value,
    climb_preset: document.querySelector('input[name=preset]:checked').value,
    climb_m: climbM === '' ? null : parseFloat(climbM)
  };
  if (!(body.distance_km >= CONFIG.distance.min_km && body.distance_km <= CONFIG.distance.max_km)) {
    message('error', `Distance must be between ${CONFIG.distance.min_km} and ${CONFIG.distance.max_km} km.`);
    return;
  }

  setBusy(true);
  message('info', 'Generating candidate routes and measuring each one. This takes a few seconds because requests are throttled to stay inside the free tier.');
  try {
    const response = await fetch('/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await response.json();
    clearMessages();
    if (!response.ok) {
      message('error', data.error || `The search failed (HTTP ${response.status}).`);
      return;
    }
    handleResults(data);
  } catch (err) {
    clearMessages();
    message('error', `Could not reach the local server: ${err.message}`);
  } finally {
    setBusy(false);
  }
}

function setBusy(busy) {
  $('search').disabled = busy;
  $('search-again').disabled = busy || searchCount === 0;
  $('search').textContent = busy ? 'Searching…' : 'Search';
}

function handleResults(data) {
  searchCount += 1;
  $('search-again').disabled = false;

  if (data.stopped_early) message('error', data.stopped_early);
  (data.warnings || []).forEach((w) => message('warn', w));

  const quota = data.quota && data.quota['x-ratelimit-remaining'];
  message('info',
    `Search ${searchCount}: spent ${data.budget.spent} of ${data.budget.total} requests` +
    (data.budget.cache_hits ? `, ${data.budget.cache_hits} served from cache` : '') +
    `. Terrain store holds ${data.terrain_points} points.` +
    (quota ? ` ORS reports ${quota} requests left in this quota window.` : ''));

  if (!data.results.length) {
    message('warn', 'No routes came back from this search. Try a different start point or distance.');
    return;
  }
  groups.unshift({ number: searchCount, target: data.target, results: data.results });
  renderGroups();
  select(0, 0);
}

function renderGroups() {
  const wrap = $('results');
  wrap.innerHTML = '';
  groups.forEach((group, gi) => {
    const heading = document.createElement('div');
    heading.className = 'group-heading';
    heading.textContent =
      `Search ${group.number}: ${group.target.distance_km} km, ${group.target.ascent_m} m climb` +
      ` (${group.target.climb_label}), ${group.target.shape === 'loop' ? 'loop' : 'out and back'}`;
    wrap.appendChild(heading);

    group.results.forEach((route, ri) => {
      wrap.appendChild(card(route, gi, ri));
    });
  });
}

function card(route, gi, ri) {
  const el = document.createElement('div');
  el.className = 'card';
  el.dataset.key = `${gi}-${ri}`;
  const badge = route.within_tolerance
    ? '<span class="badge good">within tolerance</span>'
    : '<span class="badge bad">outside tolerance</span>';
  const sign = (v, unit) => `${v > 0 ? '+' : ''}${v}${unit}`;
  el.innerHTML =
    `<h3>#${ri + 1} &middot; ${route.distance_km} km ${badge}</h3>` +
    `<div class="stat"><span>climb</span> ${route.ascent_m} m &middot; <span>descent</span> ${route.descent_m} m</div>` +
    `<div class="err">${sign(route.distance_error_km, ' km')} on distance (${route.distance_error_pct}%), ` +
    `${sign(route.ascent_error_m, ' m')} on climb (${route.ascent_error_pct}%)</div>` +
    `<div class="err">found by: ${route.strategy.replace(/_/g, ' ')}</div>`;
  el.addEventListener('click', () => select(gi, ri));
  return el;
}

function select(gi, ri) {
  const route = groups[gi].results[ri];
  document.querySelectorAll('.card').forEach((c) => {
    c.classList.toggle('selected', c.dataset.key === `${gi}-${ri}`);
  });
  if (routeLayer) map.removeLayer(routeLayer);
  routeLayer = L.polyline(route.coords, { color: '#1b4fa3', weight: 4, opacity: 0.85 }).addTo(map);
  map.fitBounds(routeLayer.getBounds(), { padding: [30, 30] });
}

boot();
