import { parseMoney, roundMoney } from './money.js';
import { withMongoTransaction } from './mongo-transaction.js';
import { stableFingerprint } from './fingerprint.js';
import {
  completeSupplierInvoiceAccountingExpectation,
  completeSupplierInvoiceSettlementLedgerExpectation,
  projectSupplierInvoiceValidated
} from './supplier-invoice-projection.js';
import { projectFinancialLedgerEvent } from './ledger-event-projection.js';
import { projectFinancialMovementObserved } from './financial-movement-projection.js';

export { stableFingerprint } from './fingerprint.js';

export const ACCOUNTING_EVENT_TYPES = Object.freeze([
  'invoice.supplier_validated',
  'invoice.customer_validated',
  'receipt.day_validated',
  'payroll.validated',
  'f24.model_validated',
  'ledger.entry_projected',
  'ledger.compensating_entry_projected'
]);

export const OBSERVATION_EVENT_TYPES = Object.freeze([
  'financial.movement_observed'
]);

export const ENTRY_KINDS = Object.freeze([
  'DOCUMENT_COMPETENCE',
  'FINANCIAL_SETTLEMENT',
  'REVERSAL'
]);

const EVENT_TYPES = new Set([...ACCOUNTING_EVENT_TYPES, ...OBSERVATION_EVENT_TYPES]);
const OBSERVATION_TYPES = new Set(OBSERVATION_EVENT_TYPES);
const ENTRY_TYPES = new Set(ENTRY_KINDS);
const EVENT_ENTRY_KINDS = new Map([
  ['invoice.supplier_validated', new Set(['DOCUMENT_COMPETENCE'])],
  ['invoice.customer_validated', new Set(['DOCUMENT_COMPETENCE'])],
  ['receipt.day_validated', new Set(['DOCUMENT_COMPETENCE'])],
  ['payroll.validated', new Set(['DOCUMENT_COMPETENCE'])],
  ['f24.model_validated', new Set(['DOCUMENT_COMPETENCE'])],
  ['ledger.entry_projected', new Set(['FINANCIAL_SETTLEMENT'])],
  ['ledger.compensating_entry_projected', new Set(['REVERSAL'])]
]);
const FINANCIAL_EVIDENCE_TYPES = new Set([
  'MOVIMENTO_BANCARIO',
  'ESTRATTO_CONTO',
  'MOVIMENTO_CARTA',
  'ESTRATTO_CARTA',
  'ATTESTAZIONE_CASSA'
]);
const ACCOUNTING_PROJECTION_PAGES = Object.freeze([
  'prima_nota.libro_giornale_mastro',
  'controllo.piano_conti',
  'controllo.bilancio',
  'controllo.anomalie'
]);
const TOKEN = /^[A-Z0-9_.:-]{1,120}$/;
const readyDatabases = new WeakSet();

function text(value, label, { max = 500, required = true } = {}) {
  const result = String(value ?? '').trim();
  if (required && !result) throw new Error(`${label} obbligatorio`);
  if (result.length > max) throw new Error(`${label} troppo lungo`);
  return result || null;
}

function token(value, label) {
  const result = text(value, label, { max: 120 }).toUpperCase();
  if (!TOKEN.test(result)) throw new Error(`${label} non valido`);
  return result;
}

function date(value, label) {
  const result = value instanceof Date ? new Date(value) : new Date(value);
  if (Number.isNaN(result.getTime())) throw new Error(`${label} non valida`);
  const year = result.getUTCFullYear();
  if (year < 2000 || year > 2100) throw new Error(`${label} fuori intervallo`);
  return result;
}

function normalizeLine(line, index) {
  const debit = parseMoney(line?.debit ?? 0, { label: `Dare riga ${index + 1}` }) ?? 0;
  const credit = parseMoney(line?.credit ?? 0, { label: `Avere riga ${index + 1}` }) ?? 0;
  if ((debit > 0) === (credit > 0)) {
    throw new Error(`Riga ${index + 1}: indicare esclusivamente Dare oppure Avere`);
  }
  return {
    accountCode: token(line?.accountCode, `Conto riga ${index + 1}`),
    debit,
    credit,
    description: text(line?.description, `Descrizione riga ${index + 1}`, { max: 500, required: false })
  };
}

