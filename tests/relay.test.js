import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveKey, sign, verify, normalizeRoom, randomRoom } from '../js/relay.js';

test('relay: password proof verifies only with the same password and room', async () => {
  const room = 'K7M2QX';
  const good = await deriveKey('tajne123', room);
  const same = await deriveKey('tajne123', room.toLowerCase());
  const wrongPw = await deriveKey('tajne124', room);
  const wrongRoom = await deriveKey('tajne123', 'K7M2QY');
  const mac = await sign(same, 'viewer', 'nonce-1');
  assert.equal(await verify(good, 'viewer', 'nonce-1', mac), true);
  assert.equal(await verify(good, 'viewer', 'nonce-2', mac), false);   // replay with another challenge
  assert.equal(await verify(good, 'hub', 'nonce-1', mac), false);      // reflected as the hub's proof
  assert.equal(await verify(good, 'viewer', 'nonce-1', await sign(wrongPw, 'viewer', 'nonce-1')), false);
  assert.equal(await verify(good, 'viewer', 'nonce-1', await sign(wrongRoom, 'viewer', 'nonce-1')), false);
  assert.equal(await verify(good, 'viewer', 'nonce-1', 'not base64!'), false);
});

test('relay: room codes', () => {
  assert.equal(normalizeRoom(' k7m-2qx '), 'K7M2QX');
  const r = randomRoom();
  assert.match(r, /^[A-HJ-NP-Z2-9]{6}$/);
});

test('relay: broker payloads are end-to-end encrypted with the password', async () => {
  const { deriveRelayKeys, seal, open } = await import('../js/relay.js');
  const a = await deriveRelayKeys('tajne123', 'K7M2QX');
  const b = await deriveRelayKeys('tajne123', 'k7m2qx');
  const wrong = await deriveRelayKeys('tajne124', 'K7M2QX');
  assert.equal(a.topic, b.topic);
  assert.notEqual(a.topic, wrong.topic);              // wrong password → different (secret) topic
  assert.match(a.topic, /^atherion-coach\/v1\/[0-9a-f]{32}$/);
  assert.ok(!a.topic.includes('K7M2QX'));
  const bytes = await seal(a.aes, { t: 'b', hr: 150 });
  assert.ok(!new TextDecoder().decode(bytes).includes('150'));
  assert.deepEqual(await open(b.aes, bytes), { t: 'b', hr: 150 });
  assert.equal(await open(wrong.aes, bytes), null);
  bytes[20] ^= 1;                                       // tampered
  assert.equal(await open(a.aes, bytes), null);
});

test('mqtt: packets round-trip through the stream parser', async () => {
  const { publishPacket, connectPacket, MqttParser, parsePublish } = await import('../js/mqtt.js');
  const payload = new Uint8Array(300).map((_, i) => i & 0xff); // needs a 2-byte length
  const pub = publishPacket('a/b', payload);
  const parser = new MqttParser();
  const stream = new Uint8Array([...connectPacket('x', 30), ...pub]);
  assert.equal(parser.push(stream.slice(0, 20)).length, 1);  // CONNECT complete, PUBLISH partial
  const [p] = parser.push(stream.slice(20));
  assert.equal(p.type, 0x30);
  const m = parsePublish(p);
  assert.equal(m.topic, 'a/b');
  assert.deepEqual([...m.payload], [...payload]);
});
