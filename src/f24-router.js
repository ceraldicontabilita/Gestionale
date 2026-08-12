import { ObjectId } from 'mongodb';
import { relationKey } from './domain.js';
import {
  buildF24FromIndexRow,
  calculateF24Totals,
  normalizeF24Row,
  parseQuietanzaText,
  registryNamespaceForSection
} from './f24.js';

let indexesReady = false;

export function registerF24Routes(app, getDb) {
  function requireDb(res) {
    const db = getDb();
    if (!db) {
      res.status(503).json({ error: 'MongoDB non configurato' });
      return null;
    }
    return db;
  }

  async function ready(db) {
    if (indexesReady) return;
    await Promise.all([
      db.collection('f24_operazioni').createIndex({ sourceKey: 1 }, { unique: true }),
      db.collection('f24_operazioni').createIndex({ dataVersamento: -1, annoElenco: -1 }),
      db.collection('f24_righe').createIndex({ f24Id: 1, progressivo: 1 }, { unique: true }),
      db.collection('f24_righe').createIndex({ namespace: 1, codice: 1 }),
      db.collection('tributi_registro').createIndex({ namespace: 1, codice: 1, validoDal: 1 }, { unique: true }),
      db.collection('collegamenti').createIndex({ relationKey: 1 }, { unique: true })
    ]);
    indexesReady = true;
  }

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
    return key;
  }

  async function findRegistryEntry(db, row, referenceDate = new Date()) {
    const namespace = row.namespace || registryNamespaceForSection(row.sezione);
    const codice = String(row.codice || '').toUpperCase();
    if (!codice) return null;
    const when = referenceDate instanceof Date ? referenceDate : new Date(referenceDate);
    return db.collection('tributi_registro').findOne({
      namespace,
      codice,
      validoDal: { $lte: when },
      $or: [{ validoAl: null }, { validoAl: { $gte: when } }],
      attivo: { $ne: false }
    }, { sort: { validoDal: -1 } });
  }

  app.get('/api/f24', async (req, res) => {
    try {
      const db = requireDb(res); if (!db) return;
      await ready(db);
      const filter = {};
      if (req.query.anno) filter.annoElenco = Number(req.query.anno);
      if (req.query.stato) filter.stato = String(req.query.stato).toUpperCase();
      const rows = await db.collection('f24_operazioni').find(filter).sort({ dataVersamento: -1, indicePortale: -1 }).limit(500).toArray();
      res.json(rows);
    } catch (error) { res.status(400).json({ error: error.message }); }
  });

  app.get('/api/f24/:id', async (req, res) => {
    try {
      const db = requireDb(res); if (!db) return;
      await ready(db);
      if (!ObjectId.isValid(req.params.id)) throw new Error('ID F24 non valido');
      const _id = new ObjectId(req.params.id);
      const f24 = await db.collection('f24_operazioni').findOne({ _id });
      if (!f24) return res.status(404).json({ error: 'F24 non trovato' });
      const righe = await db.collection('f24_righe').find({ f24Id: _id }).sort({ progressivo: 1 }).toArray();
      const collegamenti = await db.collection('collegamenti').find({
        $or: [{ 'a.tipo': 'F24', 'a.id': String(_id) }, { 'b.tipo': 'F24', 'b.id': String(_id) }]
      }).toArray();
      res.json({ ...f24, righe, collegamenti, totaliRighe: calculateF24Totals(righe) });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });

  app.post('/api/f24/importa-indice', async (req, res) => {
    try {
      const db = requireDb(res); if (!db) return;
      await ready(db);
      const inputRows = Array.isArray(req.body.righe) ? req.body.righe : [req.body.riga || req.body];
      if (!inputRows.length) throw new Error('Nessuna riga indice F24');
      const risultati = [];

      for (const input of inputRows) {
        const normalized = buildF24FromIndexRow(input);
        const now = new Date();
        const update = {
          ...normalized,
          fonteIndice: String(req.body.fonteIndice || input.fonteIndice || 'DRIVE_INDICE_F24').toUpperCase(),
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
          await db.collection('documenti').updateOne(
            documentFilter,
            {
              $set: document,
              $addToSet: { fonti: { tipo: 'CASSETTO_FISCALE', riferimento: normalized.urlSorgente, rilevataIl: now } },
              $setOnInsert: { creatoIl: now }
            },
            { upsert: true }
          );
          const savedDocument = await db.collection('documenti').findOne(documentFilter);
          documentoId = savedDocument?._id || null;
          if (documentoId) await ensureRelation(db, 'F24', f24._id, 'DOCUMENTO', documentoId, 'DOCUMENTATO_DA');
        }

        risultati.push({ f24Id: f24._id, documentoId, sourceKey: normalized.sourceKey, stato: f24.stato });
      }
      res.status(201).json({ importati: risultati.length, risultati });
    } catch (error) {
      if (error?.code === 11000) return res.status(409).json({ error: 'Duplicato F24 non coerente con l’indice' });
      res.status(400).json({ error: error.message });
    }
  });

  app.post('/api/f24/analizza-quietanza', async (req, res) => {
    try {
      const text = String(req.body.testo || '');
      if (!text) throw new Error('Testo quietanza mancante');
      res.json(parseQuietanzaText(text));
    } catch (error) { res.status(400).json({ error: error.message }); }
  });

  app.put('/api/f24/:id/righe', async (req, res) => {
    try {
      const db = requireDb(res); if (!db) return;
      await ready(db);
      if (!ObjectId.isValid(req.params.id)) throw new Error('ID F24 non valido');
      const f24Id = new ObjectId(req.params.id);
      const f24 = await db.collection('f24_operazioni').findOne({ _id: f24Id });
      if (!f24) return res.status(404).json({ error: 'F24 non trovato' });
      const inputRows = Array.isArray(req.body.righe) ? req.body.righe : [];
      const normalized = [];

      for (let i = 0; i < inputRows.length; i += 1) {
        const base = normalizeF24Row(inputRows[i]);
        const registryEntry = await findRegistryEntry(db, base, f24.dataVersamento || new Date());
        normalized.push({
          ...normalizeF24Row(inputRows[i], registryEntry),
          f24Id,
          progressivo: i + 1,
          aggiornatoIl: new Date()
        });
      }

      await db.collection('f24_righe').deleteMany({ f24Id });
      if (normalized.length) await db.collection('f24_righe').insertMany(normalized);
      const totals = calculateF24Totals(normalized);
      const unknown = normalized.filter((row) => row.classificazione?.stato !== 'CLASSIFICATO').length;
      const saldoIndice = Number(f24.saldoModello ?? f24.saldoOperazione ?? 0);
      const deltaSaldo = Math.round((totals.saldo - saldoIndice) * 100) / 100;
      await db.collection('f24_operazioni').updateOne(
        { _id: f24Id },
        {
          $set: {
            totaliRighe: totals,
            codiciDaVerificare: unknown,
            controlloSaldo: {
              saldoIndice,
              saldoRighe: totals.saldo,
              differenza: deltaSaldo,
              stato: deltaSaldo === 0 ? 'ALLINEATO' : 'DIFFERENZA'
            },
            aggiornatoIl: new Date()
          }
        }
      );
      res.json({ ok: true, righe: normalized.length, codiciDaVerificare: unknown, totali: totals, differenzaSaldo: deltaSaldo });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });

  app.get('/api/tributi', async (req, res) => {
    try {
      const db = requireDb(res); if (!db) return;
      await ready(db);
      const filter = {};
      if (req.query.namespace) filter.namespace = String(req.query.namespace).toUpperCase();
      if (req.query.codice) filter.codice = String(req.query.codice).toUpperCase();
      const rows = await db.collection('tributi_registro').find(filter).sort({ namespace: 1, codice: 1, validoDal: -1 }).limit(1000).toArray();
      res.json(rows);
    } catch (error) { res.status(400).json({ error: error.message }); }
  });

  app.post('/api/tributi', async (req, res) => {
    try {
      const db = requireDb(res); if (!db) return;
      await ready(db);
      const namespace = String(req.body.namespace || 'CODICE_TRIBUTO_AE').toUpperCase();
      const codice = String(req.body.codice || '').trim().toUpperCase();
      const descrizione = String(req.body.descrizione || '').trim();
      const fonte = String(req.body.fonte || '').trim();
      if (!codice || !descrizione || !fonte) throw new Error('Codice, descrizione e fonte sono obbligatori');
      const validoDal = req.body.validoDal ? new Date(req.body.validoDal) : new Date('1900-01-01T00:00:00.000Z');
      const validoAl = req.body.validoAl ? new Date(req.body.validoAl) : null;
      const now = new Date();
      const record = {
        namespace,
        codice,
        descrizione,
        natura: req.body.natura ? String(req.body.natura).toUpperCase() : null,
        conto: req.body.conto ? String(req.body.conto).toUpperCase() : null,
        fonte,
        validoDal,
        validoAl,
        attivo: req.body.attivo !== false,
        verificatoIl: req.body.verificatoIl ? new Date(req.body.verificatoIl) : now,
        aggiornatoIl: now
      };
      await db.collection('tributi_registro').updateOne(
        { namespace, codice, validoDal },
        { $set: record, $setOnInsert: { creatoIl: now } },
        { upsert: true }
      );
      const saved = await db.collection('tributi_registro').findOne({ namespace, codice, validoDal });
      res.status(201).json(saved);
    } catch (error) { res.status(400).json({ error: error.message }); }
  });

  app.post('/api/f24/:id/riconcilia', async (req, res) => {
    try {
      const db = requireDb(res); if (!db) return;
      await ready(db);
      if (!ObjectId.isValid(req.params.id) || !ObjectId.isValid(req.body.movimentoId)) throw new Error('ID non valido');
      const f24Id = new ObjectId(req.params.id);
      const movimentoId = new ObjectId(req.body.movimentoId);
      const [f24, movimento] = await Promise.all([
        db.collection('f24_operazioni').findOne({ _id: f24Id }),
        db.collection('movimenti').findOne({ _id: movimentoId })
      ]);
      if (!f24) return res.status(404).json({ error: 'F24 non trovato' });
      if (!movimento) return res.status(404).json({ error: 'Movimento finanziario non trovato' });
      if (!['BANCA', 'MASTERCARD'].includes(movimento.conto)) {
        return res.status(409).json({ error: 'La riconciliazione F24 richiede un movimento Banca o Mastercard reale' });
      }
      if (movimento.direzione !== 'USCITA') return res.status(409).json({ error: 'Il movimento collegato non è un addebito' });
      const realEvidence = movimento.stato === 'RICONCILIATO' || (movimento.evidenze || []).some((e) => e.reale);
      if (!realEvidence) return res.status(409).json({ error: 'Il movimento non dispone ancora di prova finanziaria reale' });

      const atteso = Number(f24.saldoModello ?? f24.saldoOperazione ?? 0);
      const differenza = Math.round((Number(movimento.importo) - Math.abs(atteso)) * 100) / 100;
      if (Math.abs(differenza) > 0.01 && !req.body.forza) {
        return res.status(409).json({ error: `Importo non coerente con F24: differenza ${differenza.toFixed(2)}`, differenza });
      }

      await ensureRelation(db, 'F24', f24Id, 'MOVIMENTO', movimentoId, 'PAGATO_DA');
      await db.collection('f24_operazioni').updateOne(
        { _id: f24Id },
        {
          $set: {
            stato: 'RICONCILIATO',
            pagamento: { movimentoId, importo: movimento.importo, differenza, riconciliatoIl: new Date() },
            aggiornatoIl: new Date()
          }
        }
      );
      res.json({ ok: true, stato: 'RICONCILIATO', differenza });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });
}
