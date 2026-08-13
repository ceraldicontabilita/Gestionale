import { ObjectId } from 'mongodb';
import { relationKey } from './domain.js';
import {
  calculateF24Totals,
  classificationFromRegistry,
  normalizeF24Row,
  parseQuietanzaText,
  registryNamespaceForSection
} from './f24.js';
import { ensureF24Indexes, importF24IndexRows } from './f24-import-service.js';
import { roundMoney } from './money.js';
import { withMongoTransaction } from './mongo-transaction.js';

const readyDatabases = new WeakSet();

function parseId(value, label = 'ID') {
  if (!ObjectId.isValid(value)) throw new Error(`${label} non valido`);
  return new ObjectId(value);
}

function transactionStatus(error) {
  return /Transaction numbers|replica set|mongos/i.test(error.message) ? 503 : 400;
}

function inValidity(record, date) {
  const when = date ? new Date(date) : new Date();
  return record.validoDal <= when && (!record.validoAl || record.validoAl >= when);
}

function paymentCause(link) {
  return [link?.a, link?.b].find((endpoint) => endpoint?.tipo && endpoint.tipo !== 'MOVIMENTO') || null;
}

export function registerF24Routes(app, { getDb, getClient }) {
  function requireDb(res) {
    const db = getDb();
    if (!db) {
      res.status(503).json({ error: 'MongoDB non configurato' });
      return null;
    }
    return db;
  }

  async function ready(db) {
    if (readyDatabases.has(db)) return;
    await ensureF24Indexes(db);
    await Promise.all([
      db.collection('f24_operazioni').createIndex({ dataVersamento: -1, annoElenco: -1 }),
      db.collection('f24_righe').createIndex({ f24Id: 1, progressivo: 1 }, { unique: true }),
      db.collection('f24_righe').createIndex({ namespace: 1, codice: 1 }),
      db.collection('tributi_registro').createIndex({ namespace: 1, codice: 1, validoDal: 1 }, { unique: true })
    ]);
    readyDatabases.add(db);
  }

  async function ensureRelation(db, aTipo, aId, bTipo, bId, relazione, session) {
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

  async function findRegistryEntry(db, row, referenceDate = new Date(), session = null) {
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
    }, { sort: { validoDal: -1 }, ...(session ? { session } : {}) });
  }

  async function refreshF24UnknownCount(db, f24Id, session) {
    const unknown = await db.collection('f24_righe').countDocuments(
      { f24Id, 'classificazione.stato': { $ne: 'CLASSIFICATO' } },
      session ? { session } : {}
    );
    await db.collection('f24_operazioni').updateOne(
      { _id: f24Id },
      { $set: { codiciDaVerificare: unknown, aggiornatoIl: new Date() } },
      session ? { session } : {}
    );
    return unknown;
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

  app.get('/api/f24-quietanze', async (req, res) => {
    try {
      const db = requireDb(res); if (!db) return;
      await ready(db);
      const filter = {};
      if (req.query.anno) filter.annoElenco = Number(req.query.anno);
      const rows = await db.collection('quietanze_f24').find(filter).sort({ dataVersamento: -1, protocollo: 1 }).limit(500).toArray();
      res.json(rows);
    } catch (error) { res.status(400).json({ error: error.message }); }
  });

  app.get('/api/f24/:id', async (req, res) => {
    try {
      const db = requireDb(res); if (!db) return;
      await ready(db);
      const _id = parseId(req.params.id, 'ID F24');
      const f24 = await db.collection('f24_operazioni').findOne({ _id });
      if (!f24) return res.status(404).json({ error: 'F24 non trovato' });
      const [righe, collegamenti] = await Promise.all([
        db.collection('f24_righe').find({ f24Id: _id }).sort({ progressivo: 1 }).toArray(),
        db.collection('collegamenti').find({
          $or: [{ 'a.tipo': 'F24', 'a.id': String(_id) }, { 'b.tipo': 'F24', 'b.id': String(_id) }]
        }).toArray()
      ]);
      res.json({ ...f24, righe, collegamenti, totaliRighe: calculateF24Totals(righe) });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });

  app.post('/api/f24/importa-indice', async (req, res) => {
    try {
      const db = requireDb(res); if (!db) return;
      await ready(db);
      const inputRows = Array.isArray(req.body.righe) ? req.body.righe : [req.body.riga || req.body];
      const risultati = await importF24IndexRows(db, inputRows, {
        fonteIndice: req.body.fonteIndice || 'DRIVE_INDICE_F24'
      });
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
      const client = getClient();
      await ready(db);
      const f24Id = parseId(req.params.id, 'ID F24');
      const inputRows = Array.isArray(req.body.righe) ? req.body.righe : [];
      const result = await withMongoTransaction(client, async (session) => {
        const f24 = await db.collection('f24_operazioni').findOne({ _id: f24Id }, { session });
        if (!f24) throw Object.assign(new Error('F24 non trovato'), { code: 'NOT_FOUND' });
        const normalized = [];
        for (let i = 0; i < inputRows.length; i += 1) {
          const base = normalizeF24Row(inputRows[i]);
          const registry = await findRegistryEntry(db, base, f24.dataVersamento || new Date(), session);
          normalized.push({ ...normalizeF24Row(inputRows[i], registry), f24Id, progressivo: i + 1, aggiornatoIl: new Date() });
        }
        await db.collection('f24_righe').deleteMany({ f24Id }, { session });
        if (normalized.length) await db.collection('f24_righe').insertMany(normalized, { session });
        const totals = calculateF24Totals(normalized);
        const unknown = normalized.filter((row) => row.classificazione?.stato !== 'CLASSIFICATO').length;
        const saldoIndice = Number(f24.saldoModello ?? f24.saldoOperazione ?? 0);
        const deltaSaldo = roundMoney(totals.saldo - saldoIndice);
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
          },
          { session }
        );
        return { righe: normalized.length, codiciDaVerificare: unknown, totali: totals, differenzaSaldo: deltaSaldo };
      });
      res.json({ ok: true, ...result });
    } catch (error) {
      if (error.code === 'NOT_FOUND') return res.status(404).json({ error: error.message });
      res.status(transactionStatus(error)).json({ error: error.message });
    }
  });

  app.get('/api/tributi', async (req, res) => {
    try {
      const db = requireDb(res); if (!db) return;
      await ready(db);
      const filter = {};
      if (req.query.namespace) filter.namespace = String(req.query.namespace).toUpperCase();
      if (req.query.codice) filter.codice = String(req.query.codice).toUpperCase();
      const observedMatch = { attivo: true, codice: { $nin: [null, ''] } };
      if (filter.namespace) observedMatch.namespace = filter.namespace;
      if (filter.codice) observedMatch.codice = filter.codice;
      const [registered, observed] = await Promise.all([
        db.collection('tributi_registro').find(filter).sort({ namespace: 1, codice: 1, validoDal: -1 }).limit(1000).toArray(),
        db.collection('f24_righe_indice').aggregate([
          { $match: observedMatch },
          { $group: {
            _id: { namespace: '$namespace', codice: '$codice' },
            occurrences: { $sum: 1 },
            descriptions: { $addToSet: '$descrizioneIndice' },
            sections: { $addToSet: '$sezione' },
            lastObservedAt: { $max: '$aggiornatoIl' }
          } },
          { $sort: { '_id.namespace': 1, '_id.codice': 1 } },
          { $limit: 2000 }
        ]).toArray()
      ]);
      const observedByKey = new Map(observed.map((row) => [`${row._id.namespace}:${row._id.codice}`, row]));
      const registeredKeys = new Set(registered.map((row) => `${row.namespace}:${row.codice}`));
      const rows = registered.map((row) => {
        const source = observedByKey.get(`${row.namespace}:${row.codice}`);
        return { ...row, registryStatus: 'CLASSIFICATO_DA_FONTE_VERIFICATA', occurrences: source?.occurrences || 0, observedSections: source?.sections?.filter(Boolean) || [] };
      });
      for (const source of observed) {
        const key = `${source._id.namespace}:${source._id.codice}`;
        if (registeredKeys.has(key)) continue;
        rows.push({
          namespace: source._id.namespace,
          codice: source._id.codice,
          descrizione: source.descriptions.find((value) => String(value || '').trim()) || 'Descrizione non presente nell indice',
          natura: null,
          conto: null,
          fonte: 'INDICE_DOCUMENTALE_DRIVE',
          verificatoIl: null,
          lastObservedAt: source.lastObservedAt || null,
          registryStatus: 'OSSERVATO_DA_CLASSIFICARE',
          occurrences: source.occurrences,
          observedSections: source.sections.filter(Boolean)
        });
      }
      rows.sort((left, right) => `${left.namespace}:${left.codice}`.localeCompare(`${right.namespace}:${right.codice}`));
      res.json(rows);
    } catch (error) { res.status(400).json({ error: error.message }); }
  });

  app.post('/api/tributi', async (req, res) => {
    try {
      const db = requireDb(res); if (!db) return;
      const client = getClient();
      await ready(db);
      const namespace = String(req.body.namespace || 'CODICE_TRIBUTO_AE').toUpperCase();
      const codice = String(req.body.codice || '').trim().toUpperCase();
      const descrizione = String(req.body.descrizione || '').trim();
      const fonte = String(req.body.fonte || '').trim();
      if (!['CODICE_TRIBUTO_AE', 'CAUSALE_INPS', 'CAUSALE_INAIL'].includes(namespace)) throw new Error('Tipo registro non valido');
      if (!codice || !descrizione || !fonte) throw new Error('Codice, descrizione e fonte sono obbligatori');
      const validoDal = req.body.validoDal ? new Date(req.body.validoDal) : new Date('1900-01-01T00:00:00.000Z');
      const validoAl = req.body.validoAl ? new Date(req.body.validoAl) : null;
      if (Number.isNaN(validoDal.getTime()) || (validoAl && Number.isNaN(validoAl.getTime()))) throw new Error('Validità registro non valida');
      if (validoAl && validoAl < validoDal) throw new Error('Intervallo di validità non valido');
      const now = new Date();
      const result = await withMongoTransaction(client, async (session) => {
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
          { upsert: true, session }
        );
        const saved = await db.collection('tributi_registro').findOne({ namespace, codice, validoDal }, { session });
        const rows = await db.collection('f24_righe').find({ namespace, codice }, { session }).limit(5000).toArray();
        const f24Ids = [...new Set(rows.map((row) => String(row.f24Id)))].filter(ObjectId.isValid).map((id) => new ObjectId(id));
        const f24Docs = f24Ids.length
          ? await db.collection('f24_operazioni').find({ _id: { $in: f24Ids } }, { session }).toArray()
          : [];
        const dates = new Map(f24Docs.map((f24) => [String(f24._id), f24.dataVersamento || f24.creatoIl || now]));
        const affected = new Set();
        const operations = [];
        for (const row of rows) {
          if (!inValidity(saved, dates.get(String(row.f24Id)))) continue;
          operations.push({
            updateOne: {
              filter: { _id: row._id },
              update: { $set: { classificazione: classificationFromRegistry(saved), aggiornatoIl: now } }
            }
          });
          affected.add(String(row.f24Id));
        }
        if (operations.length) await db.collection('f24_righe').bulkWrite(operations, { session });
        for (const id of affected) await refreshF24UnknownCount(db, new ObjectId(id), session);
        return { saved, riclassificate: operations.length, f24Aggiornati: affected.size };
      });
      res.status(201).json({ ...result.saved, riclassificate: result.riclassificate, f24Aggiornati: result.f24Aggiornati });
    } catch (error) { res.status(transactionStatus(error)).json({ error: error.message }); }
  });

  app.post('/api/f24/:id/riconcilia', async (req, res) => {
    try {
      const db = requireDb(res); if (!db) return;
      const client = getClient();
      await ready(db);
      const f24Id = parseId(req.params.id, 'ID F24');
      const movimentoId = parseId(req.body.movimentoId, 'ID movimento');
      const result = await withMongoTransaction(client, async (session) => {
        const [f24, movimento] = await Promise.all([
          db.collection('f24_operazioni').findOne({ _id: f24Id }, { session }),
          db.collection('movimenti').findOne({ _id: movimentoId }, { session })
        ]);
        if (!f24) throw Object.assign(new Error('F24 non trovato'), { code: 'F24_NOT_FOUND' });
        if (!movimento) throw Object.assign(new Error('Movimento finanziario non trovato'), { code: 'MOVEMENT_NOT_FOUND' });
        if (f24.stato === 'COMPENSATO' || Number(f24.saldoModello ?? f24.saldoOperazione ?? 0) === 0) {
          throw Object.assign(new Error('F24 a saldo zero: non richiede un addebito finanziario'), { code: 'F24_COMPENSATO' });
        }
        if (!['BANCA', 'MASTERCARD'].includes(movimento.conto) || movimento.direzione !== 'USCITA') {
          throw Object.assign(new Error('La riconciliazione F24 richiede un vero addebito Banca o Mastercard'), { code: 'INVALID_MOVEMENT' });
        }
        const evidenceTypes = movimento.conto === 'BANCA'
          ? new Set(['ESTRATTO_CONTO', 'MOVIMENTO_BANCARIO'])
          : new Set(['ESTRATTO_CARTA', 'MOVIMENTO_CARTA']);
        const realEvidence = (movimento.evidenze || []).some((e) => e.reale && e.riferimento && evidenceTypes.has(e.tipo));
        if (!realEvidence) throw Object.assign(new Error('Il movimento non dispone di una prova finanziaria reale compatibile'), { code: 'NO_REAL_EVIDENCE' });

        const group = f24.operationKey
          ? await db.collection('f24_operazioni').find({ operationKey: f24.operationKey }, { session }).sort({ numeroModelloNelGruppo: 1 }).toArray()
          : [f24];
        const amount = roundMoney(movimento.importo);
        const singleExpected = roundMoney(Math.abs(Number(f24.saldoModello ?? f24.saldoOperazione ?? 0)));
        const groupExpected = roundMoney(Math.abs(Number(f24.saldoOperazione ?? group.reduce((sum, item) => sum + Number(item.saldoModello || 0), 0))));
        const groupComplete = group.length >= Number(f24.numeroModelliF24 || 1);
        let targets;
        let expected;
        if (group.length > 1 && groupComplete && Math.abs(amount - groupExpected) <= 0.01) {
          targets = group;
          expected = groupExpected;
        } else if (Math.abs(amount - singleExpected) <= 0.01) {
          targets = [f24];
          expected = singleExpected;
        } else {
          throw Object.assign(new Error(`Importo non coerente con F24: movimento ${amount.toFixed(2)}, atteso ${singleExpected.toFixed(2)}${group.length > 1 ? ` o operazione ${groupExpected.toFixed(2)}` : ''}`), { code: 'AMOUNT_MISMATCH' });
        }

        const targetIds = new Set(targets.map((item) => String(item._id)));
        const movementLinks = await db.collection('collegamenti').find({
          relazione: 'PAGATO_DA',
          $or: [
            { 'a.tipo': 'MOVIMENTO', 'a.id': String(movimentoId) },
            { 'b.tipo': 'MOVIMENTO', 'b.id': String(movimentoId) }
          ]
        }, { session }).toArray();
        for (const link of movementLinks) {
          const cause = paymentCause(link);
          const allowed = cause?.tipo === 'F24' && targetIds.has(cause.id);
          if (cause && !allowed) {
            throw Object.assign(new Error('Il movimento è già assegnato a un’altra causa amministrativa'), { code: 'MOVEMENT_ALREADY_LINKED' });
          }
        }

        for (const target of targets) {
          const links = await db.collection('collegamenti').find({
            relazione: 'PAGATO_DA',
            $or: [
              { 'a.tipo': 'F24', 'a.id': String(target._id) },
              { 'b.tipo': 'F24', 'b.id': String(target._id) }
            ]
          }, { session }).toArray();
          const otherMovement = links.some((link) => {
            const endpoint = link.a.tipo === 'MOVIMENTO' ? link.a : link.b.tipo === 'MOVIMENTO' ? link.b : null;
            return endpoint && endpoint.id !== String(movimentoId);
          });
          if (otherMovement) throw Object.assign(new Error('Uno dei modelli F24 è già collegato a un altro movimento'), { code: 'F24_ALREADY_LINKED' });
        }

        const now = new Date();
        for (const target of targets) {
          await ensureRelation(db, 'F24', target._id, 'MOVIMENTO', movimentoId, 'PAGATO_DA', session);
          await db.collection('f24_operazioni').updateOne(
            { _id: target._id },
            {
              $set: {
                stato: 'RICONCILIATO',
                pagamento: {
                  movimentoId,
                  importoMovimento: amount,
                  quotaModello: Number(target.saldoModello ?? 0),
                  operationKey: target.operationKey || null,
                  riconciliatoIl: now
                },
                aggiornatoIl: now
              }
            },
            { session }
          );
        }
        return { stato: 'RICONCILIATO', modelliRiconciliati: targets.length, importo: amount, atteso: expected };
      });
      res.json({ ok: true, ...result });
    } catch (error) {
      if (['F24_NOT_FOUND', 'MOVEMENT_NOT_FOUND'].includes(error.code)) return res.status(404).json({ error: error.message });
      if (['F24_COMPENSATO', 'INVALID_MOVEMENT', 'NO_REAL_EVIDENCE', 'AMOUNT_MISMATCH', 'MOVEMENT_ALREADY_LINKED', 'F24_ALREADY_LINKED'].includes(error.code)) {
        return res.status(409).json({ error: error.message });
      }
      res.status(transactionStatus(error)).json({ error: error.message });
    }
  });
}
