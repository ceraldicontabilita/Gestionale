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

function compactMovement(row, allocatedCents = 0) {
  const amountCents = Math.round(Math.abs(Number(row.importo || 0)) * 100);
  const realEvidence = (row.evidenze || []).find((item) => item?.reale === true && item.riferimento);
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
    movementReference: row.riferimentoEsterno || row.sourceTransactionId || realEvidence?.riferimento || null,
    allocatedAmount: allocatedCents / 100,
    availableAmount: Math.max(0, amountCents - allocatedCents) / 100,
    provaFinanziaria: hasRealFinancialEvidence(row)
  };
}

export function buildOpenItemsView(openItems = [], obligations = [], invoices = [], { now = new Date() } = {}) {
  const obligationByKey = new Map(obligations.map((row) => [row.obligationKey, row]));
  const invoiceById = new Map(invoices.map((row) => [row.invoiceId, row]));
  const rows = openItems.map((item) => {
    const obligation = obligationByKey.get(item.obligationKey) || null;
    const invoice = obligation ? invoiceById.get(obligation.sourceEntityId) || null : null;
    const dueDate = obligation?.dueDate || invoice?.dates?.dueDate || null;
    const due = dueDate ? new Date(dueDate) : null;
    const residualCents = Number(item.residualCents || 0);
    const status = String(item.status || obligation?.status || 'OPEN').toUpperCase();
    return {
      obligationKey: item.obligationKey,
      invoiceId: invoice?.invoiceId || obligation?.sourceEntityId || null,
      invoiceNaturalKey: invoice?.naturalKey || null,
      invoiceNumber: invoice?.number || null,
      documentType: invoice?.documentType || null,
      supplier: invoice?.supplier || null,
      documentDate: invoice?.dates?.documentDate || null,
      dueDate,
      currency: item.currency || obligation?.currency || invoice?.currency || 'EUR',
      originalCents: Number(item.originalCents || obligation?.amountCents || 0),
      allocatedCents: Number(item.allocatedCents || 0),
      residualCents,
      status,
      overdue: Boolean(due && !Number.isNaN(due.getTime()) && due < now && residualCents > 0 && status !== 'CLOSED'),
      sourceEventKey: item.sourceEventKey || obligation?.sourceEventKey || null
    };
  }).sort((left, right) => {
    const leftDue = left.dueDate ? new Date(left.dueDate).getTime() : Number.MAX_SAFE_INTEGER;
    const rightDue = right.dueDate ? new Date(right.dueDate).getTime() : Number.MAX_SAFE_INTEGER;
    return leftDue - rightDue || String(left.supplier?.name || '').localeCompare(String(right.supplier?.name || ''));
  });
  return {
    counts: {
      total: rows.length,
      open: rows.filter((row) => row.status === 'OPEN').length,
      partial: rows.filter((row) => row.status === 'PARTIAL').length,
      closed: rows.filter((row) => row.status === 'CLOSED').length,
      overdue: rows.filter((row) => row.overdue).length,
      withoutDueDate: rows.filter((row) => !row.dueDate && row.status !== 'CLOSED').length,
      residualCents: rows.reduce((sum, row) => sum + row.residualCents, 0)
    },
    rows
  };
}

export function registerReconciliationRoutes(app, { getDb }) {
  app.get('/api/riconciliazione', async (req, res) => {
    try {
      const db = getDb();
      if (!db) return res.status(503).json({ error: 'MongoDB non configurato' });
      const anno = validateYear(req.query.anno || new Date().getUTCFullYear());
      const [movements, f24, acts, paymentLinks, allocations, confirmedReconciliations] = await Promise.all([
        db.collection('movimenti').find({
          conto: { $in: ['BANCA', 'MASTERCARD', 'CASSA'] },
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
        db.collection('collegamenti').find({ relazione: 'PAGATO_DA' }).limit(5000).toArray(),
        db.collection('allocations').find({ status: 'CONFIRMED' }, { projection: { movementId: 1, amountCents: 1 } }).limit(20_000).toArray(),
        db.collection('reconciliations').countDocuments({ status: 'CONFIRMED' })
      ]);

      const linkedMovementIds = new Set(paymentLinks.map(movementIdFromLink).filter(Boolean).map(String));
      const allocatedByMovement = new Map();
      for (const row of allocations) allocatedByMovement.set(String(row.movementId), (allocatedByMovement.get(String(row.movementId)) || 0) + Number(row.amountCents || 0));
      const openMovements = movements
        .filter((row) => !linkedMovementIds.has(String(row._id)))
        .map((row) => compactMovement(row, allocatedByMovement.get(String(row._id)) || 0))
        .filter((row) => row.availableAmount > 0);
      res.json({
        anno,
        riepilogo: {
          movimentiAperti: openMovements.length,
          movimentiSenzaProva: openMovements.filter((row) => !row.provaFinanziaria).length,
          f24Aperti: f24.length,
          attiAperti: acts.length,
          collegamentiConfermati: paymentLinks.length + confirmedReconciliations
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

  app.get('/api/riconciliazione/partite-aperte', async (req, res) => {
    try {
      const db = getDb();
      if (!db) return res.status(503).json({ error: 'MongoDB non configurato' });
      const [obligations, invoices] = await Promise.all([
        db.collection('obligations').find({ sourceEntityType: 'INVOICE_SUPPLIER' }).limit(20_000).toArray(),
        db.collection('invoice_suppliers').find({ current: true }, { projection: {
          invoiceId: 1, naturalKey: 1, number: 1, documentType: 1, supplier: 1, dates: 1, currency: 1
        } }).limit(20_000).toArray()
      ]);
      const obligationKeys = obligations.map((row) => row.obligationKey);
      const openItems = obligationKeys.length
        ? await db.collection('open_items').find({ obligationKey: { $in: obligationKeys } }).limit(20_000).toArray()
        : [];
      const view = buildOpenItemsView(openItems, obligations, invoices);
      const status = String(req.query.status || 'OPEN').toUpperCase();
      const rows = status === 'ALL' ? view.rows : view.rows.filter((row) => status === 'OPEN' ? row.status !== 'CLOSED' : row.status === status);
      const candidates = view.rows.filter((row) => row.status !== 'CLOSED' && row.residualCents > 0 && row.invoiceId && row.invoiceNaturalKey);
      res.set('Cache-Control', 'no-store');
      res.json({ ...view, rows: rows.slice(0, 2_000), candidates: candidates.slice(0, 2_000) });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });
}
