import crypto from 'node:crypto';
import { stableFingerprint } from './fingerprint.js';
import { withMongoTransaction } from './mongo-transaction.js';

const readyDatabases = new WeakSet();
export const ACCOUNTING_PAGE_PROJECTIONS = Object.freeze([
  'prima_nota.libro_giornale_mastro',
  'controllo.piano_conti',
  'controllo.bilancio',
  'controllo.anomalie'
]);

export async function ensureProjectionEngineIndexes(db) {
  if (readyDatabases.has(db)) return;
  await Promise.all([
    db.collection('journal_page_projection').createIndex({ projectionKey: 1 }, { unique: true }),
    db.collection('ledger_page_projection').createIndex({ accountCode: 1, year: 1, projectionKey: 1 }, { unique: true }),
    db.collection('chart_account_projection').createIndex({ accountCode: 1 }, { unique: true }),
    db.collection('trial_balance_projection').createIndex({ accountCode: 1, year: 1, currency: 1 }, { unique: true }),
    db.collection('coherence_evaluations').createIndex({ evaluationKey: 1 }, { unique: true }),
    db.collection('coherence_anomalies').createIndex({ anomalyKey: 1 }, { unique: true }),
    db.collection('projection_rebuilds').createIndex({ rebuildKey: 1 }, { unique: true })
  ]);
  readyDatabases.add(db);
}

function opts(session) { return session ? { session } : {}; }

async function journal(db, item, entry, session, now) {
  const options = opts(session);
  await db.collection('journal_page_projection').updateOne(
    { projectionKey: entry.projectionKey },
    { $set: { projectionKey: entry.projectionKey, eventKey: entry.eventKey, entryKind: entry.entryKind, source: entry.source, dates: entry.dates, currency: entry.currency, description: entry.description, lines: entry.lines, totals: entry.totals, reversedBy: entry.reversedBy || null, sourceFingerprint: entry.fingerprint, updatedAt: now }, $setOnInsert: { createdAt: now } },
    { ...options, upsert: true }
  );
  const year = entry.dates.competenceDate.getUTCFullYear();
  for (const line of entry.lines) {
    await db.collection('ledger_page_projection').updateOne(
      { accountCode: line.accountCode, year, projectionKey: entry.projectionKey },
      { $set: { eventKey: entry.eventKey, competenceDate: entry.dates.competenceDate, registrationDate: entry.dates.registrationDate, debitCents: Math.round(line.debit * 100), creditCents: Math.round(line.credit * 100), description: line.description || entry.description || null, updatedAt: now }, $setOnInsert: { accountCode: line.accountCode, year, projectionKey: entry.projectionKey, createdAt: now } },
      { ...options, upsert: true }
    );
  }
  return { rows: entry.lines.length + 1 };
}

async function chart(db, _item, entry, session, now) {
  const options = opts(session);
  for (const line of entry.lines) {
    await db.collection('chart_account_projection').updateOne(
      { accountCode: line.accountCode },
      { $set: { lastProjectionKey: entry.projectionKey, lastObservedAt: now, updatedAt: now }, $setOnInsert: { accountCode: line.accountCode, mappingStatus: 'UNMAPPED', source: 'OBSERVED_ACCOUNTING_ENTRY', createdAt: now } },
      { ...options, upsert: true }
    );
  }
  return { rows: entry.lines.length };
}

async function trialBalance(db, _item, entry, session, now) {
  const options = opts(session);
  const year = entry.dates.competenceDate.getUTCFullYear();
  const accountCodes = [...new Set(entry.lines.map((line) => line.accountCode))];
  for (const accountCode of accountCodes) {
    const balance = await db.collection('accounting_balances').findOne({ accountCode, year, currency: entry.currency }, options);
    if (!balance) throw new Error('ACCOUNTING_BALANCE_NOT_FOUND');
    await db.collection('trial_balance_projection').updateOne(
      { accountCode, year, currency: entry.currency },
      { $set: { debitCents: Number(balance.debitCents || 0), creditCents: Number(balance.creditCents || 0), balanceCents: Number(balance.balanceCents || 0), entryCount: Number(balance.entryCount || 0), lastProjectionKey: balance.lastProjectionKey, updatedAt: now }, $setOnInsert: { accountCode, year, currency: entry.currency, createdAt: now } },
      { ...options, upsert: true }
    );
  }
  return { rows: accountCodes.length };
}

