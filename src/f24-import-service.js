import { buildF24FromIndexRow } from './f24.js';
import { relationKey } from './domain.js';

export async function ensureDomainRelation(db, aTipo, aId, bTipo, bId, relazione, { session = null } = {}) {
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
    { upsert: true, ...(session ? { session } : {}) }
  );
  return key;
}

export async function ensureF24Indexes(db) {
  await Promise.all([
    db.collection('f24_operazioni').createIndex({ sourceKey: 1 }, { unique: true }),
    db.collection('f24_operazioni').createIndex({ operationKey: 1, numeroModelloNelGruppo: 1 }),
    db.collection('documenti').createIndex({ sha256: 1 }, { unique: true, sparse: true }),
    db.collection('documenti').createIndex({ primarySourceKey: 1 }, { unique: true, sparse: true }),
    db.collection('collegamenti').createIndex({ relationKey: 1 }, { unique: true })
  ]);
}

export async function importF24IndexRows(db, inputRows, { fonteIndice = 'DRIVE_INDICE_F24', now = new Date(), session = null } = {}) {
  if (!db) throw new Error('Database richiesto');
  const rows = Array.isArray(inputRows) ? inputRows : [inputRows];
  if (!rows.length) throw new Error('Nessuna riga indice F24');
  await ensureF24Indexes(db);
  const risultati = [];

  for (const input of rows) {
    const normalized = buildF24FromIndexRow(input);
    const { stato: statoDocumentale, ...sourceFields } = normalized;
    await db.collection('f24_operazioni').updateOne(
      { sourceKey: normalized.sourceKey },
      {
        $set: {
          ...sourceFields,
          statoDocumentale,
          fonteIndice: String(input?.fonteIndice || fonteIndice).toUpperCase(),
          aggiornatoIl: now
        },
        $setOnInsert: { stato: statoDocumentale, creatoIl: now }
      },
      { upsert: true, ...(session ? { session } : {}) }
    );
    const f24 = await db.collection('f24_operazioni').findOne(
      { sourceKey: normalized.sourceKey },
      session ? { session } : {}
    );

    let documentoId = null;
    if (normalized.sha256 || normalized.file) {
      const primarySourceKey = `F24_INDEX:${normalized.sourceKey}`;
      const documentFilter = normalized.sha256
        ? { sha256: normalized.sha256 }
        : { primarySourceKey };
      const source = {
        sourceKey: normalized.urlSorgente ? `CASSETTO:${normalized.urlSorgente}` : primarySourceKey,
        tipo: normalized.urlSorgente ? 'CASSETTO_FISCALE' : 'DRIVE_INDICE_F24',
        riferimento: normalized.urlSorgente || normalized.file || normalized.sourceKey
      };
      const set = {
        nomeOriginale: normalized.file || 'F24',
        tipo: normalized.tipoDocumento,
        statoDocumentale: 'DOCUMENTATO',
        protocollo: normalized.protocollo || normalized.protocolloLettoNelPdf,
        annoImposta: normalized.dataVersamento ? normalized.dataVersamento.getUTCFullYear() : normalized.annoElenco,
        'datiEstratti.f24SourceKey': normalized.sourceKey,
        'datiEstratti.f24OperationKey': normalized.operationKey,
        'datiEstratti.saldoOperazione': normalized.saldoOperazione,
        'datiEstratti.saldoModello': normalized.saldoModello,
        'datiEstratti.indicePortale': normalized.indicePortale,
        'datiEstratti.numeroModelloNelGruppo': normalized.numeroModelloNelGruppo,
        aggiornatoIl: now
      };
      if (normalized.sha256) set.sha256 = normalized.sha256;
      else set.primarySourceKey = primarySourceKey;
      const operation = {
        $set: set,
        $addToSet: { fonti: source },
        $setOnInsert: { stato: 'DOCUMENTATO', creatoIl: now },
        $unset: normalized.sha256 ? { primarySourceKey: '' } : { sha256: '' }
      };
      await db.collection('documenti').updateOne(
        documentFilter,
        operation,
        { upsert: true, ...(session ? { session } : {}) }
      );
      const savedDocument = await db.collection('documenti').findOne(
        documentFilter,
        session ? { session } : {}
      );
      documentoId = savedDocument?._id || null;
      if (documentoId) {
        await ensureDomainRelation(db, 'F24', f24._id, 'DOCUMENTO', documentoId, 'DOCUMENTATO_DA', { session });
      }
    }

    risultati.push({ f24Id: f24._id, documentoId, sourceKey: normalized.sourceKey, stato: f24.stato });
  }

  return risultati;
}
