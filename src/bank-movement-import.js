import crypto from 'node:crypto';
import { parseDelimitedLine, parseDelimitedText } from './csv.js';
import { normalizeMovement } from './domain.js';
import { ensureEventEngineIndexes, publishDomainEventInSession } from './event-engine.js';
import { stableFingerprint } from './fingerprint.js';
import { parseMoney } from './money.js';
import { withMongoTransaction } from './mongo-transaction.js';

export const BANK_BPM_CSV_HEADERS = Object.freeze([
  'Ragione Sociale',
  'Data contabile',
  'Data valuta',
  'Banca',
  'Rapporto',
  'Importo',
  'Divisa',
  'Descrizione',
  'Categoria/sottocategoria',
  'Hashtag'
]);

const readyDatabases = new WeakSet();

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function parseItalianDate(value, label) {
  const match = clean(value).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) throw new Error(`${label} non valida`);
  const [, day, month, year] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (date.getUTCFullYear() !== Number(year) || date.getUTCMonth() !== Number(month) - 1 || date.getUTCDate() !== Number(day)) {
    throw new Error(`${label} non valida`);
  }
  return date;
}

function exactHeaders(text) {
  const firstLine = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').find((line) => line.trim());
  return firstLine ? parseDelimitedLine(firstLine, ';').map((value) => clean(value)) : [];
}

function assertSchema(text) {
  const headers = exactHeaders(text);
  if (headers.length !== BANK_BPM_CSV_HEADERS.length || BANK_BPM_CSV_HEADERS.some((header, index) => headers[index] !== header)) {
    throw Object.assign(new Error('CSV non riconosciuto: atteso export Bank BPM Elenco Entrate/Uscite'), { code: 'BANK_CSV_SCHEMA_UNSUPPORTED' });
  }
}

function extractBankReference(description) {
  const source = clean(description).toUpperCase();
  const patterns = [
    /(?:NS|VS)\.?\s*(?:DISP\.?\s*)?RIF\.?\s*[:.-]?\s*([A-Z0-9][A-Z0-9/_-]{4,80})/,
    /\b(?:CRO|TRN)\s*[:.-]?\s*([A-Z0-9][A-Z0-9/_-]{4,80})/
  ];
  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (match) return match[1];
  }
  return null;
}

function rowBusinessIdentity(row) {
  return {
    company: clean(row['Ragione Sociale']).toUpperCase(),
    bookingDate: clean(row['Data contabile']),
    valueDate: clean(row['Data valuta']),
    bank: clean(row.Banca).toUpperCase(),
    account: clean(row.Rapporto).replace(/\s+/g, '').toUpperCase(),
    amount: clean(row.Importo),
    currency: clean(row.Divisa).toUpperCase(),
    description: clean(row.Descrizione).toUpperCase(),
    category: clean(row['Categoria/sottocategoria']).toUpperCase(),
    hashtag: clean(row.Hashtag).toUpperCase()
  };
}

export function parseBankStatementCsv(content) {
  const text = Buffer.isBuffer(content) ? content.toString('utf8') : String(content || '');
  if (!text.trim()) throw new Error('CSV bancario vuoto');
  if (text.includes('\uFFFD')) throw new Error('Codifica CSV non supportata: esportare in UTF-8');
  assertSchema(text);
  const rawRows = parseDelimitedText(text, { delimiter: ';' });
  const occurrences = new Map();
  return rawRows.map((row, index) => {
    const identity = rowBusinessIdentity(row);
    const identityFingerprint = stableFingerprint(identity);
    const occurrence = (occurrences.get(identityFingerprint) || 0) + 1;
    occurrences.set(identityFingerprint, occurrence);
    const signedAmount = parseMoney(row.Importo, { allowNegative: true, label: `Importo riga ${index + 2}` });
    if (signedAmount === null || signedAmount === 0) throw new Error(`Importo riga ${index + 2} deve essere diverso da zero`);
    const currency = clean(row.Divisa).toUpperCase();
    if (currency !== 'EUR') throw new Error(`Valuta riga ${index + 2} non supportata`);
    const bookingDate = parseItalianDate(row['Data contabile'], `Data contabile riga ${index + 2}`);
    const valueDate = parseItalianDate(row['Data valuta'], `Data valuta riga ${index + 2}`);
    const description = clean(row.Descrizione);
    if (!description) throw new Error(`Descrizione riga ${index + 2} obbligatoria`);
    const accountId = `BANK_ACCOUNT:${sha256(`${identity.bank}|${identity.account}`).slice(0, 32)}`;
    const explicitReference = extractBankReference(description);
    const sourceTransactionId = explicitReference
      ? `BANK_REFERENCE:${explicitReference}`
      : `ROW_FINGERPRINT:${identityFingerprint}:${occurrence}`;
    const movementKey = stableFingerprint({ accountId, sourceTransactionId });
    const amountCents = Math.round(Math.abs(signedAmount) * 100);
    const factFingerprint = stableFingerprint({ accountId, sourceTransactionId, bookingDate, valueDate, direction: signedAmount > 0 ? 'ENTRATA' : 'USCITA', amountCents, currency, description: identity.description });
    return {
      rowNumber: index + 2,
      movementKey,
      factFingerprint,
      accountId,
      sourceTransactionId,
      explicitReference,
      bookingDate,
      valueDate,
      direction: signedAmount > 0 ? 'ENTRATA' : 'USCITA',
      amountCents,
      currency,
      description,
      bank: clean(row.Banca),
      accountReference: clean(row.Rapporto),
      company: clean(row['Ragione Sociale']),
      category: clean(row['Categoria/sottocategoria']),
      hashtag: clean(row.Hashtag),
      occurrence
    };
  });
}

