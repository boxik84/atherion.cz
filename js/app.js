import { BleManager } from './ble.js';
import { AntManager } from './ant.js';
import { DemoManager } from './demo.js';
import {
  ZONES, zoneOf, zoneColor, intensityOf, maxHrOf, rmssd, kcalPerMinute, formatDuration, formatPace,
} from './metrics.js';
import { drawSparkline, drawHrChart } from './chart.js';
import { exportCsv, exportTcx } from './export.js';

const $ = (sel, el = document) => el.querySelector(sel);
const STALE_MS = 5000;
const LIVE_KEEP_MS = 60 * 60 * 1000;
const ALERT_INTENSITY = 0.95;
const SOURCE_LABEL = { ble: 'BT', ant: 'ANT+', demo: 'DEMO' };

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
  sensorNames: store.load('coach.sensorNames', {}),
  options: { sort: 'name', onlyAssigned: false, sound: false, ...store.load('coach.options', {}) },
  sensors: new Map(),       // sensorId -> sensor
  participants: new Map(),  // tile key -> participant
  hidden: new Set(),
  session: { state: 'idle', startedAt: 0, elapsedMs: 0, resumedAt: 0, laps: [] },
  selected: null,
  detailWindow: 900,
};

const saveAthletes = () => store.save('coach.athletes', state.athletes);
const saveOptions = () => store.save('coach.options', state.options);

function athleteOfSensor(sensorId) {
  return state.athletes.find((a) => a.sensorIds?.includes(sensorId)) || null;
}
function keyOf(sensorId) {
  const a = athleteOfSensor(sensorId);
  return a ? `ath:${a.id}` : `sen:${sensorId}`;
}
function athleteOfKey(key) {
  return key.startsWith('ath:') ? state.athletes.find((a) => `ath:${a.id}` === key) || null : null;
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
  const id = key.slice(4);
  return state.sensors.get(id)?.name || state.sensorNames[id] || id;
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

function onUpdate(u) {
  if (u.id === 'ant:stick') { renderAntButton(); return; }

  let s = state.sensors.get(u.id);
  if (!s) {
    if (u.status === 'disconnected') return;
    s = { id: u.id, source: u.source, name: u.name || u.id, status: 'connected', values: {}, at: {}, lastSeen: 0 };
    state.sensors.set(u.id, s);
  }
  if (u.name) {
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
    if (u.status === 'reconnecting') toast(`${s.name}: spojenie stratené, pripájam znova…`);
    if (u.status === 'error') toast(`${s.name}: ${u.error}`, true);
  }

  const now = Date.now();
  let gotData = false;
  for (const k of ['hr', 'speed', 'cadence', 'power']) {
    if (u[k] != null) { s.values[k] = u[k]; s.at[k] = now; gotData = true; }
  }
  if (gotData) {
    s.lastSeen = now;
    if (s.status !== 'error') s.status = 'connected';
  }
  if (u.rr?.length) {
    const p = participant(keyOf(u.id));
    p.rr.push(...u.rr);
    if (p.rr.length > 300) p.rr.splice(0, p.rr.length - 300);
    p.rrAt = now;
  }
  scheduleRender();
}

const ble = new BleManager(onUpdate);
const ant = new AntManager(onUpdate, (msg) => toast(msg));
const demo = new DemoManager(onUpdate);

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
    const athlete = athleteOfKey(p.key);
    records.push({
      key: p.key,
      label: labelOf(p.key),
      athlete,
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
      tiles.set(key, el);
    }
    el.dataset.key = key;
    if (grid.children[i] !== el) grid.insertBefore(el, grid.children[i] || null);
    updateTile(el, key, now, redrawCharts || fresh);
  });

  $('#empty').hidden = keys.length > 0 || state.sensors.size > 0;
  const n = state.sensors.size;
  $('#count').textContent = n === 0
    ? 'Žiadne senzory'
    : `${keys.length} ${plural(keys.length, 'športovec', 'športovci', 'športovcov')} · ${n} ${plural(n, 'senzor', 'senzory', 'senzorov')}`;
  $('#btn-demo').classList.toggle('on', demo.running);

  if (state.selected) renderDrawer(redrawCharts);
}

