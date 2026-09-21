/* UI: map, search form, ranked cards, elevation profile.
 * All search logic lives in routefinder.js; this file only presents it. */
import { APP_VERSION, CONFIG, SHAPE_LOOP, SHAPE_OUT_AND_BACK, STORAGE } from './config.js';
import {
  OrsClient, TerrainStore, diagnose, estimateSeconds, formatDuration, geocode,
  gradientAt, gradientBand, longestClimb, parsePace, profile, readDiagnosis,
  reverseProfile, search, steepestWindow,
} from './routefinder.js';

const $ = (id) => document.getElementById(id);
const BAND_TOKENS = ['var(--dn2)', 'var(--dn1)', 'var(--flat)', 'var(--up1)', 'var(--up2)', 'var(--up3)'];

// --- storage, all of it optional ------------------------------------------
function read(key, fallback = null) {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : raw;
  } catch { return fallback; }
}
function write(key, value) {
  try { localStorage.setItem(key, value); return true; } catch { return false; }
}
function safeStorage() {
  try {
    localStorage.setItem('s10.probe', '1');
    localStorage.removeItem('s10.probe');
    return localStorage;
  } catch { return null; }
}

// --- state -----------------------------------------------------------------
let map;
let startMarker;
let store;
let start = { ...CONFIG.DEFAULT_START };
let paceSeconds = null;
let apiKey = '';
let savedStarts = [];
let searchCount = 0;
let busy = false;
let reversed = false;

const groups = [];           // newest first: { number, target, candidates, profiles }
let selected = { group: 0, route: 0 };
let domain = null;           // shared chart scale for the selected group
let activeProfile = [];      // the selected route, in the direction being shown

const routeLayer = { lines: [], hits: [], arrows: null, cursor: null, turn: null };
let terrainLayer = null;

// --- boot ------------------------------------------------------------------
/* Anything that throws lands on the page rather than only in a console nobody
 * opens on a phone. Without this, one bad line leaves every control dead with
 * no visible reason. */
function installErrorReporter() {
  const report = (what) => {
    const host = document.getElementById('messages');
    if (!host) return;
    const div = document.createElement('div');
    div.className = 'msg error';
    div.textContent = `Something went wrong in the app: ${what}. `
      + 'This is a bug, not something you did.';
    host.appendChild(div);
  };

  window.addEventListener('error', (e) => {
    /* Browsers hide the detail of an error thrown by a script from another
     * origin and report a bare "Script error." with no file or line. Those
     * come from browser extensions and third-party scripts far more often
     * than from this app, and there is nothing in them anyone can act on, so
     * putting one on screen as "a bug" is crying wolf. They go to the console
     * instead. Errors in this app's own files are same-origin and keep their
     * full detail, so they still get reported. */
    if (!e.filename || e.message === 'Script error.') {
      console.warn('Opaque cross-origin script error, not shown on the page:', e.message);
      return;
    }
    if (e.filename.indexOf(window.location.origin) !== 0) {
      console.warn('Error from a third-party script, not shown on the page:', e.filename, e.message);
      return;
    }
    const where = `${e.filename.split('/').pop()}:${e.lineno}`;
    report(`${e.message} (${where})`);
  });

  window.addEventListener('unhandledrejection', (e) => report(
    (e.reason && e.reason.message) || 'a background task failed',
  ));
}

function boot() {
  installErrorReporter();
  store = new TerrainStore({ storage: safeStorage() });

  // The controls are wired before the map, so a map failure cannot take the
  // whole interface down with it.
  $('appVersion').textContent = APP_VERSION;
  buildClimbPresets();
  loadSettings();
  wireEvents();
  updateSummary();
  refreshTerrainCount();

  try {
    initMap();
  } catch (err) {
    message('error', `The map could not start: ${err.message}. `
      + 'The rest of the page still works, but routes cannot be drawn. '
      + 'Check that Leaflet loaded, then reload.');
  }

  setStart(start.lat, start.lon, read(STORAGE.startName, 'Default start'), { silent: true });

  if (!read(STORAGE.key)) {
    message('warn', 'Add your OpenRouteService key in Settings at the bottom of the page before searching. '
      + 'It stays in this browser and is only ever sent to OpenRouteService.');
  }
  window.addEventListener('resize', () => {
    if (map) map.invalidateSize();
    if (activeProfile.length) drawChart();
  });
}

/* Map overlays keep literal colours rather than theme tokens: OpenStreetMap
 * tiles are light in both themes, so the marks have to read on a light ground
 * whatever the page around them is doing. */
const MAP_INK = '#1F5C4A';

/* A chequered disc, so the point a loop begins and ends at is findable. On a
 * loop the line closes on itself and the start is otherwise invisible. */
function startFinishIcon() {
  return L.divIcon({
    className: 'sf-icon',
    iconSize: [28, 28],
    iconAnchor: [14, 14],
    html: `<svg width="28" height="28" viewBox="-14 -14 28 28" aria-hidden="true">
             <circle r="12" fill="#FFFFFF" stroke="${MAP_INK}" stroke-width="2.5"/>
             <g fill="${MAP_INK}">
               <rect x="-6" y="-6" width="6" height="6"/>
               <rect x="0" y="0" width="6" height="6"/>
             </g>
           </svg>`,
  });
}

/* Where an out and back turns round. Same question as start and finish, but
 * for the other shape. */
