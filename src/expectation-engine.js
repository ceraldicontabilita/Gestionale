import { stableFingerprint } from './fingerprint.js';

export const EXPECTATION_STATUSES = Object.freeze([
  'ATTESO',
  'IN_ELABORAZIONE',
  'DA_VERIFICARE',
  'ERRORE',
  'SODDISFATTO',
  'NON_APPLICABILE',
  'SUPERATO'
]);

export const POSITIVE_TERMINAL_EXPECTATION_STATUSES = Object.freeze([
  'SODDISFATTO',
  'NON_APPLICABILE',
  'SUPERATO'
]);

export const SUPPLIER_INVOICE_EXPECTATION_TYPES = Object.freeze({
  DOCUMENT_ORIGINAL: 'DOCUMENT_ORIGINAL',
  INVOICE_FACTS: 'SUPPLIER_INVOICE_FACTS',
  VAT: 'VAT',
  COST_AND_DEBT: 'COST_AND_DEBT',
  OPEN_ITEM: 'OPEN_ITEM',
  DUE_DATE: 'DUE_DATE',
  ACCOUNTING_COMPETENCE: 'ACCOUNTING_COMPETENCE',
  PAYMENT: 'PAYMENT',
  FINANCIAL_EVIDENCE: 'FINANCIAL_EVIDENCE',
  RECONCILIATION: 'RECONCILIATION',
  FINANCIAL_LEDGER: 'FINANCIAL_LEDGER',
  DEBT_CLOSURE: 'DEBT_CLOSURE'
});

const STATUS_SET = new Set(EXPECTATION_STATUSES);
const POSITIVE_TERMINAL = new Set(POSITIVE_TERMINAL_EXPECTATION_STATUSES);
const readyDatabases = new WeakSet();

function options(session) { return session ? { session } : {}; }

function requiredText(value, label, max = 500) {
  const result = String(value ?? '').trim();
  if (!result) throw new Error(`${label} obbligatorio`);
  if (result.length > max) throw new Error(`${label} troppo lungo`);
  return result;
}

function status(value) {
  const result = requiredText(value, 'Stato expectation', 40).toUpperCase();
  if (!STATUS_SET.has(result)) throw new Error('Stato expectation non ammesso');
  return result;
}

function evidenceRefs(values = []) {
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))].sort();
}

function materialFingerprint(record) {
  return stableFingerprint({
    expectationId: record.expectationId,
    processId: record.processId,
    entityType: record.entityType,
    entityId: record.entityId,
    expectationType: record.expectationType,
    required: record.required,
    expectedAmountCents: record.expectedAmountCents,
    currency: record.currency,
    expectedPartyId: record.expectedPartyId,
    dueDate: record.dueDate,
    createdByEventId: record.createdByEventId,
    ruleVersion: record.ruleVersion
  });
}

export function supplierInvoiceProcessId(invoiceId, version) {
  return `SUPPLIER_INVOICE:${requiredText(invoiceId, 'ID fattura', 200)}:${requiredText(version, 'Versione fattura', 120)}`;
}

export async function ensureExpectationIndexes(db) {
  if (readyDatabases.has(db)) return;
  await Promise.all([
    db.collection('expectations').createIndex({ expectationId: 1 }, { unique: true }),
    db.collection('expectations').createIndex({ processId: 1, expectationType: 1 }, { unique: true }),
    db.collection('expectations').createIndex({ entityType: 1, entityId: 1, status: 1 }),
    db.collection('expectations').createIndex({ required: 1, status: 1, dueDate: 1 }),
    db.collection('expectation_processes').createIndex({ processId: 1 }, { unique: true }),
    db.collection('expectation_audit').createIndex({ auditKey: 1 }, { unique: true })
  ]);
  readyDatabases.add(db);
}

export async function refreshExpectationProcess(db, processId, { session = null, now = new Date() } = {}) {
  const opts = options(session);
  const rows = await db.collection('expectations').find({ processId }, opts).toArray();
  const required = rows.filter((row) => row.required !== false);
  const open = required.filter((row) => !POSITIVE_TERMINAL.has(row.status));
  const process = {
    processId,
    entityType: rows[0]?.entityType || null,
    entityId: rows[0]?.entityId || null,
    status: open.length === 0 && required.length > 0 ? 'CHIUSO' : 'APERTO',
    totalExpectations: rows.length,
    requiredExpectations: required.length,
    openRequiredExpectations: open.length,
    statusCounts: Object.fromEntries(EXPECTATION_STATUSES.map((value) => [value, rows.filter((row) => row.status === value).length])),
    updatedAt: now
  };
  await db.collection('expectation_processes').updateOne(
    { processId },
    { $set: process, $setOnInsert: { createdAt: now } },
    { ...opts, upsert: true }
  );
  return process;
}