function plural(n, one, few, many) {
  return n === 1 ? one : n >= 2 && n <= 4 ? few : many;
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

  const sources = [...new Set(sensors.map((s) => s.source))];
  const badge = $('.src', el);
  badge.textContent = sources.map((s) => SOURCE_LABEL[s]).join(' + ') || '—';
  badge.className = `badge src ${sources[0] || ''}`;

  const batteries = sensors.map((s) => s.battery).filter((b) => b != null);
  const bat = $('.battery', el);
  bat.hidden = !batteries.length;
  if (batteries.length) {
    const b = Math.min(...batteries);
    bat.textContent = `🔋 ${b} %`;
    bat.classList.toggle('low', b <= 20);
  }

  const connecting = sensors.some((s) => s.status === 'connecting' || s.status === 'reconnecting');
  const stale = hr == null && v.speed == null && v.power == null;
  $('.dot', el).className = `dot ${connecting ? 'wait' : stale ? 'off' : 'live'}`;
  $('.dot', el).title = connecting ? 'Pripája sa…' : stale ? 'Bez signálu' : 'Live';
  el.classList.toggle('stale', stale && !connecting);

  const alert = intensity != null && intensity >= ALERT_INTENSITY;
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

  if (redraw && p) drawSparkline($('.spark', el), p.live, athlete);
}

function zoneBarHtml(zoneSec) {
  const total = zoneSec.reduce((a, b) => a + b, 0) || 1;
  return zoneSec.map((sec, z) => (sec ? `<i style="width:${(sec / total) * 100}%;background:${zoneColor(z)}" title="${z ? ZONES[z - 1].name : 'pod Z1'}: ${formatDuration(sec)}"></i>` : '')).join('');
}

/* ---------- session controls ---------- */

function renderSession() {
  const s = state.session.state;
  $('#btn-start').textContent = s === 'idle' ? '▶ Štart' : s === 'running' ? '⏸ Pauza' : '▶ Pokračovať';
  $('#btn-start').classList.toggle('btn-primary', s !== 'running');
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
  lapEl.hidden = !s.laps.length;
  if (s.laps.length) {
    const lapMs = ms - s.laps[s.laps.length - 1].elapsed;
    lapEl.textContent = `kolo ${s.laps.length + 1} · ${formatDuration(lapMs / 1000)}`;
  }
}

function renderAntButton() {
  const btn = $('#btn-ant');
  btn.classList.toggle('on', ant.connected);
  $('#ant-label').textContent = ant.connected ? 'ANT+ skenuje' : 'ANT+ USB';
  btn.title = ant.connected ? 'Odpojiť ANT+ stick' : 'Pripojiť Garmin USB ANT+ stick – zachytí všetky pásy v dosahu';
  if (!ant.connected) {
    for (const s of [...state.sensors.values()]) if (s.source === 'ant') state.sensors.delete(s.id);
    scheduleRender();
  }
}

/* ---------- drawer ---------- */

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function openDrawer(key) {
  state.selected = key;
  $('#drawer').hidden = false;
  renderDrawer(true);
}

function closeDrawer() {
  state.selected = null;
  $('#drawer').hidden = true;
}