export function normalizeAccountingProjection(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Proiezione contabile mancante');
  const entryKind = token(input.entryKind, 'Tipo scrittura');
  if (!ENTRY_TYPES.has(entryKind)) throw new Error('Tipo scrittura non ammesso');
  const source = {
    type: token(input.source?.type, 'Tipo fonte'),
    id: text(input.source?.id, 'ID fonte', { max: 200 }),
    version: text(input.source?.version, 'Versione fonte', { max: 120 })
  };
  const rule = {
    id: token(input.postingRule?.id, 'Regola contabile'),
    version: text(input.postingRule?.version, 'Versione regola', { max: 120 })
  };
  const lines = Array.isArray(input.lines) ? input.lines.map(normalizeLine) : [];
  if (lines.length < 2) throw new Error('Una scrittura richiede almeno due righe');
  const totalDebit = roundMoney(lines.reduce((sum, line) => sum + line.debit, 0));
  const totalCredit = roundMoney(lines.reduce((sum, line) => sum + line.credit, 0));
  if (totalDebit <= 0 || totalDebit !== totalCredit) throw new Error('Scrittura non quadrata al centesimo');

  const evidence = Array.isArray(input.evidence) ? input.evidence.map((item, index) => ({
    type: token(item?.type, `Tipo evidenza ${index + 1}`),
    reference: text(item?.reference, `Riferimento evidenza ${index + 1}`, { max: 500 })
  })) : [];
  if (entryKind === 'FINANCIAL_SETTLEMENT' && evidence.length === 0) {
    throw new Error('Il regolamento finanziario richiede una prova riferita');
  }
  if (entryKind === 'FINANCIAL_SETTLEMENT' && evidence.some((item) => !FINANCIAL_EVIDENCE_TYPES.has(item.type))) {
    throw new Error('Tipo di prova finanziaria non ammesso');
  }
  if (entryKind === 'DOCUMENT_COMPETENCE' && input.requiresPayment === true) {
    throw new Error('La competenza documento non può dipendere dal pagamento');
  }
  const reversalOf = entryKind === 'REVERSAL'
    ? text(input.reversalOf, 'Scrittura da stornare', { max: 200 })
    : null;

  const dates = {
    documentDate: input.dates?.documentDate ? date(input.dates.documentDate, 'Data documento') : null,
    receiptDate: input.dates?.receiptDate ? date(input.dates.receiptDate, 'Data ricezione') : null,
    competenceDate: date(input.dates?.competenceDate, 'Data competenza'),
    registrationDate: date(input.dates?.registrationDate, 'Data registrazione'),
    vatDate: input.dates?.vatDate ? date(input.dates.vatDate, 'Data IVA') : null,
    dueDate: input.dates?.dueDate ? date(input.dates.dueDate, 'Scadenza') : null,
    valueDate: input.dates?.valueDate ? date(input.dates.valueDate, 'Data valuta') : null
  };
  const currency = token(input.currency || 'EUR', 'Valuta');
  if (currency !== 'EUR') throw new Error('Il motore contabile iniziale ammette esclusivamente EUR');
  const normalized = {
    entryKind,
    source,
    postingRule: rule,
    currency,
    dates,
    lines,
    totals: { debit: totalDebit, credit: totalCredit },
    evidence,
    reversalOf,
    description: text(input.description, 'Descrizione scrittura', { max: 500, required: false })
  };
  normalized.projectionKey = [source.type, source.id, source.version, entryKind, rule.id, rule.version].join(':');
  normalized.fingerprint = stableFingerprint(normalized);
  return normalized;
}

