import { startOfNextYear, startOfYear, validateYear } from './ledger.js';

const FINANCIAL_EVIDENCE = Object.freeze({
  BANCA: new Set(['ESTRATTO_CONTO', 'MOVIMENTO_BANCARIO']),
  MASTERCARD: new Set(['ESTRATTO_CARTA', 'MOVIMENTO_CARTA']),
  CASSA: new Set(['ATTESTAZIONE_CASSA'])
});

export function hasRealFinancialEvidence(movement) {
  const allowed = FINANCIAL_EVIDENCE[movement?.conto];
  return Boolean(allowed && (movement.evidenze || []).some((evidence) => (
    evidence?.reale === true && evidence.riferimento && allowed.has(evidence.tipo)
  )));
}

function movementIdFromLink(link) {
  const endpoint = [link?.a, link?.b].find((item) => item?.tipo === 'MOVIMENTO');
  return endpoint?.id || null;
}

function compactMovement(row) {
  return {
    _id: row._id,
    data: row.data,
    conto: row.conto,
    direzione: row.direzione,
    importo: Number(row.importo || 0),
    descrizione: row.descrizione,
    stato: row.stato,
    fonte: row.fonte,
    riferimentoEsterno: row.riferimentoEsterno || null,
    provaFinanziaria: hasRealFinancialEvidence(row)
  };
}

export function registerReconciliationRoutes(app, { getDb }) {
  app.get('/api/riconciliazione', async (req, res) => {
    try {
      const db = getDb();
      if (!db) return res.status(503).json({ error: 'MongoDB non configurato' });
      const anno = validateYear(req.query.anno || new Date().getUTCFullYear());
      const [movements, f24, acts, paymentLinks] = await Promise.all([
        db.collection('movimenti').find({
          conto: { $in: ['BANCA', 'MASTERCARD'] },
          direzione: 'USCITA',
          data: { $gte: startOfYear(anno), $lt: startOfNextYear(anno) },
          stato: { $ne: 'RICONCILIATO' }
        }, { projection: { contenuto: 0 } }).sort({ data: -1, creatoIl: -1 }).limit(500).toArray(),
        db.collection('f24_operazioni').find({
          annoElenco: anno,
          stato: { $nin: ['RICONCILIATO', 'COMPENSATO'] }
        }).sort({ dataVersamento: -1, indicePortale: -1 }).limit(500).toArray(),
        db.collection('atti_riscossione').find({ stato: { $nin: ['PAGATO', 'ANNULLATO'] } })
          .sort({ dataNotifica: -1, dataAtto: -1, creatoIl: -1 }).limit(500).toArray(),
        db.collection('collegamenti').find({ relazione: 'PAGATO_DA' }).limit(5000).toArray()
      ]);

      const linkedMovementIds = new Set(paymentLinks.map(movementIdFromLink).filter(Boolean).map(String));
      const openMovements = movements.filter((row) => !linkedMovementIds.has(String(row._id))).map(compactMovement);
      res.json({
        anno,
        riepilogo: {
          movimentiAperti: openMovements.length,
          movimentiSenzaProva: openMovements.filter((row) => !row.provaFinanziaria).length,
          f24Aperti: f24.length,
          attiAperti: acts.length,
          collegamentiConfermati: paymentLinks.length
        },
        movimenti: openMovements,
        f24: f24.map((row) => ({
          _id: row._id,
          dataVersamento: row.dataVersamento,
          protocollo: row.protocollo || row.protocolloLettoNelPdf || null,
          file: row.file || null,
          tipoDocumento: row.tipoDocumento || null,
          stato: row.stato,
          importoAtteso: Number(row.saldoOperazione ?? row.saldoModello ?? 0),
          numeroModelli: Number(row.numeroModelliF24 || 1),
          operationKey: row.operationKey || null
        })),
        atti: acts.map((row) => ({
          _id: row._id,
          tipo: row.tipo,
          numeroAtto: row.numeroAtto || null,
          dataAtto: row.dataAtto || null,
          dataNotifica: row.dataNotifica || null,
          scadenza: row.scadenza || null,
          entiCreditori: row.entiCreditori || [],
          stato: row.stato,
          importoOriginario: row.importoOriginario ?? null,
          importoResiduo: row.ultimoSnapshot?.importoResiduo ?? null,
          totalePagamentiCollegati: Number(row.totalePagamentiCollegati || 0),
          ultimoSnapshot: row.ultimoSnapshot || null
        }))
      });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });
}
