import { stableFingerprint } from './fingerprint.js';

const readyDatabases = new WeakSet();

function options(session) { return session ? { session } : {}; }

export async function ensureObligationIndexes(db) {
  if (readyDatabases.has(db)) return;
  await Promise.all([
    db.collection('obligations').createIndex({ obligationKey: 1, version: 1 }, { unique: true }),
    db.collection('open_items').createIndex({ obligationKey: 1 }, { unique: true }),
    db.collection('reconciliations').createIndex({ reconciliationKey: 1 }, { unique: true }),
    db.collection('allocations').createIndex({ allocationKey: 1 }, { unique: true }),
    db.collection('allocations').createIndex({ movementId: 1, status: 1 }),
    db.collection('allocations').createIndex({ obligationKey: 1, status: 1 })
  ]);
  readyDatabases.add(db);
}

export async function createSupplierPayable(db, event, { session = null, now = new Date() } = {}) {
  await ensureObligationIndexes(db);
  const payload = event.payload?.supplierInvoice;
  if (!payload?.obligationKey) throw new Error('SUPPLIER_INVOICE_EVENT_PAYLOAD_INVALID');
  const opts = options(session);
  const obligation = {
    obligationKey: payload.obligationKey,
    version: event.aggregate.version,
    domain: 'FATTURE_FORNITORI',
    sourceEntityType: 'INVOICE_SUPPLIER',
    sourceEntityId: event.aggregate.id,
    sourceEventKey: event.eventKey,
    component: 'PAYABLE',
    currency: event.accounting.currency,
    amountCents: payload.amounts.payableCents,
    dueDate: payload.dueDate || null,
    status: 'OPEN',
    createdAt: now,
    updatedAt: now
  };
  obligation.fingerprint = stableFingerprint({
    obligationKey: obligation.obligationKey,
    version: obligation.version,
    domain: obligation.domain,
    sourceEntityType: obligation.sourceEntityType,
    sourceEntityId: obligation.sourceEntityId,
    sourceEventKey: obligation.sourceEventKey,
    component: obligation.component,
    currency: obligation.currency,
    amountCents: obligation.amountCents,
    dueDate: obligation.dueDate
  });
  const existing = await db.collection('obligations').findOne({ obligationKey: obligation.obligationKey, version: obligation.version }, opts);
  if (existing && existing.fingerprint !== obligation.fingerprint) throw new Error('SUPPLIER_OBLIGATION_CONFLICT');
  if (!existing) await db.collection('obligations').insertOne(obligation, opts);

  const openItem = {
    obligationKey: obligation.obligationKey,
    obligationVersion: obligation.version,
    sourceEventKey: event.eventKey,
    currency: obligation.currency,
    originalCents: obligation.amountCents,
    allocatedCents: 0,
    residualCents: obligation.amountCents,
    status: 'OPEN',
    updatedAt: now
  };
  const existingOpenItem = await db.collection('open_items').findOne({ obligationKey: obligation.obligationKey }, opts);
  if (existingOpenItem && (existingOpenItem.originalCents !== openItem.originalCents || existingOpenItem.currency !== openItem.currency)) {
    throw new Error('SUPPLIER_OPEN_ITEM_CONFLICT');
  }
  if (!existingOpenItem) await db.collection('open_items').insertOne({ ...openItem, createdAt: now }, opts);
  return { obligation: existing || obligation, openItem: existingOpenItem || openItem };
}

export async function allocateOpenItem(db, {
  obligationKey,
  movementId,
  reconciliationKey,
  allocationCents,
  eventId,
  actor
}, { session = null, now = new Date() } = {}) {
  await ensureObligationIndexes(db);
  const opts = options(session);
  const amount = Number(allocationCents);
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('Importo allocazione non valido');
  const allocationKey = stableFingerprint({ reconciliationKey, obligationKey, movementId: String(movementId), amount }).slice(0, 48);
  const existing = await db.collection('allocations').findOne({ allocationKey }, opts);
  if (existing) return { allocation: existing, duplicate: true, openItem: await db.collection('open_items').findOne({ obligationKey }, opts) };
  const current = await db.collection('open_items').findOne({ obligationKey }, opts);
  if (!current) throw new Error('OPEN_ITEM_NOT_FOUND');
  if (amount > Number(current.residualCents || 0)) throw new Error('ALLOCATION_EXCEEDS_OPEN_ITEM');
  const residualCents = Number(current.residualCents) - amount;
  const allocatedCents = Number(current.allocatedCents || 0) + amount;
  const updated = await db.collection('open_items').updateOne(
    { obligationKey, residualCents: current.residualCents, allocatedCents: current.allocatedCents },
    { $set: { residualCents, allocatedCents, status: residualCents === 0 ? 'CLOSED' : 'PARTIAL', updatedAt: now } },
    opts
  );
  if (updated.matchedCount !== 1) throw new Error('OPEN_ITEM_CONCURRENT_ALLOCATION');
  const allocation = {
    allocationKey,
    reconciliationKey,
    obligationKey,
    movementId: String(movementId),
    amountCents: amount,
    currency: current.currency,
    status: 'CONFIRMED',
    sourceEventId: eventId,
    actor: String(actor || 'SYSTEM'),
    createdAt: now,
    updatedAt: now
  };
  await db.collection('allocations').insertOne(allocation, opts);
  await db.collection('obligations').updateOne(
    { obligationKey, version: current.obligationVersion },
    { $set: { status: residualCents === 0 ? 'CLOSED' : 'PARTIAL', residualCents, updatedAt: now } },
    opts
  );
  return { allocation, duplicate: false, openItem: { ...current, residualCents, allocatedCents, status: residualCents === 0 ? 'CLOSED' : 'PARTIAL', updatedAt: now } };
}