export function normalizeDomainEvent(input, { now = new Date() } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Evento mancante');
  const type = String(input.type || '').trim();
  if (!EVENT_TYPES.has(type)) throw new Error('Tipo evento non registrato');
  const aggregate = {
    type: token(input.aggregate?.type, 'Tipo aggregato'),
    id: text(input.aggregate?.id, 'ID aggregato', { max: 200 }),
    version: text(input.aggregate?.version, 'Versione aggregato', { max: 120 })
  };
  const observation = OBSERVATION_TYPES.has(type);
  if (observation && input.accounting != null) throw new Error('Un evento di osservazione non contiene una scrittura contabile');
  const accounting = observation ? null : normalizeAccountingProjection(input.accounting);
  if (!observation && !EVENT_ENTRY_KINDS.get(type)?.has(accounting.entryKind)) throw new Error('Tipo evento e tipo scrittura non compatibili');
  if (!observation && (accounting.source.type !== aggregate.type || accounting.source.id !== aggregate.id || accounting.source.version !== aggregate.version)) {
    throw new Error('Fonte contabile e aggregato evento non coincidono');
  }
  const occurredAt = input.occurredAt ? date(input.occurredAt, 'Data evento') : date(now, 'Data evento');
  const payload = input.payload && typeof input.payload === 'object' && !Array.isArray(input.payload) ? input.payload : {};
  const eventKey = text(input.eventKey, 'Chiave evento', { max: 500, required: false }) ||
    `${type}:${aggregate.type}:${aggregate.id}:${aggregate.version}${accounting ? `:${accounting.entryKind}` : ''}`;
  const normalized = {
    eventKey,
    type,
    aggregate,
    occurredAt,
    payload,
    accounting,
    provenance: {
      source: token(input.provenance?.source || 'GESTIONALE', 'Fonte provenienza'),
      reference: text(input.provenance?.reference, 'Riferimento provenienza', { max: 500 }),
      actor: text(input.provenance?.actor, 'Attore', { max: 200, required: false })
    }
  };
  normalized.fingerprint = stableFingerprint({
    eventKey: normalized.eventKey,
    type: normalized.type,
    aggregate: normalized.aggregate,
    payload: normalized.payload,
    accounting: normalized.accounting,
    provenance: {
      source: normalized.provenance.source,
      reference: normalized.provenance.reference
    }
  });
  return normalized;
}

function normalizePostingRule(input, { actor, now = new Date() } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Regola contabile mancante');
  const allowedEntryKinds = [...new Set((input.allowedEntryKinds || []).map((value) => token(value, 'Tipo scrittura ammesso')))];
  const allowedAccounts = [...new Set((input.allowedAccounts || []).map((value) => token(value, 'Conto ammesso')))];
  if (allowedEntryKinds.length === 0 || allowedEntryKinds.some((value) => !ENTRY_TYPES.has(value))) {
    throw new Error('La regola deve indicare tipi di scrittura ammessi');
  }
  if (allowedAccounts.length < 2) throw new Error('La regola deve indicare almeno due conti ammessi');
  const rule = {
    ruleId: token(input.ruleId, 'ID regola'),
    version: text(input.version, 'Versione regola', { max: 120 }),
    status: 'APPROVED',
    active: true,
    allowedEntryKinds: allowedEntryKinds.sort(),
    allowedAccounts: allowedAccounts.sort(),
    description: text(input.description, 'Descrizione regola', { max: 500 }),
    approval: {
      actor: text(actor, 'Approvatore', { max: 200 }),
      reason: text(input.approvalReason, 'Motivo approvazione', { max: 500 }),
      approvedAt: now
    }
  };
  rule.fingerprint = stableFingerprint({
    ruleId: rule.ruleId,
    version: rule.version,
    status: rule.status,
    active: rule.active,
    allowedEntryKinds: rule.allowedEntryKinds,
    allowedAccounts: rule.allowedAccounts,
    description: rule.description,
    approval: { actor: rule.approval.actor, reason: rule.approval.reason }
  });
  return rule;
}

export async function ensureEventEngineIndexes(db) {
  if (readyDatabases.has(db)) return;
  await Promise.all([
    db.collection('domain_events').createIndex({ eventKey: 1 }, { unique: true }),
    db.collection('domain_events').createIndex({ type: 1, occurredAt: -1 }),
    db.collection('event_outbox').createIndex({ eventKey: 1 }, { unique: true }),
    db.collection('event_outbox').createIndex({ status: 1, nextAttemptAt: 1, lockedUntil: 1 }),
    db.collection('accounting_entries').createIndex({ projectionKey: 1 }, { unique: true }),
    db.collection('accounting_entries').createIndex({ 'dates.competenceDate': 1, entryKind: 1 }),
    db.collection('accounting_entries').createIndex({ reversalOf: 1 }, { sparse: true }),
    db.collection('accounting_balances').createIndex({ accountCode: 1, year: 1, currency: 1 }, { unique: true }),
    db.collection('projection_outbox').createIndex({ projectionKey: 1, pageId: 1 }, { unique: true }),
    db.collection('projection_outbox').createIndex({ status: 1, createdAt: 1 }),
    db.collection('accounting_posting_rules').createIndex({ ruleId: 1, version: 1 }, { unique: true }),
    db.collection('accounting_posting_rules').createIndex({ active: 1, status: 1 }),
    db.collection('accounting_periods').createIndex({ year: 1, month: 1 }, { unique: true }),
    db.collection('projection_audit').createIndex({ auditKey: 1 }, { unique: true })
  ]);
  readyDatabases.add(db);
}

