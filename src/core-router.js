import crypto from 'node:crypto';
import { ObjectId } from 'mongodb';
import {
  CONTI,
  STATI,
  buildLedger,
  canReconcile,
  normalizeMovement,
  relationKey
} from './domain.js';
import { parseMoney } from './money.js';
import {
  calculateClosingBalance,
  getOrCreateRiporto,
  startOfNextYear,
  startOfYear,
  validateYear
} from './ledger.js';

const readyDatabases = new WeakSet();

function parseId(value, label = 'ID') {
  if (!ObjectId.isValid(value)) throw new Error(`${label} non valido`);
  return new ObjectId(value);
}

function token(value, fallback = null) {
  const result = String(value || fallback || '').trim().toUpperCase();
  if (!result || !/^[A-Z0-9_:-]{1,80}$/.test(result)) throw new Error('Valore non valido');
  return result;
}

function text(value, max = 500) {
  const result = String(value ?? '').trim();
  if (result.length > max) throw new Error('Testo troppo lungo');
  return result || null;
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function normalizeSha(value) {
  if (!value) return null;
  const sha = String(value).trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha)) throw new Error('SHA-256 non valido');
  return sha;
}

async function ensureIndexes(db) {
  if (readyDatabases.has(db)) return;
  await Promise.all([
    db.collection('riporti').createIndex({ conto: 1, anno: 1 }, { unique: true }),
    db.collection('collegamenti').createIndex({ relationKey: 1 }, { unique: true }),
    db.collection('documenti').createIndex({ sha256: 1 }, { unique: true, sparse: true }),
    db.collection('documenti').createIndex({ primarySourceKey: 1 }, { unique: true, sparse: true }),
    db.collection('movimenti').createIndex({ conto: 1, data: 1, creatoIl: 1 }),
    db.collection('movimenti').createIndex({ proiezioneKey: 1 }, { unique: true, sparse: true })
  ]);
  readyDatabases.add(db);
}

function requireDb(getDb, res) {
  const db = getDb();
  if (!db) {
    res.status(503).json({ error: 'MongoDB non configurato' });
    return null;
  }
  return db;
}

