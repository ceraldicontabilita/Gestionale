import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { strToU8, zipSync } from 'fflate';
import { MongoClient } from 'mongodb';

const mongoUri = process.env.TEST_MONGODB_URI;
const supplierInvoiceXml = `<?xml version="1.0" encoding="UTF-8"?>
<FatturaElettronica>
  <FatturaElettronicaHeader><CedentePrestatore><DatiAnagrafici><IdFiscaleIVA><IdCodice>00000000000</IdCodice></IdFiscaleIVA><Anagrafica><Denominazione>Fornitore HTTP test</Denominazione></Anagrafica></DatiAnagrafici></CedentePrestatore></FatturaElettronicaHeader>
  <FatturaElettronicaBody><DatiGenerali><DatiGeneraliDocumento><TipoDocumento>TD01</TipoDocumento><Divisa>EUR</Divisa><Data>2026-08-01</Data><Numero>HTTP-1</Numero><ImportoTotaleDocumento>12.20</ImportoTotaleDocumento></DatiGeneraliDocumento></DatiGenerali><DatiBeniServizi><DettaglioLinee><NumeroLinea>1</NumeroLinea><Descrizione>Test</Descrizione><PrezzoUnitario>10</PrezzoUnitario><PrezzoTotale>10</PrezzoTotale><AliquotaIVA>22</AliquotaIVA></DettaglioLinee><DatiRiepilogo><AliquotaIVA>22</AliquotaIVA><ImponibileImporto>10</ImponibileImporto><Imposta>2.20</Imposta></DatiRiepilogo></DatiBeniServizi></FatturaElettronicaBody>
</FatturaElettronica>`;

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

test('HTTP reale: anonimato, PIN, CSRF e riconferma PIN sulle operazioni sensibili', {
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
      PIN_CONFIRMATION_MINUTES: '10'
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

  const invoiceBytes = Buffer.from(supplierInvoiceXml);
  const importJobResponse = await jsonRequest(`${baseUrl}/api/supplier-invoices/import-jobs`, {
    method: 'POST', cookie, csrf,
    body: { files: [{ name: 'fattura-http.xml', size: invoiceBytes.length }] }
  });
  assert.equal(importJobResponse.status, 201);
  const importJob = await importJobResponse.json();
  const invoiceUpload = await fetch(`${baseUrl}/api/supplier-invoices/import-jobs/${importJob.jobId}/files/0`, {
    method: 'POST',
    headers: {
      Cookie: cookie,
      'X-CSRF-Token': csrf,
      'X-File-Name': encodeURIComponent('fattura-http.xml'),
      'Content-Type': 'application/octet-stream'
    },
    body: invoiceBytes
  });
  assert.equal(invoiceUpload.status, 201);
  const completedImport = await jsonRequest(`${baseUrl}/api/supplier-invoices/import-jobs/${importJob.jobId}`, { cookie });
  assert.equal(completedImport.status, 200);
  const completedJob = await completedImport.json();
  assert.equal(completedJob.status, 'COMPLETED');
  assert.equal(completedJob.totals.insertedInvoices, 1);

  const nestedZip = zipSync({ 'seconda.xml': strToU8(supplierInvoiceXml) });
  const duplicateArchive = Buffer.from(zipSync({ 'prima.xml': strToU8(supplierInvoiceXml), 'annidato.zip': nestedZip }));
  const zipJobResponse = await jsonRequest(`${baseUrl}/api/supplier-invoices/import-jobs`, {
    method: 'POST', cookie, csrf,
    body: { files: [{ name: 'duplicati.zip', size: duplicateArchive.length }] }
  });
  assert.equal(zipJobResponse.status, 201);
  const zipJob = await zipJobResponse.json();
  const zipUpload = await fetch(`${baseUrl}/api/supplier-invoices/import-jobs/${zipJob.jobId}/files/0`, {
    method: 'POST',
    headers: {
      Cookie: cookie,
      'X-CSRF-Token': csrf,
      'X-File-Name': encodeURIComponent('duplicati.zip'),
      'Content-Type': 'application/octet-stream'
    },
    body: duplicateArchive
  });
  assert.equal(zipUpload.status, 201);
  const completedZipJob = await (await jsonRequest(`${baseUrl}/api/supplier-invoices/import-jobs/${zipJob.jobId}`, { cookie })).json();
  assert.equal(completedZipJob.status, 'COMPLETED');
  assert.equal(completedZipJob.totals.insertedInvoices, 0);
  assert.equal(completedZipJob.totals.duplicateInvoices, 2);

  const testClient = new MongoClient(mongoUri);
  await testClient.connect();
  t.after(() => testClient.close());
  await testClient.db(databaseName).collection('auth_sessions').updateMany({}, { $set: { pinConfirmedAt: new Date(0) } });

  const accountingValidationWithoutPin = await jsonRequest(`${baseUrl}/api/supplier-invoices/validate`, {
    method: 'POST', cookie, csrf, body: { sourceKey: 'not-relevant-before-auth-check' }
  });
  assert.equal(accountingValidationWithoutPin.status, 428);
  assert.equal((await accountingValidationWithoutPin.json()).code, 'PIN_CONFIRMATION_REQUIRED');

  const sensitive = await jsonRequest(`${baseUrl}/api/tributi`, {
    method: 'POST', cookie, csrf,
    body: { namespace: 'CODICE_TRIBUTO_AE', codice: '1001', descrizione: 'Esempio', fonte: 'Fonte sintetica verificabile' }
  });
  assert.equal(sensitive.status, 428);
  assert.equal((await sensitive.json()).code, 'PIN_CONFIRMATION_REQUIRED');

  const wrongPin = await jsonRequest(`${baseUrl}/api/auth/pin-confirm`, {
    method: 'POST', cookie, csrf,
    body: { pin: '000000' }
  });
  assert.equal(wrongPin.status, 403);

  const pinConfirmation = await jsonRequest(`${baseUrl}/api/auth/pin-confirm`, {
    method: 'POST', cookie, csrf,
    body: { pin }
  });
  assert.equal(pinConfirmation.status, 200);

  const afterPinConfirmation = await jsonRequest(`${baseUrl}/api/tributi`, {
    method: 'POST', cookie, csrf,
    body: { namespace: 'CODICE_TRIBUTO_AE', codice: '1001', descrizione: 'Esempio', fonte: 'Fonte sintetica verificabile' }
  });
  assert.equal(afterPinConfirmation.status, 201);

  await testClient.db(databaseName).collection('auth_sessions').updateMany({}, { $set: { pinConfirmedAt: new Date(0) } });
  const destructiveAttempt = await jsonRequest(`${baseUrl}/api/documenti/synthetic`, {
    method: 'DELETE', cookie, csrf
  });
  assert.equal(destructiveAttempt.status, 428);
  assert.equal((await destructiveAttempt.json()).code, 'PIN_CONFIRMATION_REQUIRED');
});
