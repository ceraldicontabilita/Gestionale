import { relationKey } from './domain.js';

const PRESERVED_STATES = new Set(['DOCUMENTATO', 'VERIFICATO', 'RICONCILIATO']);

async function ensureRelation(db, aTipo, aId, bTipo, bId, relazione) {
  const key = relationKey(aTipo, aId, bTipo, bId, relazione);
  await db.collection('collegamenti').updateOne(
    { relationKey: key },
    {
      $setOnInsert: {
        relationKey: key,
        a: { tipo: String(aTipo).toUpperCase(), id: String(aId) },
        b: { tipo: String(bTipo).toUpperCase(), id: String(bId) },
        relazione: String(relazione).toUpperCase(),
        creatoIl: new Date()
      }
    },
    { upsert: true }
  );
}

function stableSource(inbox) {
  return {
    sourceKey: inbox.sourceKey,
    tipo: String(inbox.sourceType || 'INBOX').toUpperCase(),
    riferimento: inbox.webViewLink || inbox.emailMessageKey || inbox.sourceId || inbox.sourceKey
  };
}

function knownType(value) {
  const type = String(value || 'DA_CLASSIFICARE').toUpperCase();
  return type !== 'DA_CLASSIFICARE' ? type : null;
}

function retryAt(now, attempts) {
  const minutes = Math.min(24 * 60, 15 * (2 ** Math.min(6, Math.max(0, attempts - 1))));
  return new Date(now.getTime() + minutes * 60_000);
}

export function createDocumentReprocessHandler({ limit = 250, logger = console } = {}) {
  return async function documentiRiprocessa({ db, now }) {
    await Promise.all([
      db.collection('documenti').createIndex({ sha256: 1 }, { unique: true, sparse: true }),
      db.collection('documenti').createIndex({ primarySourceKey: 1 }, { unique: true, sparse: true }),
      db.collection('collegamenti').createIndex({ relationKey: 1 }, { unique: true })
    ]);

    const queue = await db.collection('documenti_inbox').find({
      $or: [
        { stato: { $in: ['DA_CLASSIFICARE', 'DA_VERIFICARE', 'TECNICO_PEC'] }, elaboratoIl: { $exists: false } },
        { stato: 'ERRORE_TECNICO', nextRetryAt: { $lte: now } }
      ]
    }).sort({ creatoIl: 1 }).limit(Number(limit)).toArray();

    let processed = 0;
    let classified = 0;
    let technical = 0;
    let conflicts = 0;
    let errors = 0;

    for (const inbox of queue) {
      try {
        if (!inbox.gridFsId && !inbox.metadataOnly) {
          throw Object.assign(new Error('Originale non archiviato prima dell’elaborazione'), { code: 'ORIGINALE_MANCANTE' });
        }
        const source = stableSource(inbox);
        const primarySourceKey = inbox.sha256 ? null : inbox.sourceKey;
        const filter = inbox.sha256 ? { sha256: inbox.sha256 } : { primarySourceKey };
        const existing = await db.collection('documenti').findOne(filter);
        const proposed = inbox.tecnicoPec ? 'TECNICO_PEC' : knownType(inbox.propostaTipo || inbox.tipoRiconosciuto);
        const existingType = knownType(existing?.tipo);
        const conflict = Boolean(existingType && proposed && existingType !== proposed);
        const finalType = existingType || proposed || 'DA_CLASSIFICARE';
        const finalState = existing && PRESERVED_STATES.has(existing.stato)
          ? existing.stato
          : inbox.tecnicoPec
            ? 'DOCUMENTATO'
            : 'DA_VERIFICARE';
        const set = {
          nomeOriginale: inbox.nomeOriginale || existing?.nomeOriginale || 'documento',
          tipo: finalType,
          stato: finalState,
          gridFsId: inbox.gridFsId || existing?.gridFsId || null,
          conflittoClassificazione: Boolean(existing?.conflittoClassificazione || conflict),
          'datiEstratti.propostaTipo': proposed,
          'datiEstratti.mittenteAttendibile': inbox.mittenteAttendibile ?? null,
          'datiEstratti.emailFrom': inbox.emailFrom || null,
          'datiEstratti.emailSubject': inbox.emailSubject || null,
          'datiEstratti.percorsoDrive': inbox.percorso || null,
          aggiornatoIl: now
        };
        if (inbox.sha256) set.sha256 = inbox.sha256;
        else set.primarySourceKey = primarySourceKey;
        const operation = {
          $set: set,
          $addToSet: { fonti: source },
          $setOnInsert: { creatoIl: now },
          $unset: inbox.sha256 ? { primarySourceKey: '' } : { sha256: '' }
        };
        if (conflict) {
          operation.$addToSet.conflitti = {
            tipoEsistente: existingType,
            tipoProposto: proposed,
            sourceKey: inbox.sourceKey
          };
        }
        await db.collection('documenti').updateOne(filter, operation, { upsert: true });
        const document = await db.collection('documenti').findOne(filter);
        await db.collection('documenti_inbox').updateOne(
          { _id: inbox._id },
          {
            $set: {
              documentoId: document?._id || null,
              stato: inbox.tecnicoPec ? 'ARCHIVIATO_TECNICO' : 'ELABORATO',
              elaboratoIl: now,
              aggiornatoIl: now
            },
            $unset: { ultimoErrore: '', nextRetryAt: '' }
          }
        );

        if (document?._id && inbox.emailMessageKey) await ensureRelation(db, 'DOCUMENTO', document._id, 'EMAIL', inbox.emailMessageKey, 'ACQUISITO_DA');
        if (document?._id && inbox.sourceType === 'GOOGLE_DRIVE') await ensureRelation(db, 'DOCUMENTO', document._id, 'DRIVE_FILE', inbox.sourceId, 'ACQUISITO_DA');

        processed += 1;
        if (proposed && !inbox.tecnicoPec) classified += 1;
        if (inbox.tecnicoPec) technical += 1;
        if (conflict) conflicts += 1;
      } catch (error) {
        errors += 1;
        const attempts = Number(inbox.tentativiElaborazione || 0) + 1;
        await db.collection('documenti_inbox').updateOne(
          { _id: inbox._id },
          {
            $set: {
              stato: 'ERRORE_TECNICO',
              ultimoErrore: { code: error.code || 'DOCUMENT_PIPELINE_ERROR', message: error.message, at: now },
              tentativiElaborazione: attempts,
              nextRetryAt: retryAt(now, attempts),
              aggiornatoIl: now
            }
          }
        );
      }
    }

    logger.info?.(`[documenti] processati=${processed} classificati=${classified} tecnici=${technical} conflitti=${conflicts} errori=${errors}`);
    return { counts: { processed, classified, technical, conflicts, errors } };
  };
}
