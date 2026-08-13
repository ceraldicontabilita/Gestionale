import { stableFingerprint } from './fingerprint.js';

const readyDatabases = new WeakSet();

async function ensureIndexes(db) {
  if (readyDatabases.has(db)) return;
  await Promise.all([
    db.collection('financial_movement_projection').createIndex({ movementKey: 1 }, { unique: true }),
    db.collection('coherence_evaluations').createIndex({ evaluationKey: 1 }, { unique: true })
  ]);
  readyDatabases.add(db);
}

export async function projectFinancialMovementObserved(db, event, { session = null, now = new Date() } = {}) {
  if (event?.type !== 'financial.movement_observed') return { projected: false };
  await ensureIndexes(db);
  const options = session ? { session } : {};
  const movementKey = String(event.payload?.movementKey || '');
  if (!movementKey) throw new Error('FINANCIAL_MOVEMENT_KEY_MISSING');
  const movement = await db.collection('movimenti').findOne({ movementKey }, options);
  if (!movement) throw new Error('FINANCIAL_MOVEMENT_NOT_FOUND');
  if (movement.sourceEventKey && movement.sourceEventKey !== event.eventKey) throw new Error('FINANCIAL_MOVEMENT_EVENT_CONFLICT');

  const projection = {
    movementKey,
    sourceEventKey: event.eventKey,
    accountId: movement.accountId,
    sourceTransactionId: movement.sourceTransactionId,
    bookingDate: movement.data,
    valueDate: movement.dataValuta || null,
    direction: movement.direzione,
    amountCents: Math.round(Number(movement.importo || 0) * 100),
    currency: movement.valuta || 'EUR',
    status: movement.stato,
    sourceFingerprint: movement.factFingerprint,
    updatedAt: now
  };
  await db.collection('financial_movement_projection').updateOne(
    { movementKey },
    { $set: projection, $setOnInsert: { createdAt: now } },
    { ...options, upsert: true }
  );
  await db.collection('movimenti').updateOne(
    { movementKey },
    { $set: { sourceEventKey: event.eventKey, eventProjectedAt: now, aggiornatoIl: now } },
    options
  );

  const checks = {
    exactCents: Number.isSafeInteger(projection.amountCents) && projection.amountCents > 0,
    stableIdentity: Boolean(projection.accountId && projection.sourceTransactionId),
    realEvidence: (movement.evidenze || []).some((row) => row.reale === true && row.riferimento),
    sourceProvenance: Array.isArray(movement.sourceRows) && movement.sourceRows.length > 0
  };
  const inputFingerprint = stableFingerprint({ movementKey, sourceFingerprint: movement.factFingerprint, checks });
  const evaluationKey = `FINANCIAL_MOVEMENT_COHERENCE:${movementKey}:${inputFingerprint}`;
  await db.collection('coherence_evaluations').updateOne(
    { evaluationKey },
    { $setOnInsert: { evaluationKey, ruleId: 'FINANCIAL_MOVEMENT_COHERENCE', ruleVersion: '1', targetType: 'FINANCIAL_MOVEMENT', targetId: movementKey, inputFingerprint, checks, status: Object.values(checks).every(Boolean) ? 'PASS' : 'FAIL', sourceEventKey: event.eventKey, evaluatedAt: now, createdAt: now } },
    { ...options, upsert: true }
  );
  return { projected: true, movementKey, coherenceStatus: Object.values(checks).every(Boolean) ? 'PASS' : 'FAIL' };
}
