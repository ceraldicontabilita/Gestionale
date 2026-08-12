export const RISCOSSIONE_TYPES = [
  'CARTELLA_PAGAMENTO',
  'INTIMAZIONE',
  'AVVISO_ACCERTAMENTO_ESECUTIVO',
  'AVVISO_ADDEBITO_INPS',
  'RATEIZZAZIONE',
  'COMUNICAZIONE_SOMME_DOVUTE',
  'PAGOPA',
  'QUIETANZA_RISCOSSIONE',
  'SNAPSHOT_ADER',
  'ALTRO_ATTO_RISCOSSIONE'
];

export const RISCOSSIONE_STATES = [
  'DA_VERIFICARE',
  'APERTO',
  'RATEIZZATO',
  'SOSPESO',
  'PAGATO',
  'ANNULLATO'
];

export function normalizeRiscossioneAtto(input = {}, { now = new Date() } = {}) {
  const tipo = normalizeType(input.tipo);
  const importoOriginario = moneyOrNull(input.importoOriginario ?? input.importo);
  const numeroAtto = clean(input.numeroAtto ?? input.identificativoAtto);
  const fonte = clean(input.fonte) || 'MANUALE';
  const fonteRiferimento = clean(input.fonteRiferimento ?? input.url ?? input.documentoId);

  if (!numeroAtto && !fonteRiferimento) {
    throw new Error('Serve numero atto o riferimento della fonte');
  }

  return {
    tipo,
    stato: normalizeState(input.stato || 'DA_VERIFICARE'),
    numeroAtto,
    contribuente: clean(input.contribuente),
    codiceFiscale: clean(input.codiceFiscale),
    entiCreditori: normalizeList(input.entiCreditori ?? input.enteCreditore),
    dataAtto: dateOrNull(input.dataAtto),
    dataNotifica: dateOrNull(input.dataNotifica),
    scadenza: dateOrNull(input.scadenza),
    importoOriginario,
    componenti: normalizeComponents(input.componenti),
    documentoId: clean(input.documentoId),
    fonte: String(fonte).toUpperCase(),
    fonteRiferimento,
    note: clean(input.note),
    creatoIl: now,
    aggiornatoIl: now
  };
}

export function normalizeAderSnapshot(input = {}, { now = new Date() } = {}) {
  const acquisitoIl = dateOrNull(input.acquisitoIl) || now;
  const residuo = moneyOrNull(input.residuo ?? input.importoResiduo);
  const pagato = moneyOrNull(input.pagato ?? input.importoPagato) ?? 0;
  const originario = moneyOrNull(input.importoOriginario);
  const sourceKey = clean(input.sourceKey ?? input.sha256 ?? input.riferimento);
  if (!sourceKey) throw new Error('Snapshot ADER senza identificatore sorgente');

  return {
    sourceKey,
    acquisitoIl,
    importoOriginario: originario,
    importoPagato: pagato,
    importoResiduo: residuo,
    statoAder: normalizeAderState(input.statoAder),
    rateizzazione: normalizeRatePlan(input.rateizzazione),
    procedure: normalizeList(input.procedure),
    misureAgevolative: normalizeList(input.misureAgevolative),
    fonte: String(clean(input.fonte) || 'ADER').toUpperCase(),
    riferimentoFonte: clean(input.riferimentoFonte ?? input.url),
    documentoId: clean(input.documentoId),
    note: clean(input.note),
    creatoIl: now
  };
}

