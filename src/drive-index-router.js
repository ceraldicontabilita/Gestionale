import { createGoogleAccessTokenProvider } from './google-auth.js';
import { createGoogleDriveClient } from './google-drive-client.js';
import { createDriveDocumentIndex, publicDocument } from './drive-document-index.js';
import { classifyDeclaration, readResignationPdf, resignationFileIdentity } from './document-index-metadata.js';

function text(value, max = 120) { return String(value || '').trim().slice(0, max); }

export function registerDriveIndexRoutes(app, { env = process.env, service = null } = {}) {
  const rootFolderId = text(env.DRIVE_DOCUMENT_INDEX_ROOT_FOLDER_ID, 200);
  let indexService = service;
  const resignationCache = new Map();
  function getService() {
    if (indexService) return indexService;
    if (!rootFolderId) throw new Error('Indice documentale Drive non configurato');
    const drive = createGoogleDriveClient({
      getAccessToken: createGoogleAccessTokenProvider(env),
      timeoutMs: Number(env.GOOGLE_HTTP_TIMEOUT_MS || 30_000),
      maxRetries: Number(env.GOOGLE_HTTP_MAX_RETRIES || 3)
    });
    indexService = createDriveDocumentIndex({ drive, rootFolderId });
    return indexService;
  }

  app.get('/api/drive-index/overview', async (req, res) => {
    try {
      const index = await getService().load({ force: req.query.refresh === 'true' });
      res.json({ counts: index.counts, loadedAt: index.loadedAt, indexModifiedAt: index.indexFile.modifiedTime, source: 'GOOGLE_DRIVE_XLSX', originalsInDatabase: false });
    } catch (error) { res.status(503).json({ error: error.message }); }
  });

  app.get('/api/drive-index/documents', async (req, res) => {
    try {
      const index = await getService().load();
      const query = text(req.query.q).toLowerCase();
      const year = text(req.query.year, 4);
      const domain = text(req.query.domain).toLowerCase();
      const includeTechnical = req.query.includeTechnical === 'true';
      const limit = Math.max(1, Math.min(500, Number(req.query.limit || 100)));
      const rows = index.documents.filter((row) => {
        const document = publicDocument(row);
        return (includeTechnical || document.role !== 'PROVA_TECNICA')
          && (!year || document.year === year) && (!domain || document.domain.toLowerCase() === domain)
          && (!query || `${document.name} ${document.path} ${document.category} ${document.number || ''}`.toLowerCase().includes(query));
      });
      res.json({ total: rows.length, rows: rows.slice(0, limit).map(publicDocument) });
    } catch (error) { res.status(503).json({ error: error.message }); }
  });

  app.get('/api/drive-index/documents/:id', async (req, res) => {
    try {
      const serviceInstance = getService();
      const index = await serviceInstance.load();
      const row = index.byId.get(text(req.params.id, 80));
      if (!row) return res.status(404).json({ error: 'Documento non trovato nell indice Drive' });
      const document = publicDocument(row);
      const drive = await serviceInstance.resolvePath(document.path);
      res.json({ ...document, drive });
    } catch (error) { res.status(503).json({ error: error.message }); }
  });

  app.get('/api/drive-index/f24', async (req, res) => {
    try {
      const index = await getService().load();
      const year = text(req.query.year, 4);
      const rows = index.f24Rows.filter((row) => !year || text(row['Anno pagamento'], 4) === year).slice(0, 1000).map((row) => ({
        documentId: text(row['ID documento'], 80), year: text(row['Anno pagamento'], 4), date: text(row['Data pagamento'], 20), section: text(row.Sezione), rowType: text(row['Tipo riga']), taxCode: text(row['Codice tributo']), description: text(row.Descrizione, 300), period: text(row['Periodo tributo']), debit: Number(row.Debito || 0), credit: Number(row.Credito || 0), protocol: text(row.Protocollo), documentType: text(row['Tipo documento'])
      }));
      res.json({ total: rows.length, rows, note: 'Le righe F24 non provano da sole il pagamento bancario.' });
    } catch (error) { res.status(503).json({ error: error.message }); }
  });

  app.get('/api/drive-index/declarations', async (req, res) => {
    try {
      const index = await getService().load();
      res.json(index.declarations.map((row) => ({
        ...classifyDeclaration(row, index.byId.get(row.__documentId)),
        sourceType: text(row.Tipo) || null,
        documentId: row.__documentId
      })));
    } catch (error) { res.status(503).json({ error: error.message }); }
  });

  app.get('/api/drive-index/f24-documents', async (req, res) => {
    try {
      const index = await getService().load();
      const year = text(req.query.year, 4);
      const grouped = new Map();
      for (const row of index.f24Rows) {
        const documentId = text(row['ID documento'], 80);
        const documentYear = text(row['Anno pagamento'], 4);
        if (!documentId || (year && documentYear !== year)) continue;
        if (!grouped.has(documentId)) grouped.set(documentId, []);
        grouped.get(documentId).push(row);
      }
      const rows = [...grouped].map(([documentId, sourceRows]) => {
        const indexedDocument = index.byId.get(documentId);
        const document = indexedDocument ? publicDocument(indexedDocument) : { name: text(sourceRows[0]['Nome file']) || documentId, path: text(sourceRows[0]['Percorso Drive'], 500) };
        const debit = sourceRows.reduce((sum, row) => sum + Number(row.Debito || 0), 0);
        const credit = sourceRows.reduce((sum, row) => sum + Number(row.Credito || 0), 0);
        const documentType = text(sourceRows[0]['Tipo documento']) || 'F24';
        return {
          documentId,
          documentName: document.name,
          path: document.path,
          year: text(sourceRows[0]['Anno pagamento'], 4),
          date: text(sourceRows[0]['Data pagamento'], 20),
          protocol: text(sourceRows.find((row) => text(row.Protocollo) && text(row.Protocollo) !== '-')?.Protocollo) || null,
          documentType,
          receipt: documentType.toUpperCase().includes('QUIETANZA'),
          rowCount: sourceRows.length,
          totals: { debit, credit, balance: Math.round((debit - credit) * 100) / 100 },
          state: 'INDICIZZATO_DA_IMPORTARE'
        };
      }).sort((left, right) => String(right.date || '').localeCompare(String(left.date || '')) || left.documentName.localeCompare(right.documentName));
      res.json({ total: rows.length, models: rows.filter((row) => !row.receipt), receipts: rows.filter((row) => row.receipt) });
    } catch (error) { res.status(503).json({ error: error.message }); }
  });

  app.get('/api/drive-index/resignations', async (_req, res) => {
    try {
      const serviceInstance = getService();
      const index = await serviceInstance.load();
      const documents = index.documents.map(publicDocument);
      const technicalByMessage = new Map(documents.filter((document) => document.role === 'PROVA_TECNICA').map((document) => {
        const messageKey = document.name.match(/__dimissioni_telematiche__([a-f0-9]{12,32})\.txt$/i)?.[1]?.toLowerCase();
        return messageKey ? [messageKey, document] : [null, null];
      }).filter(([key]) => key));
      const rows = [];
      for (const document of documents) {
        const identity = resignationFileIdentity(document);
        if (!identity) continue;
        const cacheKey = `${index.revision}:${document.id}`;
        let metadata = resignationCache.get(cacheKey);
        if (!metadata) {
          try {
            const downloaded = await serviceInstance.downloadDocument(document.id);
            metadata = await readResignationPdf(downloaded.buffer, identity);
          } catch {
            metadata = { employeeName: null, employeeTaxIdMasked: null, effectiveDate: null, communicationType: null, transmissionDate: null, moduleId: null };
          }
          resignationCache.set(cacheKey, metadata);
        }
        const technical = technicalByMessage.get(identity.messageKey);
        rows.push({
          year: document.year || identity.documentDate.slice(0, 4),
          documentDate: identity.documentDate,
          employeeName: metadata.employeeName,
          employeeTaxIdMasked: metadata.employeeTaxIdMasked,
          employmentStartDate: metadata.employmentStartDate,
          effectiveDate: metadata.effectiveDate,
          communicationType: metadata.communicationType || (identity.fileKind.includes('REVOCA') ? 'Revoca dimissioni' : 'Dimissioni telematiche'),
          transmissionDate: metadata.transmissionDate,
          moduleId: metadata.moduleId,
          documentId: document.id,
          documentName: document.name,
          technicalSourceDocumentId: technical?.id || null,
          status: metadata.employeeName ? 'IDENTIFICATA_DA_PDF' : 'DATI_PDF_DA_VERIFICARE'
        });
      }
      rows.sort((left, right) => String(right.effectiveDate || right.documentDate).localeCompare(String(left.effectiveDate || left.documentDate)));
      res.set('Cache-Control', 'no-store');
      res.json({ total: rows.length, rows });
    } catch (error) { res.status(503).json({ error: error.message }); }
  });

  return { getService };
}
