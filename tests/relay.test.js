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
