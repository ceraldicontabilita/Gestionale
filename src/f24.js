import { parseMoney, roundMoney } from './money.js';

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

export const F24_DOCUMENT_TYPES = Object.freeze([
  'F24_MODELLO',
  'F24_QUIETANZA_AE',
  'F24_FORMATO_STAMPABILE'
]);

export const F24_STATES = Object.freeze([
  'DA_VERIFICARE',
  'DOCUMENTATO',
  'IN_ATTESA_RISCONTRO',
  'RICONCILIATO',
  'COMPENSATO'
]);

export function parseItalianAmount(value) {
  return parseMoney(value, { label: 'Importo F24' });
}

export function normalizeProtocol(value) {
  const raw = String(value || '').trim();
  if (!raw || raw === '-') return null;
  const clean = raw.replace(/\s+/g, '').replace(/-(\d{6})$/, '/$1');
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
  const numeroModelliF24 = Number(input.numero_modelli_f24 ?? input.numeroModelliF24 ?? 1);
  if (!Number.isInteger(annoElenco) || annoElenco < 2000 || annoElenco > 2100) throw new Error('Anno elenco F24 non valido');
  if (!Number.isInteger(indicePortale) || indicePortale < 0) throw new Error('Indice portale F24 non valido');
  if (!Number.isInteger(numeroModello) || numeroModello < 1) throw new Error('Numero modello F24 non valido');
  if (!Number.isInteger(numeroModelliF24) || numeroModelliF24 < 1) throw new Error('Numero modelli F24 non valido');

  const rawType = String(input.tipo_documento ?? input.tipoDocumento ?? '').toUpperCase();
  const tipoDocumento = rawType.includes('FORMATO STAMPABILE')
    ? 'F24_FORMATO_STAMPABILE'
    : rawType.includes('QUIETANZA')
      ? 'F24_QUIETANZA_AE'
      : 'F24_MODELLO';

  const sha256 = String(input.sha256 || '').trim().toLowerCase() || null;
  if (sha256 && !/^[a-f0-9]{64}$/.test(sha256)) throw new Error('SHA-256 F24 non valido');
  const file = String(input.file || input.nomeFile || '').trim() || null;
  const protocollo = normalizeProtocol(input.protocollo_telematico ?? input.protocolloTelematico);
  const protocolloPdf = normalizeProtocol(input.protocollo_letto_nel_pdf ?? input.protocolloLettoNelPdf);
  const operationKey = `${annoElenco}:${indicePortale}`;
  const sourceKey = [operationKey, numeroModello, sha256 || file || 'senza-file'].join(':');
  const saldoOperazione = parseItalianAmount(input.saldo_operazione ?? input.saldoOperazione);
  const saldoModello = parseItalianAmount(input.saldo_del_modello ?? input.saldoDelModello);
  const saldoRilevante = saldoModello ?? saldoOperazione ?? 0;

  return {
    sourceKey,
    operationKey,
    annoElenco,
    indicePortale,
    dataVersamento: parseItalianDate(input.data_versamento ?? input.dataVersamento),
    numeroModelliF24,
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
    stato: saldoRilevante === 0 ? 'COMPENSATO' : 'IN_ATTESA_RISCONTRO'
  };
}

export function normalizeF24Row(input = {}, registryEntry = null) {
  const sezione = normalizeSection(input.sezione);
  const debito = parseItalianAmount(input.debito ?? input.importoDebito) ?? 0;
  const credito = parseItalianAmount(input.credito ?? input.importoCredito) ?? 0;
  if (debito < 0 || credito < 0) throw new Error('Debito/credito F24 non possono essere negativi');
  if (debito > 0 && credito > 0) throw new Error('Una riga F24 non può essere contemporaneamente a debito e a credito');

  const contributiva = ['INPS', 'INAIL'].includes(sezione);
  const codice = contributiva
    ? String(input.causaleContributo ?? input.causale ?? input.codice ?? '').trim().toUpperCase()
    : String(input.codiceTributo ?? input.codice ?? '').trim().toUpperCase();
  if (!codice) throw new Error('Codice/causale F24 mancante');

  return {
    sezione,
    namespace: registryNamespaceForSection(sezione),
    codice,
    codiceTributo: contributiva ? null : codice,
    causaleContributo: contributiva ? codice : null,
    codiceSede: clean(input.codiceSede),
    codiceEnteComune: clean(input.codiceEnteComune)?.toUpperCase() || null,
    matricolaCodiceInps: clean(input.matricolaCodiceInps),
    codiceDittaInail: clean(input.codiceDittaInail ?? input.codiceDitta),
    numeroRiferimentoInail: clean(input.numeroRiferimentoInail ?? input.numeroRiferimento),
    rateazioneMeseRif: clean(input.rateazioneMeseRif),
    periodoDa: normalizePeriod(input.periodoDa),
    periodoA: normalizePeriod(input.periodoA),
    annoRiferimento: toIntegerOrNull(input.annoRiferimento),
    debito,
    credito,
    netto: roundMoney(debito - credito),
    raw: input.raw ? String(input.raw) : null,
    classificazione: registryEntry ? classificationFromRegistry(registryEntry) : { stato: 'DA_VERIFICARE' }
  };
}

export function classificationFromRegistry(registryEntry) {
  return {
    stato: 'CLASSIFICATO',
    registroId: registryEntry._id || null,
    descrizione: registryEntry.descrizione || null,
    natura: registryEntry.natura || null,
    conto: registryEntry.conto || null,
    fonte: registryEntry.fonte || null,
    verificatoIl: registryEntry.verificatoIl || null
  };
}

export function calculateF24Totals(rows = []) {
  const debiti = roundMoney(rows.reduce((sum, row) => sum + Number(row.debito || 0), 0));
  const crediti = roundMoney(rows.reduce((sum, row) => sum + Number(row.credito || 0), 0));
  return { debiti, crediti, saldo: roundMoney(debiti - crediti) };
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
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const raw = String(value).trim();
  const match = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (match) {
    const date = new Date(`${match[3]}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}T12:00:00.000Z`);
    return Number.isNaN(date.getTime()) ? null : date;
  }
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

function clean(value) {
  if (value === null || value === undefined) return null;
  const result = String(value).trim();
  return result || null;
}
