import 'dotenv/config';
import express from 'express';
import { MongoClient } from 'mongodb';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerAuthentication } from './src/auth.js';
import { registerCoreRoutes } from './src/core-router.js';
import { registerCorrispettiviRoutes } from './src/corrispettivi-router.js';
import { registerF24Routes } from './src/f24-router.js';
import { registerRiscossioneRoutes } from './src/riscossione-router.js';
import { registerDriveIndexRoutes } from './src/drive-index-router.js';
import { registerDriveDataRoutes } from './src/drive-data-router.js';
import { registerDrivePlanRoutes } from './src/drive-plan-router.js';
import { registerReconciliationRoutes } from './src/reconciliation-router.js';
import { createEventEngineRuntime } from './src/event-engine.js';
import { registerEventEngineRoutes } from './src/event-engine-router.js';
import { registerSupplierInvoiceRoutes } from './src/supplier-invoice-router.js';
import { createProjectionEngineRuntime } from './src/projection-engine.js';

const app = express();
const port = Number(process.env.PORT || 3000);
const version = '0.9.0';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

app.disable('x-powered-by');
if (String(process.env.TRUST_PROXY || 'true').toLowerCase() !== 'false') app.set('trust proxy', 1);
app.use((_req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
  });
  next();
});
app.use(express.json({ limit: '10mb' }));
app.use(express.text({ type: ['application/xml', 'text/xml'], limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

let client = null;
let db = null;

if (process.env.MONGODB_URI) {
  client = new MongoClient(process.env.MONGODB_URI, { maxPoolSize: 20, minPoolSize: 0 });
  await client.connect();
  db = client.db(process.env.MONGODB_DB || 'impresa_semplice');
  await Promise.all([
    db.collection('giornate_corrispettivi').createIndex({ dataGiorno: 1 }, { unique: true }),
    db.collection('crediti_pos').createIndex({ dataGiorno: 1, gestore: 1 }, { unique: true }),
    db.collection('movimenti').createIndex({ proiezioneKey: 1 }, { unique: true, sparse: true })
  ]);
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, nome: 'Impresa Semplice', versione: version, database: db ? 'connected' : 'not-configured' });
});

registerAuthentication(app, { getDb: () => db });
registerCoreRoutes(app, { getDb: () => db });
registerCorrispettiviRoutes(app, { getDb: () => db, getClient: () => client });
registerF24Routes(app, { getDb: () => db, getClient: () => client });
registerRiscossioneRoutes(app, { getDb: () => db, getClient: () => client });
const driveIndexRegistration = registerDriveIndexRoutes(app);
const driveDataRegistration = registerDriveDataRoutes(app, {
  getDb: () => db,
  getIndex: (options) => driveIndexRegistration.getService().load(options)
});
registerDrivePlanRoutes(app, { getDb: () => db });
registerReconciliationRoutes(app, { getDb: () => db });
registerEventEngineRoutes(app, { getDb: () => db, getClient: () => client });
registerSupplierInvoiceRoutes(app, { getDb: () => db, getClient: () => client });

const eventEngineRuntime = createEventEngineRuntime({ getDb: () => db, getClient: () => client });
const projectionEngineRuntime = createProjectionEngineRuntime({ getDb: () => db, getClient: () => client });
eventEngineRuntime.start();
projectionEngineRuntime.start();

const server = app.listen(port, () => console.log(`Impresa Semplice v${version} in ascolto sulla porta ${port}`));
driveDataRegistration.start();

async function shutdown(signal) {
  console.info(`[server] chiusura ${signal}`);
  await eventEngineRuntime.stop();
  await projectionEngineRuntime.stop();
  server.close(async () => {
    if (client) await client.close().catch(() => {});
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
