// ANT+ via a USB stick (Garmin USB ANT Stick / ANT USB-m / USB2) using WebUSB.
// The stick runs in continuous scan mode, so ONE stick receives every
// ANT+ heart-rate strap, foot pod and power meter in range at the same time —
// ideal for a coach watching a whole group.

import {
  antMessage,
  AntStreamParser,
  parseAntExtendedData,
  parseAntHeartRate,
  parseAntSdm,
  parseAntPower,
  ANT_DEVICE_TYPE,
} from './parsers.js';

const USB_FILTERS = [
  { vendorId: 0x0fcf, productId: 0x1008 }, // ANT USB2 Stick
  { vendorId: 0x0fcf, productId: 0x1009 }, // ANT USB-m Stick (Garmin USB ANT Stick)
  { vendorId: 0x0fcf },                    // other Dynastream / Garmin ANT devices
];

// Public ANT+ network key.
const ANTPLUS_KEY = [0xb9, 0xa5, 0x21, 0xfb, 0xbd, 0x72, 0xc3, 0x45];
const ANTPLUS_FREQ = 57; // 2457 MHz

const MSG = {
  CHANNEL_EVENT: 0x40,
  ASSIGN: 0x42,
  PERIOD: 0x43,
  SEARCH_TIMEOUT: 0x44,
  FREQ: 0x45,
  NETWORK_KEY: 0x46,
  RESET: 0x4a,
  OPEN: 0x4b,
  BROADCAST: 0x4e,
  ACK: 0x4f,
  BURST: 0x50,
  CHANNEL_ID: 0x51,
  OPEN_SCAN: 0x5b,
  ENABLE_EXT: 0x66,
  LIB_CONFIG: 0x6e,
  STARTUP: 0x6f,
};

