import { parseMoney, roundMoney } from './money.js';

export const CONTI = Object.freeze([
  'CASSA',
  'BANCA',
  'MASTERCARD',
  'SALARI',
  'FINANZIAMENTI_SOCI',
  'PROVVISORIA'
]);

export const STATI = Object.freeze([
  'DA_VERIFICARE',
  'DOCUMENTATO',
  'PARZIALE',
  'RICONCILIATO'
]);

export const DIREZIONI = Object.freeze(['ENTRATA', 'USCITA']);

const REAL_EVIDENCE_TYPES = new Set([
  'ESTRATTO_CONTO',
  'MOVIMENTO_BANCARIO',
  'ESTRATTO_CARTA',
  'MOVIMENTO_CARTA',
  'ATTESTAZIONE_CASSA'
]);

export function euro(value) {
  const parsed = parseMoney(value, { allowNegative: true });
  if (parsed === null) throw new Error('Importo non valido');
  return parsed;
}

function validDate(value, fallback) {
  const date = value instanceof Date ? new Date(value) : value ? new Date(value) : new Date(fallback);
  if (Number.isNaN(date.getTime())) throw new Error('Data movimento non valida');
  const year = date.getUTCFullYear();
  if (year < 2000 || year > 2100) throw new Error('Data movimento fuori intervallo');
  return date;
}

function cleanText(value, { required = false, max = 500, label = 'Valore' } = {}) {
  const text = String(value || '').trim();
  if (required && !text) throw new Error(`${label} obbligatorio`);
  if (text.length > max) throw new Error(`${label} troppo lungo`);
  return text || null;
}

function cleanToken(value, fallback, label) {
  const token = String(value || fallback || '').trim().toUpperCase();
  if (!token || !/^[A-Z0-9_:-]{1,80}$/.test(token)) throw new Error(`${label} non valido`);
  return token;
}

export function normalizeEvidence(value) {
  const evidence = Array.isArray(value) ? value : [];
  return evidence.filter(Boolean).map((item) => {
    const tipo = cleanToken(item.tipo, 'ALTRO', 'Tipo evidenza');
    const riferimento = cleanText(item.riferimento, { max: 500, label: 'Riferimento evidenza' });
    const reale = Boolean(item.reale);
    if (reale && !riferimento) throw new Error('Una evidenza reale richiede un riferimento verificabile');
    if (reale && !REAL_EVIDENCE_TYPES.has(tipo)) throw new Error('Tipo di evidenza reale non ammesso');
    return { tipo, riferimento, reale };
  });
}

function hasRealEvidence(evidenze) {
  return evidenze.some((item) => item.reale && item.riferimento && REAL_EVIDENCE_TYPES.has(item.tipo));
}

export function normalizeMovement(body, { now = new Date() } = {}) {
  const conto = cleanToken(body.conto, null, 'Conto');
  if (!CONTI.includes(conto)) throw new Error('Conto non valido');

  const importo = parseMoney(body.importo, { label: 'Importo movimento' });
  if (importo === null || importo <= 0) throw new Error('Importo deve essere maggiore di zero');

  const direzione = cleanToken(body.direzione, null, 'Direzione');
  if (!DIREZIONI.includes(direzione)) throw new Error('Direzione non valida');

  let stato = String(body.stato || 'DA_VERIFICARE').toUpperCase();
  if (!STATI.includes(stato)) stato = 'DA_VERIFICARE';

  const evidenze = normalizeEvidence(body.evidenze);
  const attestazioneCassa = Boolean(body.attestazioneManuale || body.provaReale);
  if (conto === 'PROVVISORIA' && stato === 'RICONCILIATO') stato = 'DA_VERIFICARE';
  if (conto === 'CASSA' && stato === 'RICONCILIATO' && !attestazioneCassa && !hasRealEvidence(evidenze)) {
    stato = 'DA_VERIFICARE';
  }
  if (conto !== 'CASSA' && stato === 'RICONCILIATO' && !hasRealEvidence(evidenze)) {
    stato = 'DA_VERIFICARE';
  }

  const createdAt = now instanceof Date ? new Date(now) : new Date(now);
  if (Number.isNaN(createdAt.getTime())) throw new Error('Data creazione non valida');

  return {
    data: validDate(body.data, createdAt),
    conto,
    direzione,
    importo,
    descrizione: cleanText(body.descrizione, { required: true, max: 500, label: 'Descrizione' }),
    tipo: cleanToken(body.tipo, 'ORDINARIO', 'Tipo movimento'),
    stato,
    evidenze,
    fonte: cleanToken(body.fonte, 'MANUALE', 'Fonte movimento'),
    documentoId: cleanText(body.documentoId, { max: 100, label: 'Documento' }),
    contropartita: body.contropartita ? cleanToken(body.contropartita, null, 'Contropartita') : null,
    riferimentoEsterno: cleanText(body.riferimentoEsterno, { max: 300, label: 'Riferimento esterno' }),
    creatoIl: createdAt,
    aggiornatoIl: createdAt
  };
}

