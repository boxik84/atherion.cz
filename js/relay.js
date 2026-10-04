// Phone → PC relay.
//
// The phone ("hub") is connected to the sensors and forwards every sensor
// update to any number of PCs ("viewers"), over two paths:
//
// 1. WebRTC (PeerJS) – direct, encrypted by DTLS. The public PeerJS server is
//    only used to find the other side. Access is protected by a password that
//    never leaves the device: both sides derive an HMAC key from
//    (password, room) with PBKDF2 and prove knowledge of it with a mutual
//    challenge/response. Repeated failures lock the room for a while.
// 2. Fallback through a public MQTT broker when the networks don't allow a
//    direct connection (mobile data, strict NAT). Everything is end-to-end
//    encrypted with AES-GCM under a key derived from the password, and the
//    topic name is derived from it too, so the broker only sees random bytes.
//    The phone publishes only while a PC asks for data (encrypted "hello").

import { MqttClient } from './mqtt.js';

const PEER_PREFIX = 'atherion-coach-';
const PROTOCOL = 1;
const AUTH_TIMEOUT_MS = 10000;
const MAX_FAILS = 5;
const FAIL_WINDOW_MS = 60000;
const LOCK_MS = 60000;
const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const BROKERS = ['wss://broker.emqx.io:8084/mqtt', 'wss://broker.hivemq.com:8884/mqtt'];
const HELLO_EVERY_MS = 8000;
const VIEWER_TTL_MS = 30000;
const RELAY_FRESH_MS = 6000;
const MAX_CLOCK_SKEW_MS = 5 * 60000;

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

const scripts = new Map();
export function loadScript(src) {
  if (!scripts.has(src)) {
    scripts.set(src, new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => { scripts.delete(src); reject(new Error(`Nepodarilo sa načítať ${src}`)); };
      document.head.append(s);
    }));
  }
  return scripts.get(src);
}

async function PeerClass() {
  await loadScript('vendor/peerjs.min.js');
  return window.peerjs.Peer;
}

// STUN finds the public address of each side; TURN relays the (still encrypted)
// traffic when the networks don't allow a direct connection, e.g. mobile data.
const ICE_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  { urls: 'stun:stun.cloudflare.com:3478' },
  {
    urls: [
      'turn:eu-0.turn.peerjs.com:3478',
      'turn:us-0.turn.peerjs.com:3478',
      'turn:eu-0.turn.peerjs.com:3478?transport=tcp',
    ],
    username: 'peerjs',
    credential: 'peerjsp',
  },
];

/** Optional self-hosted signalling server: ?peerhost=host:port (used for local testing). */
function peerOptions() {
  const base = { debug: 0, config: { iceServers: ICE_SERVERS } };
  const host = new URLSearchParams(location.search).get('peerhost');
  if (!host) return base;
  const [h, p] = host.split(':');
  return { ...base, host: h, port: Number(p || 9000), path: '/', secure: location.protocol === 'https:' };
}

export function randomRoom(len = 6) {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return [...bytes].map((b) => ROOM_ALPHABET[b % ROOM_ALPHABET.length]).join('');
}

export function normalizeRoom(room) {
  return String(room || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

const toB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const nonce = () => toB64(crypto.getRandomValues(new Uint8Array(16)));

export async function deriveKey(password, room) {
  const enc = new TextEncoder();
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: enc.encode(`atherion-coach:${normalizeRoom(room)}`), iterations: 150000, hash: 'SHA-256' },
    base,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign', 'verify'],
  );
}

