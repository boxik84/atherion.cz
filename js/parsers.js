// Pure decoders for Bluetooth LE GATT characteristics and ANT+ data pages.
// No DOM / browser APIs here so the file can be unit-tested in Node.

/* ------------------------------------------------------------------ */
/* Bluetooth LE                                                        */
/* ------------------------------------------------------------------ */

/**
 * Heart Rate Measurement (0x2A37).
 * @param {DataView} dv
 * @returns {{hr:number, contact:boolean|null, energy:number|null, rr:number[]}}
 *   rr = RR intervals in milliseconds
 */
export function parseHeartRateMeasurement(dv) {
  const flags = dv.getUint8(0);
  let o = 1;
  let hr;
  if (flags & 0x01) { hr = dv.getUint16(o, true); o += 2; }
  else { hr = dv.getUint8(o); o += 1; }

  const contactSupported = (flags & 0x04) !== 0;
  const contact = contactSupported ? (flags & 0x02) !== 0 : null;

  let energy = null;
  if (flags & 0x08) { energy = dv.getUint16(o, true); o += 2; }

  const rr = [];
  if (flags & 0x10) {
    for (; o + 1 < dv.byteLength; o += 2) {
      rr.push(Math.round((dv.getUint16(o, true) / 1024) * 1000));
    }
  }
  return { hr, contact, energy, rr };
}

/**
 * Running Speed and Cadence Measurement (0x2A53).
 * @returns {{speed:number, cadence:number, strideLength:number|null, distance:number|null, running:boolean}}
 *   speed m/s, cadence 1/min, strideLength m, distance m
 */
export function parseRscMeasurement(dv) {
  const flags = dv.getUint8(0);
  const speed = dv.getUint16(1, true) / 256;
  const cadence = dv.getUint8(3);
  let o = 4;
  let strideLength = null;
  let distance = null;
  if (flags & 0x01) { strideLength = dv.getUint16(o, true) / 100; o += 2; }
  if (flags & 0x02) { distance = dv.getUint32(o, true) / 10; o += 4; }
  return { speed, cadence, strideLength, distance, running: (flags & 0x04) !== 0 };
}

/**
 * Cycling Power Measurement (0x2A63).
 * @returns {{power:number, crankRevs:number|null, crankTime:number|null}}
 *   crankTime in 1/1024 s (raw, wraps at 65536)
 */
export function parseCyclingPowerMeasurement(dv) {
  const flags = dv.getUint16(0, true);
  const power = dv.getInt16(2, true);
  let o = 4;
  if (flags & 0x0001) o += 1;        // pedal power balance
  if (flags & 0x0004) o += 2;        // accumulated torque
  if (flags & 0x0010) o += 6;        // wheel revolution data
  let crankRevs = null;
  let crankTime = null;
  if ((flags & 0x0020) && o + 4 <= dv.byteLength) {
    crankRevs = dv.getUint16(o, true);
    crankTime = dv.getUint16(o + 2, true);
  }
  return { power, crankRevs, crankTime };
}

/**
 * Cadence from two consecutive cumulative crank readings
 * (works for both BLE CP/CSC and ANT+ — revs uint16, time 1/1024 s uint16).
 * Returns null when no new revolution happened.
 */
export function crankCadence(prev, cur) {
  if (!prev || prev.crankRevs == null || cur.crankRevs == null) return null;
  const dRevs = (cur.crankRevs - prev.crankRevs + 65536) % 65536;
  const dTime = (cur.crankTime - prev.crankTime + 65536) % 65536;
  if (dRevs === 0 || dTime === 0) return null;
  return Math.round((dRevs * 1024 * 60) / dTime);
}

/* ------------------------------------------------------------------ */
/* ANT+                                                                */
/* ------------------------------------------------------------------ */

export const ANT_DEVICE_TYPE = {
  HR: 120,
  SDM: 124,   // stride based speed & distance (foot pod, HRM-Pro Plus)
  POWER: 11,
};

const BATTERY_STATUS = { 1: 'nová', 2: 'dobrá', 3: 'ok', 4: 'slabá', 5: 'kritická' };

/**
 * ANT+ Heart Rate data page (8 bytes).
 * `prev` is the previous decoded page of the same sensor, used for RR.
 */