export async function changeAccountingPeriod({ client, db }, input, { actor, now = new Date() } = {}) {
  await ensureEventEngineIndexes(db);
  if (!client) throw new Error('Gestione periodo richiede transazione MongoDB');
  const year = Number(input?.year);
  const month = Number(input?.month);
  const action = token(input?.action, 'Azione periodo');
  const reason = text(input?.reason, 'Motivo operazione periodo', { max: 500 });
  const auditActor = text(actor, 'Attore periodo', { max: 200 });
  if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new Error('Anno periodo non valido');
  if (!Number.isInteger(month) || month < 1 || month > 12) throw new Error('Mese periodo non valido');
  if (!['OPEN', 'CLOSE', 'REOPEN'].includes(action)) throw new Error('Azione periodo non ammessa');
  return withMongoTransaction(client, async (session) => {
    const periods = db.collection('accounting_periods');
    const existing = await periods.findOne({ year, month }, { session });
    if (!existing && action !== 'OPEN') throw new Error('ACCOUNTING_PERIOD_NOT_FOUND');
    if (existing && action === 'OPEN') throw new Error('ACCOUNTING_PERIOD_ALREADY_EXISTS');
    if (action === 'CLOSE' && existing.status !== 'OPEN') throw new Error('ACCOUNTING_PERIOD_NOT_OPEN');
    if (action === 'REOPEN' && existing.status !== 'CLOSED') throw new Error('ACCOUNTING_PERIOD_NOT_CLOSED');
    if (action === 'CLOSE') {
      const periodStart = new Date(Date.UTC(year, month - 1, 1));
      const periodEnd = new Date(Date.UTC(year, month, 1));
      const pending = await db.collection('event_outbox').aggregate([
        { $match: { status: { $in: ['PENDING', 'RETRY', 'PROCESSING'] } } },
        { $lookup: { from: 'domain_events', localField: 'eventKey', foreignField: 'eventKey', as: 'event' } },
        { $unwind: '$event' },
        { $match: { 'event.accounting.dates.registrationDate': { $gte: periodStart, $lt: periodEnd } } },
        { $limit: 1 }
      ], { session }).toArray();
      if (pending.length > 0) throw new Error('ACCOUNTING_PERIOD_HAS_PENDING_EVENTS');
    }
    const version = Number(existing?.version || 0) + 1;
    const status = action === 'CLOSE' ? 'CLOSED' : 'OPEN';
    await periods.updateOne(
      { year, month, version: existing?.version },
      {
        $set: { status, version, lastAction: action, reason, actor: auditActor, updatedAt: now },
        $setOnInsert: { year, month, createdAt: now }
      },
      { session, upsert: !existing }
    );
    await db.collection('projection_audit').insertOne({
      auditKey: `ACCOUNTING_PERIOD_${action}:${year}-${String(month).padStart(2, '0')}:v${version}`,
      action: `ACCOUNTING_PERIOD_${action}`,
      year, month, version, previousStatus: existing?.status || null, status,
      actor: auditActor, reason, createdAt: now
    }, { session });
    return { year, month, version, previousStatus: existing?.status || null, status };
  });
}

export async function registerPostingRule({ client, db }, input, { actor, now = new Date() } = {}) {
  await ensureEventEngineIndexes(db);
  if (!client) throw new Error('Registrazione regola richiede transazione MongoDB');
  const rule = normalizePostingRule(input, { actor, now });
  return withMongoTransaction(client, async (session) => {
    const existing = await db.collection('accounting_posting_rules').findOne(
      { ruleId: rule.ruleId, version: rule.version },
      { session }
    );
    if (existing) {
      if (existing.fingerprint !== rule.fingerprint) throw new Error('POSTING_RULE_CONFLICT');
      return { rule: existing, duplicate: true };
    }
    await db.collection('accounting_posting_rules').insertOne({ ...rule, createdAt: now }, { session });
    await db.collection('projection_audit').insertOne({
      auditKey: `POSTING_RULE_APPROVED:${rule.ruleId}:${rule.version}`,
      action: 'POSTING_RULE_APPROVED',
      ruleId: rule.ruleId,
      ruleVersion: rule.version,
      fingerprint: rule.fingerprint,
      actor: rule.approval.actor,
      reason: rule.approval.reason,
      createdAt: now
    }, { session });
    return { rule, duplicate: false };
  });
}

