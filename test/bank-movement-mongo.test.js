import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { MongoClient } from 'mongodb';
import { importBankStatementRows, parseBankStatementCsv } from '../src/bank-movement-import.js';
import { dispatchPendingEvents } from '../src/event-engine.js';

const uri = process.env.TEST_MONGODB_URI;
const fixture = Buffer.from([
  '"Ragione Sociale";"Data contabile";"Data valuta";"Banca";"Rapporto";"Importo";"Divisa";"Descrizione";"Categoria/sottocategoria";"Hashtag"',
  '"Impresa sintetica";"01/08/2026";"02/08/2026";"BANCA TEST";"0000";"-12,20";"EUR";"BONIFICO NS RIF. SYNTHETIC01";"PAGAMENTI";""',
  '"Impresa sintetica";"03/08/2026";"03/08/2026";"BANCA TEST";"0000";"25,10";"EUR";"ACCREDITO TEST";"INCASSI";""'
].join('\n'));

test('import bancario MongoDB: sovrapposizioni, evento e proiezione restano idempotenti', { skip: !uri, timeout: 90_000 }, async (t) => {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10_000 });
  await client.connect();
  const hello = await client.db('admin').command({ hello: 1 });
  if (!hello.setName) { await client.close(); t.skip('TEST_MONGODB_URI deve puntare a un replica set MongoDB'); return; }
  const db = client.db(`bank_movement_test_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`);
  t.after(async () => { await db.dropDatabase().catch(() => {}); await client.close(); });
  const rows = parseBankStatementCsv(fixture);
  const first = await importBankStatementRows({ client, db }, rows, { sha256: 'a'.repeat(64), gridFsId: 'grid-a', filename: 'estratto-a.csv' }, { actor: 'TEST', now: new Date('2026-08-13T10:00:00Z') });
  const retry = await importBankStatementRows({ client, db }, rows, { sha256: 'a'.repeat(64), gridFsId: 'grid-a', filename: 'estratto-a.csv' }, { actor: 'TEST', now: new Date('2026-08-13T10:05:00Z') });
  const overlap = await importBankStatementRows({ client, db }, rows, { sha256: 'b'.repeat(64), gridFsId: 'grid-b', filename: 'estratto-b.csv' }, { actor: 'TEST', now: new Date('2026-08-13T10:10:00Z') });
  assert.deepEqual({ inserted: first.inserted, duplicates: first.duplicates }, { inserted: 2, duplicates: 0 });
  assert.deepEqual({ inserted: retry.inserted, duplicates: retry.duplicates }, { inserted: 0, duplicates: 2 });
  assert.deepEqual({ inserted: overlap.inserted, duplicates: overlap.duplicates }, { inserted: 0, duplicates: 2 });
  assert.equal(await db.collection('movimenti').countDocuments(), 2);
  assert.equal(await db.collection('domain_events').countDocuments({ type: 'financial.movement_observed' }), 2);
  assert.equal(await db.collection('event_outbox').countDocuments(), 2);
  const dispatched = await dispatchPendingEvents({ client, db }, { limit: 10, now: new Date('2026-08-13T10:15:00Z') });
  assert.equal(dispatched.length, 2);
  assert.ok(dispatched.every((row) => row.status === 'COMPLETED'));
  assert.equal(await db.collection('financial_movement_projection').countDocuments(), 2);
  assert.equal(await db.collection('accounting_entries').countDocuments(), 0);
  const stored = await db.collection('movimenti').findOne({ movementKey: rows[0].movementKey });
  assert.equal(stored.sourceRows.length, 2);
  assert.equal(stored.stato, 'DOCUMENTATO');
  assert.equal(stored.evidenze[0].reale, true);
});