function turnaroundIcon() {
  return L.divIcon({
    className: 'turn-icon',
    iconSize: [24, 24],
    iconAnchor: [12, 12],
    html: `<svg width="24" height="24" viewBox="-12 -12 24 24" aria-hidden="true">
             <circle r="10" fill="#FFFFFF" stroke="${MAP_INK}" stroke-width="2"/>
             <path d="M -3.5 4 L -3.5 -1 A 3.5 3.5 0 0 1 3.5 -1 L 3.5 3"
                   fill="none" stroke="${MAP_INK}" stroke-width="2" stroke-linecap="round"/>
             <path d="M 0.6 2.2 L 3.5 5.2 L 6.4 2.2 Z" fill="${MAP_INK}"/>
           </svg>`,
  });
}

function initMap() {
  if (typeof L === 'undefined') {
    throw new Error('the Leaflet mapping library did not load');
  }
  map = L.map('map', { zoomControl: true }).setView([start.lat, start.lon], CONFIG.DEFAULT_ZOOM);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);

  startMarker = L.marker([start.lat, start.lon], {
    draggable: true, icon: startFinishIcon(), zIndexOffset: 1000,
  }).addTo(map);
  startMarker.bindTooltip('Start and finish. Drag to move it.', { direction: 'top', offset: [0, -14] });
  startMarker.on('dragend', () => {
    const p = startMarker.getLatLng();
    setStart(p.lat, p.lng, 'Dropped pin');
  });
  map.on('click', (e) => setStart(e.latlng.lat, e.latlng.lng, 'Map pin'));
  map.on('zoomend', () => { if (activeProfile.length) drawArrows(); });
}

function buildClimbPresets() {
  const select = $('climbPreset');
  Object.entries(CONFIG.CLIMB_PRESETS).forEach(([name, perKm]) => {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = `${name[0].toUpperCase()}${name.slice(1)} (${perKm} m/km)`;
    if (name === 'medium') option.selected = true;
    select.appendChild(option);
  });
}

function loadSettings() {
  apiKey = read(STORAGE.key, '');
  renderKeyState();
  const pace = read(STORAGE.pace, '');
  $('pace').value = pace;
  paceSeconds = parsePace(pace);
  try { savedStarts = JSON.parse(read(STORAGE.starts, '[]')) || []; } catch { savedStarts = []; }
  renderSavedStarts();
}

/* Once a key is saved the entry field is put away, because it is set once and
 * then never touched again. The stored key is never written back into the DOM. */
function renderKeyState() {
  const saved = Boolean(apiKey);
  $('keySaved').hidden = !saved;
  $('keyEntry').hidden = saved;
  if (saved) $('apiKey').value = '';
}

// --- messages --------------------------------------------------------------
function message(kind, text) {
  const div = document.createElement('div');
  div.className = `msg ${kind}`;
  div.textContent = text;
  $('messages').appendChild(div);
}
function clearMessages() { $('messages').textContent = ''; }

// --- connection diagnosis --------------------------------------------------
/* A fetch that fails tells the page nothing, and on a phone there is no Network
 * tab to fall back on. This sends three requests that fail in different ways and
 * reports which one broke, so the cause can be named instead of guessed at. */
function renderDiagnosis(results, verdict) {
  const box = $('diagnosis');
  box.hidden = false;
  box.textContent = '';

  const summary = document.createElement('p');
  summary.className = 'verdict';
  summary.textContent = verdict.text;
  box.appendChild(summary);

  const list = document.createElement('ul');
  results.forEach((r) => {
    const li = document.createElement('li');
    const answered = r.outcome === 'answered';
    const good = answered && r.status < 400;

    const mark = document.createElement('span');
    mark.className = 'mark';
    mark.textContent = good ? '\u2713' : (answered ? '\u2014' : '\u2717');
    li.appendChild(mark);

    const probe = document.createElement('span');
    probe.className = 'probe';
    probe.textContent = r.label;
    const note = document.createElement('span');
    note.className = 'note';
    note.textContent = r.note;
    probe.appendChild(note);
    li.appendChild(probe);

    const result = document.createElement('span');
    result.className = 'result';
    result.textContent = answered ? `HTTP ${r.status}` : 'no answer';
    li.appendChild(result);

    list.appendChild(li);
  });
  box.appendChild(list);
}