function renderDrawer(redraw) {
  const key = state.selected;
  const athlete = athleteOfKey(key);
  const sensors = sensorsOfKey(key);
  const p = state.participants.get(key);
  const now = Date.now();
  const v = liveValues(key, now);
  const zone = zoneOf(v.hr, athlete);

  $('#d-title').textContent = labelOf(key);
  const maxHr = maxHrOf(athlete);
  $('#d-sub').textContent = athlete
    ? `Max. tep ${maxHr}${athlete.restHr ? ` · pokojový ${athlete.restHr} (Karvonen)` : ''}`
    : `Nepriradený senzor · zóny z max. tepu ${maxHr}`;
  $('#d-hr').textContent = v.hr ?? '–';
  const dz = $('#d-zone');
  dz.textContent = zone ? ZONES[zone - 1].name : '';
  dz.hidden = !zone;
  dz.style.background = zoneColor(zone);

  if (redraw && p) {
    drawHrChart($('#d-chart'), p.live, athlete, state.detailWindow, { muted: css('--muted'), grid: css('--line') });
  }

  const ss = p?.sess;
  const recentRr = p && now - p.rrAt < STALE_MS ? p.rr.slice(-60) : [];
  const stats = [
    ['Intenzita', v.hr ? `${Math.round(intensityOf(v.hr, athlete) * 100)} %` : '–'],
    ['HRV (RMSSD)', rmssd(recentRr) != null ? `${rmssd(recentRr)} ms` : '–'],
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
        SOURCE_LABEL[s.source],
        s.manufacturer,
        s.model,
        s.battery != null ? `batéria ${s.battery} %${s.batteryStatus ? ` (${s.batteryStatus})` : ''}` : null,
        s.rssi != null ? `signál ${s.rssi} dBm` : null,
        s.status !== 'connected' ? s.status : null,
      ].filter(Boolean).join(' · ');
      li.innerHTML = `<div class="grow"><b></b><small></small></div>`;
      $('b', li).textContent = s.name;
      $('small', li).textContent = details;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn';
      btn.textContent = s.source === 'ble' ? 'Odpojiť' : 'Skryť';
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
    sel.innerHTML = '<option value="">— nepriradený —</option>'
      + state.athletes.map((a) => `<option value="${a.id}"></option>`).join('')
      + '<option value="__new">+ Nový športovec…</option>';
    state.athletes.forEach((a, i) => { sel.options[i + 1].textContent = a.name || 'Bez mena'; });
    sel.value = athlete ? athlete.id : '';
    sel.disabled = !sensors.length;
  }
}