async function assertApprovedPostingRule(db, accounting, session) {
  const rule = await db.collection('accounting_posting_rules').findOne({
    ruleId: accounting.postingRule.id,
    version: accounting.postingRule.version,
    status: 'APPROVED',
    active: true
  }, { session });
  if (!rule) throw new Error('POSTING_RULE_NOT_APPROVED');
  if (!rule.allowedEntryKinds.includes(accounting.entryKind)) throw new Error('POSTING_RULE_ENTRY_KIND_NOT_ALLOWED');
  const invalidAccount = accounting.lines.find((line) => !rule.allowedAccounts.includes(line.accountCode));
  if (invalidAccount) throw new Error('POSTING_RULE_ACCOUNT_NOT_ALLOWED');
  return rule;
}

async function assertAccountingPeriodOpen(db, accounting, session) {
  const registrationDate = accounting.dates.registrationDate;
  const year = registrationDate.getUTCFullYear();
  const month = registrationDate.getUTCMonth() + 1;
  const period = await db.collection('accounting_periods').findOne({ year, month }, { session });
  if (!period || period.status !== 'OPEN') throw new Error('ACCOUNTING_PERIOD_NOT_OPEN');
  return period;
}

async function publishInSession(db, event, session, now) {
  const existing = await db.collection('domain_events').findOne({ eventKey: event.eventKey }, { session });
  if (existing) {
    if (existing.fingerprint !== event.fingerprint) throw new Error('EVENT_KEY_CONFLICT');
    return { event: existing, duplicate: true };
  }
  if (event.accounting) {
    await assertApprovedPostingRule(db, event.accounting, session);
    await assertAccountingPeriodOpen(db, event.accounting, session);
  }
  const stored = { ...event, status: 'RECORDED', recordedAt: now };
  await db.collection('domain_events').insertOne(stored, { session });
  await db.collection('event_outbox').insertOne({
    eventKey: event.eventKey,
    eventType: event.type,
    status: 'PENDING',
    attempts: 0,
    nextAttemptAt: now,
    lockedUntil: null,
    createdAt: now,
    updatedAt: now
  }, { session });
  await db.collection('projection_audit').insertOne({
    auditKey: `EVENT_RECORDED:${event.eventKey}`,
    action: 'EVENT_RECORDED',
    eventKey: event.eventKey,
    fingerprint: event.fingerprint,
    actor: event.provenance.actor,
    sourceReference: event.provenance.reference,
    createdAt: now
  }, { session });
  return { event: stored, duplicate: false };
}

export async function publishDomainEvent({ client, db }, input, { now = new Date() } = {}) {
  await ensureEventEngineIndexes(db);
  const event = normalizeDomainEvent(input, { now });
  if (!client) throw new Error('Pubblicazione evento richiede transazione MongoDB');
  return withMongoTransaction(client, (session) => publishInSession(db, event, session, now));
}

export async function publishDomainEventInSession(db, input, { session, now = new Date() } = {}) {
  if (!session) throw new Error('Pubblicazione evento in sessione richiede una sessione MongoDB');
  const event = normalizeDomainEvent(input, { now });
  return publishInSession(db, event, session, now);
}

