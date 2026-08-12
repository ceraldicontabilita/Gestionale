import 'dotenv/config';
import crypto from 'node:crypto';
import express from 'express';
import { MongoClient, ObjectId } from 'mongodb';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONTI,
  STATI,
  buildLedger,
  canReconcile,
  euro,
  movimentoDelta,
  normalizeMovement,
  relationKey
} from './src/domain.js';

const app = express();
const port = Number(process.env.PORT || 3000);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

app.use(express.json({ limit: '10mb' }));
app.use(express.text({ type: ['application/xml', 'text/xml'], limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

let db = null;
let client = null;

if (process.env.MONGODB_URI) {
  client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  db = client.db(process.env.MONGODB_DB || 'impresa_semplice');

  await Promise.all([
    db.collection('riporti').createIndex({ conto: 1, anno: 1 }, { unique: true }),
    db.collection('collegamenti').createIndex({ relationKey: 1 }, { unique: true }),
    db.collection('documenti').createIndex({ sha256: 1 }, { unique: true, sparse: true }),
    db.collection('giornate_corrispettivi').createIndex({ dataGiorno: 1 }, { unique: true }),
    db.collection('crediti_pos').createIndex({ dataGiorno: 1, gestore: 1 }, { unique: true }),
    db.collection('movimenti').createIndex({ conto: 1, data: 1, creatoIl: 1 })
  ]);
}

function requireDb(res) {
  if (!db) {
    res.status(503).json({ error: 'MongoDB non configurato' });
    return false;
  }
  return true;
}

function parseId(value) {
  if (!ObjectId.isValid(value)) throw new Error('ID non valido');
  return new ObjectId(value);
}

function startOfYear(anno) {
  return new Date(`${anno}-01-01T00:00:00.000Z`);
}

function startOfNextYear(anno) {
  return new Date(`${anno + 1}-01-01T00:00:00.000Z`);
}

async function calculateClosingBalance(conto, anno) {
  const riporto = await db.collection('riporti').findOne({ conto, anno });
  const saldoApertura = euro(riporto?.saldo || 0);
  const rows = await db.collection('movimenti').find({
    conto,
    data: { $gte: startOfYear(anno), $lt: startOfNextYear(anno) }
  }).toArray();
  return euro(rows.reduce((saldo, row) => saldo + movimentoDelta(row), saldoApertura));
}

async function getOrCreateRiporto(conto, anno) {
  let riporto = await db.collection('riporti').findOne({ conto, anno });
  if (!riporto) {
    const saldo = anno <= 2000 ? 0 : await calculateClosingBalance(conto, anno - 1);
    const doc = {
      conto,
      anno,
      saldo,
      origine: 'CHIUSURA_ANNO_PRECEDENTE',
      consolidato: false,
      creatoIl: new Date(),
      aggiornatoIl: new Date()
    };
    await db.collection('riporti').updateOne(
      { conto, anno },
      { $setOnInsert: doc },
      { upsert: true }
    );
    riporto = await db.collection('riporti').findOne({ conto, anno });
  }

  if (anno > 2000) {
    const atteso = await calculateClosingBalance(conto, anno - 1);
    riporto.daRiallineare = euro(atteso) !== euro(riporto.saldo);
    riporto.saldoAtteso = atteso;
  } else {
    riporto.daRiallineare = false;
  }
  return riporto;
}

async function upsertProjectedMovement(filter, movement) {
  const now = new Date();
  const { creatoIl, ...mutable } = movement;
  return db.collection('movimenti').updateOne(
    filter,
    { $set: { ...mutable, aggiornatoIl: now }, $setOnInsert: { creatoIl: creatoIl || now } },
    { upsert: true }
  );
}

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    nome: 'Impresa Semplice',
    versione: '0.2.0',
    database: db ? 'connected' : 'not-configured'
  });
});

app.get('/api/config', (_req, res) => {
  res.json({ conti: CONTI, stati: STATI });
});

