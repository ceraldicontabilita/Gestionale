import crypto from 'node:crypto';
import { parseDelimitedText } from './csv.js';
import { importF24IndexRows } from './f24-import-service.js';
import { extractDriveId } from './google-drive-client.js';
import { overlapStart } from './schedule-policy.js';
import { storeOriginalOnce } from './blob-store.js';

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const GOOGLE_NATIVE_PREFIX = 'application/vnd.google-apps.';
const F24_INDEX_NAME = 'INDICE_UNICO_DOCUMENTI_F24.csv';

export function driveSourceRevision(file) {
  return file.sha256Checksum || file.md5Checksum || file.version || file.modifiedTime || file.id;
}

function md5(buffer) {
  return crypto.createHash('md5').update(buffer).digest('hex');
}

async function upsertInbox(db, file, pathParts, original, now) {
  const revision = driveSourceRevision(file);
  const sourceKey = `DRIVE:${file.id}:${revision}`;
  const set = {
    sourceKey,
    sourceType: 'GOOGLE_DRIVE',
    sourceId: file.id,
    sourceRevision: revision,
    nomeOriginale: file.name,
    mimeType: file.mimeType,
    dimensione: original.size,
    md5Checksum: file.md5Checksum || null,
    sha256: original.sha256,
    gridFsId: original.gridFsId,
    percorso: [...pathParts, file.name].join('/'),
    webViewLink: file.webViewLink || null,
    stato: 'DA_CLASSIFICARE',
    modificatoIlFonte: file.modifiedTime ? new Date(file.modifiedTime) : null,
    aggiornatoIl: now
  };
  const result = await db.collection('documenti_inbox').updateOne(
    { sourceKey },
    { $set: set, $setOnInsert: { creatoIl: now } },
    { upsert: true }
  );
  return { sourceKey, inserted: Boolean(result.upsertedCount) };
}

export function createDriveFiscalHandler({ driveClient, rootFolder, logger = console, maxFileBytes = 25 * 1024 * 1024 }) {
  const rootFolderId = extractDriveId(rootFolder);
  if (!driveClient || !rootFolderId) throw new Error('Drive fiscale non configurato');

  return async function driveFiscalScan({ db, checkpoint, now }) {
    await Promise.all([
      db.collection('documenti_inbox').createIndex({ sourceKey: 1 }, { unique: true }),
      db.collection('documenti_inbox').createIndex({ sourceType: 1, modificatoIlFonte: -1 })
    ]);

    const overlap = checkpoint?.lastSuccessfulAt ? overlapStart(checkpoint.lastSuccessfulAt, 'DRIVE_FISCALE_SCAN') : null;
    const stack = [{ id: rootFolderId, path: [] }];
    const visitedFolders = new Set();
    let folders = 0;
    let filesSeen = 0;
    let originalsStored = 0;
    let inboxNew = 0;
    let indexesProcessed = 0;
    let f24Rows = 0;
    const errors = [];

    while (stack.length) {
      const current = stack.pop();
      if (visitedFolders.has(current.id)) continue;
      visitedFolders.add(current.id);
      let children;
      try {
        children = await driveClient.listChildren(current.id);
      } catch (error) {
        errors.push({ code: error.code || 'DRIVE_LIST_FAILED', message: error.message, reference: current.id });
        continue;
      }

      folders += 1;
      for (const file of children) {
        if (file.mimeType === FOLDER_MIME) {
          stack.push({ id: file.id, path: [...current.path, file.name] });
          continue;
        }
        filesSeen += 1;
        const revision = driveSourceRevision(file);
        const sourceKey = `DRIVE:${file.id}:${revision}`;
        const existing = await db.collection('documenti_inbox').findOne({ sourceKey });
        const isF24Index = file.name === F24_INDEX_NAME;
        const completedIndex = isF24Index && existing?.tipoRiconosciuto === 'INDICE_F24' && existing?.stato === 'ELABORATO';
        if (existing?.gridFsId && existing?.sha256 && (!isF24Index || completedIndex)) continue;

        try {
          if (String(file.mimeType || '').startsWith(GOOGLE_NATIVE_PREFIX)) {
            throw Object.assign(new Error('File Google nativo non esportato: formato non supportato dal registro fiscale'), { code: 'DRIVE_NATIVE_UNSUPPORTED' });
          }
          const declaredSize = Number(file.size || 0);
          if (declaredSize > maxFileBytes) {
            throw Object.assign(new Error(`File oltre il limite configurato (${declaredSize} byte)`), { code: 'DRIVE_FILE_TOO_LARGE' });
          }
          const buffer = await driveClient.downloadBuffer(file.id);
          if (buffer.length > maxFileBytes) throw Object.assign(new Error('File scaricato oltre il limite configurato'), { code: 'DRIVE_FILE_TOO_LARGE' });
          if (file.md5Checksum && md5(buffer) !== String(file.md5Checksum).toLowerCase()) {
            throw Object.assign(new Error('Checksum MD5 Drive non coerente con il download'), { code: 'DRIVE_CHECKSUM_MISMATCH' });
          }
          const declaredSha = /^[a-f0-9]{64}$/i.test(file.sha256Checksum || '') ? file.sha256Checksum : null;
          const original = await storeOriginalOnce(db, buffer, {
            sha256: declaredSha,
            filename: file.name,
            contentType: file.mimeType,
            metadata: { source: 'GOOGLE_DRIVE', fileId: file.id, revision, percorso: current.path.join('/') }
          });
          originalsStored += existing?.gridFsId ? 0 : 1;
          const inbox = await upsertInbox(db, file, current.path, original, now);
          if (inbox.inserted) inboxNew += 1;

          if (isF24Index) {
            const rows = parseDelimitedText(buffer.toString('utf8'), { delimiter: ';' });
            const imported = await importF24IndexRows(db, rows, { fonteIndice: 'DRIVE_INDICE_F24', now });
            indexesProcessed += 1;
            f24Rows += imported.length;
            await db.collection('documenti_inbox').updateOne(
              { sourceKey },
              { $set: { stato: 'ELABORATO', tipoRiconosciuto: 'INDICE_F24', righeImportate: imported.length, aggiornatoIl: now } }
            );
          }
        } catch (error) {
          errors.push({ code: error.code || 'DRIVE_FILE_FAILED', message: error.message, reference: file.id });
        }
      }
    }

    logger.info?.(`[drive-fiscale] cartelle=${folders} file=${filesSeen} originali=${originalsStored} nuovi=${inboxNew} f24=${f24Rows}`);
    return {
      counts: { folders, filesSeen, originalsStored, inboxNew, indexesProcessed, f24Rows, errors: errors.length },
      errors,
      checkpoint: { rootFolderId, lastScanStartedAt: now.toISOString() },
      metadata: { overlapFrom: overlap?.toISOString() || null, visitedFolders: visitedFolders.size }
    };
  };
}
