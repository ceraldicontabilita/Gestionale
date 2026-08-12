const SECTION_ALIASES = new Map([
  ['ERARIO', 'ERARIO'],
  ['INPS', 'INPS'],
  ['REGIONI', 'REGIONI'],
  ['TRIB.LOCALI', 'IMU_E_TRIBUTI_LOCALI'],
  ['TRIBUTI LOCALI', 'IMU_E_TRIBUTI_LOCALI'],
  ['IMU E ALTRI TRIBUTI LOCALI', 'IMU_E_TRIBUTI_LOCALI'],
  ['INAIL', 'INAIL'],
  ['ALTRI ENTI', 'ALTRI_ENTI']
]);

export const F24_DOCUMENT_TYPES = [
  'F24_MODELLO',
  'F24_QUIETANZA_AE',
  'F24_FORMATO_STAMPABILE'
];

export const F24_STATES = [
  'DA_VERIFICARE',
  'DOCUMENTATO',
  'IN_ATTESA_RISCONTRO',
  'RICONCILIATO',
  'COMPENSATO'
];

export function parseItalianAmount(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Importo F24 non valido');
    return Math.round(value * 100) / 100;
  }

  const text = String(value)
    .replace(/\s/g, '')
    .replace(/€/g, '')
    .replace(/\./g, '')
    .replace(',', '.')
    .trim();
  if (!text) return null;
  const parsed = Number(text);
  if (!Number.isFinite(parsed)) throw new Error(`Importo F24 non valido: ${value}`);
  return Math.round(parsed * 100) / 100;
}

export function normalizeProtocol(value) {
  const raw = String(value || '').trim();
  if (!raw || raw === '-') return null;
  const clean = raw.replace(/\s+/g, '').replace('-', '/');
  const match = clean.match(/^(\d{10,20})\/?(\d{6})?$/);
  if (!match) return raw;
  return match[2] ? `${match[1]}/${match[2]}` : match[1];
}

export function normalizeSection(value) {
  const key = String(value || '').trim().toUpperCase();
  return SECTION_ALIASES.get(key) || key.replaceAll('.', '').replaceAll(' ', '_') || 'ALTRO';
}

export function registryNamespaceForSection(section) {
  const normalized = normalizeSection(section);
  if (normalized === 'INPS') return 'CAUSALE_INPS';
  if (normalized === 'INAIL') return 'CAUSALE_INAIL';
  return 'CODICE_TRIBUTO_AE';
}

export function buildF24FromIndexRow(input = {}) {
  const annoElenco = Number(input.anno_elenco ?? input.annoElenco);
  const indicePortale = Number(input.indice_portale ?? input.indicePortale);
  const numeroModello = Number(input.numero_modello_nel_gruppo ?? input.numeroModelloNelGruppo ?? 1);
  if (!Number.isInteger(annoElenco)) throw new Error('Anno elenco F24 non valido');
  if (!Number.isInteger(indicePortale)) throw new Error('Indice portale F24 non valido');

  const rawType = String(input.tipo_documento ?? input.tipoDocumento ?? '').toUpperCase();
  const tipoDocumento = rawType.includes('QUIETANZA')
    ? 'F24_QUIETANZA_AE'
    : rawType.includes('FORMATO STAMPABILE')
      ? 'F24_FORMATO_STAMPABILE'
      : 'F24_MODELLO';

  const sha256 = String(input.sha256 || '').trim().toLowerCase() || null;
  const file = String(input.file || input.nomeFile || '').trim() || null;
  const protocollo = normalizeProtocol(input.protocollo_telematico ?? input.protocolloTelematico);
  const protocolloPdf = normalizeProtocol(input.protocollo_letto_nel_pdf ?? input.protocolloLettoNelPdf);
  const sourceKey = [annoElenco, indicePortale, numeroModello, sha256 || file || 'senza-file'].join(':');

  const saldoOperazione = parseItalianAmount(input.saldo_operazione ?? input.saldoOperazione);
  const saldoModello = parseItalianAmount(input.saldo_del_modello ?? input.saldoDelModello);

  return {
    sourceKey,
    annoElenco,
    indicePortale,
    dataVersamento: parseItalianDate(input.data_versamento ?? input.dataVersamento),
    numeroModelliF24: Number(input.numero_modelli_f24 ?? input.numeroModelliF24 ?? 1),
    numeroModelloNelGruppo: numeroModello,
    saldoOperazione,
    saldoModello,
    protocollo,
    protocolloLettoNelPdf: protocolloPdf,
    tipoDocumento,
    originePortale: String(input.origine_portale ?? input.originePortale ?? '').trim() || null,
    file,
    pagine: toIntegerOrNull(input.pagine),
    byte: toIntegerOrNull(input.byte),
    sha256,
    urlSorgente: String(input.url_sorgente ?? input.urlSorgente ?? '').trim() || null,
    nota: String(input.nota || '').trim() || null,
    provaPagamento: false,
    stato: saldoModello === 0 ? 'DOCUMENTATO' : 'IN_ATTESA_RISCONTRO'
  };
}

