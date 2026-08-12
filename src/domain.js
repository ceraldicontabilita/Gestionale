export const CONTI = [
  'CASSA',
  'BANCA',
  'MASTERCARD',
  'SALARI',
  'FINANZIAMENTI_SOCI',
  'PROVVISORIA'
];

export const STATI = [
  'DA_VERIFICARE',
  'DOCUMENTATO',
  'PARZIALE',
  'RICONCILIATO'
];

export const DIREZIONI = ['ENTRATA', 'USCITA'];

export function euro(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error('Importo non valido');
  return Math.round(n * 100) / 100;
}

export function normalizeMovement(body, { now = new Date() } = {}) {
  const conto = String(body.conto || '').toUpperCase();
  if (!CONTI.includes(conto)) throw new Error('Conto non valido');

  const importo = Math.abs(euro(body.importo));
  if (importo <= 0) throw new Error('Importo deve essere maggiore di zero');

  const direzione = String(body.direzione || '').toUpperCase();
  if (!DIREZIONI.includes(direzione)) throw new Error('Direzione non valida');

  let stato = String(body.stato || 'DA_VERIFICARE').toUpperCase();
  if (!STATI.includes(stato)) stato = 'DA_VERIFICARE';

  const evidenze = Array.isArray(body.evidenze)
    ? body.evidenze.filter(Boolean).map((e) => ({
        tipo: String(e.tipo || 'ALTRO').toUpperCase(),
        riferimento: e.riferimento ? String(e.riferimento) : null,
        reale: Boolean(e.reale)
      }))
    : [];

  const provaReale = evidenze.some((e) => e.reale) || Boolean(body.provaReale);
  if (conto !== 'CASSA' && stato === 'RICONCILIATO' && !provaReale) {
    stato = 'DA_VERIFICARE';
  }

  return {
    data: body.data ? new Date(body.data) : now,
    conto,
    direzione,
    importo,
    descrizione: String(body.descrizione || '').trim(),
    tipo: String(body.tipo || 'ORDINARIO').toUpperCase(),
    stato,
    evidenze,
    fonte: String(body.fonte || 'MANUALE').toUpperCase(),
    documentoId: body.documentoId || null,
    contropartita: body.contropartita ? String(body.contropartita).toUpperCase() : null,
    riferimentoEsterno: body.riferimentoEsterno || null,
    creatoIl: now,
    aggiornatoIl: now
  };
}

export function movimentoDelta(movimento) {
  return movimento.direzione === 'ENTRATA' ? movimento.importo : -movimento.importo;
}

export function buildLedger(rows, riporto, anno) {
  const ordered = [...rows].sort((a, b) => {
    const da = new Date(a.data).getTime();
    const db = new Date(b.data).getTime();
    if (da !== db) return da - db;
    return new Date(a.creatoIl || a.data).getTime() - new Date(b.creatoIl || b.data).getTime();
  });

  let saldo = euro(riporto?.saldo || 0);
  const result = [{
    _id: `riporto-${anno}-${riporto?.conto || ordered[0]?.conto || ''}`,
    data: new Date(`${anno}-01-01T00:00:00.000Z`),
    conto: riporto?.conto || ordered[0]?.conto || null,
    tipo: 'RIPORTO_APERTURA',
    descrizione: 'Riporto saldo anni precedenti',
    direzione: null,
    importo: Math.abs(saldo),
    saldoIniziale: saldo,
    saldoProgressivo: saldo,
    economico: false,
    stato: riporto?.daRiallineare ? 'DA_VERIFICARE' : 'RICONCILIATO',
    sintetico: true
  }];

  for (const row of ordered) {
    saldo = euro(saldo + movimentoDelta(row));
    result.push({ ...row, saldoProgressivo: saldo, economico: row.tipo !== 'RIPORTO_APERTURA' });
  }

  return result;
}

export function canReconcile(movimento, body = {}) {
  if (movimento.conto === 'CASSA') {
    return { ok: true, tipoProva: 'ATTESTAZIONE_MANUALE' };
  }
  const evidenze = [
    ...(Array.isArray(movimento.evidenze) ? movimento.evidenze : []),
    ...(Array.isArray(body.evidenze) ? body.evidenze : [])
  ];
  const hasReal = Boolean(body.provaReale) || evidenze.some((e) => Boolean(e.reale));
  return hasReal
    ? { ok: true, tipoProva: 'EVIDENZA_FINANZIARIA' }
    : { ok: false, motivo: 'Serve una prova finanziaria reale prima della riconciliazione' };
}

export function relationKey(aTipo, aId, bTipo, bId, relazione) {
  const a = `${String(aTipo).toUpperCase()}:${String(aId)}`;
  const b = `${String(bTipo).toUpperCase()}:${String(bId)}`;
  return [a, b].sort().join('|') + `|${String(relazione || 'COLLEGATO_A').toUpperCase()}`;
}
