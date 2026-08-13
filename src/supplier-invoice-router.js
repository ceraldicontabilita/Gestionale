import crypto, { randomUUID } from 'node:crypto';
import express from 'express';
import { storeOriginalOnce } from './blob-store.js';
import { getExpectationTree } from './expectation-engine.js';
import { collectSupplierInvoiceXmlEntries } from './supplier-invoice-archive.js';
import { reconcileSupplierInvoicePayment } from './supplier-invoice-settlement.js';
import { stageSupplierInvoiceXml } from './supplier-invoice-xml.js';
import { autoValidateSupplierInvoice, validateSupplierInvoice } from './supplier-invoice.js';
import { buildSupplierDirectory } from './supplier-directory-projection.js';

const importJobDatabases = new WeakSet();
const TERMINAL_FILE_STATES = new Set(['COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED']);
const MAX_JOB_FILES = 1_000;
const DEFAULT_UPLOAD_LIMIT_MB = 100;

function context(getClient, getDb, res) {
  const client = getClient?.();
  const db = getDb?.();
  if (!client || !db) {
    res.status(503).json({ error: 'MongoDB transazionale non configurato' });
    return null;
  }
  return { client, db };
}

function database(getDb, res) {
  const db = getDb?.();
  if (!db) {
    res.status(503).json({ error: 'MongoDB non configurato' });
    return null;
  }
  return db;
}

function limit(value, fallback = 100) {
  return Math.max(1, Math.min(500, Number(value || fallback)));
}

function errorStatus(error) {
  const message = String(error?.message || 'Errore fatture fornitori');
  if (/NOT_FOUND|non trovata/.test(message)) return 404;
  if (/CONFLICT|MISMATCH|REQUIRES_SUPERSEDING|EXCEEDS|ALREADY_TERMINAL/.test(message)) return 409;
  if (/EVIDENCE_REQUIRED|NOT_OUTFLOW|NOT_OPEN/.test(message)) return 422;
  return 400;
}

function uploadedXml(req) {
  if (typeof req.body === 'string') return Buffer.from(req.body, 'utf8');
  if (typeof req.body?.xml === 'string') return Buffer.from(req.body.xml, 'utf8');
  throw new Error('XML fattura obbligatorio');
}

function cleanFilename(value, fallback = 'fatture.xml') {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 500) || fallback;
}

function uploadedFilename(value, fallback) {
  try { return cleanFilename(decodeURIComponent(String(value || '')), fallback); } catch { return cleanFilename(value, fallback); }
}

function assetContentType(filename) {
  return String(filename).toLowerCase().endsWith('.zip') ? 'application/zip' : 'application/xml';
}

async function ensureImportJobIndexes(db) {
  if (importJobDatabases.has(db)) return;
  await Promise.all([
    db.collection('supplier_invoice_import_jobs').createIndex({ jobId: 1 }, { unique: true }),
    db.collection('supplier_invoice_import_jobs').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    db.collection('supplier_invoice_import_jobs').createIndex({ actor: 1, aggiornatoIl: -1 })
  ]);
  importJobDatabases.add(db);
}

function jobFileSummary(file) {
  return {
    index: file.index,
    name: file.name,
    size: file.size,
    status: file.status,
    sha256: file.sha256 || null,
    discoveredXml: Number(file.discoveredXml || 0),
    processedXml: Number(file.processedXml || 0),
    insertedInvoices: Number(file.insertedInvoices || 0),
    duplicateInvoices: Number(file.duplicateInvoices || 0),
    rejectedXml: Number(file.rejectedXml || 0),
    canonicalInvoices: Number(file.canonicalInvoices || 0),
    reviewInvoices: Number(file.reviewInvoices || 0),
    skippedEntries: Number(file.skippedEntries || 0),
    currentEntry: file.currentEntry || null,
    error: file.error || null
  };
}

