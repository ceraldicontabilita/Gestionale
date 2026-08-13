import { randomUUID } from 'node:crypto';
import { storeOriginalOnce } from './blob-store.js';
import { getExpectationTree } from './expectation-engine.js';
import { reconcileSupplierInvoicePayment } from './supplier-invoice-settlement.js';
import { stageSupplierInvoiceXml } from './supplier-invoice-xml.js';
import { validateSupplierInvoice } from './supplier-invoice.js';

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

export function registerSupplierInvoiceRoutes(app, { getClient, getDb }) {
  app.get('/api/supplier-invoices/staging', async (req, res) => {
    try {
      const db = database(getDb, res); if (!db) return;
      const rows = await db.collection('fatture').find({}, { projection: { rawXml: 0 } })
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
      const db = database(getDb, res); if (!db) return;
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
            stagingFattura: 'IMPORTATA_DA_VERIFICARE',
            invoiceSourceKeys: staged.invoices.map((row) => row.sourceKey),
            elaboratoIl: new Date(),
            aggiornatoIl: new Date()
          },
          $setOnInsert: { creatoIl: new Date() }
        },
        { upsert: true }
      );
      res.status(staged.counts.inserted ? 201 : 200).json({
        ok: true,
        duplicate: staged.counts.inserted === 0,
        sha256: staged.sha256,
        invoiceSourceKeys: staged.invoices.map((row) => row.sourceKey),
        counts: staged.counts
      });
    } catch (error) {
      res.status(errorStatus(error)).json({ error: error.message });
    }
  });

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
}
