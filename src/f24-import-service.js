import { buildF24FromIndexRow } from './f24.js';
import { relationKey } from './domain.js';

export async function ensureDomainRelation(db, aTipo, aId, bTipo, bId, relazione) {
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
  return key;
}

export async function importF24IndexRows(db, inputRows, { fonteIndice = 'DRIVE_INDICE_F24', now = new Date() } = {}) {
  if (!db) throw new Error('Database richiesto');
  const rows = Array.isArray(inputRows) ? inputRows : [inputRows];
  if (!rows.length) throw new Error('Nessuna riga indice F24');

  await Promise.all([
    db.collection('f24_operazioni').createIndex({ sourceKey: 1 }, { unique: true }),
    db.collection('documenti').createIndex({ sha256: 1 }, { unique: true, sparse: true }),
    db.collection('collegamenti').createIndex({ relationKey: 1 }, { unique: true })
  ]);

  const risultati = [];

  for (const input of rows) {
    const normalized = buildF24FromIndexRow(input);
    const update = {
      ...normalized,
      fonteIndice: String(input?.fonteIndice || fonteIndice).toUpperCase(),
      aggiornatoIl: now
    };

    await db.collection('f24_operazioni').updateOne(
      { sourceKey: normalized.sourceKey },
      { $set: update, $setOnInsert: { creatoIl: now } },
      { upsert: true }
    );
    const f24 = await db.collection('f24_operazioni').findOne({ sourceKey: normalized.sourceKey });

    let documentoId = null;
    if (normalized.sha256 || normalized.file) {
      const documentFilter = normalized.sha256
        ? { sha256: normalized.sha256 }
        : { 'datiEstratti.f24SourceKey': normalized.sourceKey };

      const document = {
        nomeOriginale: normalized.file || 'F24',
        tipo: normalized.tipoDocumento,
        stato: 'DOCUMENTATO',
        sha256: normalized.sha256,
        protocollo: normalized.protocollo || normalized.protocolloLettoNelPdf,
        annoImposta: normalized.dataVersamento ? normalized.dataVersamento.getUTCFullYear() : normalized.annoElenco,
        datiEstratti: {
          f24SourceKey: normalized.sourceKey,
          saldoOperazione: normalized.saldoOperazione,
          saldoModello: normalized.saldoModello,
          indicePortale: normalized.indicePortale,
          numeroModelloNelGruppo: normalized.numeroModelloNelGruppo
        },
        aggiornatoIl: now
      };

      const source = normalized.urlSorgente
        ? { tipo: 'CASSETTO_FISCALE', riferimento: normalized.urlSorgente }
        : { tipo: 'DRIVE_INDICE_F24', riferimento: normalized.file || normalized.sourceKey };

      await db.collection('documenti').updateOne(
        documentFilter,
        {
          $set: document,
          $addToSet: { fonti: source },
          $setOnInsert: { creatoIl: now }
        },
        { upsert: true }
      );
      const savedDocument = await db.collection('documenti').findOne(documentFilter);
      documentoId = savedDocument?._id || null;
      if (documentoId) {
        await ensureDomainRelation(db, 'F24', f24._id, 'DOCUMENTO', documentoId, 'DOCUMENTATO_DA');
      }
    }

    risultati.push({ f24Id: f24._id, documentoId, sourceKey: normalized.sourceKey, stato: f24.stato });
  }

  return risultati;
}