export async function sign(key, label, n) {
  return toB64(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${label}:${n}`)));
}

export async function verify(key, label, n, mac) {
  try {
    return await crypto.subtle.verify('HMAC', key, fromB64(mac), new TextEncoder().encode(`${label}:${n}`));
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* encrypted broker fallback                                           */
/* ------------------------------------------------------------------ */

/** Broker URLs; ?mqtt=ws://host:port overrides them for local testing. */
function brokerUrls() {
  const m = typeof location !== 'undefined' && new URLSearchParams(location.search).get('mqtt');
  return m ? [m] : BROKERS;
}

/** AES-GCM key + secret topic, both derived from (password, room). */
export async function deriveRelayKeys(password, room) {
  const te = new TextEncoder();
  const r = normalizeRoom(room);
  const base = await crypto.subtle.importKey('raw', te.encode(password), 'PBKDF2', false, ['deriveKey']);
  const aes = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: te.encode(`atherion-coach-relay:${r}`), iterations: 150000, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  const hmac = await deriveKey(password, r);
  const tag = new Uint8Array(await crypto.subtle.sign('HMAC', hmac, te.encode(`topic:${r}`)));
  const topic = `atherion-coach/v1/${[...tag.slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
  return { aes, topic };
}

export async function seal(aes, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aes, new TextEncoder().encode(JSON.stringify(obj))));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return out;
}

export async function open(aes, bytes) {
  try {
    if (bytes.length < 29) return null;
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, aes, bytes.slice(12));
    const obj = JSON.parse(new TextDecoder().decode(pt));
    return obj && typeof obj === 'object' ? obj : null;
  } catch {
    return null; // wrong password, tampered or foreign message
  }
}

/**
 * Keeps MQTT connections alive. `all`: stay connected to every broker
 * (phone – PCs may pick any); otherwise the first broker that works (PC).
 */
class BrokerLink {
  constructor({ all, onMessage, onState }) {
    this.urls = brokerUrls();
    this.all = all;
    this.onMessage = onMessage;
    this.onState = onState || (() => {});
    this.clients = new Map(); // url -> MqttClient (connected)
    this.topics = new Set();
    this.stopped = false;
    this.timers = new Set();
  }

  get connected() { return this.clients.size > 0; }

  start() {
    if (this.all) this.urls.forEach((u) => this.#run([u], 0));
    else this.#run(this.urls, 0);
  }

  #later(fn, ms) {
    const t = setTimeout(() => { this.timers.delete(t); fn(); }, ms);
    this.timers.add(t);
  }

  async #run(urls, attempt) {
    if (this.stopped) return;
    for (const url of urls) {
      const c = new MqttClient(url);
      c.onmessage = (topic, payload) => this.onMessage(topic, payload);
      try {
        await c.connect();
      } catch {
        continue;
      }
      if (this.stopped) { c.close(); return; }
      for (const t of this.topics) c.subscribe(t);
      this.clients.set(url, c);
      this.onState();
      c.onclose = () => {
        this.clients.delete(url);
        this.onState();
        this.#later(() => this.#run(urls, 0), 2000);
      };
      return;
    }
    this.#later(() => this.#run(urls, attempt + 1), Math.min(30000, 3000 * (attempt + 1)));
  }

  subscribe(topic) {
    this.topics.add(topic);
    for (const c of this.clients.values()) c.subscribe(topic);
  }

  publish(topic, bytes) {
    for (const c of this.clients.values()) c.publish(topic, bytes);
  }

  stop() {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    for (const c of this.clients.values()) c.close();
    this.clients.clear();
  }
}

/* ------------------------------------------------------------------ */
/* hub (phone)                                                         */
/* ------------------------------------------------------------------ */

export class RelayHub {
  /**
   * @param {{snapshot:()=>object[], athletes:()=>object[], onChange:(info:object)=>void, onLog:(msg:string, err?:boolean)=>void}} opts
   */
  constructor(opts) {
    this.opts = opts;
    this.peer = null;
    this.key = null;
    this.room = null;
    this.viewers = new Set();   // authenticated connections
    this.fails = [];
    this.lockedUntil = 0;
    this.status = 'off';
    // broker fallback
    this.link = null;
    this.relay = null;
    this.mqttViewers = new Map(); // viewer id -> last hello
    this.pending = [];
    this.sid = nonce();
    this.seq = 0;
    this.needSnap = false;
    this.lastSnap = 0;
    this.flushTimer = null;
  }

  get active() { return this.status !== 'off'; }

  get viewerCount() { return this.viewers.size + this.mqttViewers.size; }

