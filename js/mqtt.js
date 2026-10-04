// Minimal MQTT 3.1.1 client over WebSocket (QoS 0 only) – just what the
// encrypted relay fallback needs, without pulling in a 300 kB library.

const enc = new TextEncoder();
const dec = new TextDecoder();

function varint(n) {
  const out = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) b |= 0x80;
    out.push(b);
  } while (n > 0);
  return out;
}

function str(s) {
  const b = enc.encode(s);
  return [b.length >> 8, b.length & 0xff, ...b];
}

function packet(type, body) {
  const head = [type, ...varint(body.length)];
  const out = new Uint8Array(head.length + body.length);
  out.set(head);
  out.set(body, head.length);
  return out;
}

export function connectPacket(clientId, keepalive) {
  return packet(0x10, [...str('MQTT'), 4, 0x02, keepalive >> 8, keepalive & 0xff, ...str(clientId)]);
}

export function subscribePacket(id, topic) {
  return packet(0x82, [id >> 8, id & 0xff, ...str(topic), 0]);
}

export function publishPacket(topic, payload) {
  const t = str(topic);
  const body = new Uint8Array(t.length + payload.length);
  body.set(t);
  body.set(payload, t.length);
  return packet(0x30, body);
}

/** Incremental parser: push bytes, get complete packets {type, flags, body}. */
export class MqttParser {
  constructor() { this.buf = new Uint8Array(0); }

  push(chunk) {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf);
    merged.set(chunk, this.buf.length);
    const out = [];
    let i = 0;
    for (;;) {
      if (merged.length - i < 2) break;
      let len = 0;
      let mul = 1;
      let j = i + 1;
      let complete = false;
      for (let k = 0; k < 4 && j < merged.length; k++, j++) {
        len += (merged[j] & 0x7f) * mul;
        mul *= 128;
        if (!(merged[j] & 0x80)) { complete = true; j++; break; }
      }
      if (!complete || j + len > merged.length) break;
      out.push({ type: merged[i] & 0xf0, flags: merged[i] & 0x0f, body: merged.slice(j, j + len) });
      i = j + len;
    }
    this.buf = merged.slice(i);
    return out;
  }
}

export function parsePublish(p) {
  const tlen = (p.body[0] << 8) | p.body[1];
  const topic = dec.decode(p.body.slice(2, 2 + tlen));
  const qos = (p.flags >> 1) & 3;
  const start = 2 + tlen + (qos ? 2 : 0);
  return { topic, payload: p.body.slice(start) };
}

export class MqttClient {
  /** @param {string} url  wss://host:port/mqtt */
  constructor(url, { keepalive = 30 } = {}) {
    this.url = url;
    this.keepalive = keepalive;
    this.ws = null;
    this.parser = new MqttParser();
    this.nextId = 1;
    this.onmessage = () => {};
    this.onclose = () => {};
    this.pingTimer = null;
    this.connected = false;
  }

  connect(timeout = 8000) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) { try { this.ws.close(); } catch { /* ignore */ } reject(err); } else resolve();
      };
      const timer = setTimeout(() => done(new Error(`MQTT timeout ${this.url}`)), timeout);
      const ws = new WebSocket(this.url, 'mqtt');
      this.ws = ws;
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => {
        const id = `ac-${Math.random().toString(36).slice(2, 12)}`;
        ws.send(connectPacket(id, this.keepalive));
      };
      ws.onmessage = (e) => {
        for (const p of this.parser.push(new Uint8Array(e.data))) {
          if (p.type === 0x20) {
            if (p.body[1] === 0) {
              this.connected = true;
              this.pingTimer = setInterval(() => this.#send(new Uint8Array([0xc0, 0])), this.keepalive * 800);
              done();
            } else {
              done(new Error(`MQTT odmietnuté (${p.body[1]})`));
            }
          } else if (p.type === 0x30) {
            const m = parsePublish(p);
            try { this.onmessage(m.topic, m.payload); } catch { /* handler error */ }
          }
        }
      };
      ws.onerror = () => done(new Error(`MQTT chyba ${this.url}`));
      ws.onclose = () => {
        const was = this.connected;
        this.connected = false;
        clearInterval(this.pingTimer);
        done(new Error(`MQTT zatvorené ${this.url}`));
        if (was) this.onclose();
      };
    });
  }

  #send(bytes) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(bytes);
  }

  subscribe(topic) {
    const id = this.nextId++ & 0xffff || 1;
    this.#send(subscribePacket(id, topic));
  }

  publish(topic, payload) {
    this.#send(publishPacket(topic, payload));
  }

  close() {
    this.connected = false;
    clearInterval(this.pingTimer);
    this.onclose = () => {};
    if (this.ws) {
      try { this.#send(new Uint8Array([0xe0, 0])); this.ws.close(); } catch { /* ignore */ }
    }
  }
}
