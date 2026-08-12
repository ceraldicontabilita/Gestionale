import { MongoClient } from 'mongodb';
import { createGoogleAccessTokenProvider } from './google-auth.js';
import { createGoogleDriveClient } from './google-drive-client.js';
import { createDriveFiscalHandler } from './drive-fiscale.js';
import { createScheduler } from './scheduler.js';

let runtimeClient = null;
let scheduler = null;

function schedulerEnabled(env = process.env) {
  return String(env.SCHEDULER_ENABLED || 'true').toLowerCase() !== 'false';
}

function googleAuthConfigured(env = process.env) {
  return Boolean(
    env.GOOGLE_DRIVE_ACCESS_TOKEN ||
    (env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET && env.GOOGLE_OAUTH_REFRESH_TOKEN)
  );
}

async function startRuntime(env = process.env) {
  if (!schedulerEnabled(env)) return;
  if (!env.MONGODB_URI) {
    console.warn('[scheduler] disabilitato: MONGODB_URI assente');
    return;
  }

  runtimeClient = new MongoClient(env.MONGODB_URI);
  await runtimeClient.connect();
  const db = runtimeClient.db(env.MONGODB_DB || 'impresa_semplice');
  const handlers = {};

  if (env.DRIVE_FISCALE_ROOT_FOLDER_ID && googleAuthConfigured(env)) {
    const getAccessToken = createGoogleAccessTokenProvider(env);
    const driveClient = createGoogleDriveClient({ getAccessToken });
    handlers.DRIVE_FISCALE_SCAN = createDriveFiscalHandler({
      driveClient,
      rootFolder: env.DRIVE_FISCALE_ROOT_FOLDER_ID
    });
  } else {
    console.warn('[scheduler] Drive fiscale non attivato: configurazione incompleta');
  }

  scheduler = createScheduler({
    db,
    handlers,
    instanceId: env.RENDER_INSTANCE_ID || env.HOSTNAME || `runtime-${process.pid}`
  });
  scheduler.start({ tickEveryMs: Number(env.SCHEDULER_TICK_MS || 60_000), runImmediately: true });
  console.info(`[scheduler] attivo con ${Object.keys(handlers).length} handler`);
}

startRuntime().catch((error) => {
  console.error('[scheduler] avvio fallito:', error.message);
});

process.once('SIGTERM', () => {
  scheduler?.stop();
  runtimeClient?.close().catch(() => {});
});

process.once('SIGINT', () => {
  scheduler?.stop();
  runtimeClient?.close().catch(() => {});
});