function serializeImportJob(job) {
  const files = (job.files || []).map(jobFileSummary);
  const totals = files.reduce((out, file) => {
    out.discoveredXml += file.discoveredXml;
    out.processedXml += file.processedXml;
    out.insertedInvoices += file.insertedInvoices;
    out.duplicateInvoices += file.duplicateInvoices;
    out.rejectedXml += file.rejectedXml;
    out.canonicalInvoices += file.canonicalInvoices;
    out.reviewInvoices += file.reviewInvoices;
    out.skippedEntries += file.skippedEntries;
    if (TERMINAL_FILE_STATES.has(file.status)) out.completedFiles += 1;
    return out;
  }, { totalFiles: files.length, completedFiles: 0, discoveredXml: 0, processedXml: 0, insertedInvoices: 0, duplicateInvoices: 0, rejectedXml: 0, canonicalInvoices: 0, reviewInvoices: 0, skippedEntries: 0 });
  const units = files.reduce((sum, file) => {
    if (TERMINAL_FILE_STATES.has(file.status)) return sum + 1;
    if (file.discoveredXml > 0) return sum + Math.min(0.99, 0.2 + (0.8 * file.processedXml / file.discoveredXml));
    if (file.status === 'PROCESSING') return sum + 0.2;
    return sum;
  }, 0);
  return {
    jobId: job.jobId,
    status: job.status,
    createdAt: job.creatoIl,
    updatedAt: job.aggiornatoIl,
    totals,
    progressPercent: files.length ? Math.round((units / files.length) * 100) : 100,
    files
  };
}

async function refreshJobStatus(db, jobId) {
  const collection = db.collection('supplier_invoice_import_jobs');
  const job = await collection.findOne({ jobId });
  if (!job) return null;
  const files = job.files || [];
  const complete = files.length > 0 && files.every((file) => TERMINAL_FILE_STATES.has(file.status));
  const hasErrors = files.some((file) => file.status === 'FAILED' || Number(file.rejectedXml || 0) > 0 || Number(file.reviewInvoices || 0) > 0);
  const hasActivity = files.some((file) => file.status !== 'PENDING');
  const status = complete ? (hasErrors ? 'COMPLETED_WITH_ERRORS' : 'COMPLETED') : (hasActivity ? 'PROCESSING' : 'PENDING');
  if (job.status !== status) {
    await collection.updateOne({ jobId }, { $set: { status, aggiornatoIl: new Date(), ...(complete ? { completatoIl: new Date() } : {}) } });
    job.status = status;
  }
  return serializeImportJob(job);
}

async function updateJobFile(db, jobId, index, fields) {
  await db.collection('supplier_invoice_import_jobs').updateOne(
    { jobId, 'files.index': index },
    { $set: Object.fromEntries(Object.entries(fields).map(([key, value]) => [`files.$.${key}`, value]).concat([['aggiornatoIl', new Date()]])) }
  );
}

async function importSupplierInvoiceAsset(context, buffer, { filename, actor, containerSha256 = null, onProgress = async () => {} }) {
  const { db } = context;
  const extracted = collectSupplierInvoiceXmlEntries(buffer, filename);
  const counts = { discoveredXml: extracted.entries.length, processedXml: 0, insertedInvoices: 0, duplicateInvoices: 0, rejectedXml: 0, canonicalInvoices: 0, reviewInvoices: 0, skippedEntries: extracted.summary.skipped };
  const errors = [];
  await onProgress({ ...counts, currentEntry: null });
  for (const entry of extracted.entries) {
    try {
      const stored = await storeOriginalOnce(db, entry.buffer, {
        sha256: entry.sha256,
        filename: entry.filename,
        contentType: 'application/xml',
        metadata: { sourceType: 'UPLOAD', actor, containerSha256, archivePath: entry.path }
      });
      const externalId = stored.sha256;
      const version = stored.sha256;
      const sourceKeyBase = `UPLOAD:${externalId}:${version}`;
      const staged = await stageSupplierInvoiceXml(db, {
        buffer: entry.buffer,
        source: {
          sourceType: 'UPLOAD', externalId, version, sourceKeyBase, filename: entry.filename,
          path: entry.path, gridFsId: stored.gridFsId, sha256: stored.sha256
        }
      });
      await db.collection('documenti_inbox').updateOne(
        { sourceKey: sourceKeyBase },
        {
          $set: {
            sourceKey: sourceKeyBase,
            sourceType: 'UPLOAD',
            sourceId: externalId,
            nomeOriginale: entry.filename,
            dimensione: stored.size,
            sha256: stored.sha256,
            gridFsId: stored.gridFsId,
            propostaTipo: 'FATTURA_XML',
            stato: 'ELABORATO',
            stagingFattura: 'IMPORTATA_IN_ELABORAZIONE',
            invoiceSourceKeys: staged.invoices.map((row) => row.sourceKey),
            elaboratoIl: new Date(),
            aggiornatoIl: new Date()
          },
          $addToSet: { provenienzeUpload: { containerSha256, archivePath: entry.path } },
          $setOnInsert: { creatoIl: new Date() }
        },
        { upsert: true }
      );
      counts.insertedInvoices += staged.counts.inserted;
      counts.duplicateInvoices += staged.counts.duplicates;
      for (const invoice of staged.invoices) {
        try {
          const canonical = await autoValidateSupplierInvoice(context, invoice.sourceKey);
          if (canonical.reviewRequired) counts.reviewInvoices += 1;
          else if (!canonical.duplicate) counts.canonicalInvoices += 1;
        } catch (error) {
          counts.reviewInvoices += 1;
          errors.push({ path: entry.path, stage: 'AUTO_VALIDATION', error: String(error?.message || error).slice(0, 500) });
        }
      }
    } catch (error) {
      counts.rejectedXml += 1;
      errors.push({ path: entry.path, error: String(error?.message || error).slice(0, 500) });
    }
    counts.processedXml += 1;
    await onProgress({ ...counts, currentEntry: entry.path });
  }
  return { counts, errors: errors.slice(0, 100), archive: extracted.summary };
}

