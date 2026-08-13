import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { MongoClient } from 'mongodb';

import {
  changeAccountingPeriod,
  dispatchPendingEvents,
  publishDomainEvent,
  registerPostingRule,
  requeueOutboxEvent
} from '../src/event-engine.js';

const uri = process.env.TEST_MONGODB_URI;

function competenceEvent() {
  return {
    type: 'invoice.supplier_validated',
    aggregate: { type: 'INVOICE_SUPPLIER', id: 'fattura-test-1', version: '1' },
    accounting: {
      entryKind: 'DOCUMENT_COMPETENCE',
      source: { type: 'INVOICE_SUPPLIER', id: 'fattura-test-1', version: '1' },
      postingRule: { id: 'FATTURA_PASSIVA_TEST', version: '1' },
      dates: {
        documentDate: '2026-08-01',
        receiptDate: '2026-08-02',
        competenceDate: '2026-08-01',
        registrationDate: '2026-08-03',
        vatDate: '2026-08-02',
        dueDate: '2026-09-01'
      },
      lines: [
        { accountCode: 'COSTI_MERCI', debit: 100 },
        { accountCode: 'IVA_CREDITO', debit: 22 },
        { accountCode: 'DEBITI_FORNITORI', credit: 122 }
      ],
      description: 'Fixture sintetica senza dati reali'
    },
    provenance: { source: 'TEST_SINTETICO', reference: 'sha256:fixture-sintetica' }
  };
}

test('motore eventi MongoDB: regola approvata, outbox e proiezione sono idempotenti', {
  skip: !uri,
  timeout: 90_000
}, async (t) => {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10_000 });
  await client.connect();
  const db = client.db(`event_engine_test_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`);
  t.after(async () => {
    await db.dropDatabase().catch(() => {});
    await client.close();
  });
  const context = { client, db };
  await changeAccountingPeriod(context, {
    year: 2026, month: 8, action: 'OPEN', reason: 'Apertura fixture sintetica'
  }, { actor: 'TEST', now: new Date('2026-08-01T08:00:00Z') });
  const rule = {
    ruleId: 'FATTURA_PASSIVA_TEST',
    version: '1',
    allowedEntryKinds: ['DOCUMENT_COMPETENCE'],
    allowedAccounts: ['COSTI_MERCI', 'IVA_CREDITO', 'DEBITI_FORNITORI'],
    description: 'Regola sintetica di integrazione',
    approvalReason: 'Fixture automatica'
  };
  const firstRule = await registerPostingRule(context, rule, { actor: 'TEST', now: new Date('2026-08-03T09:00:00Z') });
  const retryRule = await registerPostingRule(context, rule, { actor: 'TEST', now: new Date('2026-08-03T09:05:00Z') });
  assert.equal(firstRule.duplicate, false);
  assert.equal(retryRule.duplicate, true);

  const first = await publishDomainEvent(context, competenceEvent(), { now: new Date('2026-08-03T10:00:00Z') });
  const retry = await publishDomainEvent(context, competenceEvent(), { now: new Date('2026-08-03T10:05:00Z') });
  assert.equal(first.duplicate, false);
  assert.equal(retry.duplicate, true);
  const dispatched = await dispatchPendingEvents(context, { limit: 10, now: new Date('2026-08-03T10:06:00Z') });
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].status, 'COMPLETED');
  assert.equal(await db.collection('domain_events').countDocuments(), 1);
  assert.equal(await db.collection('accounting_entries').countDocuments(), 1);
  assert.equal(await db.collection('accounting_balances').countDocuments(), 3);
  assert.equal(await db.collection('projection_outbox').countDocuments(), 4);
  const supplierBalance = await db.collection('accounting_balances').findOne({ accountCode: 'DEBITI_FORNITORI' });
  assert.equal(supplierBalance.balanceCents, -12_200);

  const replay = await requeueOutboxEvent(context, first.event.eventKey, {
    actor: 'TEST', reason: 'Verifica replay idempotente', now: new Date('2026-08-03T10:07:00Z')
  });
  assert.equal(replay.status, 'PENDING');
  await dispatchPendingEvents(context, { limit: 10, now: new Date('2026-08-03T10:08:00Z') });
  assert.equal(await db.collection('accounting_entries').countDocuments(), 1);
  assert.equal(await db.collection('projection_outbox').countDocuments(), 4);
  assert.equal(await db.collection('event_outbox').countDocuments({ status: 'COMPLETED' }), 1);

  const closed = await changeAccountingPeriod(context, {
    year: 2026, month: 8, action: 'CLOSE', reason: 'Chiusura fixture sintetica'
  }, { actor: 'TEST', now: new Date('2026-08-31T18:00:00Z') });
  assert.equal(closed.status, 'CLOSED');
  await assert.rejects(
    publishDomainEvent(context, {
      ...competenceEvent(),
      aggregate: { type: 'INVOICE_SUPPLIER', id: 'fattura-test-2', version: '1' },
      accounting: {
        ...competenceEvent().accounting,
        source: { type: 'INVOICE_SUPPLIER', id: 'fattura-test-2', version: '1' }
      }
    }),
    /ACCOUNTING_PERIOD_NOT_OPEN/
  );
});
