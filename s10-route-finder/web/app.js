/* UI: map, search form, ranked cards, elevation profile.
 * All search logic lives in routefinder.js; this file only presents it. */
import { APP_VERSION, CONFIG, SHAPE_LOOP, SHAPE_OUT_AND_BACK, STORAGE } from './config.js';
import {
  Candidate, OrsClient, RouteLibrary, TILE_SIZE, TerrainStore, TerrainTiles,
  decodeTerrarium, diagnose, estimateSeconds, formatDuration, geocode, gradientAt,
  gradientBand, insertWaypoint, insertionIndex, longestClimb, moveWaypoint, parsePace,
  profile, readDiagnosis, removeWaypoint, reverseProfile, routeThrough, search,
  steepestWindow, tileUrl,
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

/* What is on screen now. The two modes are separate workspaces that happen to
 * share one set of panels, so this holds whichever one is showing and the
 * other is kept in the stash below. Mixing them, which is what pushing a
 * plotted route into the search results amounted to, meant switching modes
 * left the other mode's work on the map. */
const groups = [];           // newest first: { number, target, candidates, profiles }
const stash = {
  find: { groups: [], selected: { group: 0, route: 0 } },
  plot: { groups: [], selected: { group: 0, route: 0 } },
};
let selected = { group: 0, route: 0 };
let domain = null;           // shared chart scale for the selected group
let activeProfile = [];      // the selected route, in the direction being shown

const routeLayer = { lines: [], hits: [], arrows: null, cursor: null, turn: null };
let terrainLayer = null;

/* Routes you place yourself. Kept apart from the search results because the
 * points you placed have to survive re-routing, which the drawn geometry does
 * not: every edit throws the old line away and asks for a new one. */
const plot = {
  active: false,
  waypoints: [],
  route: null,
  closeLoop: false,
  markers: [],
  line: null,
  hit: null,
  client: null,
  busy: false,
  history: [],
  /* Leaflet can follow a drag with a click on the same marker. Without this the
   * point you just dragged would delete itself. */
  ignoreClicksUntil: 0,
  /* Where the middle of the map was when this pan started, so a jitter can be
   * told from a deliberate move. */
  panFrom: null,
  again: false,
  /* Placing turned off, so the map can be looked around without leaving points
   * behind. Remembered between visits: it is how someone likes to work, not a
   * transient state. */
  locked: false,
};
let rerouteTimer = null;
let library = null;
let tiles = null;
let hills = null;

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
  /* Reading the store is 1.45 MB of JSON to parse. Doing it here put roughly
   * a quarter of a second on a phone in front of the first frame, before the
   * map even existed. It loads once the browser is idle instead, and merges
   * with anything collected in the meantime. */
  store = new TerrainStore({ storage: safeStorage(), deferLoad: true });
  library = new RouteLibrary({ storage: safeStorage() });

  // The controls are wired before the map, so a map failure cannot take the
  // whole interface down with it.
  $('appVersion').textContent = APP_VERSION;
  buildClimbPresets();
  loadSettings();
  wireEvents();
  renderPlotLock();
  updateSummary();
  refreshTerrainCount();
  renderSaved();

  try {
    initMap();
  } catch (err) {
    message('error', `The map could not start: ${err.message}. `
      + 'The rest of the page still works, but routes cannot be drawn. '
      + 'Check that Leaflet loaded, then reload.');
  }

  watchTheme();
  watchSheetPosition();
  positionMapControls();
  whenIdle(() => { store.load(); refreshTerrainCount(); });
  setStart(start.lat, start.lon, read(STORAGE.startName, 'Default start'), { silent: true });

  if (!read(STORAGE.key)) {
    message('warn', 'Add your OpenRouteService key in Settings at the bottom of the page before searching. '
      + 'It stays in this browser and is only ever sent to OpenRouteService.');
  }
  /* On a phone the address bar collapsing during a scroll fires resize, and
   * rebuilding the chart and re-measuring every Leaflet layer on each of those
   * is a lot of work for a scroll. Only a change of width can affect either,
   * and even then not until the resizing stops. */
  let resizeTimer = null;
  let lastWidth = globalThis.innerWidth || 0;
  window.addEventListener('resize', () => {
    if (globalThis.innerWidth === lastWidth) return;
    lastWidth = globalThis.innerWidth;
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resizeTimer = null;
      positionMapControls();
      if (map) map.invalidateSize();
      if (activeProfile.length) drawChart();
    }, 180);
  });
}

/* Map overlays keep literal colours rather than theme tokens: OpenStreetMap
 * tiles are light in both themes, so the marks have to read on a light ground
 * whatever the page around them is doing. */
/* The map graphics are drawn by script, so the stylesheet cannot reach them.
 * They read their colours out of it instead. This matters more than it did:
 * the dark theme inverts the basemap tiles, so a colour chosen for a light map
 * is wrong on a dark one. */
function token(name, fallback) {
  try {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name);
    return (value && value.trim()) || fallback;
  } catch { return fallback; }
}
/* Cached, because these are read inside loops that rebuild every arrow and
 * every waypoint marker, and each read forces a style resolution. They can
 * only change when the theme does, which is where the cache is cleared. */
let themeInk = null;
function readTheme() {
  themeInk = {
    route: token('--route', '#4a5636'),
    dim: token('--route-dim', '#b09c86'),
    end: token('--route-end', '#8f4a22'),
    cursor: token('--cursor', '#4a3aa7'),
  };
  return themeInk;
}
const theme = () => themeInk || readTheme();
const mapInk = () => theme().route;
const mapDim = () => theme().dim;
const mapEnd = () => theme().end;
const cursorInk = () => theme().cursor;

