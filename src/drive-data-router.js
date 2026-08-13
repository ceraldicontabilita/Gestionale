import { createGoogleAccessTokenProvider } from './google-auth.js';
import { createGoogleDriveClient, extractDriveId } from './google-drive-client.js';
import { createDriveDataImportService } from './drive-data-import.js';

function configured(env) {
  return Boolean(env.GOOGLE_DRIVE_ACCESS_TOKEN || env.GOOGLE_DRIVE_SA_JSON || (env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET && env.GOOGLE_OAUTH_REFRESH_TOKEN));
}

function escapedRegex(value) { return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&').slice(0, 120); }

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
    try { res.json({ running: service.isRunning(), lastRun: await service.status() }); }
    catch (error) { res.status(503).json({ error: error.message }); }
  });
  app.get('/api/drive-data/summary', async (_req, res) => {
    try { res.json(await service.summary()); }
    catch (error) { res.status(503).json({ error: error.message }); }
  });
  app.get('/api/drive-data/files', async (req, res) => {
    try {
      const db = getDb(); if (!db) throw new Error('MongoDB non configurato');
      const filter = { attivo: true, rootFolderId }; const query = escapedRegex(req.query.q); const year = Number(req.query.year || 0);
      if (query) filter.$or = [{ nome: { $regex: query, $options: 'i' } }, { percorso: { $regex: query, $options: 'i' } }, { tipoProposto: { $regex: query, $options: 'i' } }];
      if (year >= 2000 && year <= 2100) filter.anno = year;
      const limit = Math.max(1, Math.min(500, Number(req.query.limit || 200)));
      const [total, rows] = await Promise.all([
        db.collection('drive_files').countDocuments(filter),
        db.collection('drive_files').find(filter, { projection: { _id: 0, driveFileId: 1, nome: 1, percorso: 1, topFolder: 1, tipoProposto: 1, anno: 1, dimensione: 1, webViewLink: 1, modificatoIlFonte: 1 } }).sort({ modificatoIlFonte: -1, nome: 1 }).limit(limit).toArray()
      ]);
      res.json({ total, rows });
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
