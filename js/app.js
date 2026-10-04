import { BleManager } from './ble.js';
import { AntManager } from './ant.js';
import { DemoManager } from './demo.js';
import { RelayHub, RelayViewer, randomRoom, normalizeRoom, loadScript } from './relay.js';
import {
  ZONES, zoneOf, zoneColor, intensityOf, maxHrOf, rmssd, kcalPerMinute, formatDuration, formatPace,
} from './metrics.js';
import { drawSparkline, drawHrChart } from './chart.js';
import { exportCsv, exportTcx } from './export.js';

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const STALE_MS = 5000;
const LIVE_KEEP_MS = 60 * 60 * 1000;
const SOURCE_LABEL = { ble: 'BT', ant: 'ANT+', demo: 'DEMO' };
const RELAY_PREFIX = 'r:';

/* ------------------------------------------------------------------ */
/* persistence                                                          */
/* ------------------------------------------------------------------ */

const store = {
  load(key, fallback) {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
    catch { return fallback; }
  },
  save(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
  },
};

/* ------------------------------------------------------------------ */
/* state                                                                */
/* ------------------------------------------------------------------ */

const state = {
  /** @type {{id:string,name:string,age?:number,sex?:'m'|'f',weight?:number,maxHr?:number,restHr?:number,sensorIds:string[]}[]} */
  athletes: store.load('coach.athletes', []),
  /** athletes configured on the phone we receive data from (read-only here) */
  remoteAthletes: [],
  sensorNames: store.load('coach.sensorNames', {}),
  options: {
    sort: 'name', onlyAssigned: false, sound: false, size: 'm', theme: 'auto', alert: 0.95,
    ...store.load('coach.options', {}),
  },
  share: { room: randomRoom(), password: '', active: false, ...store.load('coach.share', {}) },
  viewer: { room: '', password: '', remember: true, ...store.load('coach.viewer', {}) },
  sensors: new Map(),       // sensorId -> sensor
  participants: new Map(),  // tile key -> participant
  hidden: new Set(),
  session: { state: 'idle', startedAt: 0, elapsedMs: 0, resumedAt: 0, laps: [] },
  selected: null,
  detailWindow: 900,
};

const saveOptions = () => store.save('coach.options', state.options);
const saveShare = () => store.save('coach.share', state.share);
function saveAthletes() {
  store.save('coach.athletes', state.athletes);
  hub.athletesChanged();
}

function allAthletes() {
  return [...state.athletes, ...state.remoteAthletes];
}
function athleteOfSensor(sensorId) {
  // local assignment wins over the one coming from the phone
  return state.athletes.find((a) => a.sensorIds?.includes(sensorId))
    || state.remoteAthletes.find((a) => a.sensorIds.includes(sensorId))
    || null;
}
function keyOf(sensorId) {
  const a = athleteOfSensor(sensorId);
  return a ? `ath:${a.id}` : `sen:${sensorId}`;
}
function athleteOfKey(key) {
  return key.startsWith('ath:') ? allAthletes().find((a) => `ath:${a.id}` === key) || null : null;
}
function sensorsOfKey(key) {
  return [...state.sensors.values()].filter((s) => !state.hidden.has(s.id) && keyOf(s.id) === key);
}
function participant(key) {
  let p = state.participants.get(key);
  if (!p) {
    p = { key, rr: [], rrAt: 0, live: [], sess: null, lastAlert: 0 };
    state.participants.set(key, p);
  }
  if (state.session.state !== 'idle' && !p.sess) p.sess = newSess();
  return p;
}
function labelOf(key) {
  const a = athleteOfKey(key);
  if (a) return a.name || 'Bez mena';
  return sensorLabel(key.slice(4));
}
function sensorLabel(id) {
  return state.sensors.get(id)?.name || state.sensorNames[id] || id;
}