export function registerCoreRoutes(app, { getDb }) {
  app.get('/api/config', (_req, res) => {
    res.json({ conti: CONTI, stati: STATI });
  });

  app.get('/api/prima-nota/:conto', async (req, res) => {
    try {
      const db = requireDb(getDb, res); if (!db) return;
      await ensureIndexes(db);
      const conto = token(req.params.conto);
      if (!CONTI.includes(conto)) throw new Error('Conto non valido');
      const anno = validateYear(req.query.anno || new Date().getUTCFullYear());
      const riporto = await getOrCreateRiporto(db, conto, anno);
      const rows = await db.collection('movimenti').find({
        conto,
        data: { $gte: startOfYear(anno), $lt: startOfNextYear(anno) }
      }).sort({ data: 1, creatoIl: 1, _id: 1 }).toArray();
      const ledger = buildLedger(rows, riporto, anno);
      res.json({
        conto,
        anno,
        riporto: {
          saldo: riporto.saldo,
          daRiallineare: riporto.daRiallineare,
          saldoAtteso: riporto.saldoAtteso,
          consolidato: Boolean(riporto.consolidato)
        },
        saldoFinale: ledger.at(-1)?.saldoProgressivo ?? riporto.saldo,
        righe: ledger
      });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.put('/api/riporti/:conto/:anno', async (req, res) => {
    try {
      const db = requireDb(getDb, res); if (!db) return;
      await ensureIndexes(db);
      const conto = token(req.params.conto);
      if (!CONTI.includes(conto)) throw new Error('Conto non valido');
      const anno = validateYear(req.params.anno);
      const saldo = parseMoney(req.body.saldo, { allowNegative: true, label: 'Saldo riporto' });
      if (saldo === null) throw new Error('Saldo riporto obbligatorio');
      const existing = await db.collection('riporti').findOne({ conto, anno });
      if (existing?.consolidato && !req.body.forza) {
        return res.status(409).json({ error: 'Riporto consolidato: modifica sensibile bloccata' });
      }
      const now = new Date();
      const update = {
        saldo,
        origine: token(req.body.origine, 'MANUALE'),
        aggiornatoIl: now
      };
      if (hasOwn(req.body, 'consolidato')) update.consolidato = Boolean(req.body.consolidato);
      await db.collection('riporti').updateOne(
        { conto, anno },
        { $set: update, $setOnInsert: { conto, anno, creatoIl: now, consolidato: false } },
        { upsert: true }
      );
      res.json({ ok: true, conto, anno, saldo });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.post('/api/movimenti', async (req, res) => {
    try {
      const db = requireDb(getDb, res); if (!db) return;
      await ensureIndexes(db);
      const movement = normalizeMovement(req.body);
      const result = await db.collection('movimenti').insertOne(movement);
      res.status(201).json({ ...movement, _id: result.insertedId });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.post('/api/movimenti/:id/riconcilia', async (req, res) => {
    try {
      const db = requireDb(getDb, res); if (!db) return;
      await ensureIndexes(db);
      const _id = parseId(req.params.id, 'ID movimento');
      const current = await db.collection('movimenti').findOne({ _id });
      if (!current) return res.status(404).json({ error: 'Movimento non trovato' });
      const check = canReconcile(current, req.body);
      if (!check.ok) return res.status(409).json({ error: check.motivo });
      await db.collection('movimenti').updateOne(
        { _id },
        {
          $set: { stato: 'RICONCILIATO', aggiornatoIl: new Date() },
          $addToSet: { evidenze: check.evidenza }
        }
      );
      res.json({ ok: true, stato: 'RICONCILIATO' });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.get('/api/documenti', async (req, res) => {
    try {
      const db = requireDb(getDb, res); if (!db) return;
      await ensureIndexes(db);
      const filter = { recordKind: { $ne: 'DRIVE_SOURCE' }, sourceActive: { $ne: false } };
      if (req.query.tipo) filter.tipo = token(req.query.tipo);
      if (req.query.stato) filter.stato = token(req.query.stato);
      const rows = await db.collection('documenti').find(filter, {
        projection: { contenuto: 0, pdfData: 0 }
      }).sort({ aggiornatoIl: -1 }).limit(500).toArray();
      res.json(rows);
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.get('/api/documenti/:id', async (req, res) => {
    try {
      const db = requireDb(getDb, res); if (!db) return;
      await ensureIndexes(db);
      const _id = parseId(req.params.id, 'ID documento');
      const document = await db.collection('documenti').findOne({ _id }, { projection: { contenuto: 0, pdfData: 0 } });
      if (!document) return res.status(404).json({ error: 'Documento non trovato' });
      const collegamenti = await db.collection('collegamenti').find({
        $or: [
          { 'a.tipo': 'DOCUMENTO', 'a.id': String(_id) },
          { 'b.tipo': 'DOCUMENTO', 'b.id': String(_id) }
        ]
      }).toArray();
      res.json({ ...document, collegamenti });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.post('/api/documenti', async (req, res) => {
    try {
      const db = requireDb(getDb, res); if (!db) return;
      await ensureIndexes(db);
      const contenuto = req.body.contenutoTestuale ? String(req.body.contenutoTestuale) : null;
      const sha256 = normalizeSha(req.body.sha256) || (contenuto
        ? crypto.createHash('sha256').update(contenuto).digest('hex')
        : null);
      const sourceType = token(req.body.fonte, 'UPLOAD');
      const reference = text(req.body.url || req.body.riferimento, 1000);
      if (!sha256 && !reference) throw new Error('Documento senza SHA-256 o riferimento sorgente');
      const stableSourceKey = text(req.body.sourceKey, 1000) || `${sourceType}:${reference || sha256}`;
      const filter = sha256 ? { sha256 } : { primarySourceKey: stableSourceKey };
      const now = new Date();
      const source = { sourceKey: stableSourceKey, tipo: sourceType, riferimento: reference };
      const set = {
        nomeOriginale: text(req.body.nomeOriginale, 500) || 'documento',
        tipo: token(req.body.tipo, 'DA_CLASSIFICARE'),
        stato: token(req.body.stato, 'DA_VERIFICARE'),
        protocollo: text(req.body.protocollo, 200),
        annoImposta: req.body.annoImposta ? validateYear(req.body.annoImposta) : null,
        datiEstratti: req.body.datiEstratti && typeof req.body.datiEstratti === 'object' ? req.body.datiEstratti : {},
        aggiornatoIl: now
      };
      if (sha256) set.sha256 = sha256;
      else set.primarySourceKey = stableSourceKey;
      const operation = {
        $set: set,
        $addToSet: { fonti: source },
        $setOnInsert: { creatoIl: now }
      };
      operation.$unset = sha256 ? { primarySourceKey: '' } : { sha256: '' };
      const result = await db.collection('documenti').updateOne(filter, operation, { upsert: true });
      const saved = await db.collection('documenti').findOne(filter);
      res.status(result.upsertedCount ? 201 : 200).json({ ...saved, duplicato: !result.upsertedCount });
    } catch (error) {
      if (error?.code === 11000) return res.status(409).json({ error: 'Documento duplicato non coerente' });
      res.status(400).json({ error: error.message });
    }
  });

  app.post('/api/collegamenti', async (req, res) => {
    try {
      const db = requireDb(getDb, res); if (!db) return;
      await ensureIndexes(db);
      const aTipo = token(req.body.aTipo);
      const aId = text(req.body.aId, 200);
      const bTipo = token(req.body.bTipo);
      const bId = text(req.body.bId, 200);
      const relazione = token(req.body.relazione, 'COLLEGATO_A');
      if (!aId || !bId) throw new Error('Estremi del collegamento mancanti');
      const key = relationKey(aTipo, aId, bTipo, bId, relazione);
      await db.collection('collegamenti').updateOne(
        { relationKey: key },
        {
          $setOnInsert: {
            relationKey: key,
            a: { tipo: aTipo, id: aId },
            b: { tipo: bTipo, id: bId },
            relazione,
            creatoIl: new Date()
          }
        },
        { upsert: true }
      );
      res.status(201).json({ ok: true, relationKey: key });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.get('/api/collegamenti/:tipo/:id', async (req, res) => {
    try {
      const db = requireDb(getDb, res); if (!db) return;
      await ensureIndexes(db);
      const tipo = token(req.params.tipo);
      const id = text(req.params.id, 200);
      const links = await db.collection('collegamenti').find({
        $or: [{ 'a.tipo': tipo, 'a.id': id }, { 'b.tipo': tipo, 'b.id': id }]
      }).toArray();
      res.json(links);
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.get('/api/dashboard', async (req, res) => {
    try {
      const db = requireDb(getDb, res); if (!db) return;
      await ensureIndexes(db);
      const anno = validateYear(req.query.anno || new Date().getUTCFullYear());
      const saldi = {};
      for (const conto of CONTI) {
        const riporto = await getOrCreateRiporto(db, conto, anno);
        const saldo = await calculateClosingBalance(db, conto, anno);
        saldi[conto] = { saldo, riporto: riporto.saldo, daRiallineare: riporto.daRiallineare };
      }
      const [daVerificare, documentiDaVerificare, f24DaRiscontrare, codiciTributoDaVerificare, riscossioneDaVerificare, riscossioneSenzaSnapshot, partiteAperte, partiteScadute] = await Promise.all([
        db.collection('movimenti').countDocuments({ stato: 'DA_VERIFICARE' }),
        db.collection('documenti').countDocuments({ stato: 'DA_VERIFICARE', recordKind: { $ne: 'DRIVE_SOURCE' }, sourceActive: { $ne: false } }),
        db.collection('f24_operazioni').countDocuments({ stato: { $in: ['IN_ATTESA_RISCONTRO', 'DA_VERIFICARE'] } }),
        db.collection('f24_righe').countDocuments({ 'classificazione.stato': 'DA_VERIFICARE' }),
        db.collection('atti_riscossione').countDocuments({ stato: 'DA_VERIFICARE' }),
        db.collection('atti_riscossione').countDocuments({ $or: [{ ultimoSnapshot: { $exists: false } }, { ultimoSnapshot: null }] }),
        db.collection('obligations').countDocuments({ sourceEntityType: 'INVOICE_SUPPLIER', status: { $in: ['OPEN', 'PARTIAL'] } }),
        db.collection('obligations').countDocuments({ sourceEntityType: 'INVOICE_SUPPLIER', status: { $in: ['OPEN', 'PARTIAL'] }, dueDate: { $lt: new Date() } })
      ]);
      res.json({
        anno,
        saldi,
        daVerificare,
        documentiDaVerificare,
        f24DaRiscontrare,
        codiciTributoDaVerificare,
        riscossioneDaVerificare,
        riscossioneSenzaSnapshot,
        partiteAperte,
        partiteScadute
      });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });
}
