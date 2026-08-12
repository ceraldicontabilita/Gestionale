import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { authConfigured, parseCookies, verifyAdminPin } from '../src/auth.js';

test('verifica il PIN legacy senza conservarlo in chiaro', () => {
  const pin = '123456';
  const env = { PIN_HASH_ADMIN: crypto.createHash('sha256').update(pin).digest('hex') };
  assert.equal(authConfigured(env), true);
  assert.equal(verifyAdminPin(pin, env), true);
  assert.equal(verifyAdminPin('654321', env), false);
});

test('supporta un hash scrypt con sale', () => {
  const pin = '246810';
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pin, salt, 32);
  const env = { PIN_SCRYPT_ADMIN: `${salt.toString('hex')}:${hash.toString('hex')}` };
  assert.equal(verifyAdminPin(pin, env), true);
  assert.equal(verifyAdminPin('000000', env), false);
});

test('analizza cookie senza confondere valori contenenti uguale', () => {
  const cookies = parseCookies('a=uno; impresa_session=abc%3Ddef; x=2');
  assert.equal(cookies.impresa_session, 'abc=def');
});