export async function createExpectations(db, definitions, { session = null, now = new Date() } = {}) {
  await ensureExpectationIndexes(db);
  const opts = options(session);
  const created = [];
  for (const definition of definitions) {
    const processId = requiredText(definition.processId, 'ID processo', 300);
    const expectationType = requiredText(definition.expectationType, 'Tipo expectation', 120).toUpperCase();
    const expectationId = stableFingerprint({ processId, expectationType }).slice(0, 40);
    const record = {
      expectationId,
      processId,
      entityType: requiredText(definition.entityType, 'Tipo entità', 120).toLowerCase(),
      entityId: requiredText(definition.entityId, 'ID entità', 200),
      expectationType,
      status: status(definition.status),
      required: definition.required !== false,
      expectedAmountCents: definition.expectedAmountCents === null || definition.expectedAmountCents === undefined
        ? null
        : Number(definition.expectedAmountCents),
      currency: definition.currency ? requiredText(definition.currency, 'Valuta', 10).toUpperCase() : null,
      expectedPartyId: definition.expectedPartyId ? requiredText(definition.expectedPartyId, 'Soggetto atteso', 200) : null,
      dueDate: definition.dueDate ? new Date(definition.dueDate) : null,
      evidenceRefs: evidenceRefs(definition.evidenceRefs),
      createdByEventId: requiredText(definition.createdByEventId, 'Evento creatore', 500),
      satisfiedByEventId: POSITIVE_TERMINAL.has(status(definition.status)) ? (definition.satisfiedByEventId || definition.createdByEventId) : null,
      ruleVersion: requiredText(definition.ruleVersion || '1', 'Versione regola', 120),
      createdAt: now,
      updatedAt: now
    };
    if (record.expectedAmountCents !== null && (!Number.isSafeInteger(record.expectedAmountCents) || record.expectedAmountCents < 0)) {
      throw new Error('Importo expectation non valido');
    }
    if (record.dueDate && Number.isNaN(record.dueDate.getTime())) throw new Error('Scadenza expectation non valida');
    record.materialFingerprint = materialFingerprint(record);
    const existing = await db.collection('expectations').findOne({ expectationId }, opts);
    if (existing) {
      if (existing.materialFingerprint !== record.materialFingerprint) throw new Error('EXPECTATION_DEFINITION_CONFLICT');
      created.push(existing);
      continue;
    }
    await db.collection('expectations').insertOne(record, opts);
    await db.collection('expectation_audit').insertOne({
      auditKey: `EXPECTATION_CREATED:${expectationId}`,
      action: 'EXPECTATION_CREATED',
      expectationId,
      processId,
      status: record.status,
      eventId: record.createdByEventId,
      evidenceRefs: record.evidenceRefs,
      createdAt: now
    }, opts);
    created.push(record);
  }
  for (const processId of [...new Set(created.map((row) => row.processId))]) {
    await refreshExpectationProcess(db, processId, { session, now });
  }
  return created;
}

export async function transitionExpectation(db, {
  processId,
  expectationType,
  nextStatus,
  eventId,
  evidence = [],
  reason = null
}, { session = null, now = new Date() } = {}) {
  await ensureExpectationIndexes(db);
  const opts = options(session);
  const type = requiredText(expectationType, 'Tipo expectation', 120).toUpperCase();
  const targetStatus = status(nextStatus);
  const record = await db.collection('expectations').findOne({ processId, expectationType: type }, opts);
  if (!record) throw new Error('EXPECTATION_NOT_FOUND');
  const refs = evidenceRefs([...(record.evidenceRefs || []), ...evidence]);
  if (record.status === targetStatus) {
    if (refs.length !== (record.evidenceRefs || []).length) {
      await db.collection('expectations').updateOne({ expectationId: record.expectationId }, { $set: { evidenceRefs: refs, updatedAt: now } }, opts);
    }
    return refreshExpectationProcess(db, processId, { session, now });
  }
  if (POSITIVE_TERMINAL.has(record.status) && targetStatus !== 'SUPERATO') throw new Error('EXPECTATION_ALREADY_TERMINAL');
  const update = {
    status: targetStatus,
    evidenceRefs: refs,
    satisfiedByEventId: POSITIVE_TERMINAL.has(targetStatus) ? requiredText(eventId, 'Evento soddisfacente', 500) : null,
    lastTransitionEventId: requiredText(eventId, 'Evento transizione', 500),
    lastTransitionReason: reason ? requiredText(reason, 'Motivo transizione', 500) : null,
    updatedAt: now
  };
  const changed = await db.collection('expectations').updateOne(
    { expectationId: record.expectationId, status: record.status },
    { $set: update },
    opts
  );
  if (changed.matchedCount !== 1) throw new Error('EXPECTATION_CONCURRENT_TRANSITION');
  const auditKey = `EXPECTATION_TRANSITION:${record.expectationId}:${record.status}:${targetStatus}:${requiredText(eventId, 'Evento transizione', 500)}`;
  await db.collection('expectation_audit').updateOne(
    { auditKey },
    { $setOnInsert: { auditKey, action: 'EXPECTATION_TRANSITION', expectationId: record.expectationId, processId, previousStatus: record.status, status: targetStatus, eventId, evidenceRefs: refs, reason: update.lastTransitionReason, createdAt: now } },
    { ...opts, upsert: true }
  );
  return refreshExpectationProcess(db, processId, { session, now });
}