export async function projectAccountingEvent(db, event, { session = null, now = new Date() } = {}) {
  const entry = event.accounting;
  const options = session ? { session } : {};
  const existing = await db.collection('accounting_entries').findOne({ projectionKey: entry.projectionKey }, options);
  if (existing) {
    if (existing.fingerprint !== entry.fingerprint) throw new Error('PROJECTION_KEY_CONFLICT');
    return { entry: existing, duplicate: true };
  }
  if (entry.entryKind === 'REVERSAL') {
    const original = await db.collection('accounting_entries').findOne({ projectionKey: entry.reversalOf }, options);
    if (!original) throw new Error('ORIGINAL_ENTRY_NOT_FOUND');
    if (original.reversedBy) throw new Error('ORIGINAL_ENTRY_ALREADY_REVERSED');
    const expected = original.lines.map((line) => ({
      accountCode: line.accountCode,
      debit: line.credit,
      credit: line.debit
    }));
    if (stableFingerprint(expected) !== stableFingerprint(entry.lines.map(({ accountCode, debit, credit }) => ({ accountCode, debit, credit })))) {
      throw new Error('REVERSAL_LINES_DO_NOT_OFFSET_ORIGINAL');
    }
  }
  const stored = {
    ...entry,
    eventKey: event.eventKey,
    eventType: event.type,
    status: 'POSTED',
    createdAt: now,
    updatedAt: now
  };
  await db.collection('accounting_entries').insertOne(stored, options);
  if (entry.entryKind === 'REVERSAL') {
    const reversalUpdate = await db.collection('accounting_entries').updateOne(
      { projectionKey: entry.reversalOf, reversedBy: { $exists: false } },
      { $set: { reversedBy: entry.projectionKey, updatedAt: now } },
      options
    );
    if (reversalUpdate.matchedCount !== 1) throw new Error('ORIGINAL_ENTRY_ALREADY_REVERSED');
  }
  const year = entry.dates.competenceDate.getUTCFullYear();
  await Promise.all(entry.lines.map((line) => db.collection('accounting_balances').updateOne(
    { accountCode: line.accountCode, year, currency: entry.currency },
    {
      $inc: {
        debitCents: Math.round(line.debit * 100),
        creditCents: Math.round(line.credit * 100),
        balanceCents: Math.round((line.debit - line.credit) * 100),
        entryCount: 1
      },
      $set: { lastProjectionKey: entry.projectionKey, updatedAt: now },
      $setOnInsert: { accountCode: line.accountCode, year, currency: entry.currency, createdAt: now }
    },
    { ...options, upsert: true }
  )));
  await db.collection('projection_outbox').insertMany(ACCOUNTING_PROJECTION_PAGES.map((pageId) => ({
    projectionKey: entry.projectionKey,
    eventKey: event.eventKey,
    eventType: 'accounting.entry_projected',
    pageId,
    status: 'PENDING',
    attempts: 0,
    nextAttemptAt: now,
    lockedUntil: null,
    createdAt: now,
    updatedAt: now
  })), options);
  await db.collection('projection_audit').insertOne({
    auditKey: `ACCOUNTING_POSTED:${event.eventKey}:${entry.projectionKey}`,
    action: 'ACCOUNTING_POSTED',
    eventKey: event.eventKey,
    projectionKey: entry.projectionKey,
    entryKind: entry.entryKind,
    fingerprint: entry.fingerprint,
    createdAt: now
  }, options);
  return { entry: stored, duplicate: false };
}

async function claimOutbox(db, { workerId, now, leaseMs }) {
  return db.collection('event_outbox').findOneAndUpdate(
    { $or: [
      {
        status: { $in: ['PENDING', 'RETRY'] },
        nextAttemptAt: { $lte: now },
        $or: [{ lockedUntil: null }, { lockedUntil: { $lte: now } }]
      },
      { status: 'PROCESSING', lockedUntil: { $lte: now } }
    ] },
    {
      $set: { status: 'PROCESSING', workerId, lockedUntil: new Date(now.getTime() + leaseMs), updatedAt: now },
      $inc: { attempts: 1 }
    },
    { sort: { createdAt: 1 }, returnDocument: 'after' }
  );
}

export async function requeueOutboxEvent({ client, db }, eventKey, { actor, reason, now = new Date() } = {}) {
  await ensureEventEngineIndexes(db);
  if (!client) throw new Error('Ripresa evento richiede transazione MongoDB');
  const key = text(eventKey, 'Chiave evento', { max: 500 });
  const auditReason = text(reason, 'Motivo ripresa', { max: 500 });
  const auditActor = text(actor, 'Attore ripresa', { max: 200 });
  return withMongoTransaction(client, async (session) => {
    const item = await db.collection('event_outbox').findOne({ eventKey: key }, { session });
    if (!item) throw new Error('OUTBOX_EVENT_NOT_FOUND');
    if (!['DEAD_LETTER', 'COMPLETED'].includes(item.status)) throw new Error('OUTBOX_EVENT_NOT_REQUEUEABLE');
    await db.collection('event_outbox').updateOne(
      { _id: item._id, status: item.status },
      {
        $set: { status: 'PENDING', attempts: 0, nextAttemptAt: now, lockedUntil: null, updatedAt: now },
        $unset: { lastError: '', completedAt: '', workerId: '' }
      },
      { session }
    );
    await db.collection('projection_audit').insertOne({
      auditKey: `OUTBOX_REQUEUED:${key}:${now.toISOString()}`,
      action: 'OUTBOX_REQUEUED', eventKey: key, actor: auditActor, reason: auditReason, createdAt: now
    }, { session });
    return { eventKey: key, previousStatus: item.status, status: 'PENDING' };
  });
}

