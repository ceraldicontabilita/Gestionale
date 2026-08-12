import { relationKey } from './domain.js';

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
    tipo: String(inbox.sourceType || 'INBOX').toUpperCase(),
    riferimento: inbox.webViewLink || inbox.emailMessageKey || inbox.sourceId || inbox.sourceKey,
    sourceKey: inbox.sourceKey
  };
}

export function createDocumentReprocessHandler({ limit = 250, logger = console } = {}) {
  return async function documentiRiprocessa({ db, now }) {
    await Promise.all([
      db.collection('documenti').createIndex({ sha256: 1 }, { unique: true, sparse: true }),
      db.collection('documenti').createIndex({ 'fonti.sourceKey': 1 }, { sparse: true }),
      db.collection('collegamenti').createIndex({ relationKey: 1 }, { unique: true })
    ]);

    const queue = await db.collection('documenti_inbox').find({
      stato: { $in: ['DA_CLASSIFICARE', 'DA_VERIFICARE', 'TECNICO_PEC'] },
      elaboratoIl: { $exists: false }
    }).sort({ creatoIl: 1 }).limit(Number(limit)).toArray();

    let processed = 0;
    let classified = 0;
    let technical = 0;
    let errors = 0;

    for (const inbox of queue) {
      try {
        const source = stableSource(inbox);
        const filter = inbox.sha256
          ? { sha256: inbox.sha256 }
          : { 'fonti.sourceKey': inbox.sourceKey };
        const tipo = inbox.tecnicoPec ? 'TECNICO_PEC' : (inbox.propostaTipo || inbox.tipoRiconosciuto || 'DA_CLASSIFICARE');
        const stato = inbox.tecnicoPec ? 'DOCUMENTATO' : (tipo === 'DA_CLASSIFICARE' ? 'DA_VERIFICARE' : 'DA_VERIFICARE');

        await db.collection('documenti').updateOne(
          filter,
          {
            $set: {
              nomeOriginale: inbox.nomeOriginale || 'documento',
              tipo,
              stato,
              sha256: inbox.sha256 || null,
              gridFsId: inbox.gridFsId || null,
              datiEstratti: {
                ...(inbox.datiEstratti || {}),
                propostaTipo: inbox.propostaTipo || null,
                mittenteAttendibile: inbox.mittenteAttendibile ?? null,
                emailFrom: inbox.emailFrom || null,
                emailSubject: inbox.emailSubject || null,
                percorsoDrive: inbox.percorso || null
              },
              aggiornatoIl: now
            },
            $addToSet: { fonti: source },
            $setOnInsert: { creatoIl: now }
          },
          { upsert: true }
        );

        const document = await db.collection('documenti').findOne(filter);
        await db.collection('documenti_inbox').updateOne(
          { _id: inbox._id },
          {
            $set: {
              documentoId: document?._id || null,
              stato: inbox.tecnicoPec ? 'ARCHIVIATO_TECNICO' : 'ELABORATO',
              elaboratoIl: now,
              aggiornatoIl: now
            }
          }
        );

        if (document?._id && inbox.emailMessageKey) {
          await ensureRelation(db, 'DOCUMENTO', document._id, 'EMAIL', inbox.emailMessageKey, 'ACQUISITO_DA');
        }
        if (document?._id && inbox.sourceType === 'GOOGLE_DRIVE') {
          await ensureRelation(db, 'DOCUMENTO', document._id, 'DRIVE_FILE', inbox.sourceId, 'ACQUISITO_DA');
        }

        processed += 1;
        if (tipo !== 'DA_CLASSIFICARE' && !inbox.tecnicoPec) classified += 1;
        if (inbox.tecnicoPec) technical += 1;
      } catch (error) {
        errors += 1;
        await db.collection('documenti_inbox').updateOne(
          { _id: inbox._id },
          { $set: { stato: 'ERRORE_TECNICO', ultimoErrore: error.message, aggiornatoIl: now } }
        );
      }
    }

    logger.info?.(`[documenti] processati=${processed} classificati=${classified} tecnici=${technical} errori=${errors}`);
    return { counts: { processed, classified, technical, errors } };
  };
}
