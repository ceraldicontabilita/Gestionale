import 'dotenv/config';
import { MongoClient } from 'mongodb';
import { createGoogleAccessTokenProvider } from './google-auth.js';
import { createGoogleDriveClient } from './google-drive-client.js';
import { createDriveFiscalHandler } from './drive-fiscale.js';
import { createEmailPecHandler } from './email-pec.js';
import { createDocumentReprocessHandler } from './document-pipeline.js';
import { createFiscalControlsHandler } from './fiscal-controls.js';
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

function pecConfigured(env = process.env) {
  return Boolean(env.PEC_IMAP_HOST && env.PEC_IMAP_USER && env.PEC_IMAP_PASSWORD);
}

async function startRuntime(env = process.env) {
  if (!schedulerEnabled(env)) return;
  if (!env.MONGODB_URI) {
    console.warn('[scheduler] disabilitato: MONGODB_URI assente');
    return;
  }

  runtimeClient = new MongoClient(env.MONGODB_URI, { maxPoolSize: 10, minPoolSize: 0 });
  await runtimeClient.connect();
  const db = runtimeClient.db(env.MONGODB_DB || 'impresa_semplice');
  const handlers = {
    DOCUMENTI_RIPROCESSA: createDocumentReprocessHandler(),
    SCADENZE_FISCALI: createFiscalControlsHandler()
  };

  if (env.DRIVE_FISCALE_ROOT_FOLDER_ID && googleAuthConfigured(env)) {
    const getAccessToken = createGoogleAccessTokenProvider(env);
    const driveClient = createGoogleDriveClient({ getAccessToken });
    handlers.DRIVE_FISCALE_SCAN = createDriveFiscalHandler({
      driveClient,
      rootFolder: env.DRIVE_FISCALE_ROOT_FOLDER_ID,
      maxFileBytes: Number(env.DRIVE_MAX_FILE_BYTES || 25 * 1024 * 1024)
    });
  } else {
    console.warn('[scheduler] Drive fiscale non attivato: configurazione incompleta');
  }

  if (pecConfigured(env)) {
    handlers.EMAIL_PEC_SCAN = createEmailPecHandler({
      config: {
        host: env.PEC_IMAP_HOST,
        port: Number(env.PEC_IMAP_PORT || 993),
        secure: String(env.PEC_IMAP_SECURE || 'true').toLowerCase() !== 'false',
        user: env.PEC_IMAP_USER,
        password: env.PEC_IMAP_PASSWORD,
        mailbox: env.PEC_IMAP_MAILBOX || 'INBOX',
        maxMessages: Number(env.PEC_IMAP_MAX_MESSAGES || 200),
        overlapUids: Number(env.PEC_IMAP_OVERLAP_UIDS || 50),
        maxMessageBytes: Number(env.PEC_IMAP_MAX_MESSAGE_BYTES || 50 * 1024 * 1024),
        channel: 'pec'
      }
    });
  } else {
    console.warn('[scheduler] PEC/email non attivata: configurazione IMAP incompleta');
  }

  scheduler = createScheduler({
    db,
    handlers,
    instanceId: env.RENDER_INSTANCE_ID || env.HOSTNAME || `runtime-${process.pid}`,
    timeZone: env.APP_TIME_ZONE || 'Europe/Rome'
  });
  scheduler.start({ tickEveryMs: Number(env.SCHEDULER_TICK_MS || 60_000), runImmediately: true });
  console.info(`[scheduler] attivo con ${Object.keys(handlers).length} handler`);
}

startRuntime().catch((error) => console.error('[scheduler] avvio fallito:', error.message));

async function stopRuntime() {
  scheduler?.stop();
  await runtimeClient?.close().catch(() => {});
}

process.once('SIGTERM', () => { stopRuntime().catch(() => {}); });
process.once('SIGINT', () => { stopRuntime().catch(() => {}); });
