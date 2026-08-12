import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  authConfigured,
  generateTotp,
  mfaConfigured,
  parseCookies,
  verifyAdminPin,
  verifyTotp
} from '../src/auth.js';

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

test('genera e verifica TOTP con finestra temporale limitata', () => {
  const secret = 'JBSWY3DPEHPK3PXP';
  const at = new Date('2026-08-12T10:00:00.000Z');
  const code = generateTotp(secret, at);
  assert.match(code, /^\d{6}$/);
  assert.equal(mfaConfigured({ MFA_TOTP_SECRET: secret }), true);
  assert.equal(verifyTotp(secret, code, at), true);
  assert.equal(verifyTotp(secret, code, new Date(at.getTime() + 3 * 60_000)), false);
  assert.equal(mfaConfigured({ MFA_TOTP_SECRET: 'non-base32' }), false);
});

test('analizza cookie senza confondere valori contenenti uguale', () => {
  const cookies = parseCookies('a=uno; impresa_session=abc%3Ddef; x=2');
  assert.equal(cookies.impresa_session, 'abc=def');
});
