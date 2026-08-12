import crypto from 'node:crypto';

export const JOB_TYPES = Object.freeze([
  'EMAIL_PEC_SCAN',
  'DRIVE_FISCALE_SCAN',
  'DOCUMENTI_RIPROCESSA',
  'SCADENZE_FISCALI',
  'CODICI_TRIBUTO_REFRESH',
  'ADER_SNAPSHOT_IMPORT'
]);

export function normalizeJobName(value) {
  const job = String(value || '').trim().toUpperCase();
  if (!JOB_TYPES.includes(job)) throw new Error('Job non valido');
  return job;
}

export async function acquireJobLease(db, jobName, options = {}) {
  const job = normalizeJobName(jobName);
  const now = options.now || new Date();
  const leaseMs = Number(options.leaseMs || 15 * 60 * 1000);
  if (!Number.isFinite(leaseMs) || leaseMs < 5_000) throw new Error('Durata lease non valida');
  const owner = options.owner || crypto.randomUUID();
  const expiresAt = new Date(now.getTime() + leaseMs);

  const updated = await db.collection('job_locks').findOneAndUpdate(
    { _id: job, expiresAt: { $lte: now } },
    { $set: { owner, acquiredAt: now, expiresAt, updatedAt: now } },
    { returnDocument: 'after' }
  );
  const renewed = updated?.value ?? updated;
  if (renewed?.owner === owner) return { job, owner, expiresAt, leaseMs };

  try {
    await db.collection('job_locks').insertOne({
      _id: job,
      owner,
      acquiredAt: now,
      expiresAt,
      updatedAt: now,
      createdAt: now
    });
    return { job, owner, expiresAt, leaseMs };
  } catch (error) {
    if (error?.code === 11000) return null;
    throw error;
  }
}

export async function renewJobLease(db, lease, { now = new Date() } = {}) {
  if (!lease?.job || !lease?.owner) return false;
  const leaseMs = Number(lease.leaseMs || 15 * 60 * 1000);
  const expiresAt = new Date(now.getTime() + leaseMs);
  const result = await db.collection('job_locks').updateOne(
    { _id: lease.job, owner: lease.owner, expiresAt: { $gt: now } },
    { $set: { expiresAt, heartbeatAt: now, updatedAt: now } }
  );
  if (result.modifiedCount > 0) lease.expiresAt = expiresAt;
  return result.modifiedCount > 0;
}

export async function releaseJobLease(db, lease, { now = new Date() } = {}) {
  if (!lease?.job || !lease?.owner) return false;
  const result = await db.collection('job_locks').updateOne(
    { _id: lease.job, owner: lease.owner },
    { $set: { expiresAt: now, releasedAt: now, updatedAt: now } }
  );
  return result.modifiedCount > 0;
}

export async function getCheckpoint(db, jobName) {
  const job = normalizeJobName(jobName);
  return db.collection('job_checkpoints').findOne({ _id: job });
}

export async function saveCheckpoint(db, jobName, checkpoint, { now = new Date() } = {}) {
  const job = normalizeJobName(jobName);
  const value = sanitizeCheckpoint(checkpoint);
  await db.collection('job_checkpoints').updateOne(
    { _id: job },
    { $set: { value, updatedAt: now }, $setOnInsert: { createdAt: now } },
    { upsert: true }
  );
  return value;
}

export function checkpointWindow(checkpoint, overlapMs = 3 * 24 * 60 * 60 * 1000) {
  if (!checkpoint?.value?.lastSuccessfulAt) return null;
  const last = new Date(checkpoint.value.lastSuccessfulAt);
  if (Number.isNaN(last.getTime())) return null;
  return new Date(last.getTime() - overlapMs);
}

export async function startJobRun(db, jobName, metadata = {}, { now = new Date() } = {}) {
  const job = normalizeJobName(jobName);
  const run = {
    job,
    status: 'RUNNING',
    startedAt: now,
    endedAt: null,
    counts: defaultCounts(),
    metadata: sanitizeMetadata(metadata),
    errors: []
  };
  const result = await db.collection('job_runs').insertOne(run);
  return { ...run, _id: result.insertedId };
}

export async function finishJobRun(db, runId, patch = {}, { now = new Date() } = {}) {
  const status = String(patch.status || 'SUCCESS').toUpperCase();
  const update = {
    status,
    endedAt: now,
    counts: normalizeCounts(patch.counts),
    errors: normalizeErrors(patch.errors)
  };
  if (patch.metadata) update.metadata = sanitizeMetadata(patch.metadata);
  await db.collection('job_runs').updateOne({ _id: runId }, { $set: update });
  return update;
}

export async function registerDocumentSource(db, documentId, source, { now = new Date() } = {}) {
  const tipo = String(source?.tipo || 'SCONOSCIUTA').toUpperCase();
  const riferimento = source?.riferimento ? String(source.riferimento) : null;
  const sourceKey = String(source?.sourceKey || `${tipo}:${riferimento || ''}`).trim();
  if (!sourceKey) throw new Error('Fonte senza chiave stabile');

  const path = `fontiByKey.${safeMongoKey(sourceKey)}`;
  await db.collection('documenti').updateOne(
    { _id: documentId },
    { $set: { [path]: { sourceKey, tipo, riferimento, rilevataIl: now }, aggiornatoIl: now } }
  );
  return sourceKey;
}

function defaultCounts() {
  return { scanned: 0, new: 0, duplicates: 0, review: 0, errors: 0 };
}

function sanitizeCheckpoint(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { value };
  return JSON.parse(JSON.stringify(value));
}

function sanitizeMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return JSON.parse(JSON.stringify(value));
}

function normalizeCounts(value = {}) {
  const out = defaultCounts();
  for (const [key, raw] of Object.entries(value || {}).slice(0, 100)) {
    if (!/^[A-Za-z0-9_]{1,80}$/.test(key)) continue;
    const number = Number(raw || 0);
    if (Number.isFinite(number)) out[key] = Math.max(0, number);
  }
  return out;
}

function normalizeErrors(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 100).map((item) => ({
    code: item?.code ? String(item.code) : null,
    message: String(item?.message || item || '').slice(0, 1000),
    reference: item?.reference ? String(item.reference) : null
  }));
}

function safeMongoKey(value) {
  return Buffer.from(String(value)).toString('base64url');
}