export async function ensureBankMovementIndexes(db) {
  if (readyDatabases.has(db)) return;
  await Promise.all([
    db.collection('movimenti').createIndex({ movementKey: 1 }, { unique: true, sparse: true }),
    db.collection('movimenti').createIndex({ accountId: 1, sourceTransactionId: 1 }, { unique: true, sparse: true }),
    db.collection('bank_statement_imports').createIndex({ importKey: 1 }, { unique: true }),
    db.collection('bank_statement_imports').createIndex({ sourceSha256: 1, importedAt: -1 })
  ]);
  readyDatabases.add(db);
}

function movementEvent(row, source, actor) {
  return {
    type: 'financial.movement_observed',
    aggregate: { type: 'FINANCIAL_MOVEMENT', id: row.movementKey, version: '1' },
    payload: {
      movementKey: row.movementKey,
      accountId: row.accountId,
      sourceTransactionId: row.sourceTransactionId,
      bookingDate: row.bookingDate,
      valueDate: row.valueDate,
      direction: row.direction,
      amountCents: row.amountCents,
      currency: row.currency
    },
    provenance: { source: 'BANK_STATEMENT_CSV', reference: `sha256:${source.sha256}:row:${row.rowNumber}`, actor }
  };
}

export async function importBankStatementRows({ client, db }, rows, source, { actor = 'SYSTEM', now = new Date() } = {}) {
  if (!client || !db) throw new Error('Import bancario richiede MongoDB transazionale');
  if (!Array.isArray(rows)) throw new Error('Righe bancarie mancanti');
  await Promise.all([ensureBankMovementIndexes(db), ensureEventEngineIndexes(db)]);
  const totals = { rows: rows.length, inserted: 0, duplicates: 0, conflicts: 0, errors: [] };

  for (const row of rows) {
    try {
      const result = await withMongoTransaction(client, async (session) => {
        const existing = await db.collection('movimenti').findOne({ movementKey: row.movementKey }, { session });
        const sourceKey = `${source.sha256}:row:${row.rowNumber}`;
        const sourceRow = { sourceKey, sha256: source.sha256, gridFsId: source.gridFsId, filename: source.filename, rowNumber: row.rowNumber, importedAt: now };
        if (existing) {
          if (existing.factFingerprint !== row.factFingerprint) throw Object.assign(new Error('MOVEMENT_KEY_CONFLICT'), { code: 'MOVEMENT_KEY_CONFLICT' });
          await db.collection('movimenti').updateOne(
            { movementKey: row.movementKey, 'sourceRows.sourceKey': { $ne: sourceKey } },
            { $addToSet: { sourceRows: sourceRow, sourceFileSha256: source.sha256 }, $set: { aggiornatoIl: now } },
            { session }
          );
          return { duplicate: true };
        }
        const evidenceReference = `BANK:${row.accountId}:${row.sourceTransactionId}`;
        const movement = {
          ...normalizeMovement({
            data: row.bookingDate,
            conto: 'BANCA',
            direzione: row.direction,
            importo: row.amountCents / 100,
            descrizione: row.description,
            tipo: 'ESTRATTO_CONTO',
            stato: 'DOCUMENTATO',
            evidenze: [{ tipo: 'MOVIMENTO_BANCARIO', riferimento: evidenceReference, reale: true }],
            fonte: 'ESTRATTO_CONTO_CSV',
            riferimentoEsterno: row.explicitReference || row.sourceTransactionId
          }, { now }),
          movementKey: row.movementKey,
          factFingerprint: row.factFingerprint,
          accountId: row.accountId,
          sourceTransactionId: row.sourceTransactionId,
          dataValuta: row.valueDate,
          valuta: row.currency,
          banca: row.bank,
          rapporto: row.accountReference,
          ragioneSocialeConto: row.company,
          categoriaBancaria: row.category,
          hashtag: row.hashtag,
          sourceRows: [sourceRow],
          sourceFileSha256: [source.sha256]
        };
        await db.collection('movimenti').insertOne(movement, { session });
        const published = await publishDomainEventInSession(db, movementEvent(row, source, actor), { session, now });
        await db.collection('movimenti').updateOne({ movementKey: row.movementKey }, { $set: { sourceEventKey: published.event.eventKey } }, { session });
        return { duplicate: false };
      });
      if (result.duplicate) totals.duplicates += 1;
      else totals.inserted += 1;
    } catch (error) {
      totals.conflicts += 1;
      totals.errors.push({ rowNumber: row.rowNumber, code: String(error.code || error.message || 'IMPORT_ERROR').slice(0, 120) });
    }
  }

  const importKey = `${source.sha256}:${stableFingerprint(rows.map((row) => row.movementKey))}`;
  await db.collection('bank_statement_imports').updateOne(
    { importKey },
    { $setOnInsert: { importKey, sourceSha256: source.sha256, filename: source.filename, rowCount: rows.length, actor, importedAt: now }, $set: { totals, updatedAt: now } },
    { upsert: true }
  );
  return totals;
}