async function runDiagnosis() {
  const button = $('diagnose');
  clearMessages();
  if (!apiKey) {
    message('error', 'Add your key first, then test the connection.');
    return;
  }
  button.disabled = true;
  const label = button.textContent;
  button.textContent = 'Testing\u2026';
  $('diagnosis').hidden = true;
  try {
    const results = await diagnose(apiKey);
    renderDiagnosis(results, readDiagnosis(results));
  } catch (err) {
    message('error', `The test itself failed: ${err.message}`);
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

// --- start point -----------------------------------------------------------
/* The app used to refuse any start outside a Sheffield bounding box. Routes can
 * now be plotted anywhere routing data exists, so the only thing worth checking
 * is that the numbers are numbers. */
function usableStart(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon)
    && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
}

function setStart(lat, lon, name, { silent = false } = {}) {
  start = { lat, lon, name: name || 'Start' };
  if (startMarker) startMarker.setLatLng([lat, lon]);
  $('startPill').textContent = `Start: ${start.name}`;
  $('sumStart').textContent = start.name;
  const ok = usableStart(lat, lon);
  $('searchBtn').disabled = !ok || busy;
  if (!ok && !silent) {
    clearMessages();
    message('error', 'That start point is not a real position.');
  }
  write(STORAGE.startName, start.name);
}

function renderSavedStarts() {
  const host = $('savedStarts');
  host.textContent = '';
  savedStarts.forEach((s, i) => {
    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.type = 'button';
    chip.innerHTML = `<span>${s.name}</span><span class="x" aria-hidden="true">&times;</span>`;
    chip.addEventListener('click', (e) => {
      if (e.target.classList.contains('x')) {
        savedStarts.splice(i, 1);
        write(STORAGE.starts, JSON.stringify(savedStarts));
        renderSavedStarts();
        return;
      }
      setStart(s.lat, s.lon, s.name);
      if (map) map.setView([s.lat, s.lon], Math.max(map.getZoom(), CONFIG.DEFAULT_ZOOM));
      updateSummary();
    });
    host.appendChild(chip);
  });
  const add = document.createElement('button');
  add.className = 'chip';
  add.type = 'button';
  add.textContent = '+ Save this start';
  add.addEventListener('click', () => {
    const name = window.prompt('Name for this start point', start.name || 'Home');
    if (!name) return;
    savedStarts.push({ name, lat: start.lat, lon: start.lon });
    write(STORAGE.starts, JSON.stringify(savedStarts));
    setStart(start.lat, start.lon, name);
    renderSavedStarts();
    updateSummary();
  });
  host.appendChild(add);
}

// --- query summary ---------------------------------------------------------
function targetAscentM(distanceKm) {
  const exact = $('climbExact').value.trim();
  if (exact !== '') {
    const metres = Number(exact);
    if (!Number.isFinite(metres) || metres < 0) return { error: 'Climb must be zero or more metres.' };
    return { metres, label: `${Math.round(metres)} m` };
  }
  const preset = $('climbPreset').value;
  const perKm = CONFIG.CLIMB_PRESETS[preset];
  return { metres: perKm * distanceKm, label: `${preset} (${perKm} m/km)` };
}

function updateSummary() {
  const distanceKm = Number($('distance').value) || 0;
  const ascent = targetAscentM(distanceKm);
  $('sumDistance').textContent = `${distanceKm} km`;
  $('sumClimb').textContent = ascent.error ? '—' : `${Math.round(ascent.metres)} m`;
  $('sumShape').textContent = $('shape').value === SHAPE_LOOP ? 'Loop' : 'Out and back';
}

// --- loading runner --------------------------------------------------------
/* A four frame pixel run cycle, written as rows so the frames stay editable.
 * '#' is a filled pixel on a 12 by 12 grid. */
const RUNNER_FRAMES = [
  ['.....##.....',
   '.....##.....',
   '............',
   '..#######...',
   '.#....##....',
   '......##....',
   '......##....',
   '.....#..#...',
   '....#....#..',
   '...#......#.',
   '..##.......#',
   '............'],
  ['.....##.....',
   '.....##.....',
   '............',
   '...#####.#..',
   '......##.#..',
   '......##....',
   '......##....',
   '......##....',
   '.....#.#....',
   '.....#..#...',
   '....##...#..',
   '............'],
  ['.....##.....',
   '.....##.....',
   '............',
   '...#######..',
   '....##....#.',
   '......##....',
   '......##....',
   '.....#..#...',
   '....#....#..',
   '...#......#.',
   '..#.......##',
   '............'],
  ['.....##.....',
   '.....##.....',
   '............',
   '..#.#####...',
   '..#..##.....',
   '......##....',
   '......##....',
   '......##....',
   '.....#.#....',
   '....#..#....',
   '...#...##...',
   '............'],
];

function runnerElement() {
  const svg = svgEl('svg', {
    class: 'runner', viewBox: '0 0 12 12', 'shape-rendering': 'crispEdges', 'aria-hidden': 'true',
  });
  RUNNER_FRAMES.forEach((frame) => {
    const g = svgEl('g', { fill: 'currentColor' });
    frame.forEach((row, y) => {
      [...row].forEach((cell, x) => {
        if (cell === '#') g.appendChild(svgEl('rect', { x, y, width: 1, height: 1 }));
      });
    });
    svg.appendChild(g);
  });
  return svg;
}

/* Shown while a search runs. Searches take around twenty seconds because the
 * requests are deliberately spaced out, so the wait needs something honest to
 * look at. */
function showLoading(text) {
  const div = document.createElement('div');
  div.className = 'msg info loading';
  div.id = 'loadingMsg';
  div.setAttribute('role', 'status');
  div.setAttribute('aria-live', 'polite');
  const label = document.createElement('span');
  label.textContent = text;
  div.append(runnerElement(), label);
  $('messages').appendChild(div);
}

// --- search ----------------------------------------------------------------
function setBusy(state) {
  busy = state;
  $('searchBtn').disabled = state || !usableStart(start.lat, start.lon);
  $('searchBtn').textContent = state ? 'Searching…' : 'Search';
}

async function runSearch() {
  clearMessages();
  if (!apiKey) {
    message('error', 'Add your OpenRouteService key in Settings at the bottom of the page first.');
    return;
  }
  const distanceKm = Number($('distance').value);
  if (!(distanceKm >= CONFIG.MIN_DISTANCE_KM && distanceKm <= CONFIG.MAX_DISTANCE_KM)) {
    message('error', `Distance must be between ${CONFIG.MIN_DISTANCE_KM} and ${CONFIG.MAX_DISTANCE_KM} km.`);
    return;
  }
  const ascent = targetAscentM(distanceKm);
  if (ascent.error) { message('error', ascent.error); return; }

  const shape = $('shape').value;
  setBusy(true);
  showLoading(`Generating and measuring candidate routes. Up to ${CONFIG.REQUEST_BUDGET} requests, `
    + 'spaced out to stay inside the free tier, so give it half a minute.');

  const client = new OrsClient({ apiKey });
  try {
    const result = await search({
      start: { lat: start.lat, lon: start.lon },
      targetDistanceM: distanceKm * 1000,
      targetAscentM: ascent.metres,
      shape,
      client,
      store,
    });
    const stored = store.save();
    clearMessages();
    handleResult(result, {
      distanceKm, ascentM: ascent.metres, climbLabel: ascent.label, shape,
    }, client, stored);
  } catch (err) {
    clearMessages();
    message('error', err.message || 'The search failed.');
  } finally {
    setBusy(false);
  }
}

function handleResult(result, target, client, stored) {
  searchCount += 1;
  refreshTerrainCount();

  if (result.stoppedEarly) message('error', result.stoppedEarly);

  // The same failure repeated once per request is noise, so show it once.
  const counts = new Map();
  result.warnings.forEach((w) => counts.set(w, (counts.get(w) || 0) + 1));
  counts.forEach((count, text) => {
    message('warn', count > 1 ? `${text} (${count} times)` : text);
  });
  if (!stored) {
    message('warn', 'The terrain store could not be saved in this browser, so it will not carry over '
      + 'to your next visit. This happens in Private Browsing or when storage is full.');
  }

  const spent = result.requestsUsed;
  $('budgetText').textContent = `Search ${searchCount}: spent ${spent} of ${CONFIG.REQUEST_BUDGET} requests`;
  $('quotaFill').style.width = `${Math.round((spent / CONFIG.REQUEST_BUDGET) * 100)}%`;
  const left = client.quota['x-ratelimit-remaining'];
  $('quotaText').textContent = left ? `${left} left in this quota window` : '';

  if (!result.candidates.length) {
    const allUnreachable = result.warnings.length
      && result.warnings.every((w) => w.startsWith('Could not reach OpenRouteService'));
    message('warn', allUnreachable
      ? 'Every request failed before it reached OpenRouteService, so this is not about '
        + 'your start point or distance. Open Settings and press "Test the connection": '
        + 'it sends three requests designed to fail in different ways and names the cause.'
      : 'No routes came back. Try a different start point or distance.');
    return;
  }

  groups.unshift({
    number: searchCount,
    target,
    candidates: result.candidates,
    profiles: result.candidates.map((c) => profile(c.coords, c.distanceM)),
  });
  selected = { group: 0, route: 0 };
  reversed = false;
  $('reverseBtn').setAttribute('aria-pressed', 'false');
  renderCards();
  selectRoute(0, 0, { fit: true });
}

// --- shared scale ----------------------------------------------------------
/* One domain across the group, so the three profiles and their sparklines are
 * genuinely comparable rather than each stretched to fill its own box. */
function domainFor(group) {
  let lo = Infinity;
  let hi = -Infinity;
  let km = 0;
  group.profiles.forEach((p) => {
    p.forEach((point) => {
      if (point.ele < lo) lo = point.ele;
      if (point.ele > hi) hi = point.ele;
    });
    if (p.length) km = Math.max(km, p[p.length - 1].km);
  });
  if (!Number.isFinite(lo)) return { lo: 0, hi: 100, km: 1 };
  const pad = Math.max(10, (hi - lo) * 0.1);
  return {
    lo: Math.floor((lo - pad) / 25) * 25,
    hi: Math.ceil((hi + pad) / 25) * 25,
    km,
  };
}

// --- cards -----------------------------------------------------------------
function sparkline(points, dom) {
  const w = 74;
  const h = 34;
  const svg = svgEl('svg', { class: 'spark', viewBox: `0 0 ${w} ${h}`, 'aria-hidden': 'true' });
  if (!points.length) return svg;
  const x = (km) => (km / dom.km) * (w - 2) + 1;
  const y = (m) => h - 3 - ((m - dom.lo) / (dom.hi - dom.lo)) * (h - 8);
  const step = Math.max(1, Math.floor(points.length / 60));
  let d = `M ${x(points[0].km)} ${y(points[0].ele)}`;
  for (let i = step; i < points.length; i += step) d += ` L ${x(points[i].km)} ${y(points[i].ele)}`;
  const last = points[points.length - 1];
  d += ` L ${x(last.km)} ${y(last.ele)}`;
  svg.appendChild(svgEl('path', {
    d: `${d} L ${x(last.km)} ${h - 1} L ${x(0)} ${h - 1} Z`, fill: 'var(--ink)', opacity: '.08', stroke: 'none',
  }));
  svg.appendChild(svgEl('path', { d, fill: 'none', stroke: 'var(--accent)', 'stroke-width': 1.6, 'stroke-linejoin': 'round' }));
  return svg;
}

function renderCards() {
  const host = $('cards');
  host.textContent = '';
  $('cardsEmpty').hidden = groups.length > 0;
  $('cardsNote').hidden = groups.length === 0;
  $('resultsHeading').textContent = groups.length
    ? `${groups[0].candidates.length} routes found`
    : 'Results';

  groups.forEach((group, gi) => {
    if (gi > 0 || groups.length > 1) {
      const heading = document.createElement('div');
      heading.className = 'group-heading';
      heading.textContent = `Search ${group.number}: ${group.target.distanceKm} km, `
        + `${Math.round(group.target.ascentM)} m, ${group.target.shape === SHAPE_LOOP ? 'loop' : 'out and back'}`;
      host.appendChild(heading);
    }
    const dom = domainFor(group);
    group.candidates.forEach((c, ri) => {
      host.appendChild(card(c, group, dom, gi, ri));
    });
  });
}

function card(candidate, group, dom, gi, ri) {
  const button = document.createElement('button');
  button.className = 'card';
  button.type = 'button';
  const isSelected = selected.group === gi && selected.route === ri;
  button.setAttribute('aria-current', String(isSelected));

  const pick = document.createElement('span');
  pick.className = 'pick';
  pick.setAttribute('aria-hidden', 'true');
  pick.textContent = isSelected ? '✓' : '';

  const mid = document.createElement('div');
  const ok = candidate.withinTolerance;
  const seconds = estimateSeconds(candidate.distanceM, candidate.ascentM, paceSeconds);

  const title = document.createElement('div');
  title.className = 'title';
  title.innerHTML = `<span class="dist num">${(candidate.distanceM / 1000).toFixed(2)} km</span>`
    + `<span class="badge ${ok ? 'good' : 'bad'}">${ok ? '✓ within' : '! outside'} tolerance</span>`;

  const sub = document.createElement('div');
  sub.className = 'sub';
  sub.innerHTML = `<span class="num">${Math.round(candidate.ascentM)} m</span> climb`
    + (seconds === null ? '' : ` &middot; <span class="num">${formatDuration(seconds)}</span>`);

  const err = document.createElement('div');
  err.className = 'err';
  const dErrKm = (candidate.distanceErrorM / 1000);
  err.textContent = `${dErrKm > 0 ? '+' : ''}${dErrKm.toFixed(2)} km `
    + `(${(candidate.relativeDistanceError * 100).toFixed(1)}%), `
    + `${candidate.ascentErrorM > 0 ? '+' : ''}${Math.round(candidate.ascentErrorM)} m climb `
    + `(${(candidate.relativeAscentError * 100).toFixed(1)}%)`;

  mid.append(title, sub, err);
  button.append(pick, mid, sparkline(group.profiles[ri], dom));
  button.addEventListener('click', () => selectRoute(gi, ri, { fit: true }));
  return button;
}

// --- selection -------------------------------------------------------------
function selectRoute(gi, ri, { fit = false } = {}) {
  selected = { group: gi, route: ri };
  reversed = false;
  $('reverseBtn').setAttribute('aria-pressed', 'false');
  $('dirPill').hidden = false;
  $('dirPill').textContent = 'As routed';
  domain = domainFor(groups[gi]);
  activeProfile = groups[gi].profiles[ri];
  renderCards();
  drawRoutes(fit);
  drawChart();
  refreshDetail();
}

// --- map -------------------------------------------------------------------
function drawRoutes(fit) {
  if (!map) return;
  routeLayer.lines.forEach((l) => map.removeLayer(l));
  routeLayer.hits.forEach((l) => map.removeLayer(l));
  routeLayer.lines = [];
  routeLayer.hits = [];

  const group = groups[selected.group];
  if (!group) return;

  group.candidates.forEach((c, i) => {
    const latLngs = c.coords.map((p) => [p[1], p[0]]);
    const isSelected = i === selected.route;
    const line = L.polyline(latLngs, {
      color: isSelected ? '#1F5C4A' : '#6E837A',
      weight: isSelected ? 5 : 2.5,
      opacity: isSelected ? 0.95 : 0.6,
    }).addTo(map);
    routeLayer.lines.push(line);

    if (!isSelected) {
      const hit = L.polyline(latLngs, {
        color: '#000', opacity: 0, weight: 20, className: 'route-hit',
      }).addTo(map);
      hit.on('click', (e) => { L.DomEvent.stop(e); selectRoute(selected.group, i, { fit: false }); });
      routeLayer.hits.push(hit);
    }
    if (isSelected) line.bringToFront();
  });

  drawArrows();
  drawTurnaround();
  if (fit) {
    const chosen = routeLayer.lines[selected.route];
    if (chosen) map.fitBounds(chosen.getBounds(), { padding: [28, 28] });
  }
}

/* Out and back retraces itself, so the far end is the only point on the line
 * you actually make a decision at. */
function drawTurnaround() {
  if (!map) return;
  if (routeLayer.turn) { map.removeLayer(routeLayer.turn); routeLayer.turn = null; }
  const group = groups[selected.group];
  if (!group) return;
  const candidate = group.candidates[selected.route];
  if (candidate.shape !== SHAPE_OUT_AND_BACK) return;

  const points = shownProfile();
  if (points.length < 3) return;
  const far = points[Math.floor((points.length - 1) / 2)];
  routeLayer.turn = L.marker([far.lat, far.lon], {
    icon: turnaroundIcon(), zIndexOffset: 900, keyboard: false,
  }).addTo(map);
  routeLayer.turn.bindTooltip(`Turn around here, ${far.km.toFixed(2)} km in`,
    { direction: 'top', offset: [0, -12] });
}

function drawArrows() {
  if (!map) return;
  if (routeLayer.arrows) map.removeLayer(routeLayer.arrows);
  routeLayer.arrows = L.layerGroup().addTo(map);
  const points = shownProfile();
  if (points.length < 3) return;

  const total = points[points.length - 1].km;
  for (let i = 0; i < CONFIG.ROUTE_ARROWS; i += 1) {
    const targetKm = ((i + 0.5) / CONFIG.ROUTE_ARROWS) * total;
    let index = points.findIndex((p) => p.km >= targetKm);
    if (index < 1) index = 1;
    if (index >= points.length - 1) index = points.length - 2;
    const a = points[index - 1];
    const b = points[index + 1];
    const lonScale = Math.cos((points[index].lat * Math.PI) / 180);
    const angle = (Math.atan2((b.lon - a.lon) * lonScale, b.lat - a.lat) * 180) / Math.PI;
    const icon = L.divIcon({
      className: 'arrow-icon',
      iconSize: [22, 22],
      iconAnchor: [11, 11],
      html: `<svg width="22" height="22" viewBox="-11 -11 22 22" style="transform:rotate(${angle}deg)">
               <circle r="9" fill="#FFFFFF" stroke="#1F5C4A" stroke-width="1.6"/>
               <path d="M 0 -5 L 4.5 4 L 0 1.6 L -4.5 4 Z" fill="#1F5C4A"/>
             </svg>`,
    });
    L.marker([points[index].lat, points[index].lon], { icon, interactive: false, keyboard: false })
      .addTo(routeLayer.arrows);
  }
}

function shownProfile() {
  return reversed ? reverseProfile(activeProfile) : activeProfile;
}

// --- elevation chart -------------------------------------------------------
const SVG_NS = 'http://www.w3.org/2000/svg';
function svgEl(name, attrs) {
  const node = document.createElementNS(SVG_NS, name);
  Object.entries(attrs).forEach(([k, v]) => node.setAttribute(k, v));
  return node;
}

const PAD = { left: 40, right: 30, top: 10, bottom: 46 };
const CHART_H = 200;
const RIBBON = 9;
let chartWidth = 560;
let scaleX = () => 0;
let scaleY = () => 0;

function drawChart() {
  const chart = $('chart');
  const points = shownProfile();
  if (!points.length) return;

  chartWidth = Math.max(280, chart.clientWidth || chart.parentNode.clientWidth || 560);
  chart.setAttribute('viewBox', `0 0 ${chartWidth} ${CHART_H}`);
  chart.setAttribute('height', CHART_H);
  chart.textContent = '';

  const plotBottom = CHART_H - PAD.bottom;
  const endKm = points[points.length - 1].km;
  scaleX = (km) => PAD.left + (km / domain.km) * (chartWidth - PAD.left - PAD.right);
  scaleY = (m) => plotBottom - ((m - domain.lo) / (domain.hi - domain.lo)) * (plotBottom - PAD.top);

  const tickStep = (domain.hi - domain.lo) > 260 ? 100 : 50;
  for (let m = domain.lo; m <= domain.hi; m += tickStep) {
    chart.appendChild(svgEl('line', {
      x1: PAD.left, x2: chartWidth - PAD.right, y1: scaleY(m), y2: scaleY(m),
      stroke: 'var(--line-soft)', 'stroke-width': 1,
    }));
    const label = svgEl('text', {
      x: PAD.left - 8, y: scaleY(m) + 4, 'text-anchor': 'end',
      fill: 'var(--muted)', 'font-size': 11, 'font-family': 'IBM Plex Mono, monospace',
    });
    label.textContent = m >= domain.hi - tickStep + 1 ? `${m} m` : String(m);
    chart.appendChild(label);
  }

  let d = `M ${scaleX(points[0].km)} ${scaleY(points[0].ele)}`;
  for (let i = 1; i < points.length; i += 1) d += ` L ${scaleX(points[i].km)} ${scaleY(points[i].ele)}`;
  chart.appendChild(svgEl('path', {
    d: `${d} L ${scaleX(endKm)} ${plotBottom} L ${scaleX(0)} ${plotBottom} Z`,
    fill: 'var(--ink)', opacity: '.05', stroke: 'none',
  }));
  chart.appendChild(svgEl('path', { d, fill: 'none', stroke: 'var(--accent)', 'stroke-width': 2, 'stroke-linejoin': 'round' }));

  // gradient ribbon, quantised into contiguous runs rather than per sample
  const ribbonY = plotBottom + 8;
  let runStart = 0;
  let runBand = gradientBand(gradientAt(points, 0));
  for (let i = 1; i < points.length; i += 1) {
    const band = gradientBand(gradientAt(points, i));
    const last = i === points.length - 1;
    if (band !== runBand || last) {
      chart.appendChild(svgEl('rect', {
        x: scaleX(points[runStart].km), y: ribbonY,
        width: Math.max(1, scaleX(points[i].km) - scaleX(points[runStart].km)),
        height: RIBBON, fill: BAND_TOKENS[runBand], rx: 1,
      }));
      runStart = i;
      runBand = band;
    }
  }

  const kmStep = domain.km > 14 ? 4 : 2;
  for (let k = 0; k <= domain.km; k += kmStep) {
    const t = svgEl('text', {
      x: scaleX(k), y: ribbonY + RIBBON + 15, 'text-anchor': 'middle',
      fill: 'var(--muted)', 'font-size': 11, 'font-family': 'IBM Plex Mono, monospace',
    });
    t.textContent = k === 0 ? '0 km' : String(k);
    chart.appendChild(t);
  }
  // where this route ends, since all the group's routes share one x domain
  chart.appendChild(svgEl('line', {
    x1: scaleX(endKm), x2: scaleX(endKm), y1: PAD.top, y2: ribbonY + RIBBON,
    stroke: 'var(--accent)', 'stroke-width': 1, 'stroke-dasharray': '2 3', opacity: '.5',
  }));
  const endLabel = svgEl('text', {
    x: scaleX(endKm), y: ribbonY + RIBBON + 15, 'text-anchor': 'middle',
    fill: 'var(--accent)', 'font-size': 11, 'font-weight': 600, 'font-family': 'IBM Plex Mono, monospace',
  });
  endLabel.textContent = endKm.toFixed(1);
  chart.appendChild(endLabel);

  const cursor = svgEl('line', {
    id: 'chartCursor', x1: 0, x2: 0, y1: PAD.top, y2: ribbonY + RIBBON,
    stroke: 'var(--cursor)', 'stroke-width': 1.5, visibility: 'hidden',
  });
  chart.appendChild(cursor);
  const dot = svgEl('circle', {
    id: 'chartDot', r: 5, fill: 'var(--cursor)', stroke: 'var(--surface)', 'stroke-width': 2, visibility: 'hidden',
  });
  chart.appendChild(dot);

  $('chartNote').textContent = 'Plotted from the smoothed series the climb figure is computed from, '
    + `with gradient averaged over ${CONFIG.GRADIENT_WINDOW_M} m before banding. `
    + 'All routes in this search share one scale.';
}

function moveCursor(clientX) {
  const chart = $('chart');
  const points = shownProfile();
  if (!points.length) return;
  const box = chart.getBoundingClientRect();
  const xInView = ((clientX - box.left) / box.width) * chartWidth;
  const endKm = points[points.length - 1].km;
  const km = Math.max(0, Math.min(endKm, ((xInView - PAD.left) / (chartWidth - PAD.left - PAD.right)) * domain.km));

  let index = points.findIndex((p) => p.km >= km);
  if (index < 0) index = points.length - 1;
  const point = points[index];
  const pct = gradientAt(points, index);

  const cursor = chart.querySelector('#chartCursor');
  const dot = chart.querySelector('#chartDot');
  cursor.setAttribute('x1', scaleX(point.km));
  cursor.setAttribute('x2', scaleX(point.km));
  cursor.setAttribute('visibility', 'visible');
  dot.setAttribute('cx', scaleX(point.km));
  dot.setAttribute('cy', scaleY(point.ele));
  dot.setAttribute('visibility', 'visible');

  $('readout').innerHTML = `<span class="num">${point.km.toFixed(2)} km</span> &middot; `
    + `<span class="num">${Math.round(point.ele)} m</span> &middot; `
    + `<span class="num">${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%</span>`;

  if (!map) return;
  if (!routeLayer.cursor) {
    routeLayer.cursor = L.circleMarker([point.lat, point.lon], {
      radius: 7, color: '#FFFFFF', weight: 2.5, fillColor: '#4a3aa7', fillOpacity: 1, interactive: false,
    }).addTo(map);
  } else {
    routeLayer.cursor.setLatLng([point.lat, point.lon]);
  }
}

function hideCursor() {
  const chart = $('chart');
  const cursor = chart.querySelector('#chartCursor');
  const dot = chart.querySelector('#chartDot');
  if (cursor) cursor.setAttribute('visibility', 'hidden');
  if (dot) dot.setAttribute('visibility', 'hidden');
  if (routeLayer.cursor) { map.removeLayer(routeLayer.cursor); routeLayer.cursor = null; }
  $('readout').textContent = 'Drag across the chart';
}

// --- detail ----------------------------------------------------------------
function refreshDetail() {
  const group = groups[selected.group];
  const candidate = group.candidates[selected.route];
  const points = shownProfile();
  $('detailPanel').hidden = false;

  $('detailTitle').textContent = `Route ${selected.route + 1} in detail`;
  $('mDist').textContent = `${(candidate.distanceM / 1000).toFixed(2)} km`;
  $('mDistErr').textContent = `${candidate.distanceErrorM > 0 ? '+' : ''}`
    + `${(candidate.distanceErrorM / 1000).toFixed(2)} km on target`;
  $('mClimb').textContent = `${Math.round(candidate.ascentM)} m`;
  $('mClimbErr').textContent = `${candidate.ascentErrorM > 0 ? '+' : ''}${Math.round(candidate.ascentErrorM)} m on target`;

  const seconds = estimateSeconds(candidate.distanceM, candidate.ascentM, paceSeconds);
  $('timeMetric').hidden = seconds === null;
  if (seconds !== null) {
    $('mTime').textContent = formatDuration(seconds);
    $('mTimeNote').textContent = `flat pace plus ${CONFIG.CLIMB_SECONDS_PER_METRE} s per metre of climb`;
  }

  const badge = $('mBadge');
  badge.className = `badge ${candidate.withinTolerance ? 'good' : 'bad'}`;
  badge.textContent = `${candidate.withinTolerance ? '✓ within' : '! outside'} tolerance`;

  const climb = longestClimb(points);
  const steep = steepestWindow(points, 200);
  const highest = points.reduce((a, p) => Math.max(a, p.ele), -Infinity);

  $('dLongest').textContent = climb.km > 0.05
    ? `${climb.km.toFixed(1)} km at ${((climb.gain / (climb.km * 1000)) * 100).toFixed(1)}%, from ${climb.fromKm.toFixed(1)} km`
    : 'nothing sustained';
  $('dSteepest').textContent = steep.gain > 0
    ? `+${Math.round(steep.gain)} m (${((steep.gain / 200) * 100).toFixed(1)}%), at ${steep.atKm.toFixed(1)} km`
    : '—';
  $('dHigh').textContent = `${Math.round(highest)} m`;
  $('dDrop').textContent = `${Math.round(candidate.descentM)} m`;
  $('dStrategy').textContent = candidate.strategy.replace(/_/g, ' ');
}

// --- terrain overlay -------------------------------------------------------
function refreshTerrainCount() {
  $('terrainCount').textContent = store.size
    ? `${store.size.toLocaleString('en-GB')} terrain points stored`
    : 'terrain store empty';
}

function toggleTerrain(on) {
  if (!map) return;
  if (terrainLayer) { map.removeLayer(terrainLayer); terrainLayer = null; }
  if (!on) return;
  const bounds = map.getBounds();
  const points = store.points().filter((p) => bounds.contains([p[0], p[1]]));
  const stride = Math.max(1, Math.ceil(points.length / 1500));
  const lo = points.reduce((a, p) => Math.min(a, p[2]), Infinity);
  const hi = points.reduce((a, p) => Math.max(a, p[2]), -Infinity);
  terrainLayer = L.layerGroup();
  for (let i = 0; i < points.length; i += stride) {
    const [lat, lon, ele] = points[i];
    const t = (ele - lo) / Math.max(1, hi - lo);
    L.circleMarker([lat, lon], {
      radius: 3, weight: 0, interactive: false,
      fillColor: t > 0.66 ? '#8e2f24' : t > 0.33 ? '#e8a05a' : '#5598e7',
      fillOpacity: 0.55,
    }).addTo(terrainLayer);
  }
  terrainLayer.addTo(map);
  if (!points.length) message('info', 'No terrain samples in view yet. They build up as you search.');
}

// --- geocoding -------------------------------------------------------------
let geocodeTimer = null;
function onPlaceInput(value) {
  clearTimeout(geocodeTimer);
  const results = $('searchResults');
  if (value.trim().length < 2) { results.hidden = true; results.textContent = ''; return; }
  geocodeTimer = setTimeout(async () => {
    try {
      const centre = map ? map.getCenter() : null;
      const hits = await geocode(value, apiKey, {
        focus: centre ? { lat: centre.lat, lon: centre.lng } : start,
      });
      results.textContent = '';
      results.hidden = hits.length === 0;
      hits.forEach((hit) => {
        const row = document.createElement('button');
        row.className = 'result-row';
        row.type = 'button';
        row.innerHTML = `<span class="what">${hit.label}</span><span class="where">${hit.locality}</span>`;
        row.addEventListener('click', () => {
          setStart(hit.lat, hit.lon, hit.label.split(',')[0]);
          if (map) map.setView([hit.lat, hit.lon], Math.max(map.getZoom(), CONFIG.DEFAULT_ZOOM));
          results.hidden = true;
          $('placeSearch').value = '';
          updateSummary();
        });
        results.appendChild(row);
      });
    } catch (err) {
      clearMessages();
      message('error', err.message);
    }
  }, 350);
}

function locateMe() {
  if (!navigator.geolocation) {
    message('error', 'This browser will not share your location.');
    return;
  }
  $('locateBtn').disabled = true;
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      $('locateBtn').disabled = false;
      const { latitude, longitude } = pos.coords;
      setStart(latitude, longitude, 'My location');
      if (map) map.setView([latitude, longitude], Math.max(map.getZoom(), CONFIG.DEFAULT_ZOOM));
      updateSummary();
    },
    (err) => {
      $('locateBtn').disabled = false;
      message('error', err.code === err.PERMISSION_DENIED
        ? 'Location permission refused. Tap the map to set your start instead.'
        : 'Could not get your location. Tap the map to set your start instead.');
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 },
  );
}

