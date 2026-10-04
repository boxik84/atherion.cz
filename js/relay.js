// Phone → PC relay over WebRTC (PeerJS).
//
// The phone ("hub") is connected to the sensors and forwards every sensor
// update to any number of PCs ("viewers"). Data flows peer-to-peer and is
// encrypted by WebRTC (DTLS); the public PeerJS server is only used to find
// the other side.
//
// Access is protected by a password that never leaves the device: both sides
// derive an HMAC key from (password, room) with PBKDF2 and prove knowledge of
// it with a challenge/response. Repeated failures lock the room for a while.

const PEER_PREFIX = 'atherion-coach-';
const PROTOCOL = 1;
const AUTH_TIMEOUT_MS = 10000;
const MAX_FAILS = 5;
const FAIL_WINDOW_MS = 60000;
const LOCK_MS = 60000;
const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

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

/** Optional self-hosted signalling server: ?peerhost=host:port (used for local testing). */
function peerOptions() {
  const host = new URLSearchParams(location.search).get('peerhost');
  if (!host) return { debug: 0 };
  const [h, p] = host.split(':');
  return { host: h, port: Number(p || 9000), path: '/', secure: location.protocol === 'https:', debug: 0 };
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
  }

  get active() { return this.status !== 'off'; }

  #set(status) {
    this.status = status;
    this.opts.onChange({ status, room: this.room, viewers: this.viewers.size });
  }

  async start(room, password) {
    await this.stop();
    this.room = normalizeRoom(room);
    this.key = await deriveKey(password, this.room);
    const Peer = await PeerClass();
    this.#set('connecting');
    await this.#open(Peer, 0);
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
  }

  athletesChanged() {
    if (this.viewers.size) this.#send({ t: 'athletes', athletes: this.opts.athletes() });
  }

  async stop() {
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
   * @param {{onUpdate:(u:object)=>void, onAthletes:(list:object[])=>void, onChange:(info:object)=>void}} opts
   */
  constructor(opts) {
    this.opts = opts;
    this.peer = null;
    this.conn = null;
    this.room = null;
    this.key = null;
    this.status = 'off';
    this.retryTimer = null;
  }

  get active() { return this.status !== 'off'; }

  #set(status, extra = {}) {
    this.status = status;
    this.opts.onChange({ status, room: this.room, ...extra });
  }

  async connect(room, password) {
    this.stop();
    this.room = normalizeRoom(room);
    this.key = await deriveKey(password, this.room);
    const Peer = await PeerClass();
    this.#set('connecting');
    await new Promise((resolve, reject) => {
      const peer = new Peer(peerOptions());
      this.peer = peer;
      peer.on('open', () => { resolve(); this.#dial(); });
      peer.on('error', (err) => {
        if (this.peer !== peer) return;
        if (err.type === 'peer-unavailable') {
          this.#set('waiting');
          this.#retry();
        } else if (this.status === 'connecting' && !this.conn) {
          reject(new Error(`Pripojenie zlyhalo (${err.type})`));
          this.stop();
        }
      });
      peer.on('disconnected', () => {
        if (this.peer === peer && !peer.destroyed) setTimeout(() => !peer.destroyed && peer.reconnect(), 2000);
      });
    });
  }

  #retry(ms = 3000) {
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => { if (this.peer && !this.peer.destroyed) this.#dial(); }, ms);
  }

  #dial() {
    if (this.conn) { try { this.conn.close(); } catch { /* ignore */ } }
    const conn = this.peer.connect(PEER_PREFIX + this.room, { reliable: true, serialization: 'json' });
    this.conn = conn;
    let welcomed = false;
    let myNonce = null;
    const openTimer = setTimeout(() => { if (!welcomed && this.conn === conn) { conn.close(); } }, AUTH_TIMEOUT_MS + 2000);

    conn.on('data', async (msg) => {
      if (this.conn !== conn || !msg || typeof msg !== 'object') return;
      if (msg.t === 'challenge') {
        myNonce = nonce();
        conn.send({ t: 'auth', mac: await sign(this.key, 'viewer', msg.nonce), nonce: myNonce });
      } else if (msg.t === 'welcome') {
        if (!msg.mac || !(await verify(this.key, 'hub', myNonce, msg.mac))) {
          conn.close();
          this.stop();
          this.#set('off', { error: 'Mobil sa nepreukázal správnym heslom' });
          return;
        }
        welcomed = true;
        clearTimeout(openTimer);
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
      clearTimeout(openTimer);
      if (this.conn !== conn || this.status === 'off') return;
      this.#set('waiting');
      this.#retry();
    });
    conn.on('error', () => {});
  }

  stop() {
    clearTimeout(this.retryTimer);
    const peer = this.peer;
    this.peer = null;
    this.conn = null;
    if (peer) peer.destroy();
    if (this.status !== 'off') this.#set('off');
  }
}