  #set(status) {
    this.status = status;
    this.opts.onChange({ status, room: this.room, viewers: this.viewerCount });
  }

  async start(room, password) {
    await this.stop();
    this.room = normalizeRoom(room);
    this.key = await deriveKey(password, this.room);
    this.relay = await deriveRelayKeys(password, this.room);
    this.#set('connecting');
    this.#startRelay();
    try {
      const Peer = await PeerClass();
      await this.#open(Peer, 0);
    } catch (err) {
      // No direct connections possible – carry on through the broker if it works.
      for (let i = 0; i < 16 && this.link && !this.link.connected; i++) await new Promise((r) => setTimeout(r, 500));
      if (!this.link?.connected) { await this.stop(); throw err; }
      this.opts.onLog('Priame spojenie nie je dostupné – zdieľam cez záložný server');
      this.#set('online');
    }
  }

  #startRelay() {
    this.link = new BrokerLink({
      all: true,
      onMessage: (topic, payload) => this.#onRelay(topic, payload),
      onState: () => this.#set(this.status),
    });
    this.link.subscribe(`${this.relay.topic}/ctl`);
    this.link.start();
    this.flushTimer = setInterval(() => this.#flush(), 1000);
  }

  async #onRelay(topic, payload) {
    if (!this.relay || topic !== `${this.relay.topic}/ctl`) return;
    const msg = await open(this.relay.aes, payload);
    if (!msg || msg.t !== 'hello' || typeof msg.id !== 'string' || !(Math.abs(Date.now() - msg.ts) < MAX_CLOCK_SKEW_MS)) return;
    const isNew = !this.mqttViewers.has(msg.id);
    this.mqttViewers.set(msg.id, Date.now());
    if (isNew) {
      this.needSnap = true;
      this.opts.onLog('PC sa pripojilo k zdieľaniu (cez záložný server)');
      this.#set(this.status);
      this.#flush();
    }
  }

  /** Once a second: one encrypted batch with all updates for PCs on the broker path. */
  async #flush() {
    const now = Date.now();
    let changed = false;
    for (const [id, t] of this.mqttViewers) {
      if (now - t > VIEWER_TTL_MS) { this.mqttViewers.delete(id); changed = true; }
    }
    if (changed) this.#set(this.status);
    if (!this.mqttViewers.size || !this.link?.connected) { this.pending = []; return; }
    const msg = { t: 'b', sid: this.sid, seq: ++this.seq, ts: now, ups: this.pending };
    this.pending = [];
    if (this.needSnap || now - this.lastSnap > 15000) {
      msg.snap = { sensors: this.opts.snapshot(), athletes: this.opts.athletes() };
      this.needSnap = false;
      this.lastSnap = now;
    }
    const link = this.link;
    const bytes = await seal(this.relay.aes, msg);
    if (link === this.link) link.publish(`${this.relay.topic}/data`, bytes);
  }

  #open(Peer, attempt) {
    return new Promise((resolve, reject) => {
      const peer = new Peer(PEER_PREFIX + this.room, peerOptions());
      this.peer = peer;
      peer.on('open', () => { this.#set('online'); resolve(); });
      peer.on('connection', (conn) => this.#accept(conn));
      peer.on('disconnected', () => {
        if (this.peer !== peer || peer.destroyed) return;
        this.#set('reconnecting');
        setTimeout(() => { if (this.peer === peer && !peer.destroyed) peer.reconnect(); }, 2000);
      });
      peer.on('error', (err) => {
        if (this.peer !== peer) return;
        if (err.type === 'unavailable-id' && attempt < 5) {
          // Our previous session may still be registered on the server for a few seconds.
          peer.destroy();
          setTimeout(() => this.#open(Peer, attempt + 1).then(resolve, reject), 3000);
        } else if (this.status === 'connecting') {
          this.#set('off');
          reject(new Error(err.type === 'unavailable-id' ? 'Tento kód už používa iné zariadenie' : `Zdieľanie zlyhalo (${err.type})`));
        } else if (err.type === 'network' || err.type === 'server-error' || err.type === 'socket-error') {
          this.#set('reconnecting');
        }
      });
    });
  }

  #accept(conn) {
    let authed = false;
    const challenge = nonce();
    const timer = setTimeout(() => { if (!authed) conn.close(); }, AUTH_TIMEOUT_MS);

    conn.on('open', () => {
      if (Date.now() < this.lockedUntil) {
        conn.send({ t: 'denied', reason: 'locked' });
        setTimeout(() => conn.close(), 300);
        return;
      }
      conn.send({ t: 'challenge', v: PROTOCOL, nonce: challenge });
    });

    conn.on('data', async (msg) => {
      if (!msg || typeof msg !== 'object') return;
      if (!authed && msg.t === 'auth') {
        const ok = typeof msg.mac === 'string' && await verify(this.key, 'viewer', challenge, msg.mac);
        if (!ok) {
          this.#fail();
          conn.send({ t: 'denied', reason: Date.now() < this.lockedUntil ? 'locked' : 'password' });
          setTimeout(() => conn.close(), 300);
          return;
        }
        authed = true;
        clearTimeout(timer);
        this.viewers.add(conn);
        conn.send({
          t: 'welcome',
          mac: typeof msg.nonce === 'string' ? await sign(this.key, 'hub', msg.nonce) : null,
          sensors: this.opts.snapshot(),
          athletes: this.opts.athletes(),
        });
        this.opts.onLog('PC sa pripojilo k zdieľaniu');
        this.#set(this.status);
      }
    });

    const drop = () => {
      clearTimeout(timer);
      if (this.viewers.delete(conn)) this.#set(this.status);
    };
    conn.on('close', drop);
    conn.on('error', drop);
  }

  #fail() {
    const now = Date.now();
    this.fails = this.fails.filter((t) => now - t < FAIL_WINDOW_MS);
    this.fails.push(now);
    this.opts.onLog('Pokus o pripojenie so zlým heslom', true);
    if (this.fails.length >= MAX_FAILS) {
      this.lockedUntil = now + LOCK_MS;
      this.fails = [];
      this.opts.onLog('Príliš veľa zlých hesiel – zdieľanie zamknuté na 1 minútu', true);
    }
  }

  #send(msg) {
    for (const conn of this.viewers) {
      try { if (conn.open) conn.send(msg); } catch { /* channel closing */ }
    }
  }

  update(u) {
    if (this.viewers.size) this.#send({ t: 'u', u });
    if (this.mqttViewers.size) {
      this.pending.push(u);
      if (this.pending.length > 1000) this.pending.shift();
    }
  }

  athletesChanged() {
    if (this.viewers.size) this.#send({ t: 'athletes', athletes: this.opts.athletes() });
    this.needSnap = true;
  }

  async stop() {
    clearInterval(this.flushTimer);
    this.link?.stop();
    this.link = null;
    this.mqttViewers.clear();
    this.pending = [];
    const peer = this.peer;
    this.peer = null;
    for (const conn of this.viewers) { try { conn.send({ t: 'bye' }); } catch { /* ignore */ } }
    this.viewers.clear();
    if (peer) { await new Promise((r) => setTimeout(r, 100)); peer.destroy(); }
    if (this.status !== 'off') this.#set('off');
  }
}