/** Latest fresh values of a participant, merged across its sensors. */
function liveValues(key, now = Date.now()) {
  const out = {};
  for (const s of sensorsOfKey(key)) {
    for (const k of ['hr', 'speed', 'cadence', 'power']) {
      if (s.values[k] != null && now - s.at[k] < STALE_MS && (out[k] == null || s.at[k] > out[`${k}At`])) {
        out[k] = s.values[k];
        out[`${k}At`] = s.at[k];
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* sensor updates                                                       */
/* ------------------------------------------------------------------ */

/** Updates from sensors attached to THIS device – also forwarded to PCs. */
function onLocalUpdate(u) {
  if (u.id === 'ant:stick') { renderSources(); if (u.status === 'disconnected') dropSensors((s) => s.source === 'ant'); return; }
  hub.update(u);
  applyUpdate(u);
}

/** Updates received from a phone. */
function onRelayUpdate(u) {
  if (!u || typeof u.id !== 'string' || u.id === 'ant:stick') return;
  applyUpdate({ ...u, id: RELAY_PREFIX + u.id, relay: true });
}

function applyUpdate(u) {
  let s = state.sensors.get(u.id);
  if (!s) {
    if (u.status === 'disconnected') return;
    s = { id: u.id, source: u.source, relay: !!u.relay, name: u.name || u.id, status: 'connected', values: {}, at: {}, lastSeen: 0 };
    state.sensors.set(u.id, s);
    updateWakeLock();
  }
  if (typeof u.name === 'string' && u.name) {
    s.name = u.name;
    if (state.sensorNames[u.id] !== u.name) {
      state.sensorNames[u.id] = u.name;
      store.save('coach.sensorNames', state.sensorNames);
    }
  }
  for (const k of ['manufacturer', 'model', 'battery', 'batteryStatus', 'rssi']) if (u[k] != null) s[k] = u[k];

  if (u.status) {
    s.status = u.status;
    if (u.status === 'disconnected') {
      state.sensors.delete(u.id);
      scheduleRender();
      return;
    }
    if (!s.relay && u.status === 'reconnecting') toast(`${s.name}: spojenie stratené, pripájam znova…`);
    if (!s.relay && u.status === 'error') toast(`${s.name}: ${u.error}`, true);
  }

  const now = Date.now();
  let gotData = false;
  for (const k of ['hr', 'speed', 'cadence', 'power']) {
    if (typeof u[k] === 'number' && Number.isFinite(u[k])) { s.values[k] = u[k]; s.at[k] = now; gotData = true; }
  }
  if (gotData) {
    s.lastSeen = now;
    if (s.status !== 'error') s.status = 'connected';
  }
  if (Array.isArray(u.rr) && u.rr.length) {
    const p = participant(keyOf(u.id));
    p.rr.push(...u.rr.filter((x) => typeof x === 'number'));
    if (p.rr.length > 300) p.rr.splice(0, p.rr.length - 300);
    p.rrAt = now;
  }
  scheduleRender();
}

function dropSensors(pred) {
  for (const s of [...state.sensors.values()]) if (pred(s)) state.sensors.delete(s.id);
  scheduleRender();
}

/** What a newly connected PC needs to see right away. */
function snapshot() {
  return [...state.sensors.values()].filter((s) => !s.relay).map((s) => ({
    id: s.id, source: s.source, name: s.name, status: s.status, battery: s.battery,
    batteryStatus: s.batteryStatus, manufacturer: s.manufacturer, model: s.model,
  }));
}

const ble = new BleManager(onLocalUpdate);
const ant = new AntManager(onLocalUpdate, (msg) => toast(msg));
const demo = new DemoManager(onLocalUpdate);

const hub = new RelayHub({
  snapshot,
  athletes: () => state.athletes.map(({ id, name, age, sex, weight, maxHr, restHr, sensorIds }) => ({
    id, name, age, sex, weight, maxHr, restHr, sensorIds: (sensorIds || []).filter((x) => !x.startsWith(RELAY_PREFIX)),
  })),
  onChange: () => { renderSources(); renderShare(); },
  onLog: (msg, err) => toast(msg, err),
});

let lastViewerStatus = 'off';
const viewer = new RelayViewer({
  onUpdate: onRelayUpdate,
  onAthletes: (list) => {
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
    state.remoteAthletes = (Array.isArray(list) ? list : []).slice(0, 200).map((a) => ({
      id: `r-${String(a.id)}`,
      name: String(a.name || ''),
      age: num(a.age), weight: num(a.weight), maxHr: num(a.maxHr), restHr: num(a.restHr),
      sex: a.sex === 'f' ? 'f' : 'm',
      sensorIds: (Array.isArray(a.sensorIds) ? a.sensorIds : []).map((x) => RELAY_PREFIX + x),
      remote: true,
    }));
    render(true);
  },
  onChange: (info) => {
    if (info.status === 'off') {
      dropSensors((s) => s.relay);
      state.remoteAthletes = [];
    }
    const live = (x) => x === 'online' || x === 'relay';
    if (live(info.status) && !live(lastViewerStatus)) setTimeout(() => { if ($('#connect-dialog').open) $('#connect-dialog').close(); }, 1200);
    if (info.status === 'online' && lastViewerStatus !== 'online') toast(`Pripojené k mobilu ${info.room}`);
    if (info.status === 'relay' && lastViewerStatus !== 'relay') toast(`Pripojené k mobilu ${info.room} cez záložný server`);
    lastViewerStatus = info.status;
    if (info.error) {
      showViewerError(info.error);
      if (info.denied) { state.viewer.password = ''; store.save('coach.viewer', state.viewer); }
    }
    renderSources();
    renderViewerForm();
  },
});

/* ------------------------------------------------------------------ */
/* session                                                              */
/* ------------------------------------------------------------------ */

function newSess() {
  return { samples: [], zoneSec: [0, 0, 0, 0, 0, 0], kcal: 0, hrSum: 0, hrN: 0, max: 0, distance: 0 };
}

function elapsedMs(now = Date.now()) {
  const s = state.session;
  return s.elapsedMs + (s.state === 'running' ? now - s.resumedAt : 0);
}

function startOrPause() {
  const s = state.session;
  const now = Date.now();
  if (s.state === 'idle') {
    Object.assign(s, { state: 'running', startedAt: now, elapsedMs: 0, resumedAt: now, laps: [] });
    for (const p of state.participants.values()) p.sess = newSess();
    for (const key of visibleKeys()) participant(key);
    toast('Tréning spustený');
  } else if (s.state === 'running') {
    s.elapsedMs = elapsedMs(now);
    s.state = 'paused';
  } else {
    s.resumedAt = now;
    s.state = 'running';
  }
  renderSession();
  updateWakeLock();
}

function lap() {
  const s = state.session;
  if (s.state === 'idle') return;
  s.laps.push({ at: Date.now(), elapsed: elapsedMs() });
  toast(`Kolo ${s.laps.length + 1}`);
  renderSession();
}

function stop() {
  const s = state.session;
  if (s.state === 'idle') return;
  if (!confirm('Ukončiť tréning a zobraziť súhrn?')) return;
  const endedAt = Date.now();
  const duration = elapsedMs(endedAt);
  const records = [];
  for (const p of state.participants.values()) {
    if (!p.sess || !p.sess.samples.length) { p.sess = null; continue; }
    records.push({
      key: p.key,
      label: labelOf(p.key),
      samples: p.sess.samples,
      zoneSec: p.sess.zoneSec,
      kcal: p.sess.kcal,
      avg: p.sess.hrN ? Math.round(p.sess.hrSum / p.sess.hrN) : null,
      max: p.sess.max || null,
      distance: p.sess.distance,
      duration: p.sess.samples.length,
    });
    p.sess = null;
  }
  const summary = { startedAt: s.startedAt, endedAt, duration, laps: s.laps.slice(), records };
  Object.assign(s, { state: 'idle', startedAt: 0, elapsedMs: 0, resumedAt: 0, laps: [] });
  renderSession();
  updateWakeLock();
  showSummary(summary);
}

/** Runs once per second: sample every participant, accumulate session stats. */
function tick() {
  const now = Date.now();
  const running = state.session.state === 'running';
  // ANT+ scanning picks up every strap nearby – forget unassigned ones that went away.
  for (const s of [...state.sensors.values()]) {
    if (s.source === 'ant' && now - s.lastSeen > 60000 && !athleteOfSensor(s.id)) state.sensors.delete(s.id);
  }
  for (const key of visibleKeys()) {
    const v = liveValues(key, now);
    if (v.hr == null && v.speed == null && v.power == null) continue;
    const p = participant(key);
    const sample = { t: now, hr: v.hr ?? null, speed: v.speed ?? null, cadence: v.cadence ?? null, power: v.power ?? null };
    p.live.push(sample);
    while (p.live.length && now - p.live[0].t > LIVE_KEEP_MS) p.live.shift();

    if (running && p.sess) {
      const ss = p.sess;
      const athlete = athleteOfKey(key);
      if (sample.speed != null) ss.distance += sample.speed;
      ss.samples.push({ ...sample, distance: sample.speed != null || ss.distance ? ss.distance : null });
      if (sample.hr) {
        ss.zoneSec[zoneOf(sample.hr, athlete)]++;
        ss.hrSum += sample.hr;
        ss.hrN++;
        ss.max = Math.max(ss.max, sample.hr);
        ss.kcal += kcalPerMinute(sample.hr, athlete) / 60;
      }
    }
  }
  renderSessionTime();
  render(true);
}

/* ------------------------------------------------------------------ */
/* rendering                                                            */
/* ------------------------------------------------------------------ */

const grid = $('#grid');
const tiles = new Map(); // key -> element
let renderTimer = null;

function scheduleRender() {
  if (renderTimer) return;
  renderTimer = setTimeout(() => { renderTimer = null; render(false); }, 200);
}

function visibleKeys() {
  const keys = new Set();
  for (const s of state.sensors.values()) {
    if (state.hidden.has(s.id)) continue;
    const key = keyOf(s.id);
    if (state.options.onlyAssigned && !key.startsWith('ath:')) continue;
    keys.add(key);
  }
  if (state.session.state !== 'idle') {
    for (const p of state.participants.values()) if (p.sess?.samples.length) keys.add(p.key);
  }
  return [...keys];
}

function sortedKeys() {
  const now = Date.now();
  const keys = visibleKeys();
  const sort = state.options.sort;
  const name = (k) => labelOf(k).toLocaleLowerCase('sk');
  return keys.sort((a, b) => {
    if (sort === 'hr') return (liveValues(b, now).hr || 0) - (liveValues(a, now).hr || 0);
    if (sort === 'zone') {
      const ia = intensityOf(liveValues(a, now).hr || 0, athleteOfKey(a));
      const ib = intensityOf(liveValues(b, now).hr || 0, athleteOfKey(b));
      return ib - ia;
    }
    return name(a).localeCompare(name(b), 'sk');
  });
}

function render(redrawCharts) {
  const now = Date.now();
  const keys = sortedKeys();

  for (const [key, el] of tiles) {
    if (!keys.includes(key)) { el.remove(); tiles.delete(key); }
  }
  keys.forEach((key, i) => {
    let el = tiles.get(key);
    const fresh = !el;
    if (!el) {
      el = $('#tile-tpl').content.firstElementChild.cloneNode(true);
      el.addEventListener('click', () => openDrawer(el.dataset.key));
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter') openDrawer(el.dataset.key); });
      $('.ibar', el).innerHTML = ZONES.map((z) => `<i style="background:${z.color}"></i>`).join('') + '<b hidden></b>';
      tiles.set(key, el);
    }
    el.dataset.key = key;
    if (grid.children[i] !== el) grid.insertBefore(el, grid.children[i] || null);
    updateTile(el, key, now, redrawCharts || fresh);
  });

  $('#empty').hidden = keys.length > 0 || state.sensors.size > 0;
  $('.toolbar').hidden = !$('#empty').hidden;
  const n = state.sensors.size;
  $('#count').textContent = n === 0
    ? 'Žiadne senzory'
    : `${keys.length} ${plural(keys.length, 'športovec', 'športovci', 'športovcov')}`;

  if (state.selected) renderDrawer(redrawCharts);
}

function plural(n, one, few, many) {
  return n === 1 ? one : n >= 2 && n <= 4 ? few : many;
}

/** Position of the intensity marker on the 50–100 % bar. */
function intensityBar(el, intensity) {
  const marker = $('b', el);
  const cells = $$('i', el);
  if (intensity == null) {
    marker.hidden = true;
    cells.forEach((c) => c.classList.remove('on'));
    return;
  }
  const pos = Math.min(1, Math.max(0, (intensity - 0.5) / 0.5));
  marker.hidden = false;
  marker.style.left = `${pos * 100}%`;
  cells.forEach((c, i) => c.classList.toggle('on', intensity >= ZONES[i].from));
}

function setHeart(svg, hr) {
  if (hr) {
    svg.classList.add('beating');
    svg.style.animationDuration = `${(60 / hr).toFixed(3)}s`;
  } else {
    svg.classList.remove('beating');
  }
}

function sourceBadge(sensors) {
  const sources = [...new Set(sensors.map((s) => s.source))];
  const relay = sensors.some((s) => s.relay);
  const text = sources.map((s) => SOURCE_LABEL[s] || s).join(' + ') || '—';
  return { text: relay ? `${text} · mobil` : text, cls: relay ? 'relay' : sources[0] || '' };
}

function updateTile(el, key, now, redraw) {
  const athlete = athleteOfKey(key);
  const sensors = sensorsOfKey(key);
  const v = liveValues(key, now);
  const p = state.participants.get(key);
  const hr = v.hr;
  const zone = zoneOf(hr, athlete);
  const intensity = hr ? intensityOf(hr, athlete) : null;

  el.style.setProperty('--zc', zoneColor(zone));
  $('.tile-name', el).textContent = labelOf(key);
  $('.hr-val', el).textContent = hr ?? '–';
  $('.pct-val', el).textContent = intensity != null ? `${Math.round(intensity * 100)} %` : '';
  $('.zone-name', el).textContent = zone ? ZONES[zone - 1].name : hr ? 'pod Z1' : '';
  setHeart($('.heart', el), hr);
  intensityBar($('.ibar', el), intensity);

  const badge = $('.src', el);
  const b = sourceBadge(sensors);
  badge.textContent = b.text;
  badge.className = `badge src ${b.cls}`;

  const batteries = sensors.map((s) => s.battery).filter((x) => x != null);
  const bat = $('.battery', el);
  bat.hidden = !batteries.length;
  if (batteries.length) {
    const min = Math.min(...batteries);
    bat.textContent = `${min} %`;
    bat.title = 'Batéria senzora';
    bat.classList.toggle('low', min <= 20);
  }

  const connecting = sensors.some((s) => s.status === 'connecting' || s.status === 'reconnecting');
  const stale = hr == null && v.speed == null && v.power == null;
  const dot = $('.dot', el);
  dot.className = `dot ${connecting ? 'wait' : stale ? 'off' : 'live'}`;
  dot.title = connecting ? 'Pripája sa…' : stale ? 'Bez signálu' : 'Live';
  el.classList.toggle('stale', stale && !connecting);

  const alert = intensity != null && intensity >= state.options.alert;
  el.classList.toggle('alert', alert);
  if (alert && p && state.options.sound && now - p.lastAlert > 4000) { p.lastAlert = now; beep(); }

  // stats
  const stats = [];
  const recentRr = p && now - p.rrAt < STALE_MS ? p.rr.slice(-30) : null;
  const hrv = recentRr ? rmssd(recentRr) : null;
  if (hrv != null) stats.push(['HRV', `${hrv}`]);
  if (p?.sess?.hrN) {
    stats.push(['Ø tep', Math.round(p.sess.hrSum / p.sess.hrN)]);
    stats.push(['Max', p.sess.max]);
    stats.push(['kcal', Math.round(p.sess.kcal)]);
  }
  if (v.speed != null) stats.push(['Tempo', formatPace(v.speed)]);
  if (v.cadence != null) stats.push([v.power != null ? 'rpm' : 'krok/min', v.cadence]);
  if (v.power != null) stats.push(['Watt', v.power]);
  if (p?.sess?.distance) stats.push(['km', (p.sess.distance / 1000).toFixed(2)]);
  $('.tile-stats', el).innerHTML = stats.map(([l, val]) => `<div class="stat"><b>${val}</b><span>${l}</span></div>`).join('');

  const zb = $('.zonebar', el);
  zb.hidden = !p?.sess?.hrN;
  if (p?.sess?.hrN) zb.innerHTML = zoneBarHtml(p.sess.zoneSec);

  if (redraw && p && state.options.size !== 's') drawSparkline($('.spark', el), p.live, athlete);
}

function zoneBarHtml(zoneSec) {
  const total = zoneSec.reduce((a, b) => a + b, 0) || 1;
  return zoneSec.map((sec, z) => (sec ? `<i style="width:${(sec / total) * 100}%;background:${zoneColor(z)}" title="${z ? ZONES[z - 1].name : 'pod Z1'}: ${formatDuration(sec)}"></i>` : '')).join('');
}

/* ---------- sources: chips + connect options ---------- */

function sourceOptions() {
  const bleOk = BleManager.isSupported();
  const usbOk = AntManager.isSupported();
  const nBle = [...state.sensors.values()].filter((s) => s.source === 'ble' && !s.relay).length;
  return [
    {
      id: 'ble', cls: 'bt', icon: 'i-bt', title: 'Bluetooth',
      text: bleOk ? 'Garmin HRM 600, HRM-Pro, HRM-Dual, hodinky… Pre každý pás kliknite znova.' : 'Tento prehliadač nepodporuje Web Bluetooth (použite Chrome/Edge, na iPhone Bluefy).',
      disabled: !bleOk, state: nBle ? `${nBle} pripojené` : '',
    },
    {
      id: 'ant', cls: 'ant', icon: 'i-ant', title: ant.connected ? 'ANT+ – odpojiť stick' : 'ANT+ USB stick',
      text: usbOk ? 'Garmin USB ANT stick zachytí všetky ANT+ pásy v dosahu naraz.' : 'WebUSB nie je dostupné (Chrome/Edge na PC alebo Androide).',
      disabled: !usbOk, state: ant.connected ? 'skenuje' : '',
    },
    {
      id: 'relay', cls: 'relay', icon: 'i-phone', title: 'Z mobilu',
      text: 'PC bez Bluetooth? Pásy pripojí mobil a dáta pošle sem – chránené heslom.',
      disabled: false, state: viewer.active ? viewerStatusText() : '',
    },
    {
      id: 'demo', cls: 'demo', icon: 'i-play', title: demo.running ? 'Demo – vypnúť' : 'Demo',
      text: 'Simulované dáta 4 športovcov – vyskúšajte bez hardvéru.',
      disabled: false, state: demo.running ? 'beží' : '',
    },
  ];
}

function renderOptions(container) {
  container.innerHTML = '';
  for (const o of sourceOptions()) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `option ${o.cls}`;
    b.disabled = o.disabled;
    b.dataset.src = o.id;
    b.innerHTML = `<span class="ico"><svg><use href="#${o.icon}"/></svg></span><b></b><small></small>`;
    $('b', b).textContent = o.title;
    if (o.state) {
      const st = document.createElement('span');
      st.className = 'state';
      st.textContent = `● ${o.state}`;
      $('b', b).append(st);
    }
    $('small', b).textContent = o.text;
    b.addEventListener('click', () => connectSource(o.id));
    container.append(b);
  }
}

const VIEWER_STATUS = {
  connecting: ['pripájam sa…', 'Pripájam sa na server, cez ktorý sa PC nájde s mobilom.'],
  dialing: ['hľadám mobil…', 'Server našiel mobil, nadväzujem priame spojenie.'],
  auth: ['overujem heslo…', 'Spojenie s mobilom je nadviazané, overujem heslo.'],
  online: ['online', 'Dáta z mobilu prichádzajú priamo.'],
  relay: ['online cez server', 'Priame spojenie sieť nepustila, dáta preto idú cez záložný server – šifrované heslom, server ich nevie prečítať. Oneskorenie asi 1 s.'],
  waiting: ['čakám na mobil', 'Mobil s týmto kódom práve nezdieľa. Je na ňom otvorená stránka a zapnuté Zdieľať? Skúšam znova…'],
  failed: ['zlyhalo, skúšam znova', 'Priame spojenie sa nepodarilo a ani cez záložný server zatiaľ neprišli dáta. Skontrolujte, či kód a heslo sedia s mobilom a či je na mobile stránka otvorená v popredí. Skúšam znova…'],
};

function viewerStatusText() {
  return VIEWER_STATUS[viewer.status]?.[0] || '';
}

function renderSources() {
  renderOptions($('#empty-options'));
  if ($('#connect-dialog').open) renderOptions($('#connect-options'));

  const chips = $('#chips');
  $$('.chip', chips).forEach((c) => c.remove());
  const add = (icon, text, cls, onClick) => {
    const c = document.createElement('button');
    c.type = 'button';
    c.className = `chip ${cls}`;
    c.innerHTML = `<i></i><svg><use href="#${icon}"/></svg><span></span>`;
    $('span', c).textContent = text;
    c.addEventListener('click', onClick);
    chips.append(c);
  };
  const nBle = [...state.sensors.values()].filter((s) => s.source === 'ble' && !s.relay).length;
  if (nBle) add('i-bt', `Bluetooth ${nBle}`, '', openConnect);
  if (ant.connected) add('i-ant', 'ANT+ skenuje', '', openConnect);
  if (demo.running) add('i-play', 'Demo', '', openConnect);
  if (viewer.active) add('i-phone', `Mobil ${viewer.room} · ${viewerStatusText()}`, viewer.status === 'online' || viewer.status === 'relay' ? '' : 'wait', () => openConnect('relay'));
  if (hub.active) {
    const txt = hub.status === 'online' ? `Zdieľanie ${hub.room} · ${hub.viewerCount} PC` : `Zdieľanie ${hub.room} · pripájam…`;
    add('i-share', txt, hub.status === 'online' ? '' : 'wait', openShare);
  }

  const shareBtn = $('#btn-share');
  shareBtn.classList.toggle('on', hub.active);
  const pill = $('#share-pill');
  pill.hidden = !hub.active;
  pill.textContent = hub.viewerCount;
  updateWakeLock();
}

async function connectSource(id) {
  if (id === 'ble') {
    try {
      const sid = await ble.add();
      toast(`${sensorLabel(sid)} pripojený`);
    } catch (err) {
      const msg = errorMessage(err);
      if (msg) toast(msg, true);
    }
  } else if (id === 'ant') {
    try {
      if (ant.connected) await ant.disconnect();
      else await ant.connect();
    } catch (err) {
      const msg = errorMessage(err);
      if (msg) toast(err?.name === 'SecurityError' || /claim|Access denied/i.test(msg)
        ? 'Stick nie je možné otvoriť. Zatvorte Garmin Express / iné ANT aplikácie; na Windows nainštalujte ovládač WinUSB (Zadig).'
        : `ANT+: ${msg}`, true);
    }
  } else if (id === 'relay') {
    openConnect('relay');
    return;
  } else if (id === 'demo') {
    if (demo.running) demo.stop(); else demo.start();
    $('#connect-dialog').close();
  }
  renderSources();
  render(true);
}

function openConnect(focus) {
  const dlg = $('#connect-dialog');
  renderOptions($('#connect-options'));
  const showViewer = focus === 'relay' || viewer.active;
  $('#viewer-form').hidden = !showViewer;
  renderViewerForm();
  if (!dlg.open) dlg.showModal();
  if (focus === 'relay') {
    const room = $('#v-room');
    (room.value ? $('#v-pass') : room).focus();
  }
}

/* ---------- viewer (PC) form ---------- */

function renderViewerForm() {
  const active = viewer.active;
  $('#v-stop').hidden = !active;
  const live = viewer.status === 'online' || viewer.status === 'relay';
  $('#v-connect').textContent = active ? (live ? 'Pripojené ✓' : 'Pripájam…') : 'Pripojiť k mobilu';
  $('#v-stop').textContent = live ? 'Odpojiť od mobilu' : 'Zrušiť';
  $('#v-connect').disabled = active;
  $('#v-room').disabled = active;
  $('#v-pass').disabled = active;
  if (!$('#v-room').value) $('#v-room').value = state.viewer.room || '';
  const st = $('#v-status');
  const info = VIEWER_STATUS[viewer.status];
  st.hidden = !info;
  if (info) {
    st.className = `conn-status ${viewer.status === 'online' || viewer.status === 'relay' ? 'ok' : viewer.status === 'failed' ? 'bad' : ''}`;
    const title = viewer.status === 'failed' ? 'Spojenie zlyhalo' : info[0];
    $('b', st).textContent = title[0].toUpperCase() + title.slice(1);
    $('small', st).textContent = viewer.status === 'failed' && viewer.failures > 1
      ? `${info[1]} (pokus ${viewer.failures})`
      : info[1];
  }
  $('#v-remember').checked = state.viewer.remember !== false;
  if ($('#connect-dialog').open) renderOptions($('#connect-options'));
}

function showViewerError(msg) {
  const el = $('#v-error');
  el.textContent = msg;
  el.hidden = !msg;
  if (msg) openConnect('relay');
}

async function connectViewer() {
  const room = normalizeRoom($('#v-room').value);
  const password = $('#v-pass').value;
  showViewerError('');
  if (room.length < 4) { showViewerError('Zadajte kód z mobilu'); return; }
  if (!password) { showViewerError('Zadajte heslo'); return; }
  const remember = $('#v-remember').checked;
  state.viewer = { room, password: remember ? password : '', remember };
  store.save('coach.viewer', state.viewer);
  try {
    await viewer.connect(room, password);
  } catch (err) {
    showViewerError(err.message || String(err));
  }
}

/* ---------- share (phone) dialog ---------- */

function openShare() {
  renderShare();
  $('#share-dialog').showModal();
}

function shareLink(room) {
  const url = new URL(location.href);
  url.search = '';
  url.hash = '';
  url.searchParams.set('view', room);
  const peerhost = new URLSearchParams(location.search).get('peerhost');
  if (peerhost) url.searchParams.set('peerhost', peerhost);
  return url.toString();
}

async function renderQr(el, text) {
  try {
    await loadScript('vendor/qrcode.js');
    const qr = window.qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    el.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
  } catch {
    el.textContent = '';
  }
}

function renderShare() {
  const on = hub.active;
  $('#share-off').hidden = on;
  $('#share-on').hidden = !on;
  $('#s-room').value = state.share.room;
  if (!$('#s-pass').value) $('#s-pass').value = state.share.password || '';
  if (on) {
    const link = shareLink(hub.room);
    $('#s-code').textContent = hub.room;
    $('#s-link-text').textContent = link.replace(/^https?:\/\//, '');
    const st = $('#s-status');
    st.className = `share-status ${hub.status === 'online' ? '' : 'wait'}`;
    st.innerHTML = '<i></i><span></span>';
    $('span', st).textContent = hub.status === 'online'
      ? `Online · pripojené PC: ${hub.viewerCount}`
      : hub.status === 'reconnecting' ? 'Spojenie so serverom stratené, obnovujem…' : 'Pripájam…';
    const qr = $('#s-qr');
    if (qr.dataset.link !== link) { qr.dataset.link = link; renderQr(qr, link); }
  }
}

async function startShare() {
  const password = $('#s-pass').value;
  const err = $('#s-error');
  err.hidden = true;
  if (password.length < 4) { err.textContent = 'Heslo musí mať aspoň 4 znaky'; err.hidden = false; return; }
  state.share.password = password;
  state.share.active = true;
  saveShare();
  $('#s-start').disabled = true;
  try {
    await hub.start(state.share.room, password);
    toast(`Zdieľanie spustené – kód ${state.share.room}`);
  } catch (e) {
    err.textContent = e.message || String(e);
    err.hidden = false;
    state.share.active = false;
    saveShare();
  }
  $('#s-start').disabled = false;
  renderShare();
}

async function stopShare() {
  state.share.active = false;
  saveShare();
  await hub.stop();
  renderShare();
}

/* ---------- session controls ---------- */

function renderSession() {
  const s = state.session.state;
  const btn = $('#btn-start');
  btn.innerHTML = s === 'running' ? '<span>❚❚ Pauza</span>' : `<svg><use href="#i-play"/></svg><span>${s === 'idle' ? 'Štart' : 'Ďalej'}</span>`;
  btn.className = `btn ${s === 'running' ? '' : 'btn-go'}`;
  $('#btn-lap').hidden = s === 'idle';
  $('#btn-stop').hidden = s === 'idle';
  renderSessionTime();
}

function renderSessionTime() {
  const s = state.session;
  const el = $('#session-time');
  const ms = elapsedMs();
  el.textContent = formatDuration(ms / 1000);
  el.className = `session-time ${s.state}`;
  const lapEl = $('#session-lap');
  if (s.state === 'idle') lapEl.textContent = 'tréning nebeží';
  else if (!s.laps.length) lapEl.textContent = s.state === 'paused' ? 'pauza' : 'kolo 1';
  else lapEl.textContent = `kolo ${s.laps.length + 1} · ${formatDuration((ms - s.laps[s.laps.length - 1].elapsed) / 1000)}`;
}

/* ---------- drawer ---------- */

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function openDrawer(key) {
  state.selected = key;
  $('#drawer').hidden = false;
  $('#scrim').hidden = false;
  $('#d-assign').dataset.sig = '';
  $('#d-sensors').dataset.sig = '';
  renderDrawer(true);
}

function closeDrawer() {
  state.selected = null;
  $('#drawer').hidden = true;
  $('#scrim').hidden = true;
}

function renderDrawer(redraw) {
  const key = state.selected;
  const athlete = athleteOfKey(key);
  const sensors = sensorsOfKey(key);
  const p = state.participants.get(key);
  const now = Date.now();
  const v = liveValues(key, now);
  const zone = zoneOf(v.hr, athlete);
  const intensity = v.hr ? intensityOf(v.hr, athlete) : null;

  $('#d-title').textContent = labelOf(key);
  const maxHr = maxHrOf(athlete);
  $('#d-sub').textContent = athlete
    ? `Max. tep ${maxHr}${athlete.restHr ? ` · pokojový ${athlete.restHr} (Karvonen)` : ''}${athlete.remote ? ' · profil z mobilu' : ''}`
    : `Nepriradený senzor · zóny z max. tepu ${maxHr}`;
  $('#d-hr').textContent = v.hr ?? '–';
  setHeart($('#d-heart'), v.hr);
  $('#d-heart').style.color = zoneColor(zone);
  const dz = $('#d-zone');
  dz.textContent = zone ? `${ZONES[zone - 1].name} · ${Math.round(intensity * 100)} %` : '';
  dz.hidden = !zone;
  dz.style.background = zoneColor(zone);
  const ibar = $('#d-ibar');
  if (!ibar.children.length) ibar.innerHTML = ZONES.map((z) => `<i style="background:${z.color}"></i>`).join('') + '<b hidden></b>';
  intensityBar(ibar, intensity);

  if (redraw && p) {
    drawHrChart($('#d-chart'), p.live, athlete, state.detailWindow, { muted: css('--muted'), grid: css('--line') });
  }

  const ss = p?.sess;
  const recentRr = p && now - p.rrAt < STALE_MS ? p.rr.slice(-60) : [];
  const hrv = rmssd(recentRr);
  const stats = [
    ['Intenzita', intensity != null ? `${Math.round(intensity * 100)} %` : '–'],
    ['HRV (RMSSD)', hrv != null ? `${hrv} ms` : '–'],
    ['Posl. RR', recentRr.length ? `${recentRr[recentRr.length - 1]} ms` : '–'],
    ['Ø tep', ss?.hrN ? Math.round(ss.hrSum / ss.hrN) : '–'],
    ['Max tep', ss?.max || '–'],
    ['kcal', ss ? Math.round(ss.kcal) : '–'],
  ];
  if (v.speed != null) stats.push(['Tempo', `${formatPace(v.speed)} /km`], ['Rýchlosť', `${(v.speed * 3.6).toFixed(1)} km/h`]);
  if (v.cadence != null) stats.push(['Kadencia', v.cadence]);
  if (v.power != null) stats.push(['Výkon', `${v.power} W`]);
  if (ss?.distance) stats.push(['Vzdialenosť', `${(ss.distance / 1000).toFixed(2)} km`]);
  $('#d-stats').innerHTML = stats.map(([l, val]) => `<div class="stat"><b>${val}</b><span>${l}</span></div>`).join('');

  // zone times: session if running, else from the live buffer
  let zoneSec = ss?.zoneSec;
  if (!zoneSec && p) {
    zoneSec = [0, 0, 0, 0, 0, 0];
    for (const s of p.live) if (s.hr) zoneSec[zoneOf(s.hr, athlete)]++;
  }
  zoneSec = zoneSec || [0, 0, 0, 0, 0, 0];
  const total = zoneSec.reduce((a, b) => a + b, 0) || 1;
  $('#d-zones').innerHTML = ZONES.slice().reverse().map((z) => {
    const sec = zoneSec[z.id];
    return `<div class="zone-row"><span>${z.name}</span><div class="bar"><i style="width:${(sec / total) * 100}%;background:${z.color}"></i></div><span>${formatDuration(sec)}</span></div>`;
  }).join('');

  // sensor list (rebuilt only when composition changes, keeps buttons clickable)
  const list = $('#d-sensors');
  const sig = sensors.map((s) => `${s.id}|${s.status}|${s.battery}|${s.rssi}`).join(',');
  if (list.dataset.sig !== sig) {
    list.dataset.sig = sig;
    list.innerHTML = '';
    for (const s of sensors) {
      const li = document.createElement('li');
      const details = [
        SOURCE_LABEL[s.source] + (s.relay ? ' cez mobil' : ''),
        s.manufacturer,
        s.model,
        s.battery != null ? `batéria ${s.battery} %${s.batteryStatus ? ` (${s.batteryStatus})` : ''}` : null,
        s.rssi != null ? `signál ${s.rssi} dBm` : null,
        s.status !== 'connected' ? s.status : null,
      ].filter(Boolean).join(' · ');
      li.innerHTML = '<div class="grow"><b></b><small></small></div>';
      $('b', li).textContent = s.name;
      $('small', li).textContent = details;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn';
      btn.textContent = s.source === 'ble' && !s.relay ? 'Odpojiť' : 'Skryť';
      btn.addEventListener('click', () => removeSensor(s.id));
      li.append(btn);
      list.append(li);
    }
    if (!sensors.length) list.innerHTML = '<li class="muted">Žiadny pripojený senzor</li>';
  }

  // assign select
  const sel = $('#d-assign');
  const selSig = `${key}|${state.athletes.map((a) => `${a.id}:${a.name}`).join(',')}`;
  if (sel.dataset.sig !== selSig) {
    sel.dataset.sig = selSig;
    sel.innerHTML = `<option value="">${athlete?.remote ? `${athlete.name} (z mobilu)` : '— nepriradený —'}</option>`;
    for (const a of state.athletes) {
      const o = document.createElement('option');
      o.value = a.id;
      o.textContent = a.name || 'Bez mena';
      sel.append(o);
    }
    sel.insertAdjacentHTML('beforeend', '<option value="__new">+ Nový športovec…</option>');
    sel.value = athlete && !athlete.remote ? athlete.id : '';
    sel.disabled = !sensors.length;
  }
}

function removeSensor(id) {
  const s = state.sensors.get(id);
  if (!s) return;
  if (s.source === 'ble' && !s.relay) ble.disconnect(id);
  else { state.hidden.add(id); toast(`${s.name} skrytý`); }
  scheduleRender();
}

/** Move all sensors of the selected tile to another athlete (or unassign). */
function assignSelected(value) {
  const oldKey = state.selected;
  const sensorIds = sensorsOfKey(oldKey).map((s) => s.id);
  if (!sensorIds.length) return;
  let athleteId = value;
  if (value === '__new') {
    const name = prompt('Meno športovca:');
    if (!name) { $('#d-assign').dataset.sig = ''; renderDrawer(false); return; }
    const a = { id: crypto.randomUUID().slice(0, 8), name: name.trim(), sex: 'm', sensorIds: [] };
    state.athletes.push(a);
    athleteId = a.id;
  }
  for (const a of state.athletes) a.sensorIds = (a.sensorIds || []).filter((id) => !sensorIds.includes(id));
  const target = state.athletes.find((a) => a.id === athleteId);
  if (target) target.sensorIds.push(...sensorIds);
  saveAthletes();

  const newKey = keyOf(sensorIds[0]);
  if (newKey !== oldKey && state.participants.has(oldKey) && !state.participants.has(newKey)) {
    const p = state.participants.get(oldKey);
    p.key = newKey;
    state.participants.delete(oldKey);
    state.participants.set(newKey, p);
  }
  const el = tiles.get(oldKey);
  if (el) { el.remove(); tiles.delete(oldKey); }
  state.selected = newKey;
  $('#d-assign').dataset.sig = '';
  render(true);
}

/* ---------- athletes dialog ---------- */

function renderAthletes() {
  const body = $('#athletes-body');
  body.innerHTML = '';
  const assigned = new Set(state.athletes.flatMap((a) => a.sensorIds || []));
  const free = [...state.sensors.values()].filter((s) => !assigned.has(s.id));

  for (const a of state.athletes) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><input class="name" data-f="name" placeholder="Meno"></td>
      <td><input type="number" data-f="age" min="5" max="100" placeholder="–"></td>
      <td><select data-f="sex"><option value="m">M</option><option value="f">Ž</option></select></td>
      <td><input type="number" data-f="weight" min="20" max="200" placeholder="kg"></td>
      <td><input type="number" data-f="maxHr" min="100" max="240" placeholder="${maxHrOf(a)}"></td>
      <td><input type="number" data-f="restHr" min="30" max="100" placeholder="–"></td>
      <td class="sensors-cell"></td>
      <td><button type="button" class="btn btn-icon btn-ghost del" title="Zmazať">🗑</button></td>`;
    for (const input of tr.querySelectorAll('[data-f]')) {
      const f = input.dataset.f;
      input.value = a[f] ?? (f === 'sex' ? 'm' : '');
      input.addEventListener('change', () => {
        const val = input.value.trim();
        a[f] = input.type === 'number' ? (val ? Number(val) : undefined) : val;
        saveAthletes();
        if (f === 'age') renderAthletes();
        render(true);
      });
    }
    const cell = $('.sensors-cell', tr);
    for (const id of a.sensorIds || []) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'sensor-chip';
      chip.title = 'Odobrať senzor';
      chip.textContent = `${sensorLabel(id)}${id.startsWith(RELAY_PREFIX) ? ' (mobil)' : ''} ✕`;
      chip.addEventListener('click', () => {
        a.sensorIds = a.sensorIds.filter((x) => x !== id);
        saveAthletes(); renderAthletes(); render(true);
      });
      cell.append(chip);
    }
    if (free.length) {
      const sel = document.createElement('select');
      sel.innerHTML = '<option value="">+ priradiť…</option>';
      for (const s of free) {
        const o = document.createElement('option');
        o.value = s.id;
        o.textContent = s.name + (s.relay ? ' (mobil)' : '');
        sel.append(o);
      }
      sel.addEventListener('change', () => {
        if (!sel.value) return;
        a.sensorIds = [...(a.sensorIds || []), sel.value];
        saveAthletes(); renderAthletes(); render(true);
      });
      cell.append(sel);
    }
    if (!cell.children.length) cell.innerHTML = '<span class="muted">—</span>';
    $('.del', tr).addEventListener('click', () => {
      if (!confirm(`Zmazať športovca ${a.name || ''}?`)) return;
      state.athletes = state.athletes.filter((x) => x !== a);
      saveAthletes(); renderAthletes(); render(true);
    });
    body.append(tr);
  }
  if (!state.athletes.length) {
    body.innerHTML = '<tr><td colspan="8" class="muted">Zatiaľ žiadni športovci. Pridajte ich tu alebo kliknite na dlaždicu senzora a zvoľte „Nový športovec“.</td></tr>';
  }

  const remote = $('#remote-athletes');
  remote.innerHTML = '';
  if (state.remoteAthletes.length) {
    remote.innerHTML = '<div class="remote-list"><h3>Z mobilu (len na čítanie)</h3><p class="muted"></p></div>';
    $('p', remote).textContent = state.remoteAthletes.map((a) => a.name || 'Bez mena').join(', ');
  }
}

/* ---------- summary dialog ---------- */

function showSummary(summary) {
  const dlg = $('#summary-dialog');
  const start = new Date(summary.startedAt);
  $('#summary-meta').textContent = `${start.toLocaleDateString('sk-SK')} ${start.toLocaleTimeString('sk-SK', { hour: '2-digit', minute: '2-digit' })} · trvanie ${formatDuration(summary.duration / 1000)} · ${summary.laps.length + 1} ${plural(summary.laps.length + 1, 'kolo', 'kolá', 'kôl')}`;

  const body = $('#summary-body');
  body.innerHTML = '';
  for (const r of summary.records) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><b></b></td><td>${formatDuration(r.duration)}</td><td>${r.avg ?? '–'}</td><td>${r.max ?? '–'}</td>
      <td>${Math.round(r.kcal)}</td><td>${r.distance ? `${(r.distance / 1000).toFixed(2)} km` : '–'}</td>
      <td><div class="zb">${zoneBarHtml(r.zoneSec)}</div></td><td></td>`;
    $('b', tr).textContent = r.label;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn';
    btn.textContent = 'TCX';
    btn.title = 'Stiahnuť TCX pre Garmin Connect / Strava';
    btn.addEventListener('click', () => exportTcx(r, summary.startedAt));
    tr.lastElementChild.append(btn);
    body.append(tr);
  }
  if (!summary.records.length) body.innerHTML = '<tr><td colspan="8" class="muted">Počas tréningu neprišli žiadne dáta.</td></tr>';

  // per-lap average HR
  const laps = $('#summary-laps');
  laps.innerHTML = '';
  if (summary.laps.length && summary.records.length) {
    const bounds = [summary.startedAt, ...summary.laps.map((l) => l.at), summary.endedAt];
    const head = bounds.slice(1).map((_, i) => `<th>Kolo ${i + 1}</th>`).join('');
    const rows = summary.records.map((r) => {
      const cells = bounds.slice(1).map((end, i) => {
        const hrs = r.samples.filter((s) => s.t >= bounds[i] && s.t < end && s.hr).map((s) => s.hr);
        return `<td>${hrs.length ? Math.round(hrs.reduce((a, b) => a + b, 0) / hrs.length) : '–'}</td>`;
      }).join('');
      return `<tr><td>${escapeHtml(r.label)}</td>${cells}</tr>`;
    }).join('');
    laps.innerHTML = `<div class="laps"><h3>Ø tep po kolách</h3><div class="table-wrap"><table><thead><tr><th>Športovec</th>${head}</tr></thead><tbody>${rows}</tbody></table></div></div>`;
  }

  $('#btn-csv').onclick = () => exportCsv(summary);
  $('#btn-csv').disabled = !summary.records.length;
  dlg.showModal();
}

function escapeHtml(s) {
  return String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
}

/* ------------------------------------------------------------------ */
/* utilities                                                            */
/* ------------------------------------------------------------------ */

function toast(msg, isError = false) {
  const el = document.createElement('div');
  el.className = `toast${isError ? ' err' : ''}`;
  el.textContent = msg;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), isError ? 6000 : 3500);
}

let audioCtx = null;
function beep() {
  try {
    audioCtx ||= new AudioContext();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.2, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.25);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.25);
  } catch { /* audio unavailable */ }
}

