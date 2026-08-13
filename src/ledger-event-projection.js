import { stableFingerprint } from './fingerprint.js';

const readyDatabases = new WeakSet();

export async function ensureLedgerEventIndexes(db) {
  if (readyDatabases.has(db)) return;
  await Promise.all([
    db.collection('ledger_entries').createIndex({ ledgerKey: 1 }, { unique: true }),
    db.collection('ledger_entries').createIndex({ sourceEventKey: 1 }, { unique: true }),
    db.collection('ledger_entries').createIndex({ 'dates.registrationDate': -1, entryKind: 1 })
  ]);
  readyDatabases.add(db);
}

export async function projectFinancialLedgerEvent(db, event, { session = null, now = new Date() } = {}) {
  if (event?.type !== 'ledger.entry_projected') return { projected: false };
  await ensureLedgerEventIndexes(db);
  const options = session ? { session } : {};
  const accounting = event.accounting;
  if (accounting.entryKind !== 'FINANCIAL_SETTLEMENT') throw new Error('LEDGER_EVENT_KIND_NOT_SUPPORTED');
  const ledger = {
    ledgerKey: accounting.projectionKey,
    sourceEventKey: event.eventKey,
    entryKind: accounting.entryKind,
    source: accounting.source,
    currency: accounting.currency,
    dates: accounting.dates,
    lines: accounting.lines,
    totals: accounting.totals,
    evidence: accounting.evidence,
    description: accounting.description || null,
    status: 'POSTED',
    createdAt: now,
    updatedAt: now
  };
  ledger.fingerprint = stableFingerprint({
    ledgerKey: ledger.ledgerKey,
    sourceEventKey: ledger.sourceEventKey,
    entryKind: ledger.entryKind,
    source: ledger.source,
    currency: ledger.currency,
    dates: ledger.dates,
    lines: ledger.lines,
    totals: ledger.totals,
    evidence: ledger.evidence
  });
  const existing = await db.collection('ledger_entries').findOne({ ledgerKey: ledger.ledgerKey }, options);
  if (existing && existing.fingerprint !== ledger.fingerprint) throw new Error('LEDGER_ENTRY_CONFLICT');
  if (!existing) await db.collection('ledger_entries').insertOne(ledger, options);
  return { projected: true, ledger: existing || ledger, duplicate: Boolean(existing) };
}