export async function dispatchNextEvent({ client, db }, {
  workerId = `worker-${process.pid}`,
  now = new Date(),
  leaseMs = 30_000,
  maxAttempts = 5
} = {}) {
  await ensureEventEngineIndexes(db);
  const claimed = await claimOutbox(db, { workerId, now, leaseMs });
  if (!claimed) return null;
  try {
    const output = await withMongoTransaction(client, async (session) => {
      const owned = await db.collection('event_outbox').findOne({
        _id: claimed._id,
        status: 'PROCESSING',
        workerId,
        lockedUntil: { $gt: now }
      }, { session });
      if (!owned) throw new Error('OUTBOX_LEASE_LOST');
      const event = await db.collection('domain_events').findOne({ eventKey: claimed.eventKey }, { session });
      if (!event) throw new Error('DOMAIN_EVENT_NOT_FOUND');
      const domainProjection = await projectSupplierInvoiceValidated(db, event, { session, now });
      const ledgerProjection = await projectFinancialLedgerEvent(db, event, { session, now });
      const movementProjection = await projectFinancialMovementObserved(db, event, { session, now });
      const projected = event.accounting
        ? await projectAccountingEvent(db, event, { session, now })
        : { projected: false };
      const competenceExpectation = await completeSupplierInvoiceAccountingExpectation(db, event, { session, now });
      const settlementExpectation = await completeSupplierInvoiceSettlementLedgerExpectation(db, event, { session, now });
      await db.collection('event_outbox').updateOne(
        { _id: claimed._id, workerId, status: 'PROCESSING' },
        { $set: { status: 'COMPLETED', completedAt: now, updatedAt: now, lockedUntil: null }, $unset: { lastError: '' } },
        { session }
      );
      return { ...projected, domainProjection, ledgerProjection, movementProjection, competenceExpectation, settlementExpectation };
    });
    return { eventKey: claimed.eventKey, status: 'COMPLETED', ...output };
  } catch (error) {
    const terminal = Number(claimed.attempts || 0) >= maxAttempts || /CONFLICT|NOT_FOUND|DO_NOT_OFFSET|ALREADY_REVERSED/.test(error.message);
    const delayMs = Math.min(60_000, 1000 * (2 ** Math.max(0, Number(claimed.attempts || 1) - 1)));
    await db.collection('event_outbox').updateOne(
      { _id: claimed._id, workerId },
      {
        $set: {
          status: terminal ? 'DEAD_LETTER' : 'RETRY',
          lastError: String(error.message || 'Errore proiezione').slice(0, 1000),
          nextAttemptAt: new Date(now.getTime() + delayMs),
          lockedUntil: null,
          updatedAt: now
        }
      }
    );
    return { eventKey: claimed.eventKey, status: terminal ? 'DEAD_LETTER' : 'RETRY', error: error.message };
  }
}

export async function dispatchPendingEvents(context, { limit = 50, ...options } = {}) {
  const results = [];
  for (let index = 0; index < Math.max(1, Math.min(500, Number(limit) || 50)); index += 1) {
    const result = await dispatchNextEvent(context, options);
    if (!result) break;
    results.push(result);
  }
  return results;
}

export function createEventEngineRuntime({ getClient, getDb, intervalMs = 2000 } = {}) {
  let timer = null;
  let running = false;
  const tick = async () => {
    if (running) return;
    const client = getClient?.();
    const db = getDb?.();
    if (!client || !db) return;
    running = true;
    try {
      await dispatchPendingEvents({ client, db }, { limit: 25 });
    } catch (error) {
      console.error('[event-engine] dispatch fallito', error.message);
    } finally {
      running = false;
    }
  };
  return {
    start() {
      if (timer) return;
      timer = setInterval(tick, Math.max(500, intervalMs));
      timer.unref?.();
      tick();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      while (running) await new Promise((resolve) => setTimeout(resolve, 10));
    },
    tick
  };
}
