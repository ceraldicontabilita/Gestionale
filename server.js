import 'dotenv/config';
import express from 'express';
import { MongoClient, ObjectId } from 'mongodb';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = express();
const port = Number(process.env.PORT || 3000);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

let db = null;
if (process.env.MONGODB_URI) {
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  db = client.db(process.env.MONGODB_DB || 'impresa_semplice');
}

const TIPI_CONTO = ['CASSA', 'BANCA', 'MASTERCARD', 'SALARI', 'FINANZIAMENTI_SOCI', 'PROVVISORIA'];
const STATI = ['DA_VERIFICARE', 'DOCUMENTATO', 'PARZIALE', 'RICONCILIATO'];

function normalizeMovement(body) {
  const conto = String(body.conto || '').toUpperCase();
  if (!TIPI_CONTO.includes(conto)) throw new Error('Conto non valido');
  const importo = Number(body.importo);
  if (!Number.isFinite(importo) || importo === 0) throw new Error('Importo non valido');

  const provaReale = Boolean(body.provaReale);
  let stato = String(body.stato || 'DA_VERIFICARE').toUpperCase();
  if (!STATI.includes(stato)) stato = 'DA_VERIFICARE';

  // Solo Cassa può essere attestata manualmente. Gli altri conti richiedono evidenza reale.
  if (conto !== 'CASSA' && stato === 'RICONCILIATO' && !provaReale) stato = 'DA_VERIFICARE';

  return {
    data: body.data ? new Date(body.data) : new Date(),
    conto,
    importo,
    descrizione: String(body.descrizione || '').trim(),
    stato,
    provaReale,
    fonte: String(body.fonte || 'MANUALE').toUpperCase(),
    documentoId: body.documentoId || null,
    creatoIl: new Date(),
    aggiornatoIl: new Date()
  };
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, database: db ? 'connected' : 'not-configured' });
});

app.get('/api/movimenti', async (_req, res) => {
  if (!db) return res.json([]);
  const rows = await db.collection('movimenti').find({}).sort({ data: -1, creatoIl: -1 }).limit(500).toArray();
  res.json(rows);
});

app.post('/api/movimenti', async (req, res) => {
  try {
    const movement = normalizeMovement(req.body);
    if (!db) return res.status(503).json({ error: 'MongoDB non configurato' });
    const result = await db.collection('movimenti').insertOne(movement);
    res.status(201).json({ ...movement, _id: result.insertedId });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/movimenti/:id/riconcilia', async (req, res) => {
  if (!db) return res.status(503).json({ error: 'MongoDB non configurato' });
  const current = await db.collection('movimenti').findOne({ _id: new ObjectId(req.params.id) });
  if (!current) return res.status(404).json({ error: 'Movimento non trovato' });
  if (current.conto !== 'CASSA' && !req.body.provaReale) {
    return res.status(409).json({ error: 'Serve una prova reale prima della riconciliazione' });
  }
  await db.collection('movimenti').updateOne(
    { _id: current._id },
    { $set: { stato: 'RICONCILIATO', provaReale: Boolean(req.body.provaReale) || current.conto === 'CASSA', aggiornatoIl: new Date() } }
  );
  res.json({ ok: true });
});

app.listen(port, () => console.log(`Impresa Semplice in ascolto sulla porta ${port}`));