export function normalizeF24Row(input = {}, registryEntry = null) {
  const sezione = normalizeSection(input.sezione);
  const debito = parseItalianAmount(input.debito ?? input.importoDebito) ?? 0;
  const credito = parseItalianAmount(input.credito ?? input.importoCredito) ?? 0;
  if (debito < 0 || credito < 0) throw new Error('Debito/credito F24 non possono essere negativi');
  if (debito > 0 && credito > 0) throw new Error('Una riga F24 non può essere contemporaneamente a debito e a credito');

  const codice = sezione === 'INPS'
    ? String(input.causaleContributo ?? input.codice ?? '').trim().toUpperCase()
    : String(input.codiceTributo ?? input.codice ?? '').trim().toUpperCase();
  if (!codice) throw new Error('Codice/causale F24 mancante');

  return {
    sezione,
    namespace: registryNamespaceForSection(sezione),
    codice,
    codiceTributo: sezione === 'INPS' ? null : codice,
    causaleContributo: sezione === 'INPS' ? codice : null,
    codiceSede: input.codiceSede ? String(input.codiceSede).trim() : null,
    codiceEnteComune: input.codiceEnteComune ? String(input.codiceEnteComune).trim().toUpperCase() : null,
    matricolaCodiceInps: input.matricolaCodiceInps ? String(input.matricolaCodiceInps).trim() : null,
    rateazioneMeseRif: input.rateazioneMeseRif ? String(input.rateazioneMeseRif).trim() : null,
    periodoDa: normalizePeriod(input.periodoDa),
    periodoA: normalizePeriod(input.periodoA),
    annoRiferimento: toIntegerOrNull(input.annoRiferimento),
    debito,
    credito,
    netto: round2(debito - credito),
    raw: input.raw ? String(input.raw) : null,
    classificazione: registryEntry
      ? {
          stato: 'CLASSIFICATO',
          registroId: registryEntry._id || null,
          descrizione: registryEntry.descrizione || null,
          natura: registryEntry.natura || null,
          conto: registryEntry.conto || null,
          fonte: registryEntry.fonte || null,
          verificatoIl: registryEntry.verificatoIl || null
        }
      : { stato: 'DA_VERIFICARE' }
  };
}

export function calculateF24Totals(rows = []) {
  const debiti = round2(rows.reduce((sum, row) => sum + Number(row.debito || 0), 0));
  const crediti = round2(rows.reduce((sum, row) => sum + Number(row.credito || 0), 0));
  return { debiti, crediti, saldo: round2(debiti - crediti) };
}

export function parseQuietanzaText(text = '') {
  const lines = String(text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const isQuietanza = lines.some((line) => line.includes('QUIETANZA DI VERSAMENTO'));
  const soggettoLine = lines.find((line) => line.startsWith('Soggetto:')) || '';
  const soggettoMatch = soggettoLine.match(/^Soggetto:\s*(.*?)\s*\(\s*([A-Z0-9]+)\s*\)/i);
  const rows = [];

  for (const line of lines) {
    let match = line.match(/^ERARIO\s+(\w+)\s+(\S+)\s+(\d{4})\s+([\d.,]+)\s+([\d.,]+)$/i);
    if (match) {
      rows.push(normalizeF24Row({
        sezione: 'ERARIO', codiceTributo: match[1], rateazioneMeseRif: match[2], annoRiferimento: match[3],
        debito: match[4], credito: match[5], raw: line
      }));
      continue;
    }

    match = line.match(/^INPS\s+(\w+)\s+(\w+)\s+(\S+)\s+(\d{1,2})\s+(\d{4})\s+(\d{1,2})\s+(\d{4})\s+([\d.,]+)\s+([\d.,]+)$/i);
    if (match) {
      rows.push(normalizeF24Row({
        sezione: 'INPS', codiceSede: match[1], causaleContributo: match[2], matricolaCodiceInps: match[3],
        periodoDa: `${match[4].padStart(2, '0')}/${match[5]}`, periodoA: `${match[6].padStart(2, '0')}/${match[7]}`,
        debito: match[8], credito: match[9], raw: line
      }));
      continue;
    }

    match = line.match(/^REGIONI\s+(\w+)\s+(\w+)\s+(\S+)\s+(\d{4})\s+([\d.,]+)\s+([\d.,]+)$/i);
    if (match) {
      rows.push(normalizeF24Row({
        sezione: 'REGIONI', codiceEnteComune: match[1], codiceTributo: match[2], rateazioneMeseRif: match[3],
        annoRiferimento: match[4], debito: match[5], credito: match[6], raw: line
      }));
      continue;
    }

    match = line.match(/^TRIB\.LOCALI\s+(\w+)\s+(\w+)\s+(\S+)\s+(\d{4})\s+([\d.,]+)\s+([\d.,]+)$/i);
    if (match) {
      rows.push(normalizeF24Row({
        sezione: 'IMU E ALTRI TRIBUTI LOCALI', codiceEnteComune: match[1], codiceTributo: match[2], rateazioneMeseRif: match[3],
        annoRiferimento: match[4], debito: match[5], credito: match[6], raw: line
      }));
    }
  }

  return {
    riconosciuto: isQuietanza,
    tipoDocumento: isQuietanza ? 'F24_QUIETANZA_AE' : 'DA_VERIFICARE',
    contribuente: soggettoMatch ? soggettoMatch[1].trim() : null,
    codiceFiscale: soggettoMatch ? soggettoMatch[2].trim() : null,
    righe: rows,
    totali: calculateF24Totals(rows)
  };
}

function parseItalianDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  const raw = String(value).trim();
  const match = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (match) return new Date(`${match[3]}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}T12:00:00.000Z`);
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function normalizePeriod(value) {
  if (!value) return null;
  const raw = String(value).trim();
  const match = raw.match(/^(\d{1,2})[\/-](\d{4})$/);
  return match ? `${match[1].padStart(2, '0')}/${match[2]}` : raw;
}

function toIntegerOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isInteger(n) ? n : null;
}

function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}
