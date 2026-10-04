// Bluetooth LE sensors via Web Bluetooth (Chrome / Edge / Android, Bluefy on iOS).
// Works with Garmin HRM 600 / HRM-Pro / HRM-Pro Plus / HRM-Dual / HRM-Fit / HRM 200,
// Garmin watches in "Broadcast heart rate" mode and any standard BLE HR strap.

import {
  parseHeartRateMeasurement,
  parseRscMeasurement,
  parseCyclingPowerMeasurement,
  crankCadence,
} from './parsers.js';

const OPTIONAL_SERVICES = [
  'heart_rate',
  'battery_service',
  'device_information',
  'running_speed_and_cadence',
  'cycling_power',
];

const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 15000, 30000];

export class BleManager {
  /** @param {(update:object)=>void} onUpdate */
  constructor(onUpdate) {
    this.onUpdate = onUpdate;
    this.devices = new Map(); // id -> {device, manual, attempt, timer, lastCrank}
  }

  static isSupported() {
    return typeof navigator !== 'undefined' && !!navigator.bluetooth;
  }

  /** Opens the browser picker and connects the chosen sensor. */
  async add() {
    const device = await navigator.bluetooth.requestDevice({
      filters: [
        { services: ['heart_rate'] },
        { services: ['running_speed_and_cadence'] },
        { services: ['cycling_power'] },
        { namePrefix: 'HRM' },
        { namePrefix: 'Forerunner' },
        { namePrefix: 'fenix' },
      ],
      optionalServices: OPTIONAL_SERVICES,
    });
    await this.#attach(device);
    return this.idOf(device);
  }

  idOf(device) {
    return `ble:${device.id}`;
  }

  async #attach(device) {
    const id = this.idOf(device);
    if (this.devices.has(id)) {
      const entry = this.devices.get(id);
      entry.manual = false;
      if (!device.gatt.connected) await this.#connect(entry);
      return;
    }
    const entry = { id, device, manual: false, attempt: 0, timer: null, lastCrank: null };
    this.devices.set(id, entry);
    device.addEventListener('gattserverdisconnected', () => this.#onDisconnected(entry));
    try {
      await this.#connect(entry);
    } catch (err) {
      this.devices.delete(id);
      this.onUpdate({ id, source: 'ble', name: device.name, status: 'disconnected' });
      throw err;
    }
  }

  async #connect(entry) {
    const { id, device } = entry;
    const name = device.name || 'BLE senzor';
    this.onUpdate({ id, source: 'ble', name, status: 'connecting' });

    const server = await device.gatt.connect();
    entry.attempt = 0;

    const info = {};
    await this.#subscribe(server, 'heart_rate', 'heart_rate_measurement', (dv) => {
      const m = parseHeartRateMeasurement(dv);
      this.onUpdate({ id, source: 'ble', name, hr: m.hr, rr: m.rr, contact: m.contact });
    }, info);

    await this.#subscribe(server, 'running_speed_and_cadence', 'rsc_measurement', (dv) => {
      const m = parseRscMeasurement(dv);
      this.onUpdate({ id, source: 'ble', name, speed: m.speed, cadence: m.cadence, distance: m.distance });
    }, info);

    await this.#subscribe(server, 'cycling_power', 'cycling_power_measurement', (dv) => {
      const m = parseCyclingPowerMeasurement(dv);
      const cad = crankCadence(entry.lastCrank, m);
      if (m.crankRevs != null) entry.lastCrank = m;
      const upd = { id, source: 'ble', name, power: m.power };
      if (cad != null) upd.cadence = cad;
      this.onUpdate(upd);
    }, info);

    // Battery: read once and subscribe if the sensor supports notifications.
    try {
      const svc = await server.getPrimaryService('battery_service');
      const ch = await svc.getCharacteristic('battery_level');
      const v = await ch.readValue();
      this.onUpdate({ id, source: 'ble', name, battery: v.getUint8(0) });
      if (ch.properties.notify) {
        ch.addEventListener('characteristicvaluechanged', (e) =>
          this.onUpdate({ id, source: 'ble', name, battery: e.target.value.getUint8(0) }));
        await ch.startNotifications();
      }
    } catch { /* no battery service */ }

    try {
      const svc = await server.getPrimaryService('device_information');
      const read = async (c) => {
        try { return new TextDecoder().decode(await (await svc.getCharacteristic(c)).readValue()); }
        catch { return null; }
      };
      const manufacturer = await read('manufacturer_name_string');
      const model = await read('model_number_string');
      this.onUpdate({ id, source: 'ble', name, manufacturer, model });
    } catch { /* optional */ }

    if (!info.any) {
      this.onUpdate({ id, source: 'ble', name, status: 'error', error: 'Senzor neposiela žiadne podporované dáta' });
      return;
    }
    this.onUpdate({ id, source: 'ble', name, status: 'connected' });
  }

  async #subscribe(server, service, characteristic, handler, info) {
    try {
      const svc = await server.getPrimaryService(service);
      const ch = await svc.getCharacteristic(characteristic);
      ch.addEventListener('characteristicvaluechanged', (e) => handler(e.target.value));
      await ch.startNotifications();
      info.any = true;
    } catch { /* service not present on this sensor */ }
  }

  #onDisconnected(entry) {
    const { id, device } = entry;
    if (entry.manual || this.devices.get(id) !== entry) return;
    const delay = RECONNECT_DELAYS[Math.min(entry.attempt, RECONNECT_DELAYS.length - 1)];
    entry.attempt++;
    this.onUpdate({ id, source: 'ble', name: device.name, status: 'reconnecting' });
    clearTimeout(entry.timer);
    entry.timer = setTimeout(async () => {
      if (entry.manual) return;
      try { await this.#connect(entry); }
      catch { this.#onDisconnected(entry); }
    }, delay);
  }

  disconnect(id) {
    const entry = this.devices.get(id);
    if (!entry) return;
    entry.manual = true;
    clearTimeout(entry.timer);
    this.devices.delete(id);
    if (entry.device.gatt.connected) entry.device.gatt.disconnect();
    this.onUpdate({ id, source: 'ble', name: entry.device.name, status: 'disconnected' });
  }

  disconnectAll() {
    for (const id of [...this.devices.keys()]) this.disconnect(id);
  }
}