let wakeLock = null;
async function updateWakeLock() {
  const want = state.sensors.size > 0 || state.session.state !== 'idle' || hub.active || viewer.active;
  if (!('wakeLock' in navigator)) return;
  try {
    if (want && !wakeLock && document.visibilityState === 'visible') {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!want && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch { /* not allowed */ }
}

function errorMessage(err) {
  if (err?.name === 'NotFoundError') return null; // user cancelled the picker
  if (err?.name === 'SecurityError') return 'Prístup zamietnutý – aplikácia musí bežať cez HTTPS.';
  if (err?.name === 'NetworkError') return 'Pripojenie zlyhalo – je senzor v dosahu a navlhčený?';
  return err?.message || String(err);
}

function applyTheme() {
  const t = state.options.theme;
  if (t === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
}

function bindSeg(el, get, set) {
  const sync = () => $$('button', el).forEach((b) => b.classList.toggle('active', b.dataset.v === get()));
  $$('button', el).forEach((b) => b.addEventListener('click', () => { set(b.dataset.v); sync(); }));
  sync();
}

/* ------------------------------------------------------------------ */
/* wiring                                                               */
/* ------------------------------------------------------------------ */

function init() {
  const banner = $('#banner');
  if (!window.isSecureContext) {
    banner.hidden = false;
    banner.textContent = 'Bluetooth, USB a zdieľanie fungujú iba cez HTTPS alebo localhost.';
  } else if (!BleManager.isSupported() && !AntManager.isSupported()) {
    banner.hidden = false;
    banner.innerHTML = 'Tento prehliadač nevie pripojiť pásy priamo. Použite <b>Chrome</b> alebo <b>Edge</b>, na iPhone aplikáciu <b>Bluefy</b> – alebo zvoľte <b>Pripojiť → Z mobilu</b> a dáta pošle mobil.';
  }
  $('#site-host').textContent = location.host || 'atherion.cz';

  $('#btn-connect').addEventListener('click', () => openConnect());
  $('#btn-share').addEventListener('click', openShare);
  $('#btn-start').addEventListener('click', startOrPause);
  $('#btn-lap').addEventListener('click', lap);
  $('#btn-stop').addEventListener('click', stop);

  // viewer form
  $('#v-connect').addEventListener('click', connectViewer);
  $('#v-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); connectViewer(); } });
  $('#v-room').addEventListener('input', (e) => { e.target.value = normalizeRoom(e.target.value); });
  $('#v-stop').addEventListener('click', () => {
    viewer.stop();
    state.viewer.password = '';
    store.save('coach.viewer', state.viewer);
    $('#v-pass').value = '';
    renderViewerForm();
  });

  // share dialog
  $('#s-newroom').addEventListener('click', () => { state.share.room = randomRoom(); saveShare(); renderShare(); });
  $('#s-show').addEventListener('change', (e) => { $('#s-pass').type = e.target.checked ? 'text' : 'password'; });
  $('#s-start').addEventListener('click', startShare);
  $('#s-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); startShare(); } });
  $('#s-stop').addEventListener('click', stopShare);
  $('#s-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(shareLink(hub.room)); toast('Odkaz skopírovaný'); }
    catch { toast(shareLink(hub.room)); }
  });

  // athletes
  $('#btn-athletes').addEventListener('click', () => { renderAthletes(); $('#athletes-dialog').showModal(); });
  $('#btn-add-athlete').addEventListener('click', () => {
    state.athletes.push({ id: crypto.randomUUID().slice(0, 8), name: '', sex: 'm', sensorIds: [] });
    saveAthletes();
    renderAthletes();
    const inputs = $$('#athletes-body input.name');
    inputs[inputs.length - 1]?.focus();
  });
  $('#athletes-dialog').addEventListener('close', () => { $('#d-assign').dataset.sig = ''; render(true); });

  // settings
  $('#btn-settings').addEventListener('click', () => $('#settings-dialog').showModal());
  const oAlert = $('#o-alert');
  oAlert.value = String(state.options.alert);
  oAlert.addEventListener('change', () => { state.options.alert = Number(oAlert.value); saveOptions(); render(false); });
  const oSound = $('#o-sound');
  oSound.checked = state.options.sound;
  oSound.addEventListener('change', () => { state.options.sound = oSound.checked; saveOptions(); if (oSound.checked) beep(); });
  const oOnly = $('#o-only');
  oOnly.checked = state.options.onlyAssigned;
  oOnly.addEventListener('change', () => { state.options.onlyAssigned = oOnly.checked; saveOptions(); render(true); });
  const oTheme = $('#o-theme');
  oTheme.value = state.options.theme;
  oTheme.addEventListener('change', () => { state.options.theme = oTheme.value; saveOptions(); applyTheme(); render(true); });

  bindSeg($('#sort-seg'), () => state.options.sort, (v) => { state.options.sort = v; saveOptions(); render(true); });
  bindSeg($('#size-seg'), () => state.options.size, (v) => {
    state.options.size = v; saveOptions();
    grid.className = `grid size-${v}`;
    render(true);
  });
  grid.className = `grid size-${state.options.size}`;

  $('#btn-fullscreen').addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen?.().catch(() => {});
  });

  $('#d-close').addEventListener('click', closeDrawer);
  $('#scrim').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.selected) closeDrawer(); });
  $('#d-assign').addEventListener('change', (e) => assignSelected(e.target.value));
  for (const b of $$('#d-window button')) {
    b.addEventListener('click', () => {
      state.detailWindow = Number(b.dataset.w);
      for (const x of $$('#d-window button')) x.classList.toggle('active', x === b);
      renderDrawer(true);
    });
  }

  document.addEventListener('visibilitychange', updateWakeLock);
  window.addEventListener('beforeunload', (e) => {
    if (state.session.state !== 'idle' || hub.viewerCount) { e.preventDefault(); e.returnValue = ''; }
  });
  window.addEventListener('resize', () => render(true));

  // Re-open an ANT+ stick the user already allowed earlier.
  if (AntManager.isSupported()) ant.restoreKnown().then((ok) => { if (ok) renderSources(); }).catch(() => {});

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  const params = new URLSearchParams(location.search);
  if (params.has('demo')) demo.start();

  // Resume sharing after a reload of the phone.
  if (state.share.active && state.share.password) {
    hub.start(state.share.room, state.share.password).catch((e) => toast(e.message, true));
  }

  // PC opened via the QR code / link: ?view=ROOM
  const viewRoom = normalizeRoom(params.get('view'));
  if (viewRoom) {
    if (viewRoom !== state.viewer.room) state.viewer = { ...state.viewer, room: viewRoom, password: '' };
    $('#v-room').value = viewRoom;
  }
  if (state.viewer.room && state.viewer.password) {
    $('#v-room').value = state.viewer.room;
    viewer.connect(state.viewer.room, state.viewer.password).catch((e) => showViewerError(e.message));
  } else if (viewRoom) {
    openConnect('relay');
  }

  renderSession();
  renderSources();
  render(true);
  setInterval(tick, 1000);
}

init();
