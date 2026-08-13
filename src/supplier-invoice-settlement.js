import { ObjectId } from 'mongodb';
import { publishDomainEventInSession } from './event-engine.js';
import {
  supplierInvoiceProcessId,
  SUPPLIER_INVOICE_EXPECTATION_TYPES,
  transitionExpectation
} from './expectation-engine.js';
import { stableFingerprint } from './fingerprint.js';
import { withMongoTransaction } from './mongo-transaction.js';
import { allocateOpenItem, ensureObligationIndexes } from './obligation-engine.js';
import { hasRealFinancialEvidence } from './reconciliation-router.js';

const ACCOUNT = /^[A-Z0-9_.:-]{1,120}$/;

function requiredText(value, label, max = 500) {
  const result = String(value ?? '').trim();
  if (!result) throw new Error(`${label} obbligatorio`);
  if (result.length > max) throw new Error(`${label} troppo lungo`);
  return result;
}

function account(value, label) {
  const result = requiredText(value, label, 120).toUpperCase();
  if (!ACCOUNT.test(result)) throw new Error(`${label} non valido`);
  return result;
}

function date(value, label) {
  const result = value instanceof Date ? new Date(value) : new Date(value);
  if (Number.isNaN(result.getTime())) throw new Error(`${label} non valida`);
  return result;
}

function movementQuery(value) {
  const raw = requiredText(value, 'ID movimento', 200);
  return ObjectId.isValid(raw) ? { $in: [raw, new ObjectId(raw)] } : raw;
}

function realEvidence(movement) {
  return (movement.evidenze || []).filter((item) => item?.reale === true && item.riferimento).map((item) => ({
    type: String(item.tipo || '').trim().toUpperCase(),
    reference: String(item.riferimento).trim()
  }));
}

function assertMovementIdentity(movement, input, invoice) {
  if (requiredText(input?.invoiceNaturalKey, 'Identità fattura', 500) !== invoice.naturalKey) {
    throw new Error('INVOICE_IDENTITY_MISMATCH');
  }
  const references = new Set([
    movement.riferimentoEsterno,
    movement.sourceTransactionId,
    ...realEvidence(movement).map((item) => item.reference)
  ].map((value) => String(value || '').trim()).filter(Boolean));
  const confirmed = requiredText(input?.movementReference, 'Riferimento movimento', 500);
  if (!references.has(confirmed)) throw new Error('MOVEMENT_REFERENCE_MISMATCH');
  if (!hasRealFinancialEvidence(movement)) throw new Error('REAL_FINANCIAL_EVIDENCE_REQUIRED');
  return confirmed;
}

function allocationAmountCents(input, openItem) {
  const raw = input?.allocationAmount === undefined || input?.allocationAmount === null
    ? Number(openItem.residualCents || 0) / 100
    : Number(input.allocationAmount);
  const cents = Math.round(raw * 100);
  if (!Number.isFinite(raw) || !Number.isSafeInteger(cents) || cents <= 0) throw new Error('Importo allocazione non valido');
  return cents;
}

function settlementEvent({ invoice, movement, reconciliationKey, allocationCents, residualCents, input, actor, now }) {
  const version = requiredText(input?.version || '1', 'Versione riconciliazione', 120);
  const payableAccount = account(input?.payableAccountCode || invoice.posting?.lines?.find((line) => line.credit > 0)?.accountCode, 'Conto debiti fornitori');
  const financialAccount = account(input?.financialAccountCode, 'Conto finanziario');
  const evidence = realEvidence(movement);
  const movementDate = date(movement.data, 'Data movimento');
  const registrationDate = date(input?.registrationDate || now, 'Data registrazione');
  return {
    eventKey: `ledger.entry_projected:RECONCILIATION:${reconciliationKey}:${version}:FINANCIAL_SETTLEMENT`,
    type: 'ledger.entry_projected',
    aggregate: { type: 'RECONCILIATION', id: reconciliationKey, version },
    occurredAt: now,
    payload: {
      supplierSettlement: {
        invoiceId: invoice.invoiceId,
        invoiceVersion: invoice.version,
        obligationKey: `SUPPLIER_INVOICE:${invoice.invoiceId}:PAYABLE`,
        reconciliationKey,
        movementId: String(movement._id),
        allocationCents,
        residualCents
      }
    },
    accounting: {
      entryKind: 'FINANCIAL_SETTLEMENT',
      source: { type: 'RECONCILIATION', id: reconciliationKey, version },
      postingRule: {
        id: account(input?.postingRule?.id, 'Regola contabile'),
        version: requiredText(input?.postingRule?.version, 'Versione regola contabile', 120)
      },
      currency: invoice.currency,
      dates: {
        documentDate: invoice.dates.documentDate,
        competenceDate: movementDate,
        registrationDate,
        dueDate: invoice.dates.dueDate,
        valueDate: movement.dataValuta ? date(movement.dataValuta, 'Data valuta') : movementDate
      },
      lines: [
        { accountCode: payableAccount, debit: allocationCents / 100, credit: 0, description: `Pagamento fattura ${invoice.number}` },
        { accountCode: financialAccount, debit: 0, credit: allocationCents / 100, description: `Uscita ${movement.conto}` }
      ],
      evidence,
      description: `Regolamento fattura fornitore ${invoice.number}`
    },
    provenance: {
      source: 'SUPPLIER_INVOICE_RECONCILIATION',
      reference: requiredText(input?.movementReference, 'Riferimento movimento', 500),
      actor: String(actor || 'SYSTEM')
    }
  };
}