export function registerSupplierInvoiceRoutes(app, { getClient, getDb }) {
  const uploadLimitMb = Math.max(1, Math.min(250, Number(process.env.SUPPLIER_INVOICE_UPLOAD_MAX_MB || DEFAULT_UPLOAD_LIMIT_MB)));
  app.get('/api/supplier-invoices/staging', async (req, res) => {
    try {
      const db = database(getDb, res); if (!db) return;
      const canonicalSourceKeys = await db.collection('invoice_suppliers').distinct('sources.sourceKey', { current: true });
      const filter = canonicalSourceKeys.length
        ? { sourceKey: { $nin: canonicalSourceKeys }, stato: { $nin: ['VALIDATA', 'SCARTATA'] } }
        : { stato: { $nin: ['VALIDATA', 'SCARTATA'] } };
      const rows = await db.collection('fatture').find(filter, { projection: { rawXml: 0 } })
        .sort({ aggiornatoIl: -1, sourceKey: 1 }).limit(limit(req.query.limit)).toArray();
      res.set('Cache-Control', 'no-store');
      res.json(rows);
    } catch (error) {
      res.status(errorStatus(error)).json({ error: error.message });
    }
  });

  app.get('/api/supplier-invoices', async (req, res) => {
    try {
      const db = database(getDb, res); if (!db) return;
      const rows = await db.collection('invoice_suppliers').find({ current: true })
        .sort({ 'dates.documentDate': -1, invoiceId: 1 }).limit(limit(req.query.limit)).toArray();
      const obligationKeys = rows.map((row) => `SUPPLIER_INVOICE:${row.invoiceId}:PAYABLE`);
      const processIds = rows.map((row) => `SUPPLIER_INVOICE:${row.invoiceId}:${row.version}`);
      const [openItems, processes] = await Promise.all([
        obligationKeys.length ? db.collection('open_items').find({ obligationKey: { $in: obligationKeys } }).toArray() : [],
        processIds.length ? db.collection('expectation_processes').find({ processId: { $in: processIds } }).toArray() : []
      ]);
      const openByKey = new Map(openItems.map((row) => [row.obligationKey, row]));
      const processById = new Map(processes.map((row) => [row.processId, row]));
      res.set('Cache-Control', 'no-store');
      res.json(rows.map((row) => ({
        ...row,
        openItem: openByKey.get(`SUPPLIER_INVOICE:${row.invoiceId}:PAYABLE`) || null,
        expectationProcess: processById.get(`SUPPLIER_INVOICE:${row.invoiceId}:${row.version}`) || null
      })));
    } catch (error) {
      res.status(errorStatus(error)).json({ error: error.message });
    }
  });

  app.get('/api/supplier-invoices/suppliers/directory', async (_req, res) => {
    try {
      const db = database(getDb, res); if (!db) return;
      const [staging, canonical, openItems] = await Promise.all([
        db.collection('fatture').find({}, { projection: {
          sourceKey: 1, stato: 1, fornitore: 1, numero: 1, tipoDocumento: 1,
          data: 1, totaleDocumento: 1
        } }).toArray(),
        db.collection('invoice_suppliers').find({ current: true }, { projection: {
          invoiceId: 1, sourceKey: 1, sources: 1, supplier: 1, number: 1,
          documentType: 1, dates: 1, amounts: 1
        } }).toArray(),
        db.collection('open_items').find({ sourceEntityType: 'INVOICE_SUPPLIER' }).toArray()
      ]);
      res.set('Cache-Control', 'no-store');
      res.json(buildSupplierDirectory(staging, canonical, openItems));
    } catch (error) {
      res.status(errorStatus(error)).json({ error: error.message });
    }
  });

  app.get('/api/supplier-invoices/:invoiceId/tree', async (req, res) => {
    try {
      const db = database(getDb, res); if (!db) return;
      const invoice = await db.collection('invoice_suppliers').findOne({ invoiceId: String(req.params.invoiceId), current: true });
      if (!invoice) return res.status(404).json({ error: 'SUPPLIER_INVOICE_NOT_FOUND' });
      const tree = await getExpectationTree(db, { entityType: 'invoice_supplier', entityId: invoice.invoiceId });
      res.set('Cache-Control', 'no-store');
      res.json({ invoice, ...tree });
    } catch (error) {
      res.status(errorStatus(error)).json({ error: error.message });
    }
  });

  app.post('/api/supplier-invoices/intake', async (req, res) => {
    try {
      const current = context(getClient, getDb, res); if (!current) return;
      const { db } = current;
      const buffer = uploadedXml(req);
      const filename = String(req.body?.filename || req.get('x-file-name') || 'fattura.xml').slice(0, 500);
      const stored = await storeOriginalOnce(db, buffer, {
        filename,
        contentType: 'application/xml',
        metadata: { sourceType: 'UPLOAD', actor: String(req.auth?.sessionId || 'SYSTEM') }
      });
      const externalId = String(req.body?.externalId || req.get('x-external-id') || stored.sha256 || randomUUID()).slice(0, 500);
      const version = String(req.body?.version || stored.sha256 || '1').slice(0, 120);
      const sourceKeyBase = `UPLOAD:${externalId}:${version}`;
      const staged = await stageSupplierInvoiceXml(db, {
        buffer,
        source: {
          sourceType: 'UPLOAD', externalId, version, sourceKeyBase, filename,
          gridFsId: stored.gridFsId, sha256: stored.sha256
        }
      });
      await db.collection('documenti_inbox').updateOne(
        { sourceKey: sourceKeyBase },
        {
          $set: {
            sourceKey: sourceKeyBase,
            sourceType: 'UPLOAD',
            sourceId: externalId,
            nomeOriginale: filename,
            dimensione: stored.size,
            sha256: stored.sha256,
            gridFsId: stored.gridFsId,
            propostaTipo: 'FATTURA_XML',
            stato: 'ELABORATO',
            stagingFattura: 'IMPORTATA_IN_ELABORAZIONE',
            invoiceSourceKeys: staged.invoices.map((row) => row.sourceKey),
            elaboratoIl: new Date(),
            aggiornatoIl: new Date()
          },
          $setOnInsert: { creatoIl: new Date() }
        },
        { upsert: true }
      );
      const automatic = [];
      for (const invoice of staged.invoices) {
        automatic.push(await autoValidateSupplierInvoice(current, invoice.sourceKey));
      }
      res.status(staged.counts.inserted ? 201 : 200).json({
        ok: true,
        duplicate: staged.counts.inserted === 0,
        sha256: staged.sha256,
        invoiceSourceKeys: staged.invoices.map((row) => row.sourceKey),
        counts: {
          ...staged.counts,
          canonical: automatic.filter((row) => !row.reviewRequired && !row.duplicate).length,
          review: automatic.filter((row) => row.reviewRequired).length
        }
      });
    } catch (error) {
      res.status(errorStatus(error)).json({ error: error.message });
    }
  });

  app.post('/api/supplier-invoices/import-jobs', async (req, res) => {
    try {
      const db = database(getDb, res); if (!db) return;
      await ensureImportJobIndexes(db);
      const manifest = Array.isArray(req.body?.files) ? req.body.files : [];
      if (!manifest.length || manifest.length > MAX_JOB_FILES) throw new Error(`Selezionare da 1 a ${MAX_JOB_FILES} file XML o ZIP`);
      const files = manifest.map((file, index) => {
        const name = cleanFilename(file?.name, `caricamento-${index + 1}`);
        const size = Number(file?.size);
        if (!Number.isSafeInteger(size) || size <= 0) throw new Error(`Dimensione non valida per ${name}`);
        if (size > uploadLimitMb * 1024 * 1024) throw new Error(`${name} supera il limite di ${uploadLimitMb} MB`);
        if (!/\.(xml|zip)$/i.test(name)) throw new Error(`Formato non supportato: ${name}`);
        return { index, name, size, status: 'PENDING', discoveredXml: 0, processedXml: 0, insertedInvoices: 0, duplicateInvoices: 0, rejectedXml: 0, canonicalInvoices: 0, reviewInvoices: 0, skippedEntries: 0 };
      });
      const now = new Date();
      const job = {
        jobId: randomUUID(),
        type: 'SUPPLIER_INVOICE_IMPORT',
        status: 'PENDING',
        actor: String(req.auth?.sessionId || 'SYSTEM'),
        files,
        creatoIl: now,
        aggiornatoIl: now,
        expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000)
      };
      await db.collection('supplier_invoice_import_jobs').insertOne(job);
      res.status(201).json(serializeImportJob(job));
    } catch (error) {
      res.status(errorStatus(error)).json({ error: error.message });
    }
  });

  app.get('/api/supplier-invoices/import-jobs/:jobId', async (req, res) => {
    try {
      const db = database(getDb, res); if (!db) return;
      await ensureImportJobIndexes(db);
      const job = await refreshJobStatus(db, String(req.params.jobId));
      if (!job) return res.status(404).json({ error: 'IMPORT_JOB_NOT_FOUND' });
      res.set('Cache-Control', 'no-store');
      res.json(job);
    } catch (error) {
      res.status(errorStatus(error)).json({ error: error.message });
    }
  });

  app.post(
    '/api/supplier-invoices/import-jobs/:jobId/files/:index',
    express.raw({ type: 'application/octet-stream', limit: `${uploadLimitMb}mb` }),
    async (req, res) => {
      const db = database(getDb, res); if (!db) return;
      const jobId = String(req.params.jobId);
      const index = Number(req.params.index);
      try {
        await ensureImportJobIndexes(db);
        if (!Number.isSafeInteger(index) || index < 0 || !Buffer.isBuffer(req.body) || !req.body.length) throw new Error('File upload non valido');
        const job = await db.collection('supplier_invoice_import_jobs').findOne({ jobId });
        if (!job) return res.status(404).json({ error: 'IMPORT_JOB_NOT_FOUND' });
        const file = job.files?.find((item) => item.index === index);
        if (!file) return res.status(404).json({ error: 'IMPORT_JOB_FILE_NOT_FOUND' });
        if (req.body.length !== file.size) throw new Error(`Dimensione ricevuta diversa dal file selezionato: ${file.name}`);
        const filename = uploadedFilename(req.get('x-file-name'), file.name);
        if (filename !== file.name) throw new Error('Nome file diverso dal manifesto di importazione');
        const sha256 = crypto.createHash('sha256').update(req.body).digest('hex');
        if (TERMINAL_FILE_STATES.has(file.status)) {
          if (file.sha256 === sha256) return res.json({ ok: true, duplicateUpload: true, job: await refreshJobStatus(db, jobId) });
          return res.status(409).json({ error: 'IMPORT_JOB_FILE_ALREADY_COMPLETED' });
        }
        await updateJobFile(db, jobId, index, { status: 'PROCESSING', sha256, currentEntry: null, error: null });
        const container = await storeOriginalOnce(db, req.body, {
          sha256,
          filename,
          contentType: assetContentType(filename),
          metadata: { sourceType: 'UPLOAD', actor: String(req.auth?.sessionId || 'SYSTEM'), importJobId: jobId }
        });
        const result = await importSupplierInvoiceAsset({ client: getClient?.(), db }, req.body, {
          filename,
          actor: String(req.auth?.sessionId || 'SYSTEM'),
          containerSha256: container.sha256,
          onProgress: (progress) => updateJobFile(db, jobId, index, progress)
        });
        const status = result.counts.rejectedXml || result.counts.reviewInvoices ? 'COMPLETED_WITH_ERRORS' : 'COMPLETED';
        await updateJobFile(db, jobId, index, {
          ...result.counts,
          status,
          currentEntry: null,
          errors: result.errors,
          archive: result.archive,
          completedAt: new Date()
        });
        res.status(201).json({ ok: true, duplicateUpload: false, result, job: await refreshJobStatus(db, jobId) });
      } catch (error) {
        if (Number.isSafeInteger(index) && index >= 0) {
          await updateJobFile(db, jobId, index, { status: 'FAILED', currentEntry: null, error: String(error?.message || error).slice(0, 500), completedAt: new Date() }).catch(() => {});
          await refreshJobStatus(db, jobId).catch(() => {});
        }
        res.status(errorStatus(error)).json({ error: error.message });
      }
    }
  );

  app.post('/api/supplier-invoices/validate', async (req, res) => {
    try {
      const current = context(getClient, getDb, res); if (!current) return;
      const output = await validateSupplierInvoice(current, req.body?.sourceKey, req.body, {
        actor: String(req.auth?.sessionId || 'SYSTEM')
      });
      res.status(output.duplicate ? 200 : 202).json({
        ok: true,
        duplicate: output.duplicate,
        invoiceId: output.invoice.invoiceId,
        version: output.invoice.version,
        eventKey: output.event.eventKey
      });
    } catch (error) {
      res.status(errorStatus(error)).json({ error: error.message });
    }
  });

  app.post('/api/supplier-invoices/:invoiceId/reconcile', async (req, res) => {
    try {
      const current = context(getClient, getDb, res); if (!current) return;
      const output = await reconcileSupplierInvoicePayment(current, {
        ...req.body,
        invoiceId: String(req.params.invoiceId)
      }, { actor: String(req.auth?.sessionId || 'SYSTEM') });
      res.status(output.duplicate ? 200 : 202).json({
        ok: true,
        duplicate: output.duplicate,
        invoiceId: output.invoice.invoiceId,
        reconciliationKey: output.reconciliation.reconciliationKey,
        eventKey: output.event.eventKey,
        openItem: output.openItem || null
      });
    } catch (error) {
      res.status(errorStatus(error)).json({ error: error.message });
    }
  });

  function start() {
    let running = false;
    async function processBacklog() {
      if (running) return;
      running = true;
      try {
      const client = getClient?.(); const db = getDb?.();
      if (!client || !db) return;
      const existingSources = new Set(await db.collection('invoice_suppliers').distinct('sources.sourceKey', { current: true }));
      const pending = await db.collection('fatture').find({
        sourceKey: { $nin: [...existingSources] },
        'quadraturaEstrazione.status': 'EXACT',
        stato: { $nin: ['VALIDATA', 'SCARTATA'] }
      }, { projection: { sourceKey: 1 } }).sort({ creatoIl: 1 }).limit(5_000).toArray();
      for (const row of pending) {
        await autoValidateSupplierInvoice({ client, db }, row.sourceKey).catch((error) => console.error('[supplier-invoice] validazione automatica differita:', error.message));
      }
      } finally {
        running = false;
      }
    }
    const first = setTimeout(() => processBacklog().catch((error) => console.error('[supplier-invoice] avvio validazione automatica:', error.message)), 2_000);
    const interval = setInterval(() => processBacklog().catch((error) => console.error('[supplier-invoice] scansione validazione automatica:', error.message)), 30_000);
    first.unref?.();
    interval.unref?.();
    return { first, interval, run: processBacklog };
  }

  return { start };
}
