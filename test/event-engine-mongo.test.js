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
import { dispatchPendingProjections, rebuildAccountingProjections } from '../src/projection-engine.js';
import { reconcileSupplierInvoicePayment } from '../src/supplier-invoice-settlement.js';
import { validateSupplierInvoice } from '../src/supplier-invoice.js';

const uri = process.env.TEST_MONGODB_URI;

function competenceEvent() {
  return {
    type: 'invoice.supplier_validated',
    aggregate: { type: 'INVOICE_SUPPLIER', id: 'fattura-test-1', version: '1' },
    payload: {
      supplierInvoice: {
        naturalKey: 'IT00000000000|TEST-1|2026-08-01|TD01',
        supplier: { vatId: 'IT00000000000', taxId: null, name: 'Fornitore sintetico' },
        amounts: { taxableCents: 10_000, exposedVatCents: 2_200, deductibleVatCents: 2_200, totalCents: 12_200, withholdingCents: 0, payableCents: 12_200, costCents: 10_000 },
        dueDate: new Date('2026-09-01T00:00:00Z'),
        vatEntryKey: 'fattura-test-1:1:INPUT_VAT',
        obligationKey: 'SUPPLIER_INVOICE:fattura-test-1:PAYABLE'
      }
    },
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
  const hello = await client.db('admin').command({ hello: 1 });
  if (!hello.setName) {
    await client.close();
    t.skip('TEST_MONGODB_URI deve puntare a un replica set MongoDB');
    return;
  }
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

  await db.collection('fatture').insertOne({
    sourceKey: 'DRIVE_FILE:fixture-supplier-invoice:1',
    extractionVersion: 'FATTURAPA_XML_V2',
    quadraturaEstrazione: { status: 'EXACT' },
    fornitore: { partitaIva: 'IT00000000000', denominazione: 'Fornitore sintetico' },
    tipoDocumento: 'TD01', numero: 'TEST-1', data: new Date('2026-08-01T00:00:00Z'), divisa: 'EUR',
    imponibile: 100, ivaEsposta: 22, totaleDocumento: 122, ritenuta: 0,
    righe: [{ numero: 1, descrizione: 'Merce sintetica', prezzoTotale: 100, aliquotaIva: 22 }],
    riepiloghiIva: [{ aliquotaIva: 22, imponibile: 100, imposta: 22 }],
    stato: 'IMPORTATA_DA_VERIFICARE', aggiornatoIl: new Date('2026-08-02T00:00:00Z')
  });
  const validation = {
    version: '1', sourceVersion: 'fixture-1', ivaDetraibile: 22,
    receiptDate: '2026-08-02', competenceDate: '2026-08-01', registrationDate: '2026-08-03', vatDate: '2026-08-02', dueDate: '2026-09-01',
    costAccountCode: 'COSTI_MERCI', vatAccountCode: 'IVA_CREDITO', payableAccountCode: 'DEBITI_FORNITORI',
    postingRule: { id: 'FATTURA_PASSIVA_TEST', version: '1' }, reason: 'Fixture automatica'
  };
  const first = await validateSupplierInvoice(context, 'DRIVE_FILE:fixture-supplier-invoice:1', validation, { actor: 'TEST', now: new Date('2026-08-03T10:00:00Z') });
  const retry = await validateSupplierInvoice(context, 'DRIVE_FILE:fixture-supplier-invoice:1', validation, { actor: 'TEST', now: new Date('2026-08-03T10:05:00Z') });
  assert.equal(first.duplicate, false);
  assert.equal(retry.duplicate, true);
  const dispatched = await dispatchPendingEvents(context, { limit: 10, now: new Date('2026-08-03T10:06:00Z') });
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].status, 'COMPLETED');
  assert.equal(await db.collection('domain_events').countDocuments(), 1);
  assert.equal(await db.collection('accounting_entries').countDocuments(), 1);
  assert.equal(await db.collection('accounting_balances').countDocuments(), 3);
  assert.equal(await db.collection('projection_outbox').countDocuments(), 4);
  assert.equal(await db.collection('obligations').countDocuments(), 1);
  assert.equal(await db.collection('open_items').countDocuments(), 1);
  assert.equal(await db.collection('vat_entries').countDocuments(), 1);
  const supplierBalance = await db.collection('accounting_balances').findOne({ accountCode: 'DEBITI_FORNITORI' });
  assert.equal(supplierBalance.balanceCents, -12_200);

  const pageDispatch = await dispatchPendingProjections(context, { limit: 10, now: new Date('2026-08-03T10:06:30Z') });
  assert.equal(pageDispatch.length, 4);
  assert.equal(pageDispatch.every((item) => item.status === 'COMPLETED'), true);
  assert.equal(await db.collection('journal_page_projection').countDocuments(), 1);
  assert.equal(await db.collection('ledger_page_projection').countDocuments(), 3);
  assert.equal(await db.collection('chart_account_projection').countDocuments(), 3);
  assert.equal(await db.collection('trial_balance_projection').countDocuments(), 3);
  assert.equal(await db.collection('coherence_evaluations').countDocuments({ status: 'PASS' }), 1);

  const missingBalance = await db.collection('accounting_balances').findOne({ accountCode: 'COSTI_MERCI' });
  await db.collection('accounting_balances').deleteOne({ _id: missingBalance._id });
  await db.collection('projection_outbox').updateOne(
    { pageId: 'controllo.bilancio' },
    { $set: { status: 'PENDING', attempts: 0, nextAttemptAt: new Date('2026-08-03T10:06:31Z'), lockedUntil: null }, $unset: { workerId: '', completedAt: '' } }
  );
  const transientFailure = await dispatchPendingProjections(context, { limit: 1, now: new Date('2026-08-03T10:06:31Z') });
  assert.equal(transientFailure[0].status, 'RETRY');
  await db.collection('accounting_balances').insertOne(missingBalance);
  const retrySuccess = await dispatchPendingProjections(context, { limit: 1, now: new Date('2026-08-03T10:06:33Z') });
  assert.equal(retrySuccess[0].status, 'COMPLETED');

  const rebuild = await rebuildAccountingProjections(context, { actor: 'TEST', reason: 'Fixture ricostruzione', now: new Date('2026-08-03T10:06:40Z') });
  const rebuildReplay = await rebuildAccountingProjections(context, { actor: 'TEST', reason: 'Fixture replay', now: new Date('2026-08-03T10:06:50Z') });
  assert.equal(rebuild.duplicate, false);
  assert.equal(rebuildReplay.duplicate, true);
  assert.equal(await db.collection('journal_page_projection').countDocuments(), 1);

  const replay = await requeueOutboxEvent(context, first.event.eventKey, {
    actor: 'TEST', reason: 'Verifica replay idempotente', now: new Date('2026-08-03T10:07:00Z')
  });
  assert.equal(replay.status, 'PENDING');
  await dispatchPendingEvents(context, { limit: 10, now: new Date('2026-08-03T10:08:00Z') });
  assert.equal(await db.collection('accounting_entries').countDocuments(), 1);
  assert.equal(await db.collection('projection_outbox').countDocuments(), 4);
  assert.equal(await db.collection('event_outbox').countDocuments({ status: 'COMPLETED' }), 1);

  const original = await db.collection('accounting_entries').findOne({ entryKind: 'DOCUMENT_COMPETENCE' });
  await registerPostingRule(context, {
    ruleId: 'STORNO_FATTURA_PASSIVA_TEST', version: '1', allowedEntryKinds: ['REVERSAL'],
    allowedAccounts: ['COSTI_MERCI', 'IVA_CREDITO', 'DEBITI_FORNITORI'],
    description: 'Storno sintetico', approvalReason: 'Fixture automatica'
  }, { actor: 'TEST', now: new Date('2026-08-03T10:08:10Z') });
  await publishDomainEvent(context, {
    type: 'ledger.compensating_entry_projected',
    aggregate: { type: 'LEDGER_ENTRY', id: 'storno-fattura-test-1', version: '1' },
    accounting: {
      entryKind: 'REVERSAL',
      source: { type: 'LEDGER_ENTRY', id: 'storno-fattura-test-1', version: '1' },
      postingRule: { id: 'STORNO_FATTURA_PASSIVA_TEST', version: '1' },
      dates: { competenceDate: '2026-08-01', registrationDate: '2026-08-03' },
      lines: original.lines.map((line) => ({ accountCode: line.accountCode, debit: line.credit, credit: line.debit })),
      reversalOf: original.projectionKey,
      description: 'Storno compensativo sintetico'
    },
    provenance: { source: 'TEST_SINTETICO', reference: 'correzione:fixture-1' }
  }, { now: new Date('2026-08-03T10:08:20Z') });
  const reversalDispatch = await dispatchPendingEvents(context, { limit: 10, now: new Date('2026-08-03T10:08:30Z') });
  assert.equal(reversalDispatch[0].status, 'COMPLETED');
  assert.equal(await db.collection('accounting_entries').countDocuments(), 2);
  assert.ok((await db.collection('accounting_entries').findOne({ projectionKey: original.projectionKey })).reversedBy);
  await dispatchPendingProjections(context, { limit: 10, now: new Date('2026-08-03T10:08:40Z') });
  const rebuildAfterReversal = await rebuildAccountingProjections(context, { actor: 'TEST', reason: 'Ricostruzione dopo storno', now: new Date('2026-08-03T10:08:50Z') });
  assert.equal(rebuildAfterReversal.entryCount, 2);
  assert.equal((await db.collection('trial_balance_projection').findOne({ accountCode: 'DEBITI_FORNITORI' })).balanceCents, 0);

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