async function transitionSettlementExpectations(db, {
  invoice,
  event,
  reconciliationKey,
  movementReference,
  residualCents
}, { session, now }) {
  const processId = supplierInvoiceProcessId(invoice.invoiceId, invoice.version);
  const complete = residualCents === 0;
  const nextStatus = complete ? 'SODDISFATTO' : 'IN_ELABORAZIONE';
  const evidence = [event.eventKey, reconciliationKey, movementReference];
  for (const expectationType of [
    SUPPLIER_INVOICE_EXPECTATION_TYPES.PAYMENT,
    SUPPLIER_INVOICE_EXPECTATION_TYPES.FINANCIAL_EVIDENCE,
    SUPPLIER_INVOICE_EXPECTATION_TYPES.RECONCILIATION
  ]) {
    await transitionExpectation(db, {
      processId,
      expectationType,
      nextStatus,
      eventId: event.eventKey,
      evidence,
      reason: complete ? 'Pagamento integralmente riconciliato con prova finanziaria' : 'Pagamento parziale riconciliato con prova finanziaria'
    }, { session, now });
  }
  await transitionExpectation(db, {
    processId,
    expectationType: SUPPLIER_INVOICE_EXPECTATION_TYPES.FINANCIAL_LEDGER,
    nextStatus: 'IN_ELABORAZIONE',
    eventId: event.eventKey,
    evidence,
    reason: 'Scrittura finanziaria accodata'
  }, { session, now });
  if (complete) {
    await transitionExpectation(db, {
      processId,
      expectationType: SUPPLIER_INVOICE_EXPECTATION_TYPES.DEBT_CLOSURE,
      nextStatus: 'SODDISFATTO',
      eventId: event.eventKey,
      evidence,
      reason: 'Residuo partita aperta pari a zero'
    }, { session, now });
  }
}