const MANUFACTURERS = { 1: 'Garmin', 13: 'Dynastream', 15: 'Timex', 23: 'Suunto', 32: 'Wahoo', 123: 'Polar' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class AntManager {
  /** @param {(update:object)=>void} onUpdate  @param {(msg:string)=>void} onLog */
  constructor(onUpdate, onLog = () => {}) {
    this.onUpdate = onUpdate;
    this.onLog = onLog;
    this.device = null;
    this.parser = new AntStreamParser();
    this.waiters = [];
    this.sensors = new Map(); // id -> {prev, manufacturer, distance, lastRaw}
    this.running = false;
  }

  static isSupported() {
    return typeof navigator !== 'undefined' && !!navigator.usb;
  }

  get connected() {
    return !!this.device && this.running;
  }

  async connect() {
    const device = await navigator.usb.requestDevice({ filters: USB_FILTERS });
    await this.#open(device);
  }

  /** Re-open a stick the user already granted earlier (no picker needed). */
  async restoreKnown() {
    const devices = await navigator.usb.getDevices();
    const stick = devices.find((d) => d.vendorId === 0x0fcf);
    if (stick) { await this.#open(stick); return true; }
    return false;
  }

  async #open(device) {
    await device.open();
    if (device.configuration === null) await device.selectConfiguration(1);
    const iface = device.configuration.interfaces[0];
    await device.claimInterface(iface.interfaceNumber);
    const eps = iface.alternate.endpoints;
    this.epIn = eps.find((e) => e.direction === 'in' && e.type === 'bulk')?.endpointNumber;
    this.epOut = eps.find((e) => e.direction === 'out' && e.type === 'bulk')?.endpointNumber;
    if (this.epIn == null || this.epOut == null) throw new Error('ANT stick: nenašiel som USB endpointy');

    this.device = device;
    this.running = true;
    this.#readLoop();

    navigator.usb.addEventListener('disconnect', this.#onUsbDisconnect);
    await this.#init();
  }

  #onUsbDisconnect = (e) => {
    if (e.device !== this.device) return;
    this.onLog('ANT+ stick bol odpojený');
    this.#teardown();
  };

  async #init() {
    // Reset and wait for the startup message.
    await this.#send(MSG.RESET, [0x00]);
    await this.#waitFor((m) => m.id === MSG.STARTUP, 1500).catch(() => sleep(500));

    await this.#command(MSG.NETWORK_KEY, [0x00, ...ANTPLUS_KEY]);
    await this.#command(MSG.ASSIGN, [0x00, 0x00, 0x00]);          // ch0, receive, network 0
    await this.#command(MSG.CHANNEL_ID, [0x00, 0, 0, 0, 0]);      // wildcard: any device
    await this.#command(MSG.FREQ, [0x00, ANTPLUS_FREQ]);

    // Ask for channel ID + RSSI with every message.
    let code = await this.#command(MSG.LIB_CONFIG, [0x00, 0xc0]);
    if (code !== 0) code = await this.#command(MSG.ENABLE_EXT, [0x00, 0x01]);

    code = await this.#command(MSG.OPEN_SCAN, [0x00]);
    if (code === 0) {
      this.onLog('ANT+ stick pripojený – skenujem všetky senzory v dosahu');
      this.onUpdate({ id: 'ant:stick', source: 'ant', status: 'scanning' });
      return;
    }

    // Fallback for sticks without scan mode: one HR channel, first strap found.
    this.onLog('Stick nepodporuje scan mód – pripájam prvý HR pás');
    await this.#command(MSG.CHANNEL_ID, [0x00, 0, 0, ANT_DEVICE_TYPE.HR, 0]);
    await this.#command(MSG.PERIOD, [0x00, 8070 & 0xff, 8070 >> 8]);
    await this.#command(MSG.SEARCH_TIMEOUT, [0x00, 0xff]);
    await this.#command(MSG.OPEN, [0x00]);
    this.onUpdate({ id: 'ant:stick', source: 'ant', status: 'scanning' });
  }

  async #send(id, data) {
    await this.device.transferOut(this.epOut, antMessage(id, data));
  }

  /** Sends a config message and resolves with its response code (0 = OK). */
  async #command(id, data) {
    const wait = this.#waitFor((m) => m.id === MSG.CHANNEL_EVENT && m.data[1] === id, 1000);
    await this.#send(id, data);
    try { return (await wait).data[2]; }
    catch { return -1; }
  }

  #waitFor(pred, timeout) {
    return new Promise((resolve, reject) => {
      const w = { pred, resolve };
      this.waiters.push(w);
      setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) { this.waiters.splice(i, 1); reject(new Error('timeout')); }
      }, timeout);
    });
  }

  async #readLoop() {
    while (this.running && this.device) {
      let res;
      try {
        res = await this.device.transferIn(this.epIn, 64);
      } catch (err) {
        if (this.running) { this.onLog(`ANT+ chyba čítania: ${err.message}`); this.#teardown(); }
        return;
      }
      if (!res.data || res.status !== 'ok') continue;
      const msgs = this.parser.push(new Uint8Array(res.data.buffer, res.data.byteOffset, res.data.byteLength));
      for (const m of msgs) this.#handle(m);
    }
  }

  #handle(m) {
    for (let i = 0; i < this.waiters.length; i++) {
      if (this.waiters[i].pred(m)) {
        const [w] = this.waiters.splice(i, 1);
        w.resolve(m);
        return;
      }
    }
    if (m.id !== MSG.BROADCAST && m.id !== MSG.ACK && m.id !== MSG.BURST) return;

    const d = parseAntExtendedData(m.data);
    if (d.deviceType == null) return;
    const id = `ant:${d.deviceType}:${d.deviceNumber}`;
    let s = this.sensors.get(id);
    if (!s) { s = { prev: null, manufacturer: null, distance: 0, lastRaw: null }; this.sensors.set(id, s); }

    const base = { id, source: 'ant', rssi: d.rssi };

    if (d.deviceType === ANT_DEVICE_TYPE.HR) {
      const p = parseAntHeartRate(d.payload, s.prev);
      s.prev = p;
      if (p.manufacturerId != null) s.manufacturer = MANUFACTURERS[p.manufacturerId] || `výrobca ${p.manufacturerId}`;
      const upd = { ...base, name: `${s.manufacturer === 'Garmin' ? 'Garmin HRM' : 'ANT+ HR'} ${d.deviceNumber}`, hr: p.hr, rr: p.rr };
      if (p.battery != null) upd.battery = p.battery;
      if (p.batteryStatus) upd.batteryStatus = p.batteryStatus;
      if (s.manufacturer) upd.manufacturer = s.manufacturer;
      if (p.hr > 0) this.onUpdate(upd);
    } else if (d.deviceType === ANT_DEVICE_TYPE.SDM) {
      const p = parseAntSdm(d.payload);
      const upd = { ...base, name: `ANT+ Foot pod ${d.deviceNumber}` };
      if (p.speed != null) upd.speed = p.speed;
      if (p.cadence != null) upd.cadence = Math.round(p.cadence * 2); // strides → steps/min
      if (p.distanceRaw != null) {
        if (s.lastRaw != null) s.distance += (p.distanceRaw - s.lastRaw + 256) % 256;
        s.lastRaw = p.distanceRaw;
        upd.distance = s.distance;
      }
      this.onUpdate(upd);
    } else if (d.deviceType === ANT_DEVICE_TYPE.POWER) {
      const p = parseAntPower(d.payload);
      if (p.power == null) return;
      const upd = { ...base, name: `ANT+ Power ${d.deviceNumber}`, power: p.power };
      if (p.cadence != null) upd.cadence = p.cadence;
      this.onUpdate(upd);
    }
  }

  #teardown() {
    this.running = false;
    navigator.usb.removeEventListener('disconnect', this.#onUsbDisconnect);
    this.device = null;
    this.onUpdate({ id: 'ant:stick', source: 'ant', status: 'disconnected' });
  }

  async disconnect() {
    if (!this.device) return;
    const dev = this.device;
    try { await this.#send(MSG.RESET, [0x00]); } catch { /* ignore */ }
    this.#teardown();
    try { await dev.close(); } catch { /* ignore */ }
  }
}
