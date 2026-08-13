import { createGoogleAccessTokenProvider } from './google-auth.js';
import { createGoogleDriveClient, extractDriveId } from './google-drive-client.js';
import { createDriveDataImportService } from './drive-data-import.js';

function configured(env) {
  return Boolean(env.GOOGLE_DRIVE_ACCESS_TOKEN || env.GOOGLE_DRIVE_SA_JSON || (env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET && env.GOOGLE_OAUTH_REFRESH_TOKEN));
}

function escapedRegex(value) { return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&').slice(0, 120); }

export const DRIVE_DOMAIN_DEFINITIONS = Object.freeze({
  f24: { label: 'F24', match: [{ topFolder: 'F24' }, { tipoProposto: 'F24_DOCUMENTO' }, { percorso: /(?:^|\/)F24(?:\/|_|-)/i }] },
  quietanze: { label: 'Quietanze', match: [{ topFolder: 'Quietanze' }, { tipoProposto: 'QUIETANZA' }, { percorso: /quietanz/i }] },
  riscossione: { label: 'Riscossione e ADER', match: [{ topFolder: 'CARTELLE ESATTORIALI' }, { tipoProposto: 'ATTO_RISCOSSIONE' }, { percorso: /(?:agenzia.?riscossione|\bADER\b|cartell[ae].?esattorial)/i }] },
  verbali: { label: 'Verbali auto', match: [{ topFolder: 'VERBALI AUTO' }, { tipoProposto: 'VERBALE_AUTO' }, { percorso: /notifica.?polizia.?locale/i }] },
  dipendenti: { label: 'Dipendenti', match: [{ topFolder: { $in: ['Cedolini Paga', 'certificazioni dipendenti', 'CONTRATTI DIPENDENTI', 'documenti dipendenti', 'unilav'] } }, { tipoProposto: { $in: ['CEDOLINO', 'CERTIFICAZIONE_UNICA', 'CONTRATTO_DIPENDENTE', 'DOCUMENTO_DIPENDENTE', 'UNILAV'] } }] },
  fatture: { label: 'Fatture', match: [{ topFolder: { $in: ['Fatture Xml Gestionale', 'Fatture Estero', 'Fatture PDF Legacy'] } }, { tipoProposto: { $in: ['FATTURA_XML', 'FATTURA_ESTERO'] } }] },
  banca: { label: 'Banca e pagamenti', match: [{ topFolder: { $in: ['Estratti conto', 'Bonifici effettuati', 'cbill', 'Assegni'] } }, { tipoProposto: { $in: ['ESTRATTO_CONTO', 'BONIFICO', 'CBILL', 'ASSEGNO'] } }] },
  corrispettivi: { label: 'Corrispettivi', match: [{ topFolder: 'Corrispettivi' }, { tipoProposto: { $in: ['CORRISPETTIVO', 'CORRISPETTIVO_XML', 'CORRISPETTIVI_RT'] } }] },
  fiscale: { label: 'Dichiarazioni fiscali', match: [{ topFolder: 'dichiarazioni fiscali' }, { tipoProposto: 'DICHIARAZIONE_FISCALE' }] },
  azienda: { label: 'Documenti aziendali', match: [{ topFolder: { $in: ['DOCUMENTI AZIENDALI', 'LICENZE', 'mutui', 'Voucher digitalizzazione', 'AVVISI BONARI'] } }, { tipoProposto: { $in: ['AVVISO_BONARIO', 'MUTUO'] } }] },
  rettifiche: { label: 'Note di rettifica', match: [{ topFolder: 'Note direttifica' }, { percorso: /note?.?d[i']?rettifica/i }] },
  da_classificare: { label: 'Da classificare', match: [{ topFolder: 'Nuova cartella' }, { tipoProposto: { $in: ['DA_VERIFICARE', 'NON_CLASSIFICATO'] } }] }
});

const FILE_PROJECTION = Object.freeze({ _id: 0, driveFileId: 1, nome: 1, percorso: 1, topFolder: 1, tipoProposto: 1, anno: 1, dimensione: 1, webViewLink: 1, modificatoIlFonte: 1, md5Checksum: 1, sha256Checksum: 1, parentId: 1 });

function domainClause(domain) {
  const definition = DRIVE_DOMAIN_DEFINITIONS[String(domain || '').toLowerCase()];
  return definition ? { $or: definition.match } : null;
}

function fileFilter({ rootFolderId, query = '', year = 0, topFolder = '', type = '', domain = '', includeTechnical = false } = {}) {
  const clauses = [{ attivo: true, rootFolderId }];
  const domainMatch = domainClause(domain);
  if (domainMatch) clauses.push(domainMatch);
  if (topFolder) clauses.push({ topFolder });
  if (type) clauses.push({ tipoProposto: type });
  if (query) clauses.push({ $or: [{ nome: { $regex: query, $options: 'i' } }, { percorso: { $regex: query, $options: 'i' } }, { tipoProposto: { $regex: query, $options: 'i' } }] });
  if (year >= 2000 && year <= 2100) clauses.push({ anno: year });
  if (!includeTechnical) clauses.push({ nome: { $not: /^(?:daticert\.xml|smime\.p7s|postacert\.eml)$/i }, percorso: { $not: /(?:05_MESSAGGI_COMPLETI_RECUPERO|allegati_recuperati\/(?:daticert\.xml|smime\.p7s|postacert\.eml)$)/i } });
  return clauses.length === 1 ? clauses[0] : { $and: clauses };
}

export function registerDriveDataRoutes(app, { getDb, getIndex, env = process.env, autoStart = true } = {}) {
  const rootFolderId = extractDriveId(env.DRIVE_DOCUMENT_INDEX_ROOT_FOLDER_ID);
  if (!rootFolderId || !configured(env)) return { service: null, start: () => null };
  const driveClient = createGoogleDriveClient({
    getAccessToken: createGoogleAccessTokenProvider(env),
    timeoutMs: Number(env.GOOGLE_HTTP_TIMEOUT_MS || 30_000),
    maxRetries: Number(env.GOOGLE_HTTP_MAX_RETRIES || 3)
  });
  const service = createDriveDataImportService({
    getDb,
    getIndex,
    driveClient,
    rootFolderId,
    rootAdoptionConfirmation: extractDriveId(env.DRIVE_DATA_ROOT_ADOPTION_CONFIRM),
    leaseMs: Number(env.DRIVE_IMPORT_LEASE_MS || 30 * 60 * 1000)
  });

  app.get('/api/drive-data/status', async (_req, res) => {
    try { res.set('Cache-Control', 'no-store'); res.json({ running: service.isRunning(), lastRun: await service.status() }); }
    catch (error) { res.status(503).json({ error: error.message }); }
  });
  app.get('/api/drive-data/summary', async (_req, res) => {
    try { res.set('Cache-Control', 'no-store'); res.json(await service.summary()); }
    catch (error) { res.status(503).json({ error: error.message }); }
  });
  app.get('/api/drive-data/files', async (req, res) => {
    try {
      const db = getDb(); if (!db) throw new Error('MongoDB non configurato');
      const filter = fileFilter({
        rootFolderId,
        query: escapedRegex(req.query.q),
        year: Number(req.query.year || 0),
        topFolder: String(req.query.topFolder || '').slice(0, 200),
        type: String(req.query.type || '').slice(0, 100),
        domain: String(req.query.domain || ''),
        includeTechnical: req.query.includeTechnical === 'true'
      });
      const limit = Math.max(1, Math.min(500, Number(req.query.limit || 200)));
      const [total, rows] = await Promise.all([
        db.collection('drive_files').countDocuments(filter),
        db.collection('drive_files').find(filter, { projection: FILE_PROJECTION }).sort({ modificatoIlFonte: -1, nome: 1 }).limit(limit).toArray()
      ]);
      res.set('Cache-Control', 'no-store');
      res.json({ total, rows });
    } catch (error) { res.status(503).json({ error: error.message }); }
  });
  app.get('/api/drive-data/domains', async (_req, res) => {
    try {
      const db = getDb(); if (!db) throw new Error('MongoDB non configurato');
      const [topFolders, domainCounts] = await Promise.all([
        db.collection('drive_files').aggregate([
          { $match: { attivo: true, rootFolderId } },
          { $group: { _id: '$topFolder', count: { $sum: 1 }, years: { $addToSet: '$anno' } } },
          { $sort: { count: -1, _id: 1 } }
        ]).toArray(),
        Promise.all(Object.entries(DRIVE_DOMAIN_DEFINITIONS).map(async ([key, definition]) => ({
          key,
          label: definition.label,
          count: await db.collection('drive_files').countDocuments(fileFilter({ rootFolderId, domain: key }))
        })))
      ]);
      res.set('Cache-Control', 'no-store');
      res.json({ topFolders, domains: domainCounts });
    } catch (error) { res.status(503).json({ error: error.message }); }
  });
  app.get('/api/drive-data/source-packages/summary', async (_req, res) => {
    try {
      const db = getDb(); if (!db) throw new Error('MongoDB non configurato');
      const rows = await db.collection('source_package_records').aggregate([
        { $match: { attivo: true } },
        { $group: { _id: { packageKind: '$packageKind', recordType: '$recordType' }, count: { $sum: 1 }, categories: { $addToSet: '$category' } } },
        { $sort: { '_id.packageKind': 1, '_id.recordType': 1 } }
      ]).toArray();
      res.set('Cache-Control', 'no-store');
      res.json({ total: rows.reduce((sum, row) => sum + row.count, 0), rows });
    } catch (error) { res.status(503).json({ error: error.message }); }
  });
  app.get('/api/drive-data/source-packages/records', async (req, res) => {
    try {
      const db = getDb(); if (!db) throw new Error('MongoDB non configurato');
      const clauses = [{ attivo: true }];
      if (req.query.packageKind) clauses.push({ packageKind: String(req.query.packageKind).toUpperCase() });
      if (req.query.recordType) clauses.push({ recordType: String(req.query.recordType).toUpperCase() });
      if (req.query.category) clauses.push({ category: String(req.query.category) });
      const year = Number(req.query.year || 0); if (year >= 2000 && year <= 2100) clauses.push({ year });
      const query = escapedRegex(req.query.q);
      if (query) clauses.push({ $or: [{ fileName: { $regex: query, $options: 'i' } }, { relativePath: { $regex: query, $options: 'i' } }, { subject: { $regex: query, $options: 'i' } }, { sender: { $regex: query, $options: 'i' } }] });
      const filter = clauses.length === 1 ? clauses[0] : { $and: clauses };
      const limit = Math.max(1, Math.min(1000, Number(req.query.limit || 500)));
      const [total, rows] = await Promise.all([
        db.collection('source_package_records').countDocuments(filter),
        db.collection('source_package_records').find(filter, { projection: { _id: 0, sourceRecordKey: 1, packageKind: 1, recordType: 1, sourceEntry: 1, sourceRow: 1, fields: 1, category: 1, year: 1, date: 1, fileName: 1, relativePath: 1, sha256: 1, sourceUrl: 1, subject: 1, sender: 1, status: 1, declaration: 1, drivePackageFileId: 1, drivePackageName: 1, drivePackagePath: 1, drivePackageWebViewLink: 1, packageSources: 1 } }).sort({ year: -1, date: -1, fileName: 1 }).limit(limit).toArray()
      ]);
      res.set('Cache-Control', 'no-store');
      res.json({ total, rows });
    } catch (error) { res.status(503).json({ error: error.message }); }
  });
  app.get('/api/drive-data/domains/:domain/files', async (req, res) => {
    try {
      const db = getDb(); if (!db) throw new Error('MongoDB non configurato');
      const domain = String(req.params.domain || '').toLowerCase();
      const definition = DRIVE_DOMAIN_DEFINITIONS[domain];
      if (!definition) return res.status(404).json({ error: 'Dominio documentale non riconosciuto' });
      const filter = fileFilter({ rootFolderId, domain, query: escapedRegex(req.query.q), year: Number(req.query.year || 0) });
      const limit = Math.max(1, Math.min(500, Number(req.query.limit || 200)));
      const [total, rows] = await Promise.all([
        db.collection('drive_files').countDocuments(filter),
        db.collection('drive_files').find(filter, { projection: FILE_PROJECTION }).sort({ anno: -1, modificatoIlFonte: -1, nome: 1 }).limit(limit).toArray()
      ]);
      res.set('Cache-Control', 'no-store');
      res.json({ domain, label: definition.label, total, rows });
    } catch (error) { res.status(503).json({ error: error.message }); }
  });
  app.post('/api/drive-data/import', async (req, res) => {
    if (service.isRunning()) return res.status(202).json({ accepted: true, running: true });
    service.run({ force: req.body?.force === true }).catch((error) => console.error('[drive-data] importazione fallita:', error.message));
    res.status(202).json({ accepted: true, running: true });
  });

  function start() {
    if (!autoStart || !getDb()) return null;
    const timer = setTimeout(() => service.run().catch((error) => console.error('[drive-data] avvio automatico fallito:', error.message)), 1_000);
    timer.unref?.();
    return timer;
  }
  return { service, start };
}