/* ------------------------------------------------------------------ */
/* viewer (PC)                                                         */
/* ------------------------------------------------------------------ */

export class RelayViewer {
  /**
   * Direct path status: connecting (signalling server) → dialing (looking for
   * the phone) → auth (password check) → online; on trouble waiting (phone not
   * sharing) or failed (no direct path) – both keep retrying.
   * Meanwhile the encrypted broker path runs in parallel; while the direct path
   * is not online and broker data is flowing, the status is "relay".
   * @param {{onUpdate:(u:object)=>void, onAthletes:(list:object[])=>void, onChange:(info:object)=>void}} opts
   */
  constructor(opts) {
    this.opts = opts;
    this.peer = null;
    this.conn = null;
    this.room = null;
    this.key = null;
    this.rtc = 'off';
    this.status = 'off';
    this.retryTimer = null;
    this.failures = 0;
    // broker fallback
    this.link = null;
    this.relay = null;
    this.vid = nonce();
    this.relaySid = null;
    this.relaySeq = 0;
    this.lastRelayAt = 0;
    this.helloTimer = null;
    this.freshTimer = null;
  }

  get active() { return this.status !== 'off'; }

  #computed() {
    if (this.rtc === 'off') return 'off';
    if (this.rtc === 'online') return 'online';
    if (Date.now() - this.lastRelayAt < RELAY_FRESH_MS) return 'relay';
    return this.rtc;
  }

  #emit(extra = {}, force = false) {
    const status = this.#computed();
    if (!force && status === this.status && !Object.keys(extra).length) return;
    this.status = status;
    this.opts.onChange({ status, room: this.room, failures: this.failures, ...extra });
  }

  #set(rtc, extra = {}) {
    const was = this.rtc;
    this.rtc = rtc;
    if (was === 'online' && rtc !== 'online') this.#hello();
    this.#emit(extra, true);
  }

  async connect(room, password) {
    this.stop();
    this.room = normalizeRoom(room);
    this.key = await deriveKey(password, this.room);
    this.relay = await deriveRelayKeys(password, this.room);
    this.failures = 0;
    this.#set('connecting');
    this.#startRelay();

    let Peer;
    try {
      Peer = await PeerClass();
    } catch {
      this.#set('failed', { reason: 'server' });
      return;
    }
    if (this.rtc === 'off') return;
    const peer = new Peer(peerOptions());
    this.peer = peer;
    const timer = setTimeout(() => {
      if (this.peer === peer && !peer.open) this.#set('failed', { reason: 'server' });
    }, 15000);
    peer.on('open', () => {
      clearTimeout(timer);
      if (this.peer === peer && !this.conn) this.#dial();
    });
    peer.on('error', (err) => {
      if (this.peer !== peer) return;
      if (err.type === 'peer-unavailable') {
        this.#drop();
        this.#set('waiting');
        this.#retry(3000);
      } else if (!peer.open) {
        clearTimeout(timer);
        this.#set('failed', { reason: 'server' });
      }
    });
    peer.on('disconnected', () => {
      if (this.peer === peer && !peer.destroyed) setTimeout(() => !peer.destroyed && peer.reconnect(), 2000);
    });
  }

  /* ---------- broker path ---------- */

  #startRelay() {
    this.link = new BrokerLink({
      all: false,
      onMessage: (topic, payload) => this.#onRelay(topic, payload),
      onState: () => this.#hello(),
    });
    this.link.subscribe(`${this.relay.topic}/data`);
    this.link.start();
    this.helloTimer = setInterval(() => this.#hello(), HELLO_EVERY_MS);
    this.freshTimer = setInterval(() => this.#emit(), 2000);
  }

  /** Ask the phone to publish through the broker (only needed without a direct connection). */
  async #hello() {
    if (!this.link?.connected || this.rtc === 'online' || this.rtc === 'off') return;
    const link = this.link;
    const bytes = await seal(this.relay.aes, { t: 'hello', id: this.vid, ts: Date.now() });
    if (link === this.link) link.publish(`${this.relay.topic}/ctl`, bytes);
  }

  async #onRelay(topic, payload) {
    if (!this.relay || topic !== `${this.relay.topic}/data`) return;
    const msg = await open(this.relay.aes, payload);
    if (!msg || msg.t !== 'b' || typeof msg.seq !== 'number' || typeof msg.sid !== 'string') return;
    // Drop replays: new phone session must be recent, within a session seq must grow.
    if (msg.sid !== this.relaySid) {
      if (!(Math.abs(Date.now() - msg.ts) < MAX_CLOCK_SKEW_MS)) return;
      this.relaySid = msg.sid;
    } else if (msg.seq <= this.relaySeq) {
      return;
    }
    this.relaySeq = msg.seq;
    if (this.rtc === 'online' || this.rtc === 'off') return; // direct path wins, avoid duplicates
    this.lastRelayAt = Date.now();
    if (msg.snap) {
      this.opts.onAthletes(Array.isArray(msg.snap.athletes) ? msg.snap.athletes : []);
      for (const u of Array.isArray(msg.snap.sensors) ? msg.snap.sensors : []) this.opts.onUpdate(u);
    }
    for (const u of Array.isArray(msg.ups) ? msg.ups : []) this.opts.onUpdate(u);
    this.#emit();
  }

  /* ---------- direct path ---------- */

  #retry(ms) {
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      if (this.peer && !this.peer.destroyed && !this.conn) this.#dial();
    }, ms);
  }

  /** Forget the current data connection (PeerJS emits no 'close' for one that never opened). */
  #drop() {
    const conn = this.conn;
    this.conn = null;
    if (conn) { try { conn.close(); } catch { /* ignore */ } }
  }

  #dial() {
    this.#drop();
    if (!this.peer || this.peer.destroyed) return;
    const conn = this.peer.connect(PEER_PREFIX + this.room, { reliable: true, serialization: 'json' });
    this.conn = conn;
    this.#set('dialing');
    let opened = false;
    let welcomed = false;
    let myNonce = null;

    const fail = (reason) => {
      if (this.conn !== conn || welcomed) return;
      clearTimeout(timer);
      this.#drop();
      this.failures++;
      this.#set('failed', { reason });
      this.#retry(Math.min(60000, 5000 * this.failures));
    };
    // ICE through strict NATs can take a while, but not this long.
    const timer = setTimeout(() => fail(opened ? 'auth' : 'ice'), 20000);

    conn.on('open', () => {
      if (this.conn !== conn) return;
      opened = true;
      this.#set('auth');
    });
    conn.on('iceStateChanged', (st) => {
      if (st === 'failed' && !opened) fail('ice');
    });

    conn.on('data', async (msg) => {
      if (this.conn !== conn || !msg || typeof msg !== 'object') return;
      if (msg.t === 'challenge') {
        myNonce = nonce();
        conn.send({ t: 'auth', mac: await sign(this.key, 'viewer', msg.nonce), nonce: myNonce });
      } else if (msg.t === 'welcome') {
        if (!msg.mac || !(await verify(this.key, 'hub', myNonce, msg.mac))) {
          this.stop();
          this.#set('off', { error: 'Mobil sa nepreukázal správnym heslom' });
          return;
        }
        welcomed = true;
        clearTimeout(timer);
        this.failures = 0;
        this.#set('online');
        this.opts.onAthletes(msg.athletes || []);
        for (const u of msg.sensors || []) this.opts.onUpdate(u);
      } else if (msg.t === 'denied') {
        const error = msg.reason === 'locked'
          ? 'Mobil dočasne zablokoval pripájanie po zlých heslách. Skúste o minútu.'
          : 'Nesprávne heslo';
        this.stop();
        this.#set('off', { error, denied: true });
      } else if (!welcomed) {
        // ignore anything before authentication
      } else if (msg.t === 'u') {
        this.opts.onUpdate(msg.u);
      } else if (msg.t === 'athletes') {
        this.opts.onAthletes(msg.athletes || []);
      } else if (msg.t === 'bye') {
        this.#set('waiting');
      }
    });

    conn.on('close', () => {
      clearTimeout(timer);
      if (this.conn !== conn || this.rtc === 'off') return;
      this.conn = null;
      this.#set('waiting');
      this.#retry(3000);
    });
    conn.on('error', () => {});
  }

  stop() {
    clearTimeout(this.retryTimer);
    clearInterval(this.helloTimer);
    clearInterval(this.freshTimer);
    this.link?.stop();
    this.link = null;
    this.relaySid = null;
    this.relaySeq = 0;
    this.lastRelayAt = 0;
    const peer = this.peer;
    this.peer = null;
    this.conn = null;
    if (peer) peer.destroy();
    if (this.rtc !== 'off') { this.rtc = 'off'; this.#emit({}, true); }
  }
}
