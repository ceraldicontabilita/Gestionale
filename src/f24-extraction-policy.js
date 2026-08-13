const DEFAULT_REQUIRED_MARKERS = Object.freeze([
  'CODICE FISCALE',
  'ERARIO',
  'SALDO'
]);

export const F24_EXTRACTION_MODES = Object.freeze([
  'NATIVE_ONLY',
  'NATIVE_PLUS_TARGETED_OCR',
  'OCR_FULL',
  'MANUAL_REVIEW'
]);

export const F24_ESSENTIAL_FIELDS = Object.freeze([
  'taxpayerFiscalCode',
  'modelDate',
  'lines',
  'totalDebit',
  'totalCredit',
  'finalBalance'
]);

function normalizedText(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

function present(value) {
  if (Array.isArray(value)) return value.length > 0;
  return value !== null && value !== undefined && String(value).trim() !== '';
}

function missingFields(fields = {}, requiredFields = F24_ESSENTIAL_FIELDS) {
  return requiredFields.filter((field) => !present(fields[field]));
}

export function evaluateF24ExtractionPolicy({
  pages = [],
  fields = {},
  requiredFields = F24_ESSENTIAL_FIELDS,
  requiredMarkers = DEFAULT_REQUIRED_MARKERS,
  accountingStatus = 'NON_VERIFICATO',
  documentOrigin = null
} = {}) {
  const pageTexts = pages.map((page) => String(page?.text || ''));
  const joinedText = normalizedText(pageTexts.join('\n'));
  const nativeCharacters = joinedText.replace(/\s/g, '').length;
  const pagesWithText = pageTexts.filter((text) => normalizedText(text).length >= 20).length;
  const missing = missingFields(fields, requiredFields);
  const missingMarkers = requiredMarkers.filter((marker) => !joinedText.includes(normalizedText(marker)));
  const hasNativeText = nativeCharacters >= 80 && pagesWithText > 0;
  const quadratureFailed = accountingStatus === 'CONTESTATO';
  const quadratureConfirmed = accountingStatus === 'QUADRATO';
  const reasons = [];

  if (!hasNativeText) reasons.push('TESTO_NATIVO_ASSENTE_O_INSUFFICIENTE');
  if (missing.length) reasons.push('CAMPI_ESSENZIALI_MANCANTI');
  if (missingMarkers.length) reasons.push('MARCATORI_F24_MANCANTI');
  if (quadratureFailed) reasons.push('QUADRATURA_FALLITA');

  let mode;
  if (!hasNativeText) {
    mode = 'OCR_FULL';
  } else if (missing.length || missingMarkers.length || quadratureFailed) {
    mode = 'NATIVE_PLUS_TARGETED_OCR';
  } else if (quadratureConfirmed) {
    mode = 'NATIVE_ONLY';
  } else {
    mode = 'MANUAL_REVIEW';
    reasons.push('QUADRATURA_NON_CONFERMATA');
  }

  return {
    mode,
    nativeTextAuthoritative: hasNativeText,
    ocrCanOverwriteNative: false,
    ocrPurpose: mode === 'NATIVE_ONLY' ? 'NONE' : mode === 'OCR_FULL' ? 'RECOVERY' : 'VERIFICATION',
    documentOrigin: documentOrigin ? String(documentOrigin).toUpperCase() : null,
    metrics: { nativeCharacters, pagesWithText, totalPages: pages.length },
    missingFields: missing,
    missingMarkers,
    reasons: [...new Set(reasons)],
    requiresHumanReview: mode === 'MANUAL_REVIEW'
  };
}

function normalizeFiscalCode(value) {
  return String(value || '').replace(/\s+/g, '').toUpperCase();
}

function normalizeDate(value) {
  const raw = String(value || '').trim();
  const italian = raw.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/);
  return italian ? `${italian[3]}-${italian[2].padStart(2, '0')}-${italian[1].padStart(2, '0')}` : raw;
}

function normalizeAmount(value) {
  const raw = String(value ?? '').replace(/\s/g, '').replace(/€/g, '');
  if (!raw) return null;
  const normalized = raw.includes(',') ? raw.replaceAll('.', '').replace(',', '.') : raw;
  const amount = Number(normalized);
  return Number.isFinite(amount) ? amount.toFixed(2) : null;
}

function normalizeComparable(fieldType, value) {
  if (value === null || value === undefined) return null;
  if (fieldType === 'AMOUNT') return normalizeAmount(value);
  if (fieldType === 'FISCAL_CODE' || fieldType === 'CODE') return normalizeFiscalCode(value);
  if (fieldType === 'DATE') return normalizeDate(value);
  return normalizedText(value);
}

export function compareNativeAndOcrField({
  field,
  fieldType = 'TEXT',
  nativeValue = null,
  ocrValue = null,
  nativeSource = null,
  ocrSource = null,
  ocrConfidence = null
} = {}) {
  const nativeNormalized = normalizeComparable(fieldType, nativeValue);
  const ocrNormalized = normalizeComparable(fieldType, ocrValue);
  let comparison;
  if (nativeNormalized === null && ocrNormalized === null) comparison = 'NOT_DETERMINABLE';
  else if (nativeNormalized === null) comparison = 'OCR_RECOVERY_REQUIRES_REVIEW';
  else if (ocrNormalized === null) comparison = 'NATIVE_ONLY';
  else comparison = nativeNormalized === ocrNormalized ? 'MATCH' : 'CONFLICT';

  return {
    field: String(field || ''),
    fieldType: String(fieldType || 'TEXT').toUpperCase(),
    native: { value: nativeNormalized, rawValue: nativeValue, source: nativeSource },
    ocr: { value: ocrNormalized, rawValue: ocrValue, source: ocrSource, confidence: ocrConfidence },
    comparison,
    acceptedValue: comparison === 'MATCH' || comparison === 'NATIVE_ONLY' ? nativeNormalized : null,
    state: comparison === 'MATCH' ? 'VALIDATO' : comparison === 'NATIVE_ONLY' ? 'ESTRATTO' : comparison === 'CONFLICT' ? 'CONTESTATO' : 'NON_DETERMINABILE',
    autoConfirm: comparison === 'MATCH',
    requiresHumanReview: ['CONFLICT', 'OCR_RECOVERY_REQUIRES_REVIEW', 'NOT_DETERMINABLE'].includes(comparison)
  };
}

export function buildTargetedOcrPlan({ policy, fieldLocations = {} } = {}) {
  if (!policy || policy.mode === 'NATIVE_ONLY') return { enabled: false, fullDocument: false, targets: [] };
  if (policy.mode === 'OCR_FULL') return { enabled: true, fullDocument: true, targets: [] };
  const targetNames = [...new Set([...(policy.missingFields || []), ...(policy.reasons?.includes('QUADRATURA_FALLITA') ? ['amountColumns', 'sectionTotals', 'finalBalance'] : [])])];
  return {
    enabled: targetNames.length > 0,
    fullDocument: false,
    targets: targetNames.map((field) => ({ field, location: fieldLocations[field] || null, requiresCoordinates: !fieldLocations[field] }))
  };
}