export async function reconcileSupplierInvoicePayment({ client, db }, input, { actor, now = new Date() } = {}) {
  if (!client || !db) throw new Error('Riconciliazione fattura richiede MongoDB transazionale');
  await ensureObligationIndexes(db);
  return withMongoTransaction(client, async (session) => {
    const invoiceId = requiredText(input?.invoiceId, 'ID fattura', 200);
    const invoice = await db.collection('invoice_suppliers').findOne({ invoiceId, current: true }, { session });
    if (!invoice) throw new Error('SUPPLIER_INVOICE_NOT_FOUND');
    const obligationKey = `SUPPLIER_INVOICE:${invoice.invoiceId}:PAYABLE`;
    const openItem = await db.collection('open_items').findOne({ obligationKey }, { session });
    if (!openItem) throw new Error('SUPPLIER_OPEN_ITEM_NOT_FOUND');
    const movement = await db.collection('movimenti').findOne({ _id: movementQuery(input?.movementId) }, { session });
    if (!movement) throw new Error('FINANCIAL_MOVEMENT_NOT_FOUND');
    if (String(movement.direzione || '').toUpperCase() !== 'USCITA') throw new Error('FINANCIAL_MOVEMENT_NOT_OUTFLOW');
    const movementReference = assertMovementIdentity(movement, input, invoice);
    const reconciliationVersion = requiredText(input?.version || '1', 'Versione riconciliazione', 120);
    if (input?.allocationAmount === undefined || input?.allocationAmount === null) {
      const existingByIdentity = await db.collection('reconciliations').findOne({
        obligationKey,
        movementId: String(movement._id),
        version: reconciliationVersion,
        status: 'CONFIRMED'
      }, { session });
      if (existingByIdentity) {
        const event = await db.collection('domain_events').findOne({ eventKey: existingByIdentity.eventKey }, { session });
        if (!event) throw new Error('SUPPLIER_SETTLEMENT_EVENT_NOT_FOUND');
        return { invoice, movement, reconciliation: existingByIdentity, event, openItem, duplicate: true };
      }
    }
    const allocationCents = allocationAmountCents(input, openItem);
    const movementCents = Math.round(Math.abs(Number(movement.importo || 0)) * 100);
    const reconciliationKey = stableFingerprint({
      movementId: String(movement._id),
      obligationKey,
      allocationCents,
      version: reconciliationVersion
    }).slice(0, 48);
    const existing = await db.collection('reconciliations').findOne({ reconciliationKey }, { session });
    if (existing) {
      const event = await db.collection('domain_events').findOne({ eventKey: existing.eventKey }, { session });
      if (!event) throw new Error('SUPPLIER_SETTLEMENT_EVENT_NOT_FOUND');
      return { invoice, movement, reconciliation: existing, event, openItem, duplicate: true };
    }
    if (Number(openItem.residualCents || 0) <= 0) throw new Error('SUPPLIER_OPEN_ITEM_NOT_OPEN');
    const prior = await db.collection('allocations').aggregate([
      { $match: { movementId: String(movement._id), status: 'CONFIRMED' } },
      { $group: { _id: null, cents: { $sum: '$amountCents' } } }
    ], { session }).toArray();
    const availableMovementCents = movementCents - Number(prior[0]?.cents || 0);
    if (allocationCents > availableMovementCents) throw new Error('ALLOCATION_EXCEEDS_MOVEMENT');
    const residualCents = Number(openItem.residualCents) - allocationCents;
    const event = settlementEvent({ invoice, movement, reconciliationKey, allocationCents, residualCents, input, actor, now });
    const published = await publishDomainEventInSession(db, event, { session, now });
    const reconciliation = {
      reconciliationKey,
      version: reconciliationVersion,
      status: 'CONFIRMED',
      causeType: 'SUPPLIER_INVOICE',
      causeId: invoice.invoiceId,
      obligationKey,
      movementId: String(movement._id),
      allocationCents,
      currency: invoice.currency,
      identityEvidence: { invoiceNaturalKey: invoice.naturalKey, movementReference },
      eventKey: published.event.eventKey,
      actor: String(actor || 'SYSTEM'),
      reason: requiredText(input?.reason, 'Motivo riconciliazione', 500),
      createdAt: now,
      updatedAt: now
    };
    reconciliation.fingerprint = stableFingerprint({
      reconciliationKey,
      version: reconciliation.version,
      causeType: reconciliation.causeType,
      causeId: reconciliation.causeId,
      obligationKey,
      movementId: reconciliation.movementId,
      allocationCents,
      currency: reconciliation.currency,
      identityEvidence: reconciliation.identityEvidence
    });
    await db.collection('reconciliations').insertOne(reconciliation, { session });
    const allocation = await allocateOpenItem(db, {
      obligationKey,
      movementId: movement._id,
      reconciliationKey,
      allocationCents,
      eventId: published.event.eventKey,
      actor
    }, { session, now });
    const movementAllocatedCents = movementCents - availableMovementCents + allocationCents;
    await db.collection('movimenti').updateOne(
      { _id: movement._id },
      { $set: { stato: movementAllocatedCents === movementCents ? 'RICONCILIATO' : 'PARZIALMENTE_RICONCILIATO', aggiornatoIl: now } },
      { session }
    );
    await transitionSettlementExpectations(db, {
      invoice,
      event: published.event,
      reconciliationKey,
      movementReference,
      residualCents
    }, { session, now });
    return { invoice, movement, reconciliation, allocation: allocation.allocation, openItem: allocation.openItem, event: published.event, duplicate: false };
  });
}
