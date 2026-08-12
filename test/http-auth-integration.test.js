import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { generateTotp } from '../src/auth.js';

const mongoUri = process.env.TEST_MONGODB_URI;
const totpSecret = 'JBSWY3DPEHPK3PXP';

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForHealth(baseUrl, child) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server terminato con codice ${child.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Server di test non disponibile');
}

function cookiesFrom(response) {
  const values = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')].filter(Boolean);
  return values.map((value) => value.split(';')[0]).join('; ');
}

function csrfFrom(cookieHeader) {
  const part = cookieHeader.split(';').map((value) => value.trim()).find((value) => value.startsWith('impresa_csrf='));
  return part ? decodeURIComponent(part.slice('impresa_csrf='.length)) : '';
}

async function jsonRequest(url, { method = 'GET', cookie = '', csrf = '', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = cookie;
  if (csrf) headers['X-CSRF-Token'] = csrf;
  return fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

test('HTTP reale: anonimato bloccato, PIN, CSRF e MFA step-up', {
  skip: !mongoUri,
  timeout: 90_000
}, async (t) => {
  const port = await freePort();
  const databaseName = `impresa_http_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const pin = '246810';
  const child = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      MONGODB_URI: mongoUri,
      MONGODB_DB: databaseName,
      NODE_ENV: 'test',
      COOKIE_SECURE: 'false',
      TRUST_PROXY: 'false',
      SCHEDULER_ENABLED: 'false',
      PIN_HASH_ADMIN: crypto.createHash('sha256').update(pin).digest('hex'),
      PIN_SCRYPT_ADMIN: '',
      MFA_TOTP_SECRET: totpSecret,
      MFA_STEPUP_MINUTES: '10'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let logs = '';
  child.stdout.on('data', (chunk) => { logs += chunk.toString(); });
  child.stderr.on('data', (chunk) => { logs += chunk.toString(); });
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
    await new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', resolve);
      setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 5_000).unref();
    });
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(baseUrl, child).catch((error) => {
    throw new Error(`${error.message}\n${logs}`);
  });

  const anonymous = await jsonRequest(`${baseUrl}/api/config`);
  assert.equal(anonymous.status, 401);

  const login = await jsonRequest(`${baseUrl}/api/auth/pin-login`, { method: 'POST', body: { pin } });
  assert.equal(login.status, 200);
  const cookie = cookiesFrom(login);
  const csrf = csrfFrom(cookie);
  assert.match(cookie, /impresa_session=/);
  assert.match(csrf, /^[A-Za-z0-9_-]+$/);

  const config = await jsonRequest(`${baseUrl}/api/config`, { cookie });
  assert.equal(config.status, 200);

  const noCsrf = await jsonRequest(`${baseUrl}/api/movimenti`, {
    method: 'POST', cookie,
    body: { conto: 'CASSA', direzione: 'ENTRATA', importo: 10, descrizione: 'Incasso test' }
  });
  assert.equal(noCsrf.status, 403);

  const movement = await jsonRequest(`${baseUrl}/api/movimenti`, {
    method: 'POST', cookie, csrf,
    body: { conto: 'CASSA', direzione: 'ENTRATA', importo: 10, descrizione: 'Incasso test' }
  });
  assert.equal(movement.status, 201);

  const sensitive = await jsonRequest(`${baseUrl}/api/tributi`, {
    method: 'POST', cookie, csrf,
    body: { namespace: 'CODICE_TRIBUTO_AE', codice: '1001', descrizione: 'Esempio', fonte: 'Fonte sintetica verificabile' }
  });
  assert.equal(sensitive.status, 428);
  assert.equal((await sensitive.json()).code, 'MFA_REQUIRED');

  const mfa = await jsonRequest(`${baseUrl}/api/auth/mfa`, {
    method: 'POST', cookie, csrf,
    body: { code: generateTotp(totpSecret, new Date()) }
  });
  assert.equal(mfa.status, 200);

  const afterMfa = await jsonRequest(`${baseUrl}/api/tributi`, {
    method: 'POST', cookie, csrf,
    body: { namespace: 'CODICE_TRIBUTO_AE', codice: '1001', descrizione: 'Esempio', fonte: 'Fonte sintetica verificabile' }
  });
  assert.equal(afterMfa.status, 201);
});