/* A chequered disc, so the point a loop begins and ends at is findable. On a
 * loop the line closes on itself and the start is otherwise invisible. */
function startFinishIcon() {
  return L.divIcon({
    className: 'sf-icon',
    iconSize: [28, 28],
    iconAnchor: [14, 14],
    html: `<svg width="28" height="28" viewBox="-14 -14 28 28" aria-hidden="true">
             <circle r="12" fill="#FFFFFF" stroke="${mapInk()}" stroke-width="2.5"/>
             <g fill="${mapInk()}">
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
             <circle r="10" fill="#FFFFFF" stroke="${mapInk()}" stroke-width="2"/>
             <path d="M -3.5 4 L -3.5 -1 A 3.5 3.5 0 0 1 3.5 -1 L 3.5 3"
                   fill="none" stroke="${mapInk()}" stroke-width="2" stroke-linecap="round"/>
             <path d="M 0.6 2.2 L 3.5 5.2 L 6.4 2.2 Z" fill="${mapInk()}"/>
           </svg>`,
  });
}

/* Switching between the light and dark themes changes every colour the map
 * graphics read, and the dark one inverts the basemap underneath them, so
 * they have to be drawn again rather than left as they were. */
function watchTheme() {
  if (!globalThis.matchMedia) return;
  let query;
  try { query = globalThis.matchMedia('(prefers-color-scheme: dark)'); } catch { return; }
  const redraw = () => {
    readTheme();
    if (!map) return;
    drawRoutes(false);
    drawPlot();
    drawChart();
  };
  if (query.addEventListener) query.addEventListener('change', redraw);
  else if (query.addListener) query.addListener(redraw);
}

function initMap() {
  if (typeof L === 'undefined') {
    throw new Error('the Leaflet mapping library did not load');
  }
  map = L.map('map', { zoomControl: true }).setView([start.lat, start.lon], CONFIG.DEFAULT_ZOOM);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    // The stylesheet washes the basemap warm. It must not catch the hills
    // overlay, which shares this pane, so the wash is hung on this class.
    className: 'basemap',
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
  map.on('click', (e) => {
    if (plot.active) {
      if (plot.locked || Date.now() < plot.ignoreClicksUntil) return;
      addPlotPoint(e.latlng.lat, e.latlng.lng);
      return;
    }
    setStart(e.latlng.lat, e.latlng.lng, 'Map pin');
  });

  /* Aim with the crosshair: drag the ground under it and let go. Only a real
   * pan counts. A zoom is not a pan, and neither is a wobble on the way to a
   * tap, and either dropping a point would cost a routing request to undo. */
  map.on('dragstart', () => {
    plot.panFrom = plot.active && !plot.locked ? aimPoint() : null;
  });
  map.on('dragend', () => {
    if (!plot.active || plot.locked || !plot.panFrom) return;
    const from = plot.panFrom;
    plot.panFrom = null;
    const zoom = map.getZoom();
    const now = aimPoint();
    if (!now) return;
    const moved = map.project(now, zoom).distanceTo(map.project(from, zoom));
    if (moved < CONFIG.PLOT_PAN_THRESHOLD_PX) return;
    plot.ignoreClicksUntil = Date.now() + 400;
    addPlotPoint(now.lat, now.lng);
  });
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
  plot.locked = Boolean(read(STORAGE.plotLock, ''));
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
/* These buttons are an icon plus a hidden label, so their text cannot be set
 * by replacing the whole contents: that would throw the icon away. */
function setToolLabel(button, on, offText, onText) {
  const text = on ? onText : offText;
  button.setAttribute('aria-pressed', String(on));
  button.setAttribute('aria-label', text);
  button.title = text;
  const label = button.querySelector ? button.querySelector('.label') : null;
  if (label) label.textContent = text;
  else button.textContent = text;
}

/* The controls that float over the map have to start below the header, and
 * the header's height is not something to guess at: it changes with the mode,
 * with the safe area inset, and with the text size someone has chosen. */
function positionMapControls() {
  const header = $('findQuery').hidden ? document.querySelector('.topbar') : $('findQuery');
  if (!header || !header.getBoundingClientRect) return;
  const bottom = header.getBoundingClientRect().bottom;
  if (!bottom) return;
  const root = document.documentElement;
  if (root && root.style && root.style.setProperty) {
    root.style.setProperty('--hud-top', `${Math.round(bottom) + 10}px`);
  }
}

function scrollSheet(top) {
  const scroller = document.querySelector('.scroll');
  if (scroller && scroller.scrollTo) scroller.scrollTo({ top, behavior: 'smooth' });
}

/* The controls that float over the map are only useful while the map is what
 * you are looking at. Once the sheet is scrolled up over them they are just
 * something sitting on top of its buttons, so they get out of the way. */
function watchSheetPosition() {
  const scroller = document.querySelector('.scroll');
  if (!scroller || !scroller.addEventListener) return;
  let queued = false;
  const update = () => {
    queued = false;
    const sheet = document.querySelector('.sheet');
    if (!sheet || !sheet.getBoundingClientRect) return;
    const covered = sheet.getBoundingClientRect().top < 300;
    if (document.body && document.body.classList) {
      document.body.classList.toggle('sheet-up', covered);
    }
  };
  scroller.addEventListener('scroll', () => {
    if (queued) return;
    queued = true;
    if (globalThis.requestAnimationFrame) globalThis.requestAnimationFrame(update);
    else update();
  });
  update();
}

function message(kind, text) {
  const div = document.createElement('div');
  div.className = `msg ${kind}`;
  div.textContent = text;
  $('messages').appendChild(div);
}
function clearMessages() { $('messages').textContent = ''; loadingEl = null; }

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
/* A search shows this twice, once for reading the terrain and once for
 * generating routes. Without taking the first one down, two runners animate at
 * the same time. Held as a reference rather than looked up by id, because the
 * element only exists while a search is running. */
let loadingEl = null;
function showLoading(text) {
  if (loadingEl && loadingEl.remove) loadingEl.remove();
  const div = document.createElement('div');
  div.className = 'msg info loading';
  div.id = 'loadingMsg';
  div.setAttribute('role', 'status');
  div.setAttribute('aria-live', 'polite');
  const label = document.createElement('span');
  label.textContent = text;
  div.append(runnerElement(), label);
  $('messages').appendChild(div);
  loadingEl = div;
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

  /* Learn the ground before choosing where to aim. Waypoints go out to roughly
   * a quarter of the target distance, and each is chosen from terrain within a
   * few hundred metres of its ideal point, so that is the area worth knowing.
   * These tiles cost no routing requests and carry no key. */
  showLoading('Reading the shape of the ground around your start\u2026');
  const reach = distanceKm * 1000 * (CONFIG.LOOP_WAYPOINT_FACTOR + CONFIG.TERRAIN_SEARCH_RADIUS_FRACTION);
  const ground = await harvestTerrain(start.lat, start.lon, Math.max(1500, reach));

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
    // Deferred: writing a megabyte and a half of terrain here would stall the
    // moment the results appear, which is the worst moment to stall.
    saveTerrainSoon();
    clearMessages();
    handleResult(result, {
      distanceKm, ascentM: ascent.metres, climbLabel: ascent.label, shape,
    }, client, ground);
  } catch (err) {
    clearMessages();
    message('error', err.message || 'The search failed.');
  } finally {
    setBusy(false);
  }
}