async function coherence(db, _item, entry, session, now) {
  const options = opts(session);
  const debitCents = entry.lines.reduce((sum, line) => sum + Math.round(line.debit * 100), 0);
  const creditCents = entry.lines.reduce((sum, line) => sum + Math.round(line.credit * 100), 0);
  const checks = {
    exactQuadrature: debitCents > 0 && debitCents === creditCents,
    sourceIdentity: Boolean(entry.source?.type && entry.source?.id && entry.source?.version),
    postingRule: Boolean(entry.postingRule?.id && entry.postingRule?.version),
    provenance: Boolean(entry.eventKey && entry.fingerprint)
  };
  const status = Object.values(checks).every(Boolean) ? 'PASS' : 'FAIL';
  const inputFingerprint = stableFingerprint({ projectionKey: entry.projectionKey, fingerprint: entry.fingerprint, checks });
  const evaluationKey = `ACCOUNTING_ENTRY_COHERENCE:${entry.projectionKey}:${inputFingerprint}`;
  await db.collection('coherence_evaluations').updateOne(
    { evaluationKey },
    { $setOnInsert: { evaluationKey, ruleId: 'ACCOUNTING_ENTRY_COHERENCE', ruleVersion: '1', targetType: 'ACCOUNTING_ENTRY', targetId: entry.projectionKey, inputFingerprint, checks, status, sourceEventKey: entry.eventKey, evaluatedAt: now, createdAt: now } },
    { ...options, upsert: true }
  );
  if (status === 'FAIL') {
    const anomalyKey = `ACCOUNTING_ENTRY_COHERENCE:${entry.projectionKey}`;
    await db.collection('coherence_anomalies').updateOne(
      { anomalyKey },
      { $set: { status: 'OPEN', checks, inputFingerprint, updatedAt: now }, $setOnInsert: { anomalyKey, targetType: 'ACCOUNTING_ENTRY', targetId: entry.projectionKey, createdAt: now } },
      { ...options, upsert: true }
    );
  }
  return { rows: 1, coherenceStatus: status };
}

const handlers = new Map([
  ['prima_nota.libro_giornale_mastro', journal],
  ['controllo.piano_conti', chart],
  ['controllo.bilancio', trialBalance],
  ['controllo.anomalie', coherence]
]);

async function applyProjection(db, item, { session = null, now = new Date() } = {}) {
  const handler = handlers.get(item.pageId);
  if (!handler) throw new Error('PROJECTION_PAGE_NOT_REGISTERED');
  const entry = await db.collection('accounting_entries').findOne({ projectionKey: item.projectionKey }, opts(session));
  if (!entry) throw new Error('ACCOUNTING_ENTRY_NOT_FOUND');
  return handler(db, item, entry, session, now);
}

async function claim(db, { workerId, now, leaseMs }) {
  return db.collection('projection_outbox').findOneAndUpdate(
    { $or: [
      {
        status: { $in: ['PENDING', 'RETRY'] },
        $and: [
          { $or: [{ nextAttemptAt: { $exists: false } }, { nextAttemptAt: { $lte: now } }] },
          { $or: [{ lockedUntil: null }, { lockedUntil: { $exists: false } }, { lockedUntil: { $lte: now } }] }
        ]
      },
      { status: 'PROCESSING', lockedUntil: { $lte: now } }
    ] },
    { $set: { status: 'PROCESSING', workerId, lockedUntil: new Date(now.getTime() + leaseMs), updatedAt: now }, $inc: { attempts: 1 } },
    { sort: { createdAt: 1, pageId: 1 }, returnDocument: 'after' }
  );
}