function removeSensor(id) {
  const s = state.sensors.get(id);
  if (!s) return;
  if (s.source === 'ble') ble.disconnect(id);
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
    if (!name) { renderDrawerAssignReset(); return; }
    const a = { id: crypto.randomUUID().slice(0, 8), name: name.trim(), sensorIds: [] };
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

function renderDrawerAssignReset() {
  $('#d-assign').dataset.sig = '';
  renderDrawer(false);
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
      <td><button type="button" class="btn btn-icon btn-ghost" title="Zmazať">🗑</button></td>`;
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
      chip.className = 'btn';
      chip.title = 'Odobrať senzor';
      chip.textContent = `${sensorLabel(id)} ✕`;
      chip.style.minHeight = '30px';
      chip.style.marginRight = '4px';
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
        o.textContent = s.name;
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
    tr.querySelector('button[title="Zmazať"]').addEventListener('click', () => {
      if (!confirm(`Zmazať športovca ${a.name || ''}?`)) return;
      state.athletes = state.athletes.filter((x) => x !== a);
      saveAthletes(); renderAthletes(); render(true);
    });
    body.append(tr);
  }
  if (!state.athletes.length) {
    body.innerHTML = '<tr><td colspan="8" class="muted">Zatiaľ žiadni športovci. Pridajte ich tu alebo kliknite na dlaždicu senzora a zvoľte „Nový športovec“.</td></tr>';
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
  const want = state.sensors.size > 0 || state.session.state !== 'idle';
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

/* ------------------------------------------------------------------ */
/* wiring                                                               */
/* ------------------------------------------------------------------ */

function init() {
  const bleOk = BleManager.isSupported();
  const usbOk = AntManager.isSupported();
  const banner = $('#banner');
  if (!window.isSecureContext) {
    banner.hidden = false;
    banner.textContent = 'Bluetooth a USB fungujú iba cez HTTPS alebo localhost.';
  } else if (!bleOk && !usbOk) {
    banner.hidden = false;
    banner.innerHTML = 'Tento prehliadač nepodporuje Web Bluetooth ani WebUSB. Použite <b>Chrome</b> alebo <b>Edge</b> (Windows, macOS, Linux, Android), na iPhone/iPade aplikáciu <b>Bluefy</b>. <b>Demo</b> funguje všade.';
  }
  $('#btn-ble').disabled = !bleOk;
  if (!bleOk) $('#btn-ble').title = 'Web Bluetooth nie je v tomto prehliadači dostupný';
  $('#btn-ant').disabled = !usbOk;
  if (!usbOk) $('#btn-ant').title = 'WebUSB nie je v tomto prehliadači dostupné (Chrome/Edge na počítači alebo Androide)';

  $('#btn-ble').addEventListener('click', async () => {
    try {
      const id = await ble.add();
      toast(`${sensorLabel(id)} pripojený`);
    } catch (err) {
      const msg = errorMessage(err);
      if (msg) toast(msg, true);
    }
    updateWakeLock();
  });

  $('#btn-ant').addEventListener('click', async () => {
    try {
      if (ant.connected) await ant.disconnect();
      else await ant.connect();
    } catch (err) {
      const msg = errorMessage(err);
      if (msg) toast(err?.name === 'SecurityError' || /claim|Access denied/i.test(msg)
        ? 'Stick nie je možné otvoriť. Zatvorte Garmin Express / iné ANT aplikácie; na Windows nainštalujte ovládač WinUSB (Zadig).'
        : `ANT+: ${msg}`, true);
    }
    renderAntButton();
    updateWakeLock();
  });

  $('#btn-demo').addEventListener('click', () => {
    if (demo.running) demo.stop(); else demo.start();
    render(true);
    updateWakeLock();
  });

  $('#btn-start').addEventListener('click', startOrPause);
  $('#btn-lap').addEventListener('click', lap);
  $('#btn-stop').addEventListener('click', stop);

  $('#btn-athletes').addEventListener('click', () => { renderAthletes(); $('#athletes-dialog').showModal(); });
  $('#btn-add-athlete').addEventListener('click', () => {
    state.athletes.push({ id: crypto.randomUUID().slice(0, 8), name: '', sex: 'm', sensorIds: [] });
    saveAthletes();
    renderAthletes();
    const inputs = document.querySelectorAll('#athletes-body input.name');
    inputs[inputs.length - 1]?.focus();
  });
  $('#athletes-dialog').addEventListener('close', () => { $('#d-assign').dataset.sig = ''; render(true); });

  $('#btn-fullscreen').addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen?.().catch(() => {});
  });

  $('#d-close').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.selected) closeDrawer(); });
  $('#d-assign').addEventListener('change', (e) => assignSelected(e.target.value));
  for (const b of document.querySelectorAll('#d-window button')) {
    b.addEventListener('click', () => {
      state.detailWindow = Number(b.dataset.w);
      for (const x of document.querySelectorAll('#d-window button')) x.classList.toggle('active', x === b);
      renderDrawer(true);
    });
  }

  const sort = $('#sort');
  sort.value = state.options.sort;
  sort.addEventListener('change', () => { state.options.sort = sort.value; saveOptions(); render(true); });
  const only = $('#only-assigned');
  only.checked = state.options.onlyAssigned;
  only.addEventListener('change', () => { state.options.onlyAssigned = only.checked; saveOptions(); render(true); });
  const sound = $('#sound');
  sound.checked = state.options.sound;
  sound.addEventListener('change', () => { state.options.sound = sound.checked; saveOptions(); if (sound.checked) beep(); });

  document.addEventListener('visibilitychange', updateWakeLock);
  window.addEventListener('beforeunload', (e) => {
    if (state.session.state !== 'idle') { e.preventDefault(); e.returnValue = ''; }
  });
  window.addEventListener('resize', () => render(true));

  // Re-open an ANT+ stick the user already allowed earlier.
  if (usbOk) ant.restoreKnown().then((ok) => { if (ok) renderAntButton(); }).catch(() => {});

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  const params = new URLSearchParams(location.search);
  if (params.has('demo')) demo.start();

  renderSession();
  render(true);
  setInterval(tick, 1000);
}

init();
