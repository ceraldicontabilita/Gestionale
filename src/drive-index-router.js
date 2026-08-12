import { createGoogleAccessTokenProvider } from './google-auth.js';
import { createGoogleDriveClient } from './google-drive-client.js';
import { createDriveDocumentIndex, publicDocument } from './drive-document-index.js';

function text(value, max = 120) { return String(value || '').trim().slice(0, max); }

export function registerDriveIndexRoutes(app, { env = process.env, service = null } = {}) {
  const rootFolderId = text(env.DRIVE_DOCUMENT_INDEX_ROOT_FOLDER_ID, 200);
  let indexService = service;
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
      const limit = Math.max(1, Math.min(500, Number(req.query.limit || 100)));
      const rows = index.documents.filter((row) => {
        const document = publicDocument(row);
        return (!year || document.year === year) && (!domain || document.domain.toLowerCase() === domain)
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
      res.json(index.declarations.map((row) => ({ year: text(row.Anno, 4), type: text(row.Tipo), protocol: text(row.Protocollo) || null, archivePath: text(row['Percorso archivio'], 500), documentId: row.__documentId })));
    } catch (error) { res.status(503).json({ error: error.message }); }
  });
}