export function recognizeRiscossioneText(text = '') {
  const raw = String(text);
  const upper = raw.toUpperCase();
  const signals = [];
  let tipo = 'ALTRO_ATTO_RISCOSSIONE';
  let confidence = 0.25;

  if (upper.includes('CARTELLA DI PAGAMENTO')) {
    tipo = 'CARTELLA_PAGAMENTO';
    confidence = 0.95;
    signals.push('CARTELLA_DI_PAGAMENTO');
  } else if (upper.includes('AVVISO DI ADDEBITO') && upper.includes('INPS')) {
    tipo = 'AVVISO_ADDEBITO_INPS';
    confidence = 0.95;
    signals.push('AVVISO_ADDEBITO', 'INPS');
  } else if (upper.includes('INTIMAZIONE') && upper.includes('PAGAMENTO')) {
    tipo = 'INTIMAZIONE';
    confidence = 0.85;
    signals.push('INTIMAZIONE', 'PAGAMENTO');
  } else if (upper.includes('ACCERTAMENTO') && upper.includes('ESECUTIVO')) {
    tipo = 'AVVISO_ACCERTAMENTO_ESECUTIVO';
    confidence = 0.85;
    signals.push('ACCERTAMENTO', 'ESECUTIVO');
  } else if (upper.includes('RATEIZZAZIONE') || upper.includes('PIANO DI AMMORTAMENTO')) {
    tipo = 'RATEIZZAZIONE';
    confidence = 0.75;
    signals.push('RATEIZZAZIONE');
  }

  if (upper.includes('AGENZIA DELLE ENTRATE-RISCOSSIONE') || upper.includes('AGENZIA ENTRATE RISCOSSIONE')) {
    signals.push('ADER');
    confidence = Math.min(0.99, confidence + 0.05);
  }

  const numeroAtto = firstMatch(raw, [
    /(?:numero|n\.?|identificativo)\s+(?:atto|cartella)?\s*[:#-]?\s*([A-Z0-9-]{8,40})/i,
    /cartella\s+(?:n\.?|numero)?\s*([A-Z0-9-]{8,40})/i
  ]);

  return {
    tipoProposto: tipo,
    confidenza: confidence,
    segnali: signals,
    numeroAttoProposto: numeroAtto,
    stato: confidence >= 0.9 ? 'PROPOSTA_FORTE' : 'DA_VERIFICARE'
  };
}

export function snapshotSummary(snapshots = []) {
  if (!snapshots.length) return null;
  const sorted = [...snapshots].sort((a, b) => new Date(b.acquisitoIl) - new Date(a.acquisitoIl));
  const latest = sorted[0];
  return {
    acquisitoIl: latest.acquisitoIl,
    importoOriginario: latest.importoOriginario,
    importoPagato: latest.importoPagato,
    importoResiduo: latest.importoResiduo,
    statoAder: latest.statoAder,
    rateizzazione: latest.rateizzazione,
    fonte: latest.fonte,
    riferimentoFonte: latest.riferimentoFonte
  };
}

function normalizeType(value) {
  const type = String(value || 'ALTRO_ATTO_RISCOSSIONE').trim().toUpperCase();
  return RISCOSSIONE_TYPES.includes(type) ? type : 'ALTRO_ATTO_RISCOSSIONE';
}

function normalizeState(value) {
  const state = String(value || 'DA_VERIFICARE').trim().toUpperCase();
  return RISCOSSIONE_STATES.includes(state) ? state : 'DA_VERIFICARE';
}

function normalizeAderState(value) {
  const state = clean(value);
  return state ? state.toUpperCase().replaceAll(' ', '_') : null;
}

function normalizeComponents(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out = {};
  for (const [key, raw] of Object.entries(value)) {
    const amount = moneyOrNull(raw);
    if (amount !== null) out[key] = amount;
  }
  return out;
}

function normalizeRatePlan(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return {
    identificativo: clean(value.identificativo),
    numeroRate: integerOrNull(value.numeroRate),
    ratePagate: integerOrNull(value.ratePagate),
    prossimaScadenza: dateOrNull(value.prossimaScadenza),
    importoRata: moneyOrNull(value.importoRata),
    stato: clean(value.stato)?.toUpperCase() || null
  };
}

function normalizeList(value) {
  if (value === null || value === undefined || value === '') return [];
  const array = Array.isArray(value) ? value : [value];
  return array.map(clean).filter(Boolean);
}

function moneyOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Importo riscossione non valido');
    return round2(value);
  }
  const text = String(value).replace(/\s/g, '').replace(/€/g, '').replace(/\./g, '').replace(',', '.');
  const parsed = Number(text);
  if (!Number.isFinite(parsed)) throw new Error(`Importo riscossione non valido: ${value}`);
  return round2(parsed);
}

function dateOrNull(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  const raw = String(value).trim();
  const it = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  const date = it
    ? new Date(`${it[3]}-${it[2].padStart(2, '0')}-${it[1].padStart(2, '0')}T12:00:00.000Z`)
    : new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

function integerOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isInteger(n) ? n : null;
}

function clean(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}

function firstMatch(text, regexes) {
  for (const regex of regexes) {
    const match = text.match(regex);
    if (match?.[1]) return match[1].trim();
  }
  return null;
}

function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}
