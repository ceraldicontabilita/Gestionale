import { parseDelimitedText } from './csv.js';
import { importF24IndexRows } from './f24-import-service.js';
import { extractDriveId } from './google-drive-client.js';
import { overlapStart } from './schedule-policy.js';

const FOLDER_MIME = 'application/vnd.google-apps.folder';

function sourceRevision(file) {
  return file.modifiedTime || file.md5Checksum || file.id;
}

async function upsertInbox(db, file, pathParts, now) {
  const sourceKey = `DRIVE:${file.id}:${sourceRevision(file)}`;
  const doc = {
    sourceKey,
    sourceType: 'GOOGLE_DRIVE',
    sourceId: file.id,
    sourceRevision: sourceRevision(file),
    nomeOriginale: file.name,
    mimeType: file.mimeType,
    dimensione: file.size ? Number(file.size) : null,
    md5Checksum: file.md5Checksum || null,
    percorso: [...pathParts, file.name].join('/'),
    webViewLink: file.webViewLink || null,
    stato: 'DA_CLASSIFICARE',
    modificatoIlFonte: file.modifiedTime ? new Date(file.modifiedTime) : null,
    aggiornatoIl: now
  };
  const result = await db.collection('documenti_inbox').updateOne(
    { sourceKey },
    { $set: doc, $setOnInsert: { creatoIl: now } },
    { upsert: true }
  );
  return { sourceKey, inserted: Boolean(result.upsertedCount) };
}

export function createDriveFiscalHandler({ driveClient, rootFolder, logger = console }) {
  const rootFolderId = extractDriveId(rootFolder);
  if (!driveClient || !rootFolderId) throw new Error('Drive fiscale non configurato');

  return async function driveFiscalScan({ db, checkpoint, policy, now }) {
    await Promise.all([
      db.collection('documenti_inbox').createIndex({ sourceKey: 1 }, { unique: true }),
      db.collection('documenti_inbox').createIndex({ sourceType: 1, modificatoIlFonte: -1 })
    ]);

    const overlap = checkpoint?.lastSuccessfulAt ? overlapStart(checkpoint.lastSuccessfulAt, 'DRIVE_FISCALE_SCAN') : null;
    const stack = [{ id: rootFolderId, path: [] }];
    let folders = 0;
    let filesSeen = 0;
    let inboxNew = 0;
    let indexesProcessed = 0;
    let f24Rows = 0;
    const errors = [];

    while (stack.length) {
      const current = stack.pop();
      let children;
      try {
        children = await driveClient.listChildren(current.id);
      } catch (error) {
        errors.push({ code: error.code || 'DRIVE_LIST_FAILED', message: error.message, folderId: current.id });
        continue;
      }

      folders += 1;
      for (const file of children) {
        if (file.mimeType === FOLDER_MIME) {
          stack.push({ id: file.id, path: [...current.path, file.name] });
          continue;
        }

        filesSeen += 1;
        const modifiedAt = file.modifiedTime ? new Date(file.modifiedTime) : null;
        const isRecent = !overlap || !modifiedAt || modifiedAt >= overlap;
        if (isRecent) {
          try {
            const inbox = await upsertInbox(db, file, current.path, now);
            if (inbox.inserted) inboxNew += 1;
          } catch (error) {
            errors.push({ code: 'INBOX_UPSERT_FAILED', message: error.message, fileId: file.id });
          }
        }

        if (file.name === 'INDICE_UNICO_DOCUMENTI_F24.csv') {
          try {
            const text = await driveClient.downloadText(file.id);
            const rows = parseDelimitedText(text, { delimiter: ';' });
            const imported = await importF24IndexRows(db, rows, { fonteIndice: 'DRIVE_INDICE_F24', now });
            indexesProcessed += 1;
            f24Rows += imported.length;
            await db.collection('documenti_inbox').updateMany(
              { sourceId: file.id },
              { $set: { stato: 'ELABORATO', tipoRiconosciuto: 'INDICE_F24', aggiornatoIl: now } }
            );
          } catch (error) {
            errors.push({ code: error.code || 'F24_INDEX_FAILED', message: error.message, fileId: file.id });
          }
        }
      }
    }

    logger.info?.(`[drive-fiscale] cartelle=${folders} file=${filesSeen} nuovi=${inboxNew} f24=${f24Rows}`);
    return {
      counts: { folders, filesSeen, inboxNew, indexesProcessed, f24Rows, errors: errors.length },
      errors,
      checkpoint: { rootFolderId, lastScanStartedAt: now.toISOString() },
      metadata: { overlapFrom: overlap?.toISOString() || null }
    };
  };
}