export async function getExpectationTree(db, { entityType, entityId, processId } = {}) {
  await ensureExpectationIndexes(db);
  const filter = {};
  if (processId) filter.processId = requiredText(processId, 'ID processo', 300);
  if (entityType) filter.entityType = requiredText(entityType, 'Tipo entità', 120).toLowerCase();
  if (entityId) filter.entityId = requiredText(entityId, 'ID entità', 200);
  const expectations = await db.collection('expectations').find(filter).sort({ processId: 1, expectationType: 1 }).limit(2000).toArray();
  const processIds = [...new Set(expectations.map((row) => row.processId))];
  const processes = processIds.length
    ? await db.collection('expectation_processes').find({ processId: { $in: processIds } }).sort({ processId: 1 }).toArray()
    : [];
  return { expectations, processes };
}

export function supplierInvoiceExpectationDefinitions(event) {
  if (event?.type !== 'invoice.supplier_validated') return [];
  const payload = event.payload?.supplierInvoice;
  if (!payload) throw new Error('SUPPLIER_INVOICE_EVENT_PAYLOAD_INVALID');
  const processId = supplierInvoiceProcessId(event.aggregate.id, event.aggregate.version);
  const base = {
    processId,
    entityType: 'invoice_supplier',
    entityId: event.aggregate.id,
    required: true,
    expectedAmountCents: payload.amounts?.payableCents,
    currency: event.accounting.currency,
    expectedPartyId: payload.supplier?.vatId || payload.supplier?.taxId || null,
    dueDate: payload.dueDate || null,
    createdByEventId: event.eventKey,
    ruleVersion: 'SUPPLIER_INVOICE_EXPECTATIONS_V1'
  };
  const satisfied = { status: 'SODDISFATTO', evidenceRefs: [event.provenance.reference, event.eventKey] };
  return [
    { ...base, expectationType: SUPPLIER_INVOICE_EXPECTATION_TYPES.DOCUMENT_ORIGINAL, ...satisfied },
    { ...base, expectationType: SUPPLIER_INVOICE_EXPECTATION_TYPES.INVOICE_FACTS, ...satisfied },
    { ...base, expectationType: SUPPLIER_INVOICE_EXPECTATION_TYPES.VAT, ...satisfied },
    { ...base, expectationType: SUPPLIER_INVOICE_EXPECTATION_TYPES.COST_AND_DEBT, ...satisfied },
    { ...base, expectationType: SUPPLIER_INVOICE_EXPECTATION_TYPES.OPEN_ITEM, ...satisfied },
    { ...base, expectationType: SUPPLIER_INVOICE_EXPECTATION_TYPES.DUE_DATE, status: payload.dueDate ? 'SODDISFATTO' : 'DA_VERIFICARE', evidenceRefs: [event.eventKey] },
    { ...base, expectationType: SUPPLIER_INVOICE_EXPECTATION_TYPES.ACCOUNTING_COMPETENCE, status: 'IN_ELABORAZIONE', evidenceRefs: [event.eventKey] },
    { ...base, expectationType: SUPPLIER_INVOICE_EXPECTATION_TYPES.PAYMENT, status: 'ATTESO', evidenceRefs: [] },
    { ...base, expectationType: SUPPLIER_INVOICE_EXPECTATION_TYPES.FINANCIAL_EVIDENCE, status: 'ATTESO', evidenceRefs: [] },
    { ...base, expectationType: SUPPLIER_INVOICE_EXPECTATION_TYPES.RECONCILIATION, status: 'ATTESO', evidenceRefs: [] },
    { ...base, expectationType: SUPPLIER_INVOICE_EXPECTATION_TYPES.FINANCIAL_LEDGER, status: 'ATTESO', evidenceRefs: [] },
    { ...base, expectationType: SUPPLIER_INVOICE_EXPECTATION_TYPES.DEBT_CLOSURE, status: 'ATTESO', evidenceRefs: [] }
  ];
}