export function movimentoDelta(movimento) {
  if (!DIREZIONI.includes(movimento?.direzione)) throw new Error('Direzione movimento non valida');
  const amount = parseMoney(movimento.importo, { label: 'Importo movimento' });
  return movimento.direzione === 'ENTRATA' ? amount : -amount;
}

export function buildLedger(rows, riporto, anno) {
  const ordered = [...rows].sort((a, b) => {
    const da = new Date(a.data).getTime();
    const db = new Date(b.data).getTime();
    if (da !== db) return da - db;
    const ca = new Date(a.creatoIl || a.data).getTime();
    const cb = new Date(b.creatoIl || b.data).getTime();
    if (ca !== cb) return ca - cb;
    return String(a._id || '').localeCompare(String(b._id || ''));
  });

  let saldo = roundMoney(riporto?.saldo || 0);
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
    saldo = roundMoney(saldo + movimentoDelta(row));
    result.push({ ...row, saldoProgressivo: saldo, economico: row.tipo !== 'RIPORTO_APERTURA' });
  }

  return result;
}

export function canReconcile(movimento, body = {}) {
  if (movimento?.conto === 'PROVVISORIA') {
    return { ok: false, motivo: 'Un movimento in Provvisoria deve prima essere classificato' };
  }

  const nuove = normalizeEvidence(body.evidenze);
  const evidenze = [...(Array.isArray(movimento?.evidenze) ? movimento.evidenze : []), ...nuove];
  if (movimento?.conto === 'CASSA') {
    if (body.attestazioneManuale || hasRealEvidence(evidenze)) {
      return {
        ok: true,
        evidenza: body.attestazioneManuale
          ? { tipo: 'ATTESTAZIONE_CASSA', riferimento: cleanText(body.riferimento, { required: true, max: 500, label: 'Riferimento attestazione' }), reale: true }
          : evidenze.find((item) => item.reale)
      };
    }
    return { ok: false, motivo: 'Serve una attestazione manuale esplicita per la Cassa' };
  }

  const evidenza = evidenze.find((item) => item.reale && item.riferimento && REAL_EVIDENCE_TYPES.has(item.tipo));
  return evidenza
    ? { ok: true, evidenza }
    : { ok: false, motivo: 'Serve una evidenza finanziaria reale con riferimento verificabile' };
}

export function relationKey(aTipo, aId, bTipo, bId, relazione) {
  const typeA = cleanToken(aTipo, null, 'Tipo relazione');
  const typeB = cleanToken(bTipo, null, 'Tipo relazione');
  const idA = cleanText(aId, { required: true, max: 200, label: 'ID relazione' });
  const idB = cleanText(bId, { required: true, max: 200, label: 'ID relazione' });
  const relation = cleanToken(relazione, 'COLLEGATO_A', 'Relazione');
  const a = `${typeA}:${idA}`;
  const b = `${typeB}:${idB}`;
  return `${[a, b].sort().join('|')}|${relation}`;
}