// --- events ----------------------------------------------------------------
function wireEvents() {
  $('editSearch').addEventListener('click', function toggle() {
    const panel = $('searchPanel');
    const opening = panel.hidden;
    panel.hidden = !opening;
    this.setAttribute('aria-expanded', String(opening));
    $('editCue').textContent = opening ? 'Close' : 'Edit';
  });

  ['distance', 'climbPreset', 'climbExact', 'shape'].forEach((id) => {
    $(id).addEventListener('input', updateSummary);
    $(id).addEventListener('change', updateSummary);
  });

  $('searchBtn').addEventListener('click', runSearch);
  $('placeSearch').addEventListener('input', (e) => onPlaceInput(e.target.value));
  $('locateBtn').addEventListener('click', locateMe);

  $('reverseBtn').addEventListener('click', function flip() {
    reversed = !reversed;
    this.setAttribute('aria-pressed', String(reversed));
    $('dirPill').textContent = reversed ? 'Reversed' : 'As routed';
    hideCursor();
    drawArrows();
    drawChart();
    refreshDetail();
  });

  $('terrainBtn').addEventListener('click', function terrain() {
    const on = this.getAttribute('aria-pressed') !== 'true';
    this.setAttribute('aria-pressed', String(on));
    this.textContent = on ? 'Hide terrain samples' : 'Show terrain samples';
    toggleTerrain(on);
  });

  $('saveKey').addEventListener('click', () => {
    const value = $('apiKey').value.trim();
    clearMessages();
    if (!value) { message('error', 'Paste your key first.'); return; }
    apiKey = value;
    renderKeyState();
    if (!write(STORAGE.key, value)) {
      message('warn', 'This browser refused to save the key, which happens in Private Browsing. '
        + 'It will work for this session but you will have to paste it again next time.');
      return;
    }
    message('info', 'Key saved in this browser.');
  });

  $('diagnose').addEventListener('click', runDiagnosis);

  $('changeKey').addEventListener('click', () => {
    $('keySaved').hidden = true;
    $('keyEntry').hidden = false;
    $('apiKey').value = '';
    $('apiKey').focus();
  });

  $('removeKey').addEventListener('click', () => {
    apiKey = '';
    write(STORAGE.key, '');
    renderKeyState();
    clearMessages();
    message('warn', 'Key removed from this browser. Searching needs one.');
  });

  $('pace').addEventListener('input', (e) => {
    paceSeconds = parsePace(e.target.value);
    write(STORAGE.pace, e.target.value);
    if (groups.length) { renderCards(); refreshDetail(); }
  });
  $('clearPace').addEventListener('click', () => {
    $('pace').value = '';
    paceSeconds = null;
    write(STORAGE.pace, '');
    if (groups.length) { renderCards(); refreshDetail(); }
  });

  $('clearTerrain').addEventListener('click', () => {
    store.clear();
    refreshTerrainCount();
    clearMessages();
    message('info', 'Terrain store cleared. It rebuilds as you search.');
  });

  const chart = $('chart');
  chart.addEventListener('pointerdown', (e) => { chart.setPointerCapture(e.pointerId); moveCursor(e.clientX); });
  chart.addEventListener('pointermove', (e) => { if (e.buttons || e.pointerType === 'mouse') moveCursor(e.clientX); });
  chart.addEventListener('pointerup', hideCursor);
  chart.addEventListener('pointerleave', hideCursor);
}

boot();
