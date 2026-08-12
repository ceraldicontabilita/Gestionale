import { ObjectId } from 'mongodb';
import { relationKey } from './domain.js';
import {
  normalizeAderSnapshot,
  normalizeRiscossioneAtto,
  recognizeRiscossioneText,
  snapshotSummary
} from './riscossione.js';
import { withMongoTransaction } from './mongo-transaction.js';

const readyDatabases = new WeakSet();

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function transactionStatus(error) {
  return /Transaction numbers|replica set|mongos/i.test(error.message) ? 503 : 400;
}

export function registerRiscossioneRoutes(app, { getDb, getClient }) {
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
    await Promise.all([
      db.collection('atti_riscossione').createIndex({ tipo: 1, stato: 1, dataAtto: -1 }),
      db.collection('atti_riscossione').createIndex({ tipo: 1, numeroAtto: 1 }, { unique: true, sparse: true }),
      db.collection('atti_riscossione').createIndex(
        { fonte: 1, fonteRiferimento: 1 },
        { unique: true, partialFilterExpression: { fonteRiferimento: { $type: 'string' } }, name: 'riscossione_source_unique' }
      ),
      db.collection('ader_snapshots').createIndex({ attoId: 1, sourceKey: 1 }, { unique: true }),
      db.collection('ader_snapshots').createIndex({ attoId: 1, acquisitoIl: -1 }),
      db.collection('collegamenti').createIndex({ relationKey: 1 }, { unique: true })
    ]);
    readyDatabases.add(db);
  }

  function parseId(value, label = 'ID') {
    if (!ObjectId.isValid(value)) throw new Error(`${label} non valido`);
    return new ObjectId(value);
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

  app.get('/api/riscossione/atti', async (req, res) => {
    try {
      const db = requireDb(res); if (!db) return;
      await ready(db);
      const filter = {};
      if (req.query.tipo) filter.tipo = String(req.query.tipo).toUpperCase();
      if (req.query.stato) filter.stato = String(req.query.stato).toUpperCase();
      const rows = await db.collection('atti_riscossione').find(filter).sort({ dataNotifica: -1, dataAtto: -1, creatoIl: -1 }).limit(500).toArray();
      res.json(rows);
    } catch (error) { res.status(400).json({ error: error.message }); }
  });

  app.post('/api/riscossione/atti', async (req, res) => {
    try {
      const db = requireDb(res); if (!db) return;
      const client = getClient();
      await ready(db);
      const result = await withMongoTransaction(client, async (session) => {
        const atto = normalizeRiscossioneAtto(req.body);
        const filter = atto.numeroAtto
          ? { tipo: atto.tipo, numeroAtto: atto.numeroAtto }
          : { fonte: atto.fonte, fonteRiferimento: atto.fonteRiferimento };
        const { creatoIl, stato, ...mutable } = atto;
        const update = { ...mutable, aggiornatoIl: new Date() };
        if (hasOwn(req.body, 'stato')) update.stato = stato;
        await db.collection('atti_riscossione').updateOne(
          filter,
          { $set: update, $setOnInsert: { creatoIl, stato } },
          { upsert: true, session }
        );
        const saved = await db.collection('atti_riscossione').findOne(filter, { session });
        if (atto.documentoId) {
          await ensureRelation(db, 'RISCOSSIONE_ATTO', saved._id, 'DOCUMENTO', atto.documentoId, 'DOCUMENTATO_DA', session);
        }
        return saved;
      });
      res.status(201).json(result);
    } catch (error) { res.status(transactionStatus(error)).json({ error: error.message }); }
  });

  app.get('/api/riscossione/atti/:id', async (req, res) => {
    try {
      const db = requireDb(res); if (!db) return;
      await ready(db);
      const attoId = parseId(req.params.id, 'ID atto');
      const atto = await db.collection('atti_riscossione').findOne({ _id: attoId });
      if (!atto) return res.status(404).json({ error: 'Atto non trovato' });
      const [snapshots, collegamenti] = await Promise.all([
        db.collection('ader_snapshots').find({ attoId }).sort({ acquisitoIl: -1, _id: -1 }).toArray(),
        db.collection('collegamenti').find({
          $or: [
            { 'a.tipo': 'RISCOSSIONE_ATTO', 'a.id': String(attoId) },
            { 'b.tipo': 'RISCOSSIONE_ATTO', 'b.id': String(attoId) }
          ]
        }).toArray()
      ]);
      res.json({ ...atto, snapshots, ultimoSnapshot: snapshotSummary(snapshots), collegamenti });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });

  app.post('/api/riscossione/riconosci', async (req, res) => {
    try {
      const testo = String(req.body.testo || '');
      if (!testo) throw new Error('Testo documento mancante');
      res.json(recognizeRiscossioneText(testo));
    } catch (error) { res.status(400).json({ error: error.message }); }
  });

  app.post('/api/riscossione/atti/:id/snapshot', async (req, res) => {
    try {
      const db = requireDb(res); if (!db) return;
      const client = getClient();
      await ready(db);
      const attoId = parseId(req.params.id, 'ID atto');
      const saved = await withMongoTransaction(client, async (session) => {
        const atto = await db.collection('atti_riscossione').findOne({ _id: attoId }, { session });
        if (!atto) throw Object.assign(new Error('Atto non trovato'), { code: 'NOT_FOUND' });
        const snapshot = normalizeAderSnapshot(req.body);
        const { creatoIl, ...mutable } = snapshot;
        await db.collection('ader_snapshots').updateOne(
          { attoId, sourceKey: snapshot.sourceKey },
          { $set: { ...mutable, attoId }, $setOnInsert: { creatoIl } },
          { upsert: true, session }
        );
        const current = await db.collection('ader_snapshots').findOne({ attoId, sourceKey: snapshot.sourceKey }, { session });
        if (snapshot.documentoId) {
          await ensureRelation(db, 'RISCOSSIONE_ATTO', attoId, 'DOCUMENTO', snapshot.documentoId, 'AGGIORNATO_DA_SNAPSHOT', session);
        }
        const latest = await db.collection('ader_snapshots').find({ attoId }, { session }).sort({ acquisitoIl: -1, _id: -1 }).limit(1).next();
        const summary = snapshotSummary(latest ? [latest] : []);
        await db.collection('atti_riscossione').updateOne(
          { _id: attoId },
          {
            $set: {
              ultimoSnapshot: summary,
              ultimoSnapshotId: latest?._id || null,
              aggiornatoIl: new Date()
            }
          },
          { session }
        );
        return current;
      });
      res.status(201).json(saved);
    } catch (error) {
      if (error.code === 'NOT_FOUND') return res.status(404).json({ error: error.message });
      res.status(transactionStatus(error)).json({ error: error.message });
    }
  });

  app.post('/api/riscossione/atti/:id/collega-movimento', async (req, res) => {
    try {
      const db = requireDb(res); if (!db) return;
      const client = getClient();
      await ready(db);
      const attoId = parseId(req.params.id, 'ID atto');
      const movimentoId = parseId(req.body.movimentoId, 'ID movimento');
      const result = await withMongoTransaction(client, async (session) => {
        const [atto, movimento] = await Promise.all([
          db.collection('atti_riscossione').findOne({ _id: attoId }, { session }),
          db.collection('movimenti').findOne({ _id: movimentoId }, { session })
        ]);
        if (!atto) throw Object.assign(new Error('Atto non trovato'), { code: 'ATTO_NOT_FOUND' });
        if (!movimento) throw Object.assign(new Error('Movimento non trovato'), { code: 'MOVEMENT_NOT_FOUND' });
        if (!['BANCA', 'MASTERCARD'].includes(movimento.conto) || movimento.direzione !== 'USCITA') {
          throw Object.assign(new Error('Il pagamento della riscossione richiede un vero addebito Banca o Mastercard'), { code: 'INVALID_MOVEMENT' });
        }
        const evidenceTypes = movimento.conto === 'BANCA'
          ? new Set(['ESTRATTO_CONTO', 'MOVIMENTO_BANCARIO'])
          : new Set(['ESTRATTO_CARTA', 'MOVIMENTO_CARTA']);
        const provaReale = (movimento.evidenze || []).some((e) => e.reale && e.riferimento && evidenceTypes.has(e.tipo));
        if (!provaReale) throw Object.assign(new Error('Il movimento non dispone di prova finanziaria reale compatibile'), { code: 'NO_REAL_EVIDENCE' });

        const existingLinks = await db.collection('collegamenti').find({
          relazione: 'PAGATO_DA',
          $or: [
            { 'a.tipo': 'MOVIMENTO', 'a.id': String(movimentoId) },
            { 'b.tipo': 'MOVIMENTO', 'b.id': String(movimentoId) }
          ]
        }, { session }).toArray();
        const linkedElsewhere = existingLinks.some((link) => {
          const endpoint = link.a.tipo === 'RISCOSSIONE_ATTO' ? link.a : link.b.tipo === 'RISCOSSIONE_ATTO' ? link.b : null;
          return endpoint && endpoint.id !== String(attoId);
        });
        if (linkedElsewhere) throw Object.assign(new Error('Il movimento è già collegato a un altro atto della riscossione'), { code: 'MOVEMENT_ALREADY_LINKED' });

        await ensureRelation(db, 'RISCOSSIONE_ATTO', attoId, 'MOVIMENTO', movimentoId, 'PAGATO_DA', session);
        const links = await db.collection('collegamenti').find({
          relazione: 'PAGATO_DA',
          $or: [
            { 'a.tipo': 'RISCOSSIONE_ATTO', 'a.id': String(attoId) },
            { 'b.tipo': 'RISCOSSIONE_ATTO', 'b.id': String(attoId) }
          ]
        }, { session }).toArray();
        const ids = links.map((link) => link.a.tipo === 'MOVIMENTO' ? link.a.id : link.b.id)
          .filter(ObjectId.isValid).map((id) => new ObjectId(id));
        const movimenti = ids.length ? await db.collection('movimenti').find({ _id: { $in: ids } }, { session }).toArray() : [];
        const totalePagamentiCollegati = Math.round(movimenti.reduce((sum, row) => sum + Number(row.importo || 0), 0) * 100) / 100;
        await db.collection('atti_riscossione').updateOne(
          { _id: attoId },
          { $set: { totalePagamentiCollegati, aggiornatoIl: new Date() } },
          { session }
        );
        return { totalePagamentiCollegati };
      });
      res.json({
        ok: true,
        ...result,
        nota: 'Il residuo ADER non viene modificato: si aggiorna solo con un nuovo snapshot ufficiale.'
      });
    } catch (error) {
      if (['ATTO_NOT_FOUND', 'MOVEMENT_NOT_FOUND'].includes(error.code)) return res.status(404).json({ error: error.message });
      if (['INVALID_MOVEMENT', 'NO_REAL_EVIDENCE', 'MOVEMENT_ALREADY_LINKED'].includes(error.code)) return res.status(409).json({ error: error.message });
      res.status(transactionStatus(error)).json({ error: error.message });
    }
  });

  app.get('/api/riscossione/controlli', async (_req, res) => {
    try {
      const db = requireDb(res); if (!db) return;
      await ready(db);
      const now = new Date();
      const [daVerificare, senzaSnapshot, scadutiAperti] = await Promise.all([
        db.collection('atti_riscossione').countDocuments({ stato: 'DA_VERIFICARE' }),
        db.collection('atti_riscossione').countDocuments({ $or: [{ ultimoSnapshot: { $exists: false } }, { ultimoSnapshot: null }] }),
        db.collection('atti_riscossione').countDocuments({ scadenza: { $lt: now }, stato: { $nin: ['PAGATO', 'ANNULLATO'] } })
      ]);
      res.json({ daVerificare, senzaSnapshot, scadutiAperti });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });
}
