import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { createServiceAccountAssertion } from '../src/google-auth.js';

test('firma una richiesta Google Drive limitata alla sola lettura', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const at = new Date('2026-08-12T12:00:00Z');
  const assertion = createServiceAccountAssertion({
    client_email: 'gestionale@example.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' })
  }, at);
  const [header, payload, signature] = assertion.split('.');
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  assert.equal(claims.scope, 'https://www.googleapis.com/auth/drive.readonly');
  assert.equal(claims.aud, 'https://oauth2.googleapis.com/token');
  assert.equal(claims.exp - claims.iat, 3630);
  assert.equal(crypto.verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, 'base64url')), true);
});

test('rifiuta identità tecniche incomplete', () => {
  assert.throws(() => createServiceAccountAssertion({ client_email: 'manca-chiave@example.com' }), /non valida/);
});
