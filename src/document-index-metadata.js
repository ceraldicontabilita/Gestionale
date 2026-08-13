import { PDFParse } from 'pdf-parse';

function clean(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

function normalized(value) {
  return clean(value).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
}

function firstMatch(value, pattern) {
  return clean(value).match(pattern)?.[1] || null;
}

export function classifyDeclaration(row, document = {}) {
  const archivePath = clean(row?.['Percorso archivio']);
  const documentName = clean(document?.['Nome file'] || archivePath.split('/').at(-1));
  const declaredType = clean(row?.Tipo);
  const haystack = normalized(`${declaredType} ${archivePath} ${documentName}`)
    .replace(/[_.-]+/g, ' ')
    .replace(/\s+/g, ' ');

  let model = null;
  let category = null;
  if (/\b770\b/.test(haystack)) { model = 'MODELLO 770'; category = "SOSTITUTI D'IMPOSTA"; }
  else if (/ELENCO\s+PERCIPIENT/.test(haystack)) { model = 'ELENCO PERCIPIENTI'; category = "SOSTITUTI D'IMPOSTA"; }
  else if (/\b760\b/.test(haystack)) { model = 'MODELLO 760'; category = 'REDDITI'; }
  else if (/REDDITI\s+(SC|SOCIETA\s+DI\s+CAPITALI)/.test(haystack)) { model = 'REDDITI SC'; category = 'REDDITI'; }
  else if (/REDDITI\s+(SP|SOCIETA\s+DI\s+PERSONE)/.test(haystack)) { model = 'REDDITI SP'; category = 'REDDITI'; }
  else if (/REDDITI\s+(PF|PERSONE\s+FISICHE)/.test(haystack)) { model = 'REDDITI PF'; category = 'REDDITI'; }
  else if (/\bIRAP\b/.test(haystack)) { model = 'IRAP'; category = 'IRAP'; }
  else if (/\bLIPE\b|LIQUIDAZION[EI]\s+PERIODIC/.test(haystack)) { model = 'LIPE'; category = 'IVA'; }
  else if (/(^|\s)IVA(\s|$)/.test(haystack)) { model = 'DICHIARAZIONE IVA'; category = 'IVA'; }
  else if (/CERTIFICAZIONE\s+UNICA|(^|\s)CU(\s|$)/.test(haystack)) { model = 'CERTIFICAZIONE UNICA'; category = "SOSTITUTI D'IMPOSTA"; }

  if (!model) {
    const usefulDeclaredType = declaredType && !/^DICHIARAZION(E|I)(\s+FISCAL[EI])?$/i.test(declaredType);
    model = usefulDeclaredType ? declaredType.replaceAll('_', ' ').toUpperCase() : 'ALTRA DICHIARAZIONE';
    category = 'ALTRE DICHIARAZIONI';
  }

  const taxYear = clean(row?.['Anno imposta'])
    || firstMatch(`${archivePath} ${documentName}`, /(?:imposta|periodo)[_\s-]*(20\d{2})/i);
  const submissionReference = clean(row?.['Riferimento invio'])
    || firstMatch(documentName, /(?:^|[_\s-])(T\d{12,24})(?:[_\s.-]|$)/i);

  return {
    year: clean(row?.Anno).slice(0, 4),
    taxYear: taxYear ? clean(taxYear).slice(0, 4) : null,
    model,
    category,
    protocol: clean(row?.Protocollo) || null,
    submissionReference: submissionReference?.toUpperCase() || null,
    documentName,
    archivePath
  };
}

export function documentRole(document = {}) {
  const name = normalized(document?.['Nome file'] || document?.name);
  const path = normalized(document?.__path || document?.path);
  if (/^(DATICERT\.XML|SMIME\.P7S|POSTACERT\.EML)$/.test(name)) return 'PROVA_TECNICA';
  if (/__DIMISSIONI_TELEMATICHE__.*\.TXT$/.test(name)) return 'PROVA_TECNICA';
  if (path.includes('/05_MESSAGGI_COMPLETI_RECUPERO/')) return 'PROVA_TECNICA';
  return 'DOCUMENTO_PRINCIPALE';
}

export function resignationFileIdentity(document = {}) {
  const name = clean(document?.['Nome file'] || document?.name).split(/[\\/]/).at(-1);
  const match = name.match(/^(\d{4}-\d{2}-\d{2})-[^_]*__([a-f0-9]{12,32})__([A-Z]{6}\d{2}[A-Z]\d{2}[A-Z]\d{3}[A-Z])_((?:Revoca_)?Dimissione)\.pdf$/i);
  if (!match) return null;
  return {
    documentDate: match[1],
    messageKey: match[2].toLowerCase(),
    employeeTaxId: match[3].toUpperCase(),
    fileKind: match[4].toUpperCase()
  };
}

function label(text, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return clean(String(text || '').match(new RegExp(`(?:^|\\n)\\s*${escaped}\\s+([^\\r\\n]+)`, 'i'))?.[1]);
}

export function maskTaxId(value) {
  const taxId = clean(value).toUpperCase();
  if (taxId.length < 8) return taxId;
  return `${taxId.slice(0, 3)}${'•'.repeat(Math.max(3, taxId.length - 8))}${taxId.slice(-5)}`;
}

export function extractResignationMetadata(text, fallback = {}) {
  const employeeTaxId = label(text, 'Codice Fiscale') || clean(fallback.employeeTaxId);
  const givenName = label(text, 'Nome');
  const familyName = label(text, 'Cognome');
  return {
    employeeName: [givenName, familyName].filter(Boolean).join(' ') || null,
    employeeTaxId: employeeTaxId ? employeeTaxId.toUpperCase() : null,
    employeeTaxIdMasked: maskTaxId(employeeTaxId),
    employmentStartDate: label(text, 'Data Inizio') || null,
    effectiveDate: label(text, 'Data Decorrenza') || null,
    communicationType: label(text, 'Tipo Comunicazione') || null,
    transmissionDate: label(text, 'Data Trasmissione') || null,
    moduleId: label(text, 'Codice Identificativo Modulo') || null
  };
}

export async function readResignationPdf(buffer, fallback = {}) {
  const parser = new PDFParse({ data: Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '') });
  try {
    const output = await parser.getText();
    return extractResignationMetadata(output.text, fallback);
  } finally {
    await parser.destroy();
  }
}