export async function dispatchNextProjection({ client, db }, { workerId = `projection-${process.pid}`, now = new Date(), leaseMs = 30_000, maxAttempts = 5 } = {}) {
  if (!client || !db) throw new Error('Consumer proiezioni richiede MongoDB transazionale');
  await ensureProjectionEngineIndexes(db);
  const claimed = await claim(db, { workerId, now, leaseMs });
  if (!claimed) return null;
  try {
    const result = await withMongoTransaction(client, async (session) => {
      const owned = await db.collection('projection_outbox').findOne({ _id: claimed._id, status: 'PROCESSING', workerId, lockedUntil: { $gt: now } }, { session });
      if (!owned) throw new Error('PROJECTION_LEASE_LOST');
      const projected = await applyProjection(db, owned, { session, now });
      await db.collection('projection_outbox').updateOne(
        { _id: owned._id, status: 'PROCESSING', workerId },
        { $set: { status: 'COMPLETED', completedAt: now, lockedUntil: null, updatedAt: now }, $unset: { lastError: '' } },
        { session }
      );
      return projected;
    });
    return { projectionKey: claimed.projectionKey, pageId: claimed.pageId, status: 'COMPLETED', ...result };
  } catch (error) {
    const terminal = Number(claimed.attempts || 0) >= maxAttempts || /PROJECTION_PAGE_NOT_REGISTERED|ACCOUNTING_ENTRY_NOT_FOUND/.test(error.message);
    const delayMs = Math.min(60_000, 1000 * (2 ** Math.max(0, Number(claimed.attempts || 1) - 1)));
    await db.collection('projection_outbox').updateOne(
      { _id: claimed._id, workerId },
      { $set: { status: terminal ? 'DEAD_LETTER' : 'RETRY', lastError: String(error.message).slice(0, 1000), nextAttemptAt: new Date(now.getTime() + delayMs), lockedUntil: null, updatedAt: now } }
    );
    return { projectionKey: claimed.projectionKey, pageId: claimed.pageId, status: terminal ? 'DEAD_LETTER' : 'RETRY', error: error.message };
  }
}

export async function dispatchPendingProjections(context, { limit = 100, ...options } = {}) {
  const results = [];
  for (let index = 0; index < Math.max(1, Math.min(1000, Number(limit) || 100)); index += 1) {
    const result = await dispatchNextProjection(context, options);
    if (!result) break;
    results.push(result);
  }
  return results;
}

export async function rebuildAccountingProjections({ client, db }, { actor, reason, now = new Date() } = {}) {
  if (!client || !db) throw new Error('Ricostruzione proiezioni richiede MongoDB transazionale');
  await ensureProjectionEngineIndexes(db);
  const entries = await db.collection('accounting_entries').find({}).sort({ projectionKey: 1 }).toArray();
  const rebuildKey = stableFingerprint({ projectionKeys: entries.map((entry) => entry.projectionKey), schemaVersion: '1' });
  const existing = await db.collection('projection_rebuilds').findOne({ rebuildKey });
  if (existing) return { ...existing, duplicate: true };
  let rows = 0;
  for (const entry of entries) for (const pageId of ACCOUNTING_PAGE_PROJECTIONS) rows += Number((await applyProjection(db, { projectionKey: entry.projectionKey, pageId }, { now })).rows || 0);
  const record = { rebuildId: crypto.randomUUID(), rebuildKey, schemaVersion: '1', actor: String(actor || 'SYSTEM'), reason: String(reason || 'Ricostruzione richiesta').slice(0, 500), entryCount: entries.length, rows, completedAt: now, createdAt: now };
  await db.collection('projection_rebuilds').insertOne(record);
  return { ...record, duplicate: false };
}

export function createProjectionEngineRuntime({ getClient, getDb, intervalMs = 2000 } = {}) {
  let timer = null; let running = false;
  const tick = async () => {
    if (running) return;
    const client = getClient?.(); const db = getDb?.(); if (!client || !db) return;
    running = true;
    try { await dispatchPendingProjections({ client, db }, { limit: 100 }); }
    catch (error) { console.error('[projection-engine] dispatch fallito', error.message); }
    finally { running = false; }
  };
  return {
    start() { if (!timer) { timer = setInterval(tick, Math.max(500, intervalMs)); timer.unref?.(); tick(); } },
    async stop() { if (timer) clearInterval(timer); timer = null; while (running) await new Promise((resolve) => setTimeout(resolve, 10)); },
    tick
  };
}
