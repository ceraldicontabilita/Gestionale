import crypto, { randomUUID } from 'node:crypto';
import express from 'express';
import { importBankStatementRows, parseBankStatementCsv } from './bank-movement-import.js';
import { storeOriginalOnce } from './blob-store.js';

const MAX_FILES = 100;
const TERMINAL = new Set(['COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED']);
const readyDatabases = new WeakSet();

function database(getDb, res) {
  const db = getDb?.();
  if (!db) res.status(503).json({ error: 'MongoDB non configurato' });
  return db;
}

function cleanFilename(value, fallback) {
  const name = String(value || fallback || '').replace(/[\r\n\0]/g, '').trim().slice(0, 500);
  if (!name) throw new Error('Nome file obbligatorio');
  return name;
}

function uploadedFilename(value, fallback) {
  if (!value) return fallback;
  try { return cleanFilename(decodeURIComponent(value), fallback); }
  catch { throw new Error('Nome file upload non valido'); }
}

function errorStatus(error) {
  if (/NOT_FOUND/.test(error.message)) return 404;
  if (/ALREADY|CONFLICT/.test(error.message)) return 409;
  return 400;
}

async function ensureIndexes(db) {
  if (readyDatabases.has(db)) return;
  await Promise.all([
    db.collection('bank_movement_import_jobs').createIndex({ jobId: 1 }, { unique: true }),
    db.collection('bank_movement_import_jobs').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 })
  ]);
  readyDatabases.add(db);
}

function serialize(job) {
  const files = job.files || [];
  const totals = files.reduce((out, file) => {
    out.totalFiles += 1;
    if (TERMINAL.has(file.status)) out.completedFiles += 1;
    out.rows += Number(file.rows || 0);
    out.inserted += Number(file.inserted || 0);
    out.duplicates += Number(file.duplicates || 0);
    out.conflicts += Number(file.conflicts || 0);
    return out;
  }, { totalFiles: 0, completedFiles: 0, rows: 0, inserted: 0, duplicates: 0, conflicts: 0 });
  return {
    jobId: job.jobId,
    type: job.type,
    status: job.status,
    files,
    totals,
    progressPercent: totals.totalFiles ? Math.round(totals.completedFiles / totals.totalFiles * 100) : 0,
    creatoIl: job.creatoIl,
    aggiornatoIl: job.aggiornatoIl
  };
}

async function refresh(db, jobId) {
  const current = await db.collection('bank_movement_import_jobs').findOne({ jobId });
  if (!current) return null;
  const allTerminal = current.files.length > 0 && current.files.every((file) => TERMINAL.has(file.status));
  const hasErrors = current.files.some((file) => file.status !== 'COMPLETED' || Number(file.conflicts || 0) > 0);
  const status = allTerminal ? (hasErrors ? 'COMPLETED_WITH_ERRORS' : 'COMPLETED') : current.files.some((file) => file.status === 'PROCESSING') ? 'PROCESSING' : 'PENDING';
  if (status !== current.status) {
    await db.collection('bank_movement_import_jobs').updateOne({ jobId }, { $set: { status, aggiornatoIl: new Date(), ...(allTerminal ? { completedAt: new Date() } : {}) } });
    current.status = status;
  }
  return serialize(current);
}

async function updateFile(db, jobId, index, values) {
  await db.collection('bank_movement_import_jobs').updateOne(
    { jobId, 'files.index': index },
    { $set: Object.fromEntries(Object.entries(values).map(([key, value]) => [`files.$.${key}`, value]).concat([['aggiornatoIl', new Date()]])) }
  );
}