export function parseAntHeartRate(bytes, prev) {
  const page = bytes[0] & 0x7f;
  const eventTime = bytes[4] | (bytes[5] << 8);
  const beatCount = bytes[6];
  const hr = bytes[7];
  const out = { page, hr, beatCount, eventTime, rr: [] };

  if (page === 4) {
    const prevEventTime = bytes[2] | (bytes[3] << 8);
    const prevBeatCount = prev ? prev.beatCount : null;
    if (prevBeatCount == null || prevBeatCount !== beatCount) {
      const rr = ((eventTime - prevEventTime + 65536) % 65536) / 1024 * 1000;
      if (rr > 250 && rr < 2500) out.rr.push(Math.round(rr));
    }
  } else if (prev && prev.beatCount !== beatCount) {
    // Fallback for legacy pages: only trust a single-beat step.
    const dBeats = (beatCount - prev.beatCount + 256) % 256;
    if (dBeats === 1) {
      const rr = ((eventTime - prev.eventTime + 65536) % 65536) / 1024 * 1000;
      if (rr > 250 && rr < 2500) out.rr.push(Math.round(rr));
    }
  }

  if (page === 2) {
    out.manufacturerId = bytes[1];
    out.serial = bytes[2] | (bytes[3] << 8);
  } else if (page === 3) {
    out.hwVersion = bytes[1];
    out.swVersion = bytes[2];
    out.model = bytes[3];
  } else if (page === 7) {
    out.battery = bytes[1] === 0xff ? null : bytes[1];
    out.batteryVoltage = (bytes[3] & 0x0f) + bytes[2] / 256;
    out.batteryStatus = BATTERY_STATUS[(bytes[3] >> 4) & 0x07] || null;
  }
  return out;
}

/** ANT+ Stride Based Speed & Distance (foot pod). */
export function parseAntSdm(bytes) {
  const page = bytes[0];
  const out = { page };
  if (page === 1) {
    out.distanceRaw = bytes[3] + (bytes[4] >> 4) / 16;     // m, wraps at 256
    out.speed = (bytes[4] & 0x0f) + bytes[5] / 256;        // m/s
    out.strides = bytes[6];
  } else if (page === 2 || page === 3) {
    out.cadence = bytes[3] + (bytes[4] >> 4) / 16;          // strides/min
    out.speed = (bytes[4] & 0x0f) + bytes[5] / 256;
  }
  return out;
}

/** ANT+ Bicycle Power — standard power-only page 0x10. */
export function parseAntPower(bytes) {
  const page = bytes[0];
  const out = { page };
  if (page === 0x10) {
    out.eventCount = bytes[1];
    out.cadence = bytes[3] === 0xff ? null : bytes[3];
    out.power = bytes[6] | (bytes[7] << 8);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* ANT serial message framing                                          */
/* ------------------------------------------------------------------ */

export const ANT_SYNC = 0xa4;

/** Build an ANT message: SYNC, LEN, ID, DATA..., CHECKSUM */
export function antMessage(id, data) {
  const msg = new Uint8Array(data.length + 4);
  msg[0] = ANT_SYNC;
  msg[1] = data.length;
  msg[2] = id;
  msg.set(data, 3);
  let cs = 0;
  for (let i = 0; i < msg.length - 1; i++) cs ^= msg[i];
  msg[msg.length - 1] = cs;
  return msg;
}

/**
 * Incremental parser for the ANT byte stream coming from a USB stick.
 * push() returns an array of complete messages {id, data:Uint8Array}.
 */
export class AntStreamParser {
  constructor() { this.buf = new Uint8Array(0); }

  push(chunk) {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf);
    merged.set(chunk, this.buf.length);
    let b = merged;
    const out = [];
    let i = 0;
    while (i < b.length) {
      if (b[i] !== ANT_SYNC) { i++; continue; }
      if (i + 1 >= b.length) break;
      const len = b[i + 1];
      const total = len + 4;
      if (i + total > b.length) break;
      let cs = 0;
      for (let k = i; k < i + total - 1; k++) cs ^= b[k];
      if (cs !== b[i + total - 1]) { i++; continue; }
      out.push({ id: b[i + 2], data: b.slice(i + 3, i + 3 + len) });
      i += total;
    }
    this.buf = b.slice(i);
    return out;
  }
}

/**
 * Decode a broadcast/ack data message (0x4E / 0x4F) carrying extended data.
 * data = [channel, 8 payload bytes, flag, ...extended]
 */
export function parseAntExtendedData(data) {
  const channel = data[0];
  const payload = data.slice(1, 9);
  const res = { channel, payload, deviceNumber: null, deviceType: null, transType: null, rssi: null };
  if (data.length <= 9) return res;
  const flag = data[9];
  let o = 10;
  if (flag & 0x80) {
    res.deviceNumber = data[o] | (data[o + 1] << 8);
    res.deviceType = data[o + 2] & 0x7f;
    res.transType = data[o + 3];
    // upper nibble of transmission type extends the device number to 20 bits
    res.deviceNumber += ((res.transType >> 4) & 0x0f) << 16;
    o += 4;
  }
  if (flag & 0x40) {
    const v = data[o + 1];
    res.rssi = v > 127 ? v - 256 : v;
    o += 3;
  }
  return res;
}
