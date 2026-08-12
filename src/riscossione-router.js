import { ObjectId } from 'mongodb';
import { relationKey } from './domain.js';
import {
  normalizeAderSnapshot,
  normalizeRiscossioneAtto,
  recognizeRiscossioneText,
  snapshotSummary
} from './riscossione.js';

let indexesReady = false;

export function registerRiscossioneRoutes(app, getDb) {
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
      db.collection('atti_riscossione').createIndex({ tipo: 1, stato: 1, dataAtto: -1 }),
      db.collection('atti_riscossione').createIndex({ numeroAtto: 1 }, { sparse: true }),
      db.collection('atti_riscossione').createIndex({ fonte: 1, fonteRiferimento: 1 }, { sparse: true }),
      db.collection('ader_snapshots').createIndex({ attoId: 1, sourceKey: 1 }, { unique: true }),
      db.collection('ader_snapshots').createIndex({ attoId: 1, acquisitoIl: -1 }),
      db.collection('collegamenti').createIndex({ relationKey: 1 }, { unique: true })
    ]);
    indexesReady = true;
  }

  function parseId(value, label = 'ID') {
    if (!ObjectId.isValid(value)) throw new Error(`${label} non valido`);
    return new ObjectId(value);
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
      await ready(db);
      const atto = normalizeRiscossioneAtto(req.body);
      const now = new Date();
      const filter = atto.numeroAtto
        ? { tipo: atto.tipo, numeroAtto: atto.numeroAtto }
        : { fonte: atto.fonte, fonteRiferimento: atto.fonteRiferimento };

      const { creatoIl, ...mutable } = atto;
      await db.collection('atti_riscossione').updateOne(
        filter,
        { $set: { ...mutable, aggiornatoIl: now }, $setOnInsert: { creatoIl } },
        { upsert: true }
      );
      const saved = await db.collection('atti_riscossione').findOne(filter);

      if (atto.documentoId) {
        await ensureRelation(db, 'RISCOSSIONE_ATTO', saved._id, 'DOCUMENTO', atto.documentoId, 'DOCUMENTATO_DA');
      }

      res.status(201).json(saved);
    } catch (error) { res.status(400).json({ error: error.message }); }
  });

  app.get('/api/riscossione/atti/:id', async (req, res) => {
    try {
      const db = requireDb(res); if (!db) return;
      await ready(db);
      const attoId = parseId(req.params.id, 'ID atto');
      const atto = await db.collection('atti_riscossione').findOne({ _id: attoId });
      if (!atto) return res.status(404).json({ error: 'Atto non trovato' });

      const [snapshots, collegamenti] = await Promise.all([
        db.collection('ader_snapshots').find({ attoId }).sort({ acquisitoIl: -1 }).toArray(),
        db.collection('collegamenti').find({
          $or: [
            { 'a.tipo': 'RISCOSSIONE_ATTO', 'a.id': String(attoId) },
            { 'b.tipo': 'RISCOSSIONE_ATTO', 'b.id': String(attoId) }
          ]
        }).toArray()
      ]);

      res.json({
        ...atto,
        snapshots,
        ultimoSnapshot: snapshotSummary(snapshots),
        collegamenti
      });
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
      await ready(db);
      const attoId = parseId(req.params.id, 'ID atto');
      const atto = await db.collection('atti_riscossione').findOne({ _id: attoId });
      if (!atto) return res.status(404).json({ error: 'Atto non trovato' });

      const snapshot = normalizeAderSnapshot(req.body);
      const record = { ...snapshot, attoId };
      await db.collection('ader_snapshots').updateOne(
        { attoId, sourceKey: snapshot.sourceKey },
        { $set: record },
        { upsert: true }
      );
      const saved = await db.collection('ader_snapshots').findOne({ attoId, sourceKey: snapshot.sourceKey });

      if (snapshot.documentoId) {
        await ensureRelation(db, 'RISCOSSIONE_ATTO', attoId, 'DOCUMENTO', snapshot.documentoId, 'AGGIORNATO_DA_SNAPSHOT');
      }

      await db.collection('atti_riscossione').updateOne(
        { _id: attoId },
        {
          $set: {
            ultimoSnapshot: {
              snapshotId: saved._id,
              acquisitoIl: saved.acquisitoIl,
              importoResiduo: saved.importoResiduo,
              statoAder: saved.statoAder
            },
            aggiornatoIl: new Date()
          }
        }
      );

      res.status(201).json(saved);
    } catch (error) { res.status(400).json({ error: error.message }); }
  });

  app.post('/api/riscossione/atti/:id/collega-movimento', async (req, res) => {
    try {
      const db = requireDb(res); if (!db) return;
      await ready(db);
      const attoId = parseId(req.params.id, 'ID atto');
      const movimentoId = parseId(req.body.movimentoId, 'ID movimento');
      const [atto, movimento] = await Promise.all([
        db.collection('atti_riscossione').findOne({ _id: attoId }),
        db.collection('movimenti').findOne({ _id: movimentoId })
      ]);
      if (!atto) return res.status(404).json({ error: 'Atto non trovato' });
      if (!movimento) return res.status(404).json({ error: 'Movimento non trovato' });
      if (!['BANCA', 'MASTERCARD'].includes(movimento.conto)) {
        return res.status(409).json({ error: 'Il pagamento della riscossione richiede un movimento Banca o Mastercard' });
      }
      if (movimento.direzione !== 'USCITA') {
        return res.status(409).json({ error: 'Il movimento collegato non è un addebito' });
      }
      const provaReale = movimento.stato === 'RICONCILIATO' || (movimento.evidenze || []).some((e) => e.reale);
      if (!provaReale) {
        return res.status(409).json({ error: 'Il movimento non dispone ancora di prova finanziaria reale' });
      }

      await ensureRelation(db, 'RISCOSSIONE_ATTO', attoId, 'MOVIMENTO', movimentoId, 'PAGATO_DA');

      const links = await db.collection('collegamenti').find({
        relazione: 'PAGATO_DA',
        $or: [
          { 'a.tipo': 'RISCOSSIONE_ATTO', 'a.id': String(attoId) },
          { 'b.tipo': 'RISCOSSIONE_ATTO', 'b.id': String(attoId) }
        ]
      }).toArray();
      const ids = links.map((link) => link.a.tipo === 'MOVIMENTO' ? link.a.id : link.b.id).filter(ObjectId.isValid).map((id) => new ObjectId(id));
      const movimenti = ids.length ? await db.collection('movimenti').find({ _id: { $in: ids } }).toArray() : [];
      const totalePagamentiCollegati = Math.round(movimenti.reduce((sum, row) => sum + Number(row.importo || 0), 0) * 100) / 100;

      await db.collection('atti_riscossione').updateOne(
        { _id: attoId },
        { $set: { totalePagamentiCollegati, aggiornatoIl: new Date() } }
      );

      res.json({
        ok: true,
        totalePagamentiCollegati,
        nota: 'Il residuo ADER non viene modificato: si aggiorna solo con un nuovo snapshot ufficiale.'
      });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });

  app.get('/api/riscossione/controlli', async (_req, res) => {
    try {
      const db = requireDb(res); if (!db) return;
      await ready(db);
      const now = new Date();
      const [daVerificare, senzaSnapshot, scadutiAperti] = await Promise.all([
        db.collection('atti_riscossione').countDocuments({ stato: 'DA_VERIFICARE' }),
        db.collection('atti_riscossione').countDocuments({ $or: [{ ultimoSnapshot: { $exists: false } }, { ultimoSnapshot: null }] }),
        db.collection('atti_riscossione').countDocuments({
          scadenza: { $lt: now },
          stato: { $nin: ['PAGATO', 'ANNULLATO'] }
        })
      ]);
      res.json({ daVerificare, senzaSnapshot, scadutiAperti });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });
}