test('ramo fatture MongoDB: obbligo, competenza, prova finanziaria e chiusura sono end-to-end', {
  skip: !uri,
  timeout: 90_000
}, async (t) => {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10_000 });
  await client.connect();
  const hello = await client.db('admin').command({ hello: 1 });
  if (!hello.setName) {
    await client.close();
    t.skip('TEST_MONGODB_URI deve puntare a un replica set MongoDB');
    return;
  }
  const db = client.db(`supplier_invoice_branch_test_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`);
  t.after(async () => {
    await db.dropDatabase().catch(() => {});
    await client.close();
  });
  const context = { client, db };
  await changeAccountingPeriod(context, {
    year: 2026, month: 8, action: 'OPEN', reason: 'Apertura ramo fatture sintetico'
  }, { actor: 'TEST', now: new Date('2026-08-01T08:00:00Z') });
  await registerPostingRule(context, {
    ruleId: 'FATTURA_PASSIVA_E2E', version: '1', allowedEntryKinds: ['DOCUMENT_COMPETENCE'],
    allowedAccounts: ['COSTI_MERCI', 'IVA_CREDITO', 'DEBITI_FORNITORI'],
    description: 'Competenza fattura fornitore sintetica', approvalReason: 'Fixture automatica'
  }, { actor: 'TEST', now: new Date('2026-08-03T08:00:00Z') });
  await db.collection('fatture').insertOne({
    sourceKey: 'UPLOAD:fixture-supplier-e2e:1', extractionVersion: 'FATTURAPA_XML_V2',
    quadraturaEstrazione: { status: 'EXACT' },
    fornitore: { partitaIva: 'IT00000000000', denominazione: 'Fornitore sintetico' },
    tipoDocumento: 'TD01', numero: 'E2E-1', data: new Date('2026-08-01T00:00:00Z'), divisa: 'EUR',
    imponibile: 100, ivaEsposta: 22, totaleDocumento: 122, ritenuta: 0,
    righe: [{ numero: 1, descrizione: 'Merce sintetica', prezzoTotale: 100, aliquotaIva: 22 }],
    riepiloghiIva: [{ aliquotaIva: 22, imponibile: 100, imposta: 22 }],
    pagamenti: [{ modalita: 'MP05', scadenza: new Date('2026-09-01T00:00:00Z'), importo: 122 }],
    stato: 'IMPORTATA_DA_VERIFICARE', aggiornatoIl: new Date('2026-08-02T00:00:00Z')
  });
  const validated = await validateSupplierInvoice(context, 'UPLOAD:fixture-supplier-e2e:1', {
    version: '1', sourceVersion: 'fixture-e2e-1', ivaDetraibile: 22,
    receiptDate: '2026-08-02', competenceDate: '2026-08-01', registrationDate: '2026-08-03', vatDate: '2026-08-02',
    costAccountCode: 'COSTI_MERCI', vatAccountCode: 'IVA_CREDITO', payableAccountCode: 'DEBITI_FORNITORI',
    postingRule: { id: 'FATTURA_PASSIVA_E2E', version: '1' }, reason: 'Fixture end-to-end'
  }, { actor: 'TEST', now: new Date('2026-08-03T10:00:00Z') });
  const competence = await dispatchPendingEvents(context, { limit: 10, now: new Date('2026-08-03T10:01:00Z') });
  assert.equal(competence.length, 1);
  assert.equal(competence[0].status, 'COMPLETED');
  const beforePayment = await db.collection('expectation_processes').findOne({ entityId: validated.invoice.invoiceId });
  assert.equal(beforePayment.status, 'APERTO');
  assert.equal(beforePayment.openRequiredExpectations, 5);

  const movementReference = 'BANK-TX-SYNTHETIC-E2E-1';
  const movement = await db.collection('movimenti').insertOne({
    conto: 'BANCA', data: new Date('2026-08-05T00:00:00Z'), dataValuta: new Date('2026-08-05T00:00:00Z'),
    direzione: 'USCITA', importo: 122, descrizione: 'Pagamento sintetico', stato: 'DA_VERIFICARE',
    riferimentoEsterno: movementReference,
    evidenze: [{ tipo: 'MOVIMENTO_BANCARIO', reale: true, riferimento: movementReference }],
    creatoIl: new Date('2026-08-05T08:00:00Z'), aggiornatoIl: new Date('2026-08-05T08:00:00Z')
  });
  const settlementInput = {
    invoiceId: validated.invoice.invoiceId,
    invoiceNaturalKey: validated.invoice.naturalKey,
    movementId: String(movement.insertedId),
    movementReference,
    version: '1',
    registrationDate: '2026-08-05'
  };
  const settled = await reconcileSupplierInvoicePayment(context, settlementInput, { actor: 'TEST', now: new Date('2026-08-05T10:00:00Z') });
  const settlementRetry = await reconcileSupplierInvoicePayment(context, settlementInput, { actor: 'TEST', now: new Date('2026-08-05T10:00:05Z') });
  assert.equal(settled.duplicate, false);
  assert.equal(settlementRetry.duplicate, true);
  assert.equal(settled.openItem.status, 'CLOSED');
  const financial = await dispatchPendingEvents(context, { limit: 10, now: new Date('2026-08-05T10:01:00Z') });
  assert.equal(financial.length, 1);
  assert.equal(financial[0].status, 'COMPLETED');
  assert.equal(await db.collection('accounting_entries').countDocuments(), 2);
  assert.equal(await db.collection('ledger_entries').countDocuments(), 1);
  assert.equal(await db.collection('reconciliations').countDocuments(), 1);
  assert.equal(await db.collection('allocations').countDocuments(), 1);
  const automaticSettlementRule = await db.collection('accounting_posting_rules').findOne({ ruleId: 'FATTURA_PASSIVA_PAGAMENTO_AUTO', version: '1' });
  assert.equal(automaticSettlementRule.status, 'APPROVED');
  assert.deepEqual(automaticSettlementRule.allowedAccounts.sort(), ['BANCA', 'CASSA', 'DEBITI_FORNITORI', 'MASTERCARD']);
  const openItem = await db.collection('open_items').findOne({ obligationKey: `SUPPLIER_INVOICE:${validated.invoice.invoiceId}:PAYABLE` });
  assert.equal(openItem.status, 'CLOSED');
  assert.equal(openItem.residualCents, 0);
  const process = await db.collection('expectation_processes').findOne({ entityId: validated.invoice.invoiceId });
  assert.equal(process.status, 'CHIUSO');
  assert.equal(process.openRequiredExpectations, 0);
  assert.equal(await db.collection('expectations').countDocuments({ processId: process.processId }), 12);
});