export function registerBankMovementRoutes(app, { getDb, getClient, uploadLimitMb = 50 } = {}) {
  app.post('/api/bank-movements/import-jobs', async (req, res) => {
    try {
      const db = database(getDb, res); if (!db) return;
      await ensureIndexes(db);
      const manifest = Array.isArray(req.body?.files) ? req.body.files : [];
      if (!manifest.length || manifest.length > MAX_FILES) throw new Error(`Selezionare da 1 a ${MAX_FILES} file CSV`);
      const files = manifest.map((file, index) => {
        const name = cleanFilename(file?.name, `estratto-${index + 1}.csv`);
        const size = Number(file?.size);
        if (!/\.csv$/i.test(name)) throw new Error(`Formato non supportato: ${name}`);
        if (!Number.isSafeInteger(size) || size <= 0 || size > uploadLimitMb * 1024 * 1024) throw new Error(`Dimensione non valida per ${name}`);
        return { index, name, size, status: 'PENDING', rows: 0, inserted: 0, duplicates: 0, conflicts: 0 };
      });
      const now = new Date();
      const job = { jobId: randomUUID(), type: 'BANK_MOVEMENT_CSV_IMPORT', status: 'PENDING', actor: String(req.auth?.sessionId || 'SYSTEM'), files, creatoIl: now, aggiornatoIl: now, expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000) };
      await db.collection('bank_movement_import_jobs').insertOne(job);
      res.status(201).json(serialize(job));
    } catch (error) { res.status(errorStatus(error)).json({ error: error.message }); }
  });

  app.get('/api/bank-movements/import-jobs/:jobId', async (req, res) => {
    try {
      const db = database(getDb, res); if (!db) return;
      await ensureIndexes(db);
      const job = await refresh(db, String(req.params.jobId));
      if (!job) return res.status(404).json({ error: 'BANK_IMPORT_JOB_NOT_FOUND' });
      res.set('Cache-Control', 'no-store');
      res.json(job);
    } catch (error) { res.status(errorStatus(error)).json({ error: error.message }); }
  });

  app.post('/api/bank-movements/import-jobs/:jobId/files/:index', express.raw({ type: 'application/octet-stream', limit: `${uploadLimitMb}mb` }), async (req, res) => {
    const db = database(getDb, res); if (!db) return;
    const jobId = String(req.params.jobId);
    const index = Number(req.params.index);
    try {
      await ensureIndexes(db);
      if (!Number.isSafeInteger(index) || index < 0 || !Buffer.isBuffer(req.body) || !req.body.length) throw new Error('File upload non valido');
      const job = await db.collection('bank_movement_import_jobs').findOne({ jobId });
      if (!job) return res.status(404).json({ error: 'BANK_IMPORT_JOB_NOT_FOUND' });
      if (String(job.actor) !== String(req.auth?.sessionId || '')) return res.status(403).json({ error: 'Importazione appartenente a un altra sessione' });
      const file = job.files.find((item) => item.index === index);
      if (!file) return res.status(404).json({ error: 'BANK_IMPORT_FILE_NOT_FOUND' });
      if (req.body.length !== file.size) throw new Error(`Dimensione ricevuta diversa dal file selezionato: ${file.name}`);
      const filename = uploadedFilename(req.get('x-file-name'), file.name);
      if (filename !== file.name) throw new Error('Nome file diverso dal manifesto di importazione');
      const sourceSha256 = crypto.createHash('sha256').update(req.body).digest('hex');
      if (TERMINAL.has(file.status)) {
        if (file.sha256 === sourceSha256) return res.json({ ok: true, duplicateUpload: true, job: await refresh(db, jobId) });
        return res.status(409).json({ error: 'BANK_IMPORT_FILE_ALREADY_COMPLETED' });
      }
      await updateFile(db, jobId, index, { status: 'PROCESSING', sha256: sourceSha256, error: null });
      const original = await storeOriginalOnce(db, req.body, { sha256: sourceSha256, filename, contentType: 'text/csv', metadata: { sourceType: 'BANK_STATEMENT_UPLOAD', actor: job.actor, importJobId: jobId } });
      const rows = parseBankStatementCsv(req.body);
      const totals = await importBankStatementRows({ client: getClient?.(), db }, rows, { sha256: original.sha256, gridFsId: original.gridFsId, filename: original.filename }, { actor: job.actor });
      const status = totals.conflicts ? 'COMPLETED_WITH_ERRORS' : 'COMPLETED';
      await updateFile(db, jobId, index, { ...totals, status, completedAt: new Date() });
      res.status(201).json({ ok: true, duplicateUpload: false, totals, job: await refresh(db, jobId) });
    } catch (error) {
      if (Number.isSafeInteger(index) && index >= 0) await updateFile(db, jobId, index, { status: 'FAILED', error: String(error.message || error).slice(0, 500), completedAt: new Date() }).catch(() => {});
      await refresh(db, jobId).catch(() => {});
      res.status(errorStatus(error)).json({ error: error.message });
    }
  });
}