function handleResult(result, target, client, ground = null) {
  searchCount += 1;
  refreshTerrainCount();

  if (ground && ground.failed && !ground.fetched && !ground.skipped) {
    message('warn', 'The elevation tiles would not load, so this search aimed its '
      + 'waypoints using only ground earlier routes had crossed. The climb figures '
      + 'themselves are unaffected: those come from the routing service.');
  }

  if (result.stoppedEarly) message('error', result.stoppedEarly);

  // The same failure repeated once per request is noise, so show it once.
  const counts = new Map();
  result.warnings.forEach((w) => counts.set(w, (counts.get(w) || 0) + 1));
  counts.forEach((count, text) => {
    message('warn', count > 1 ? `${text} (${count} times)` : text);
  });

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

  rememberGroup({
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
/* Every search keeps three routes and their profiles, which is about 0.9 MB.
 * Two of the three places that add a group already dropped the oldest; the
 * search did not, so a long session grew without limit and re-rendered a card
 * and a sparkline for every route ever found. */
function rememberGroup(group) {
  groups.unshift(group);
  while (groups.length > CONFIG.GROUPS_KEPT) groups.pop();
}

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
/* Redraws every panel from whatever is in `groups`, including when that is
 * nothing, which is what switching modes needs. */
function refreshDisplay({ fit = false } = {}) {
  if (!groups.length) {
    selected = { group: 0, route: 0 };
    activeProfile = [];
    domain = null;
    reversed = false;
    $('reverseBtn').setAttribute('aria-pressed', 'false');
    $('dirPill').hidden = true;
    renderCards();
    drawRoutes(false);
    drawPlot();
    drawChart();
    refreshDetail();
    return;
  }
  const gi = Math.min(selected.group, groups.length - 1);
  const ri = Math.min(selected.route, groups[gi].candidates.length - 1);
  selectRoute(gi, ri, { fit });
}

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
  drawPlot();
  drawChart();
  refreshDetail();
}

// --- map -------------------------------------------------------------------
function drawRoutes(fit) {
  if (!map) return;
  /* Everything this layer owns goes, not only the lines. The arrows, the
   * turnaround marker and the chart's cursor are drawn below the early return,
   * so when the display emptied they were never cleared and stayed on the map
   * pointing along a route that was no longer there. */
  routeLayer.lines.forEach((l) => map.removeLayer(l));
  routeLayer.hits.forEach((l) => map.removeLayer(l));
  routeLayer.lines = [];
  routeLayer.hits = [];
  if (routeLayer.arrows) { map.removeLayer(routeLayer.arrows); routeLayer.arrows = null; }
  if (routeLayer.turn) { map.removeLayer(routeLayer.turn); routeLayer.turn = null; }
  if (routeLayer.cursor) { map.removeLayer(routeLayer.cursor); routeLayer.cursor = null; }

  const group = groups[selected.group];
  if (!group) return;

  group.candidates.forEach((c, i) => {
    const latLngs = c.coords.map((p) => [p[1], p[0]]);
    const isSelected = i === selected.route;
    const line = L.polyline(latLngs, {
      color: isSelected ? mapInk() : mapDim(),
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
               <circle r="9" fill="#FFFFFF" stroke="${mapInk()}" stroke-width="1.6"/>
               <path d="M 0 -5 L 4.5 4 L 0 1.6 L -4.5 4 Z" fill="${mapInk()}"/>
             </svg>`,
    });
    L.marker([points[index].lat, points[index].lon], { icon, interactive: false, keyboard: false })
      .addTo(routeLayer.arrows);
  }
}

/* Built once per profile rather than on every call: a single selection asks
 * for it four times and a scrub asks on every pointer move, and each build
 * allocated an object per point. Keyed on the profile itself, so it cannot go
 * stale however the selection changes. */
let reversedOf = null;
let reversedProfile = null;
function shownProfile() {
  if (!reversed) return activeProfile;
  if (reversedOf !== activeProfile) {
    reversedProfile = reverseProfile(activeProfile);
    reversedOf = activeProfile;
  }
  return reversedProfile;
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
  if (!points.length) { chart.textContent = ''; return; }

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
      radius: 7, color: '#FFFFFF', weight: 2.5, fillColor: cursorInk(), fillOpacity: 1, interactive: false,
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
  if (!group || !group.candidates[selected.route]) {
    $('detailPanel').hidden = true;
    $('dirPill').hidden = true;
    return;
  }
  const candidate = group.candidates[selected.route];
  const points = shownProfile();
  $('detailPanel').hidden = false;

  $('detailTitle').textContent = group.plotted
    ? 'Your route in detail'
    : `Route ${selected.route + 1} in detail`;
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
function metresAcrossView() {
  if (!map) return 4000;
  const b = map.getBounds();
  const ne = b.getNorthEast();
  const sw = b.getSouthWest();
  return Math.max(500, haversineMetres(sw.lat, sw.lng, ne.lat, ne.lng));
}

function haversineMetres(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const p = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * p) / 2) ** 2
    + Math.cos(lat1 * p) * Math.cos(lat2 * p) * Math.sin(((lon2 - lon1) * p) / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/* Fetches the shape of the ground around a point into the terrain store, so a
 * search can aim its waypoints at real hills the first time it runs somewhere
 * rather than only at ground earlier routes happened to cross. Never throws:
 * elevation makes a search better, and a search without it still has to run. */
async function harvestTerrain(lat, lon, radiusM) {
  if (!tiles) tiles = new TerrainTiles({ loadTile: loadTileImage });
  try {
    const result = await tiles.harvest(store, lat, lon, radiusM);
    if (result.added) saveTerrainSoon();
    return result;
  } catch {
    return { fetched: 0, added: 0, failed: 1, skipped: 0, truncated: false };
  }
}

/* The store is about a megabyte and a half at its cap, and localStorage writes
 * block the main thread while they serialise it. Doing that the instant a
 * search finishes stalls the very moment the results appear, so it waits for
 * the browser to be idle. A failure still gets reported, just later. */
function whenIdle(run) {
  if (globalThis.requestIdleCallback) globalThis.requestIdleCallback(run, { timeout: 4000 });
  else setTimeout(run, 400);
}

let terrainSaveQueued = false;
function saveTerrainSoon() {
  if (terrainSaveQueued) return;
  terrainSaveQueued = true;
  const run = () => {
    terrainSaveQueued = false;
    if (store.save() === false) {
      message('warn', 'The terrain store could not be saved in this browser, so it will not '
        + 'carry over to your next visit. This happens in Private Browsing or when storage is full.');
    }
    refreshTerrainCount();
  };
  whenIdle(run);
}

function refreshTerrainCount() {
  $('terrainCount').textContent = store.size
    ? `${store.size.toLocaleString('en-GB')} terrain points stored`
    : 'terrain store empty';
}

/* Elevation as a picture of the ground. The scale is sequential, so it is one
 * hue running light to dark: low ground pale, high ground deep. The previous
 * version ran blue to orange to red, which is a diverging scheme doing a
 * sequential job, and read as three categories of hill rather than a slope.
 *
 * Checked for what a sequential ramp is actually judged on, lightness falling
 * monotonically: 0.931 down to 0.319 in OKLab, a span of 0.612. Blue is the
 * documented default for sequential data and is wrong here for a reason the
 * palette cannot know: on a map, blue is water. */
const HILL_RAMP = ['#fbe3d4', '#f5c09f', '#ec9260', '#eb6834', '#c04a1d', '#8a3212', '#561f0a']
  .map((h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]);

function hillColour(t) {
  const x = Math.max(0, Math.min(1, t)) * (HILL_RAMP.length - 1);
  const i = Math.min(HILL_RAMP.length - 2, Math.floor(x));
  const f = x - i;
  const a = HILL_RAMP[i];
  const b = HILL_RAMP[i + 1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

/* The ramp, flattened once into a lookup table. Colouring a tile touches
 * 65,536 pixels, and asking hillColour for each of them returned a fresh
 * three element array every time: a quarter of a million allocations per
 * tile, and a pan pulls a dozen tiles at once. Measured at 2.39 ms a tile
 * against 0.60 ms this way, on a desktop. */
const HILL_LUT = (() => {
  const lut = new Uint8Array(512 * 3);
  for (let i = 0; i < 512; i += 1) {
    const [r, g, b] = hillColour(i / 511);
    lut[i * 3] = r; lut[i * 3 + 1] = g; lut[i * 3 + 2] = b;
  }
  return lut;
})();

/* Decodes one elevation tile into pixels a canvas can read. */
function loadTileImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = TILE_SIZE;
        canvas.height = TILE_SIZE;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, TILE_SIZE, TILE_SIZE);
        resolve(ctx.getImageData(0, 0, TILE_SIZE, TILE_SIZE));
      } catch (err) { reject(err); }
    };
    img.onerror = () => reject(new Error('elevation tile would not load'));
    img.src = url;
  });
}

/* The range the colours are spread over. A fixed range would make flat country
 * one flat wash and hilly country clip, so it follows the ground in view. */
function hillDomain() {
  if (!map || !store.size) return null;
  /* Asks the store for the ground around the middle of the view. It used to
   * decode all eighty thousand cells and hand each one to Leaflet to test
   * against the bounds, which allocated eighty thousand times for an answer
   * the grid index already holds. Measured at 38 ms against 6 ms, for the
   * same numbers, and that is on a desktop. */
  const centre = map.getCenter();
  const near = store.within(centre.lat, centre.lng, metresAcrossView() * 0.75);
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of near) {
    if (p[2] < lo) lo = p[2];
    if (p[2] > hi) hi = p[2];
  }
  if (!Number.isFinite(lo) || hi - lo < 5) return null;
  return { lo, hi };
}

function makeHillsLayer() {
  const Hills = L.GridLayer.extend({
    createTile(coords, done) {
      const canvas = document.createElement('canvas');
      canvas.width = TILE_SIZE;
      canvas.height = TILE_SIZE;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const url = tileUrl(CONFIG.TERRAIN_TILE_URL, coords.z, coords.x, coords.y);
      loadTileImage(url).then((pixels) => {
        const { data } = pixels;
        const domain = hills && hills.domain ? hills.domain : { lo: 0, hi: 500 };
        const span = Math.max(1, domain.hi - domain.lo);
        for (let i = 0; i < data.length; i += 4) {
          const ele = decodeTerrarium(data[i], data[i + 1], data[i + 2]);
          let t = (((ele - domain.lo) / span) * 511) | 0;
          if (t < 0) t = 0; else if (t > 511) t = 511;
          const at = t * 3;
          data[i] = HILL_LUT[at]; data[i + 1] = HILL_LUT[at + 1];
          data[i + 2] = HILL_LUT[at + 2]; data[i + 3] = 150;
        }
        ctx.putImageData(pixels, 0, 0);
        done(null, canvas);
      }).catch((err) => done(err, canvas));
      return canvas;
    },
  });
  return new Hills({
    maxNativeZoom: CONFIG.TERRAIN_TILE_ZOOM,   // above this the data is upsampled
    minZoom: 9,
    attribution: CONFIG.TERRAIN_TILE_ATTRIBUTION,
    pane: 'tilePane',
    zIndex: 250,
  });
}

async function toggleTerrain(on) {
  if (!map) return;
  if (hills) { map.removeLayer(hills); hills = null; }
  if (!on) return;

  const centre = map.getCenter();
  const radius = Math.max(1500, metresAcrossView() / 2);
  const before = store.size;
  const harvested = await harvestTerrain(centre.lat, centre.lng, radius);
  if (harvested && harvested.failed && !harvested.fetched && store.size === before) {
    message('warn', 'The elevation tiles would not load, so the hills cannot be drawn. '
      + 'They come from a free service with no key, which is occasionally unavailable.');
    setToolLabel($('terrainBtn'), false, 'Show hills', 'Hide hills');
    return;
  }

  hills = makeHillsLayer();
  hills.domain = hillDomain() || { lo: 0, hi: 400 };
  /* The harvest above only notices an outage when it actually asks for a tile,
   * and it asks for none it has already read. So the drawing has to speak for
   * itself: without this, a service that went down after a successful search
   * would paint nothing and explain nothing. */
  let warned = false;
  if (hills.on) {
    hills.on('tileerror', () => {
      if (warned) return;
      warned = true;
      message('warn', 'Some elevation tiles would not load, so the hills are patchy '
        + 'or missing. They come from a free service with no key, which is '
        + 'occasionally unavailable. Nothing else is affected.');
    });
  }
  hills.addTo(map);
  refreshTerrainCount();
}


// --- geocoding -------------------------------------------------------------
// --- plotting your own route ----------------------------------------------
/* Where the crosshair actually is, which is no longer the middle of the map:
 * the sheet covers the lower part of the screen, so the crosshair sits higher
 * to stay in the visible strip. Reading its real position keeps the promise
 * that the point lands where you were aiming, wherever the design puts it. */
function aimPoint() {
  if (!map) return null;
  const centre = map.getCenter();
  const marker = $('crosshair');
  const container = map.getContainer ? map.getContainer() : null;
  if (!marker || !container || !container.getBoundingClientRect) return centre;
  try {
    const box = container.getBoundingClientRect();
    const cross = marker.getBoundingClientRect();
    if (!box.width || !cross.width) return centre;
    return map.containerPointToLatLng([
      cross.left + cross.width / 2 - box.left,
      cross.top + cross.height / 2 - box.top,
    ]);
  } catch { return centre; }
}

function plotIcon(index, total) {
  const first = index === 0;
  const last = index === total - 1 && total > 1;
  const fill = first ? mapInk() : (last ? mapEnd() : '#FFFFFF');
  const ink = first || last ? '#FFFFFF' : mapInk();
  const label = first ? 'S' : (last && !plot.closeLoop ? 'F' : String(index + 1));
  return L.divIcon({
    className: '',
    iconSize: [22, 22],
    iconAnchor: [11, 11],
    html: `<svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">`
      + `<circle cx="11" cy="11" r="9" fill="${fill}" stroke="${mapInk()}" stroke-width="2"/>`
      + `<text x="11" y="15" text-anchor="middle" font-size="10" font-weight="700"`
      + ` font-family="system-ui,sans-serif" fill="${ink}">${label}</text></svg>`,
  });
}

function clearPlotLayers() {
  if (!map) return;
  plot.markers.forEach((m) => map.removeLayer(m));
  plot.markers = [];
  if (plot.line) { map.removeLayer(plot.line); plot.line = null; }
  if (plot.hit) { map.removeLayer(plot.hit); plot.hit = null; }
}

function drawPlot() {
  if (!map) return;
  clearPlotLayers();
  // Nothing of a plotted route is drawn outside plot mode. Leaving it behind is
  // what made switching modes feel like the map had not been cleared.
  if (!plot.active) return;

  if (plot.route && plot.route.coords.length) {
    const latLngs = plot.route.coords.map((c) => [c[1], c[0]]);
    plot.line = L.polyline(latLngs, { color: mapInk(), weight: 5, opacity: 0.95 }).addTo(map);
    if (plot.active) {
      plot.hit = L.polyline(latLngs, {
        color: '#000', opacity: 0, weight: 24, className: 'route-hit',
      }).addTo(map);
      plot.hit.on('click', (e) => {
        L.DomEvent.stop(e);
        if (Date.now() < plot.ignoreClicksUntil) return;
        const at = insertionIndex(plot.route, e.latlng.lat, e.latlng.lng);
        pushHistory();
        plot.waypoints = insertWaypoint(plot.waypoints, at, {
          lat: e.latlng.lat, lon: e.latlng.lng,
        });
        scheduleReroute();
      });
    }
  }

  if (!plot.active) return;
  plot.waypoints.forEach((w, i) => {
    const marker = L.marker([w.lat, w.lon], {
      draggable: true, icon: plotIcon(i, plot.waypoints.length), zIndexOffset: 1100,
    }).addTo(map);
    marker.bindTooltip(i === 0 ? 'Your first point. Drag to move, tap to remove.'
      : 'Drag to move, tap to remove.', { direction: 'top', offset: [0, -14] });
    marker.on('dragend', () => {
      const p = marker.getLatLng();
      plot.ignoreClicksUntil = Date.now() + 400;
      pushHistory();
      plot.waypoints = moveWaypoint(plot.waypoints, i, { lat: p.lat, lon: p.lng });
      scheduleReroute();
    });
    marker.on('click', (e) => {
      L.DomEvent.stop(e);
      if (Date.now() < plot.ignoreClicksUntil) return;
      pushHistory();
      plot.waypoints = removeWaypoint(plot.waypoints, i);
      scheduleReroute();
    });
    plot.markers.push(marker);
  });
}

function pushHistory() {
  plot.history.push({
    waypoints: plot.waypoints.map((w) => ({ ...w })),
    closeLoop: plot.closeLoop,
  });
  if (plot.history.length > 30) plot.history.shift();
}

/* Shown three ways, because a mode inside a mode is the easiest thing in an
 * interface to lose track of: the button says which state it is in, the
 * crosshair fades, and a padlock appears inside it. */
function renderPlotLock() {
  const off = plot.locked;
  $('plotLock').setAttribute('aria-pressed', String(off));
  $('plotLockText').textContent = off ? 'Placing off' : 'Placing on';
  $('plotLock').title = off
    ? 'Panning will not place points. Tap to start placing again.'
    : 'Letting go of a pan places a point. Tap to stop that.';
  $('crosshair').classList.toggle('locked', off);
}

function setPlotLock(off) {
  plot.locked = off;
  write(STORAGE.plotLock, off ? '1' : '');
  renderPlotLock();
  renderPlotStats();
}

function plotStatus(text) { $('plotStats').textContent = text; }

function renderPlotStats() {
  const n = plot.waypoints.length;
  if (plot.locked && !plot.busy && !rerouteTimer) {
    const so_far = n >= 2 && plot.route
      ? `${(plot.route.distanceM / 1000).toFixed(2)} km so far. `
      : '';
    plotStatus(`${so_far}Placing is off, so pan and zoom freely. `
      + 'The padlock turns it back on.');
    return;
  }
  if (!n) { plotStatus('Drag the map so the crosshair is where you want to start, then let go.'); return; }
  if (n < 2) { plotStatus('One point placed. Tap again to make a route.'); return; }
  if (plot.busy) { plotStatus(`Working out the route through ${n} points\u2026`); return; }
  if (rerouteTimer) { plotStatus(`${n} points placed\u2026`); return; }
  if (!plot.route) { plotStatus(`${n} points placed.`); return; }
  const km = (plot.route.distanceM / 1000).toFixed(2);
  const up = Math.round(plot.route.ascentM);
  const seconds = estimateSeconds(plot.route.distanceM, plot.route.ascentM, paceSeconds);
  const time = seconds ? `, about ${formatDuration(seconds)}` : '';
  plotStatus(`${km} km, ${up} m of climb${time}`);
  $('plotUndo').disabled = plot.history.length === 0;
}

function plotBudgetText() {
  if (!plot.client) return;
  const spent = plot.client.requestsUsed;
  $('budgetText').textContent = `Plotting: spent ${spent} of ${CONFIG.PLOT_BUDGET} requests`;
  $('quotaFill').style.width = `${Math.round((spent / CONFIG.PLOT_BUDGET) * 100)}%`;
}

/* Points land the instant you release. The request that turns them into a route
 * waits a moment, so three points panned out in quick succession cost one
 * request instead of three. */
function scheduleReroute(delay = CONFIG.PLOT_ROUTE_DEBOUNCE_MS) {
  drawPlot();
  renderPlotStats();
  if (rerouteTimer) clearTimeout(rerouteTimer);
  rerouteTimer = setTimeout(() => { rerouteTimer = null; reroute(); }, delay);
}

async function reroute() {
  drawPlot();
  renderPlotStats();
  if (plot.waypoints.length < 2) {
    plot.route = null;
    drawPlot();
    showPlotAsResult();
    return;
  }
  // A request already out: remember to go round again rather than drop the edit.
  if (plot.busy) { plot.again = true; return; }
  plot.busy = true;
  renderPlotStats();
  try {
    plot.route = await routeThrough(plot.client, plot.waypoints, { closeLoop: plot.closeLoop });
    clearMessages();
  } catch (err) {
    message('error', err.message);
  } finally {
    plot.busy = false;
    plotBudgetText();
    drawPlot();
    renderPlotStats();
    showPlotAsResult();
    if (plot.again) { plot.again = false; reroute(); }
  }
}

/* A plotted route is shown through the same machinery as a searched one, so the
 * elevation profile, the gradient colouring and the climb statistics all work
 * without a second implementation. */
function showPlotAsResult() {
  if (!plot.route) return;
  const targetDistanceM = Number($('distance').value) * 1000;
  const target = {
    distanceKm: Number($('distance').value),
    ascentM: targetAscentM(Number($('distance').value)),
  };
  const candidate = new Candidate({
    coords: plot.route.coords,
    distanceM: plot.route.distanceM,
    targetDistanceM,
    targetAscentM: target.ascentM,
    strategy: 'plotted by hand',
    shape: 'plotted',
  });
  // Replaces rather than accumulates: there is one route being drawn, and every
  // edit is the same route again, not another candidate to compare against.
  groups.length = 0;
  groups.push({
    number: 0,
    target,
    plotted: true,
    candidates: [candidate],
    profiles: [profile(candidate.coords, candidate.distanceM)],
  });
  selected = { group: 0, route: 0 };
  selectRoute(0, 0, { fit: false });
}

function addPlotPoint(lat, lon) {
  pushHistory();
  plot.waypoints = insertWaypoint(plot.waypoints, plot.waypoints.length, { lat, lon });
  scheduleReroute();
}

function setPlotMode(on) {
  if (plot.active === on) return;

  /* Each mode keeps its own workspace. Leaving one puts its routes away;
   * arriving at the other takes its routes back out, so searching, plotting,
   * and going back to your search results loses nothing. */
  const leaving = plot.active ? 'plot' : 'find';
  const arriving = on ? 'plot' : 'find';
  stash[leaving].groups = groups.slice();
  stash[leaving].selected = { ...selected };

  plot.active = on;
  $('modeFind').setAttribute('aria-pressed', String(!on));
  $('modePlot').setAttribute('aria-pressed', String(on));
  $('modeFind').classList.toggle('on', !on);
  $('modePlot').classList.toggle('on', on);
  // The targets only govern a search, so they go away when nothing is searching.
  $('findQuery').hidden = on;
  $('resultsPanel').hidden = on;
  if (on) { $('searchPanel').hidden = true; $('editSearch').setAttribute('aria-expanded', 'false'); }
  $('plotBar').hidden = !on;
  $('crosshair').hidden = !on;
  $('plotLock').hidden = !on;
  renderPlotLock();
  if (startMarker) {
    if (on) map.removeLayer(startMarker);
    else startMarker.addTo(map);
  }
  if (on) {
    if (!plot.client) plot.client = new OrsClient({ apiKey, budget: CONFIG.PLOT_BUDGET });
    if (!apiKey) message('error', 'Plotting needs your OpenRouteService key. Add one in Settings.');
    plotBudgetText();
  } else {
    $('budgetText').textContent = 'Tap the map to set your start';
    $('quotaFill').style.width = '0';
  }
  groups.length = 0;
  groups.push(...stash[arriving].groups);
  selected = { ...stash[arriving].selected };

  // Any in-flight edit belongs to the mode being left.
  if (rerouteTimer) { clearTimeout(rerouteTimer); rerouteTimer = null; }

  // Bring the restored routes back into view: they may be somewhere else entirely.
  positionMapControls();
  refreshDisplay({ fit: groups.length > 0 });
  renderPlotStats();
}

function clearPlot() {
  pushHistory();
  plot.waypoints = [];
  plot.route = null;
  drawPlot();
  renderPlotStats();
}

function undoPlot() {
  const last = plot.history.pop();
  if (!last) return;
  plot.waypoints = last.waypoints;
  plot.closeLoop = last.closeLoop;
  $('plotLoop').setAttribute('aria-pressed', String(plot.closeLoop));
  scheduleReroute();
}

// --- saved routes ----------------------------------------------------------
function currentRouteForSaving() {
  if (plot.active && plot.route) {
    return {
      coords: plot.route.coords,
      distanceM: plot.route.distanceM,
      ascentM: plot.route.ascentM,
      descentM: plot.route.descentM,
      closeLoop: plot.closeLoop,
      waypoints: plot.waypoints,
    };
  }
  const group = groups[selected.group];
  if (!group) return null;
  const candidate = group.candidates[selected.route];
  if (!candidate) return null;
  return {
    coords: candidate.coords,
    distanceM: candidate.distanceM,
    ascentM: candidate.ascentM,
    descentM: candidate.descentM,
    closeLoop: candidate.shape === SHAPE_LOOP,
    waypoints: [],
  };
}

function renderSaved() {
  const host = $('savedList');
  const rows = library ? library.list() : [];
  host.textContent = '';
  $('savedEmpty').hidden = rows.length > 0;
  $('savedCount').textContent = rows.length
    ? `${rows.length} of ${CONFIG.SAVED_ROUTES_LIMIT}` : '';

  rows.forEach((r) => {
    const row = document.createElement('div');
    row.className = 'saved-row';

    const what = document.createElement('span');
    what.className = 'what';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = r.name;
    const meta = document.createElement('span');
    meta.className = 'meta';
    const when = new Date(r.savedAt);
    const km = (r.distanceM / 1000).toFixed(2);
    meta.textContent = `${km} km, ${r.ascentM} m climb`
      + `${r.plotted ? ', plotted by hand' : ''}`
      + ` \u00b7 ${Number.isNaN(when.getTime()) ? '' : when.toLocaleDateString()}`;
    what.appendChild(name);
    what.appendChild(meta);
    row.appendChild(what);

    const acts = document.createElement('span');
    acts.className = 'acts';
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'small';
    open.textContent = 'Open';
    open.addEventListener('click', () => openSaved(r.id));
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'small';
    del.textContent = 'Delete';
    del.addEventListener('click', () => deleteSaved(r.id, r.name));
    acts.appendChild(open);
    acts.appendChild(del);
    row.appendChild(acts);

    host.appendChild(row);
  });
}

function saveCurrentRoute() {
  clearMessages();
  const route = currentRouteForSaving();
  if (!route) {
    message('error', 'There is no route on screen to save yet.');
    return;
  }
  const typed = $('routeName').value.trim();
  const name = typed || `${(route.distanceM / 1000).toFixed(1)} km, ${Math.round(route.ascentM)} m`;
  const result = library.save(route, name);
  if (!result.ok) { message('error', result.reason); return; }
  $('routeName').value = '';
  renderSaved();
  message('info', result.replaced ? `Replaced "${name}".` : `Saved as "${name}".`);
}

function openSaved(id) {
  const saved = library.get(id);
  if (!saved) { message('error', 'That route could not be read back.'); return; }
  clearMessages();

  if (saved.waypoints.length) {
    // It was plotted, so it can go back to being editable.
    if (!plot.active) setPlotMode(true);
    plot.waypoints = saved.waypoints;
    plot.closeLoop = saved.closeLoop;
    $('plotLoop').setAttribute('aria-pressed', String(plot.closeLoop));
    plot.route = {
      coords: saved.coords,
      distanceM: saved.distanceM,
      ascentM: saved.ascentM,
      descentM: saved.descentM,
      wayPoints: [],
      waypoints: saved.waypoints,
      closeLoop: saved.closeLoop,
    };
    plot.history = [];
    drawPlot();
    renderPlotStats();
    showPlotAsResult();
    message('info', `"${saved.name}" opened for editing. Drag its points to change it.`);
  } else {
    if (plot.active) setPlotMode(false);
    const candidate = new Candidate({
      coords: saved.coords,
      distanceM: saved.distanceM,
      targetDistanceM: saved.distanceM,
      targetAscentM: saved.ascentM || 1,
      strategy: `saved as "${saved.name}"`,
      shape: saved.closeLoop ? SHAPE_LOOP : 'saved',
    });
    rememberGroup({
      number: 0,
      target: { distanceKm: saved.distanceM / 1000, ascentM: saved.ascentM },
      candidates: [candidate],
      profiles: [profile(candidate.coords, candidate.distanceM)],
    });
    selectRoute(0, 0, { fit: true });
    message('info', `"${saved.name}" opened.`);
  }

  if (map && plot.line) map.fitBounds(plot.line.getBounds(), { padding: [28, 28] });
}

function deleteSaved(id, name) {
  const result = library.remove(id);
  clearMessages();
  if (!result.ok) { message('error', result.reason); return; }
  renderSaved();
  message('info', `Deleted "${name}".`);
}

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
    setToolLabel(this, on, 'Show hills', 'Hide hills');
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

  $('modeFind').addEventListener('click', () => setPlotMode(false));
  $('modePlot').addEventListener('click', () => setPlotMode(true));
  $('plotDone').addEventListener('click', () => setPlotMode(false));
  $('plotClear').addEventListener('click', clearPlot);
  $('plotUndo').addEventListener('click', undoPlot);
  $('plotLoop').addEventListener('click', function toggleLoop() {
    pushHistory();
    plot.closeLoop = !plot.closeLoop;
    this.setAttribute('aria-pressed', String(plot.closeLoop));
    scheduleReroute();
  });
  $('plotLock').addEventListener('click', () => setPlotLock(!plot.locked));

  /* A toggle, not a one-way trip. Opening settings scrolls the page to the
   * bottom, and without a way back the same button appeared to do nothing on
   * a second press while the rest of the app was off-screen. */
  $('settingsJump').addEventListener('click', () => {
    const panel = $('settingsPanel');
    const opening = !panel.open;
    panel.open = opening;
    $('settingsJump').setAttribute('aria-expanded', String(opening));
    scrollSheet(opening ? 1e6 : 0);
  });
  $('saveRouteBtn').addEventListener('click', saveCurrentRoute);
  $('routeName').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveCurrentRoute();
  });
  $('mapSizeBtn').addEventListener('click', function toggleMapSize() {
    const panel = document.querySelector('.map-panel');
    const compact = !panel.classList.contains('compact');
    panel.classList.toggle('compact', compact);
    setToolLabel(this, compact, 'Shrink map', 'Grow map');
    // Leaflet caches the size of its box, so it has to be told it changed.
    if (map) setTimeout(() => map.invalidateSize(), 200);
  });

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

  /* Capturing a touch pointer hands the whole gesture to the chart, which
   * overrides touch-action and stops the page scrolling under a finger. Once a
   * route is plotted the chart fills most of the sheet, so that is exactly
   * where a thumb lands and the page would not move. A mouse or pen drag has
   * no other meaning here, so those are still captured; a finger is left to
   * the scroller, and touch-action: pan-y lets it scrub across and scroll
   * down. */
  const chart = $('chart');
  chart.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch' && chart.setPointerCapture) chart.setPointerCapture(e.pointerId);
    moveCursor(e.clientX);
  });
  chart.addEventListener('pointermove', (e) => {
    if (e.buttons || e.pointerType === 'mouse') moveCursor(e.clientX);
  });
  chart.addEventListener('pointerup', hideCursor);
  chart.addEventListener('pointerleave', hideCursor);
  // The browser sends this when it takes the gesture over for scrolling.
  chart.addEventListener('pointercancel', hideCursor);
}

boot();