app.get('/api/prima-nota/:conto', async (req, res) => {
  try {
    if (!requireDb(res)) return;
    const conto = String(req.params.conto).toUpperCase();
    if (!CONTI.includes(conto)) return res.status(400).json({ error: 'Conto non valido' });
    const anno = Number(req.query.anno || new Date().getFullYear());
    const riporto = await getOrCreateRiporto(conto, anno);
    const rows = await db.collection('movimenti').find({
      conto,
      data: { $gte: startOfYear(anno), $lt: startOfNextYear(anno) }
    }).sort({ data: 1, creatoIl: 1 }).toArray();

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
    if (!requireDb(res)) return;
    const conto = String(req.params.conto).toUpperCase();
    const anno = Number(req.params.anno);
    if (!CONTI.includes(conto)) throw new Error('Conto non valido');
    if (!Number.isInteger(anno)) throw new Error('Anno non valido');

    const saldo = euro(req.body.saldo);
    const existing = await db.collection('riporti').findOne({ conto, anno });
    if (existing?.consolidato && !req.body.forza) {
      return res.status(409).json({ error: 'Riporto consolidato: modifica sensibile bloccata' });
    }

    await db.collection('riporti').updateOne(
      { conto, anno },
      {
        $set: {
          saldo,
          origine: String(req.body.origine || 'MANUALE').toUpperCase(),
          consolidato: Boolean(req.body.consolidato),
          aggiornatoIl: new Date()
        },
        $setOnInsert: { creatoIl: new Date() }
      },
      { upsert: true }
    );
    res.json({ ok: true, conto, anno, saldo });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/movimenti', async (req, res) => {
  try {
    if (!requireDb(res)) return;
    const movement = normalizeMovement(req.body);
    const result = await db.collection('movimenti').insertOne(movement);
    res.status(201).json({ ...movement, _id: result.insertedId });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/movimenti/:id/riconcilia', async (req, res) => {
  try {
    if (!requireDb(res)) return;
    const _id = parseId(req.params.id);
    const current = await db.collection('movimenti').findOne({ _id });
    if (!current) return res.status(404).json({ error: 'Movimento non trovato' });

    const check = canReconcile(current, req.body);
    if (!check.ok) return res.status(409).json({ error: check.motivo });

    const nuovaEvidenza = {
      tipo: check.tipoProva,
      riferimento: req.body.riferimento || null,
      reale: true,
      registrataIl: new Date()
    };

    await db.collection('movimenti').updateOne(
      { _id },
      {
        $set: { stato: 'RICONCILIATO', aggiornatoIl: new Date() },
        $push: { evidenze: nuovaEvidenza }
      }
    );
    res.json({ ok: true, stato: 'RICONCILIATO' });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/documenti', async (req, res) => {
  try {
    if (!requireDb(res)) return;

    const contenuto = req.body.contenutoTestuale ? String(req.body.contenutoTestuale) : null;
    const sha256 = req.body.sha256
      ? String(req.body.sha256).toLowerCase()
      : contenuto
        ? crypto.createHash('sha256').update(contenuto).digest('hex')
        : null;

    if (sha256) {
      const existing = await db.collection('documenti').findOne({ sha256 });
      if (existing) {
        const fonte = {
          tipo: String(req.body.fonte || 'UPLOAD').toUpperCase(),
          riferimento: req.body.url || req.body.riferimento || null,
          rilevataIl: new Date()
        };
        await db.collection('documenti').updateOne(
          { _id: existing._id },
          { $addToSet: { fonti: fonte }, $set: { aggiornatoIl: new Date() } }
        );
        return res.json({ duplicato: true, documentoId: existing._id });
      }
    }

    const documento = {
      nomeOriginale: String(req.body.nomeOriginale || 'documento'),
      tipo: String(req.body.tipo || 'DA_CLASSIFICARE').toUpperCase(),
      stato: String(req.body.stato || 'DA_VERIFICARE').toUpperCase(),
      sha256,
      protocollo: req.body.protocollo || null,
      annoImposta: req.body.annoImposta ? Number(req.body.annoImposta) : null,
      datiEstratti: req.body.datiEstratti || {},
      fonti: [{
        tipo: String(req.body.fonte || 'UPLOAD').toUpperCase(),
        riferimento: req.body.url || req.body.riferimento || null,
        rilevataIl: new Date()
      }],
      creatoIl: new Date(),
      aggiornatoIl: new Date()
    };

    const result = await db.collection('documenti').insertOne(documento);
    res.status(201).json({ ...documento, _id: result.insertedId });
  } catch (error) {
    if (error?.code === 11000) return res.status(409).json({ error: 'Documento duplicato' });
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/collegamenti', async (req, res) => {
  try {
    if (!requireDb(res)) return;
    const aTipo = String(req.body.aTipo || '').toUpperCase();
    const aId = String(req.body.aId || '');
    const bTipo = String(req.body.bTipo || '').toUpperCase();
    const bId = String(req.body.bId || '');
    const relazione = String(req.body.relazione || 'COLLEGATO_A').toUpperCase();
    if (!aTipo || !aId || !bTipo || !bId) throw new Error('Estremi del collegamento mancanti');

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
  if (!requireDb(res)) return;
  const tipo = String(req.params.tipo).toUpperCase();
  const id = String(req.params.id);
  const links = await db.collection('collegamenti').find({
    $or: [{ 'a.tipo': tipo, 'a.id': id }, { 'b.tipo': tipo, 'b.id': id }]
  }).toArray();
  res.json(links);
});

app.post('/api/corrispettivi/giornata', async (req, res) => {
  try {
    if (!requireDb(res)) return;
    const dataGiorno = String(req.body.data || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dataGiorno)) throw new Error('Data giornata non valida');

    const totaleXml = euro(req.body.totaleXml);
    if (totaleXml < 0) throw new Error('Totale XML non valido');

    const chiusuraOperativa = req.body.chiusuraOperativa === null || req.body.chiusuraOperativa === undefined
      ? null
      : euro(req.body.chiusuraOperativa);

    const pos = {};
    for (const gestore of ['NUMIA', 'SUMUP']) {
      const raw = req.body.pos?.[gestore];
      if (raw !== null && raw !== undefined && raw !== '') pos[gestore] = euro(raw);
    }

    const now = new Date();
    const record = {
      dataGiorno,
      totaleXml,
      documentoXmlId: req.body.documentoXmlId || null,
      chiusuraOperativa,
      pos,
      originePos: req.body.originePos || {},
      aggiornatoIl: now
    };

    await db.collection('giornate_corrispettivi').updateOne(
      { dataGiorno },
      { $set: record, $setOnInsert: { creatoIl: now } },
      { upsert: true }
    );

    const dataMovimento = new Date(`${dataGiorno}T12:00:00.000Z`);
    if (totaleXml > 0) {
      await upsertProjectedMovement(
        { conto: 'CASSA', tipo: 'CORRISPETTIVO_GIORNALIERO', riferimentoEsterno: dataGiorno },
        normalizeMovement({
          data: dataMovimento,
          conto: 'CASSA',
          direzione: 'ENTRATA',
          importo: totaleXml,
          descrizione: `Corrispettivi giornalieri ${dataGiorno}`,
          tipo: 'CORRISPETTIVO_GIORNALIERO',
          stato: 'DOCUMENTATO',
          fonte: 'XML_RT',
          documentoId: req.body.documentoXmlId || null,
          riferimentoEsterno: dataGiorno
        }, { now })
      );
    } else {
      await db.collection('movimenti').deleteMany({
        conto: 'CASSA',
        tipo: 'CORRISPETTIVO_GIORNALIERO',
        riferimentoEsterno: dataGiorno
      });
    }

    for (const gestore of ['NUMIA', 'SUMUP']) {
      if (!(gestore in pos)) continue;
      const amount = euro(pos[gestore]);

      if (amount > 0) {
        await upsertProjectedMovement(
          {
            conto: 'CASSA',
            tipo: 'TRASFERIMENTO_POS',
            riferimentoEsterno: `${dataGiorno}:${gestore}`
          },
          normalizeMovement({
            data: dataMovimento,
            conto: 'CASSA',
            direzione: 'USCITA',
            importo: amount,
            descrizione: `POS ${gestore} verso accredito`,
            tipo: 'TRASFERIMENTO_POS',
            stato: 'DOCUMENTATO',
            fonte: String(req.body.originePos?.[gestore] || 'MANUALE'),
            contropartita: `CREDITO_POS_${gestore}`,
            riferimentoEsterno: `${dataGiorno}:${gestore}`
          }, { now })
        );
      } else {
        await db.collection('movimenti').deleteMany({
          conto: 'CASSA',
          tipo: 'TRASFERIMENTO_POS',
          riferimentoEsterno: `${dataGiorno}:${gestore}`
        });
      }

      await db.collection('crediti_pos').updateOne(
        { dataGiorno, gestore },
        {
          $set: {
            importoVenduto: amount,
            residuo: amount,
            stato: amount === 0 ? 'NESSUN_INCASSO' : 'IN_ATTESA_ACCREDITO',
            origine: String(req.body.originePos?.[gestore] || 'MANUALE').toUpperCase(),
            aggiornatoIl: now
          },
          $setOnInsert: { creatoIl: now }
        },
        { upsert: true }
      );
    }

    const posCompleti = ['NUMIA', 'SUMUP'].every((g) => g in pos);
    const totalePos = euro(Object.values(pos).reduce((a, b) => a + b, 0));
    const baseContante = chiusuraOperativa;
    const contanteAtteso = baseContante === null || !posCompleti
      ? null
      : euro(baseContante - totalePos);

    const controlloFiscale = chiusuraOperativa === null
      ? { stato: 'DATI_INCOMPLETI' }
      : {
          stato: euro(chiusuraOperativa - totaleXml) === 0 ? 'ALLINEATO' : 'DIFFERENZA',
          differenza: euro(chiusuraOperativa - totaleXml)
        };

    res.status(201).json({
      ok: true,
      dataGiorno,
      totaleXml,
      chiusuraOperativa,
      pos,
      totalePos,
      contanteAtteso,
      controlloFiscale,
      nota: posCompleti ? null : 'Contante non determinato: manca almeno una chiusura POS reale'
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/corrispettivi/:data', async (req, res) => {
  if (!requireDb(res)) return;
  const dataGiorno = String(req.params.data).slice(0, 10);
  const giornata = await db.collection('giornate_corrispettivi').findOne({ dataGiorno });
  const crediti = await db.collection('crediti_pos').find({ dataGiorno }).toArray();
  if (!giornata) return res.status(404).json({ error: 'Giornata non trovata' });
  res.json({ giornata, crediti });
});

app.get('/api/dashboard', async (req, res) => {
  try {
    if (!requireDb(res)) return;
    const anno = Number(req.query.anno || new Date().getFullYear());
    const saldi = {};
    for (const conto of CONTI) {
      const riporto = await getOrCreateRiporto(conto, anno);
      const saldo = await calculateClosingBalance(conto, anno);
      saldi[conto] = { saldo, riporto: riporto.saldo, daRiallineare: riporto.daRiallineare };
    }
    const daVerificare = await db.collection('movimenti').countDocuments({ stato: 'DA_VERIFICARE' });
    const documentiDaVerificare = await db.collection('documenti').countDocuments({ stato: 'DA_VERIFICARE' });
    res.json({ anno, saldi, daVerificare, documentiDaVerificare });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.listen(port, () => console.log(`Impresa Semplice in ascolto sulla porta ${port}`));

process.on('SIGTERM', async () => {
  if (client) await client.close();
  process.exit(0);
});
