import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseHeartRateMeasurement, parseRscMeasurement, parseCyclingPowerMeasurement, crankCadence,
  parseAntHeartRate, parseAntSdm, parseAntPower, antMessage, AntStreamParser, parseAntExtendedData,
} from '../js/parsers.js';
import { zoneOf, intensityOf, rmssd, formatPace, formatDuration } from '../js/metrics.js';
import { buildTcx } from '../js/export.js';

const dv = (bytes) => new DataView(new Uint8Array(bytes).buffer);

test('BLE HR: uint8 value with RR intervals', () => {
  // flags: RR present (0x10) + contact supported & detected (0x06)
  const m = parseHeartRateMeasurement(dv([0x16, 72, 0x00, 0x04, 0x33, 0x03]));
  assert.equal(m.hr, 72);
  assert.equal(m.contact, true);
  assert.deepEqual(m.rr, [1000, 800]); // 1024/1024 s, 819/1024 s
});

test('BLE HR: uint16 value with energy expended', () => {
  const m = parseHeartRateMeasurement(dv([0x09, 0x2c, 0x01, 0x10, 0x00]));
  assert.equal(m.hr, 300);
  assert.equal(m.energy, 16);
  assert.equal(m.contact, null);
  assert.deepEqual(m.rr, []);
});

test('BLE RSC with stride length and distance', () => {
  // speed 3.5 m/s = 896/256, cadence 88, stride 120 cm, distance 1234.5 m
  const m = parseRscMeasurement(dv([0x07, 0x80, 0x03, 88, 120, 0, 0x39, 0x30, 0, 0]));
  assert.equal(m.speed, 3.5);
  assert.equal(m.cadence, 88);
  assert.equal(m.strideLength, 1.2);
  assert.equal(m.distance, 1234.5);
  assert.equal(m.running, true);
});

test('BLE cycling power with crank data → cadence', () => {
  const a = parseCyclingPowerMeasurement(dv([0x20, 0x00, 250, 0, 10, 0, 0x00, 0x04]));
  const b = parseCyclingPowerMeasurement(dv([0x20, 0x00, 0x04, 0x01, 11, 0, 0x55, 0x07]));
  assert.equal(a.power, 250);
  assert.equal(b.power, 260);
  // 1 rev in (0x0755-0x0400)/1024 s = 0.8330 s → 72 rpm
  assert.equal(crankCadence(a, b), 72);
  assert.equal(crankCadence(b, b), null);
});

test('ANT+ HR page 4 gives RR from previous event time', () => {
  // prev event 0x0400, current 0x0800 → 1024 ticks = 1000 ms
  const p = parseAntHeartRate([0x84, 0xff, 0x00, 0x04, 0x00, 0x08, 17, 60], { beatCount: 16 });
  assert.equal(p.page, 4);
  assert.equal(p.hr, 60);
  assert.deepEqual(p.rr, [1000]);
  // same beat repeated → no duplicate RR
  const q = parseAntHeartRate([0x04, 0xff, 0x00, 0x04, 0x00, 0x08, 17, 60], p);
  assert.deepEqual(q.rr, []);
});

test('ANT+ HR page 7 battery and page 2 manufacturer', () => {
  const b = parseAntHeartRate([0x07, 85, 0x80, 0x23, 0, 0, 1, 70], null);
  assert.equal(b.battery, 85);
  assert.equal(b.batteryStatus, 'dobrá');
  assert.equal(b.batteryVoltage, 3.5);
  const m = parseAntHeartRate([0x82, 1, 0x39, 0x30, 0, 0, 1, 70], null);
  assert.equal(m.manufacturerId, 1);
  assert.equal(m.serial, 12345);
});

test('ANT+ SDM and power pages', () => {
  const s1 = parseAntSdm([1, 0, 0, 100, 0x83, 0x80, 5, 0]);
  assert.equal(s1.distanceRaw, 100.5);
  assert.equal(s1.speed, 3.5);
  const s2 = parseAntSdm([2, 0, 0, 85, 0x83, 0x80, 0, 0]);
  assert.equal(s2.cadence, 85.5);
  const p = parseAntPower([0x10, 7, 0xff, 90, 0, 0, 0x2c, 0x01]);
  assert.equal(p.power, 300);
  assert.equal(p.cadence, 90);
});

test('ANT framing round-trip and extended data', () => {
  const reset = antMessage(0x4a, [0]);
  assert.deepEqual([...reset], [0xa4, 0x01, 0x4a, 0x00, 0xa4 ^ 0x01 ^ 0x4a]);

  const data = [0, 0x04, 0, 0, 0, 0, 0x08, 5, 140, 0xc0, 0x39, 0x30, 120, 0x01, 0x20, 0xc4, 0x80];
  const msg = antMessage(0x4e, data);
  const parser = new AntStreamParser();
  // split delivery + garbage byte in front
  const first = parser.push(new Uint8Array([0x00, ...msg.slice(0, 7)]));
  assert.equal(first.length, 0);
  const out = parser.push(msg.slice(7));
  assert.equal(out.length, 1);
  const ext = parseAntExtendedData(out[0].data);
  assert.equal(ext.deviceNumber, 12345);
  assert.equal(ext.deviceType, 120);
  assert.equal(ext.rssi, -60);
  assert.equal(ext.payload[7], 140);
});

test('zones, Karvonen and helpers', () => {
  const a = { maxHr: 200 };
  assert.equal(zoneOf(95, a), 0);
  assert.equal(zoneOf(130, a), 2);
  assert.equal(zoneOf(185, a), 5);
  const k = { maxHr: 200, restHr: 50 };
  assert.equal(intensityOf(125, k), 0.5);
  assert.equal(zoneOf(125, k), 1);
  assert.equal(rmssd([800, 810, 790, 800]), 14);
  assert.equal(formatPace(1000 / 300), '5:00');
  assert.equal(formatDuration(3725), '1:02:05');
});

test('TCX export is well formed', () => {
  const t0 = Date.UTC(2026, 0, 1, 10, 0, 0);
  const xml = buildTcx({
    label: 'Ján <test>', kcal: 12.4,
    samples: [
      { t: t0 + 1000, hr: 120, speed: 3, cadence: 170, power: null, distance: 3 },
      { t: t0 + 2000, hr: 124, speed: 3, cadence: 172, power: null, distance: 6 },
    ],
  }, t0);
  assert.match(xml, /<Activity Sport="Running">/);
  assert.match(xml, /<AverageHeartRateBpm><Value>122<\/Value>/);
  assert.match(xml, /<ns3:RunCadence>86<\/ns3:RunCadence>/);
  assert.match(xml, /Ján &lt;test&gt;/);
  assert.equal((xml.match(/<Trackpoint>/g) || []).length, 2);
});
