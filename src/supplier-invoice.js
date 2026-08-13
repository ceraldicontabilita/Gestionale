import { parseMoney, roundMoney } from './money.js';
import { ensureEventEngineIndexes, publishDomainEventInSession } from './event-engine.js';
import { stableFingerprint } from './fingerprint.js';
import { withMongoTransaction } from './mongo-transaction.js';
import { projectSupplierInvoiceValidated } from './supplier-invoice-projection.js';

const readyDatabases = new WeakSet();
const ACCOUNT = /^[A-Z0-9_.:-]{1,120}$/;

function requiredText(value, label, max = 500) {
  const result = String(value ?? '').trim();
  if (!result) throw new Error(`${label} obbligatorio`);
  if (result.length > max) throw new Error(`${label} troppo lungo`);
  return result;
}

function account(value, label) {
  const result = requiredText(value, label, 120).toUpperCase();
  if (!ACCOUNT.test(result)) throw new Error(`${label} non valido`);
  return result;
}

function isoDate(value, label) {
  const result = value instanceof Date ? new Date(value) : new Date(value);
  if (Number.isNaN(result.getTime())) throw new Error(`${label} non valida`);
  return result;
}

function cents(value, label, options) {
  const parsed = parseMoney(value, { label, ...options });
  if (parsed === null) throw new Error(`${label} obbligatorio`);
  return Math.round(parsed * 100);
}

function sourceId(source) {
  if (source?._id) return String(source._id);
  return requiredText(source?.sourceKey, 'Chiave fonte', 500);
}

function canonicalNaturalKey(source) {
  const issuer = source?.fornitore?.partitaIva || source?.fornitore?.codiceFiscale;
  return [
    requiredText(issuer, 'Identificativo fiscale fornitore', 40).toUpperCase(),
    requiredText(source?.numero, 'Numero fattura', 120).toUpperCase(),
    isoDate(source?.data, 'Data fattura').toISOString().slice(0, 10),
    requiredText(source?.tipoDocumento, 'Tipo documento', 40).toUpperCase()
  ].join('|');
}

export async function ensureSupplierInvoiceIndexes(db) {
  if (readyDatabases.has(db)) return;
  await Promise.all([
    db.collection('invoice_suppliers').createIndex({ invoiceId: 1, version: 1 }, { unique: true }),
    db.collection('invoice_suppliers').createIndex({ naturalKey: 1, current: 1 }, { unique: true, partialFilterExpression: { current: true } }),
    db.collection('invoice_suppliers').createIndex({ 'sources.sourceKey': 1, 'sources.sourceVersion': 1 }, { unique: true }),
    db.collection('obligations').createIndex({ obligationKey: 1, version: 1 }, { unique: true }),
    db.collection('open_items').createIndex({ obligationKey: 1 }, { unique: true }),
    db.collection('vat_entries').createIndex({ vatEntryKey: 1 }, { unique: true })
  ]);
  readyDatabases.add(db);
}

export function buildSupplierInvoiceValidation(source, input, { actor, now = new Date() } = {}) {
  if (!source || typeof source !== 'object') throw new Error('Fattura importata non trovata');
  if (String(source.stato || '').toUpperCase() === 'SCARTATA') throw new Error('Fattura importata scartata');
  if (source.extractionVersion !== 'FATTURAPA_XML_V2' || source.quadraturaEstrazione?.status !== 'EXACT') {
    throw new Error('Fattura priva di estrazione XML canonica esatta');
  }
  const currency = requiredText(source.divisa || 'EUR', 'Valuta', 10).toUpperCase();
  if (currency !== 'EUR') throw new Error('La prima integrazione ammette esclusivamente fatture EUR');

  const naturalKey = canonicalNaturalKey(source);
  const invoiceId = stableFingerprint({ entity: 'INVOICE_SUPPLIER', naturalKey }).slice(0, 32);
  const version = requiredText(input?.version || '1', 'Versione validazione', 40);
  const taxableCents = cents(source.imponibile, 'Imponibile');
  const exposedVatCents = cents(source.ivaEsposta, 'IVA esposta');
  const deductibleVatCents = cents(input?.ivaDetraibile, 'IVA detraibile');
  const totalCents = cents(source.totaleDocumento, 'Totale documento');
  const withholdingCents = cents(source.ritenuta || 0, 'Ritenuta');
  if (deductibleVatCents > exposedVatCents) throw new Error('IVA detraibile superiore all IVA esposta');
  if (totalCents <= 0) throw new Error('Totale documento non positivo');
  if (taxableCents < 0 || exposedVatCents < 0 || withholdingCents < 0) throw new Error('Componenti fattura non valide');
  const payableCents = totalCents - withholdingCents;
  if (payableCents <= 0) throw new Error('Debito fornitore non positivo');
  const costCents = totalCents - deductibleVatCents;
  if (costCents <= 0) throw new Error('Costo contabile non positivo');

  const documentDate = isoDate(source.data, 'Data documento');
  const receiptDate = isoDate(input?.receiptDate, 'Data ricezione');
  const competenceDate = isoDate(input?.competenceDate || source.data, 'Data competenza');
  const registrationDate = isoDate(input?.registrationDate || now, 'Data registrazione');
  const vatDate = isoDate(input?.vatDate || input?.receiptDate, 'Data IVA');
  const dueDate = input?.dueDate || source.pagamenti?.find((item) => item?.scadenza)?.scadenza;
  const normalizedDueDate = dueDate ? isoDate(dueDate, 'Data scadenza') : null;
  const costAccount = account(input?.costAccountCode, 'Conto costo');
  const vatAccount = deductibleVatCents > 0 ? account(input?.vatAccountCode, 'Conto IVA') : null;
  const payableAccount = account(input?.payableAccountCode, 'Conto debiti fornitori');
  const withholdingAccount = withholdingCents > 0 ? account(input?.withholdingAccountCode, 'Conto ritenute') : null;

  const lines = [{ accountCode: costAccount, debit: costCents / 100, credit: 0, description: 'Costo fattura fornitore' }];
  if (deductibleVatCents > 0) lines.push({ accountCode: vatAccount, debit: deductibleVatCents / 100, credit: 0, description: 'IVA detraibile fattura fornitore' });
  lines.push({ accountCode: payableAccount, debit: 0, credit: payableCents / 100, description: 'Debito verso fornitore' });
  if (withholdingCents > 0) lines.push({ accountCode: withholdingAccount, debit: 0, credit: withholdingCents / 100, description: 'Ritenuta da versare' });
  const debit = lines.reduce((sum, line) => sum + Math.round(line.debit * 100), 0);
  const credit = lines.reduce((sum, line) => sum + Math.round(line.credit * 100), 0);
  if (debit !== credit) throw new Error('Quadratura contabile fattura non esatta');

  const sourceKey = requiredText(source.sourceKey, 'Chiave fonte', 500);
  const invoice = {
    invoiceId,
    version,
    naturalKey,
    current: true,
    sourceKey,
    sourceVersion: requiredText(input?.sourceVersion || source.aggiornatoIl?.toISOString?.() || source.aggiornatoIl || '1', 'Versione fonte', 120),
    documentId: sourceId(source),
    documentType: requiredText(source.tipoDocumento, 'Tipo documento', 40).toUpperCase(),
    number: requiredText(source.numero, 'Numero fattura', 120),
    supplier: {
      vatId: source.fornitore?.partitaIva ? requiredText(source.fornitore.partitaIva, 'Partita IVA', 40) : null,
      taxId: source.fornitore?.codiceFiscale ? requiredText(source.fornitore.codiceFiscale, 'Codice fiscale', 40) : null,
      name: requiredText(source.fornitore?.denominazione, 'Denominazione fornitore', 300)
    },
    currency,
    dates: { documentDate, receiptDate, competenceDate, registrationDate, vatDate, dueDate: normalizedDueDate },
    amounts: {
      taxableCents,
      exposedVatCents,
      deductibleVatCents,
      nonDeductibleVatCents: exposedVatCents - deductibleVatCents,
      totalCents,
      withholdingCents,
      payableCents,
      costCents
    },
    posting: {
      ruleId: account(input?.postingRule?.id, 'Regola contabile'),
      ruleVersion: requiredText(input?.postingRule?.version, 'Versione regola contabile', 120),
      lines
    },
    sourceLines: Array.isArray(source.righe) ? source.righe : [],
    vatSummaries: Array.isArray(source.riepiloghiIva) ? source.riepiloghiIva : [],
    validation: {
      status: 'VALIDATED',
      actor: requiredText(actor, 'Attore', 200),
      reason: requiredText(input?.reason, 'Motivo validazione', 500),
      validatedAt: now
    }
  };
  invoice.sources = [{ sourceKey: invoice.sourceKey, sourceVersion: invoice.sourceVersion, documentId: invoice.documentId }];
  invoice.fingerprint = stableFingerprint({
    invoiceId: invoice.invoiceId,
    version: invoice.version,
    naturalKey: invoice.naturalKey,
    documentType: invoice.documentType,
    number: invoice.number,
    supplier: invoice.supplier,
    currency: invoice.currency,
    dates: invoice.dates,
    amounts: invoice.amounts,
    posting: invoice.posting,
    sourceLines: invoice.sourceLines,
    vatSummaries: invoice.vatSummaries
  });
  const event = {
    eventKey: `invoice.supplier_validated:INVOICE_SUPPLIER:${invoiceId}:${version}:DOCUMENT_COMPETENCE`,
    type: 'invoice.supplier_validated',
    aggregate: { type: 'INVOICE_SUPPLIER', id: invoiceId, version },
    occurredAt: now,
    payload: {
      supplierInvoice: {
        naturalKey,
        supplier: invoice.supplier,
        amounts: invoice.amounts,
        dueDate: normalizedDueDate,
        vatEntryKey: `${invoiceId}:${version}:INPUT_VAT`,
        obligationKey: `SUPPLIER_INVOICE:${invoiceId}:PAYABLE`
      }
    },
    accounting: {
      entryKind: 'DOCUMENT_COMPETENCE',
      source: { type: 'INVOICE_SUPPLIER', id: invoiceId, version },
      postingRule: { id: invoice.posting.ruleId, version: invoice.posting.ruleVersion },
      currency,
      dates: invoice.dates,
      lines,
      requiresPayment: false,
      description: `Fattura fornitore ${invoice.number}`
    },
    provenance: { source: 'SUPPLIER_INVOICE_VALIDATION', reference: sourceKey, actor: invoice.validation.actor }
  };
  return { invoice, event };
}

export async function validateSupplierInvoice({ client, db }, sourceKey, input, options = {}) {
  if (!client || !db) throw new Error('Validazione fattura richiede MongoDB transazionale');
  await Promise.all([ensureSupplierInvoiceIndexes(db), ensureEventEngineIndexes(db)]);
  const now = options.now || new Date();
  const actor = options.actor || 'SYSTEM';
  return withMongoTransaction(client, async (session) => {
    const source = await db.collection('fatture').findOne({ sourceKey: requiredText(sourceKey, 'Chiave fonte', 500) }, { session });
    const { invoice, event } = buildSupplierInvoiceValidation(source, input, { actor, now });
    const existing = await db.collection('invoice_suppliers').findOne({ invoiceId: invoice.invoiceId, version: invoice.version }, { session });
    if (existing) {
      if (existing.fingerprint !== invoice.fingerprint) throw new Error('SUPPLIER_INVOICE_VERSION_CONFLICT');
      await db.collection('invoice_suppliers').updateOne(
        { _id: existing._id },
        { $addToSet: { sources: invoice.sources[0] }, $set: { updatedAt: now } },
        { session }
      );
      const recordedEvent = await db.collection('domain_events').findOne({ eventKey: event.eventKey }, { session });
      if (!recordedEvent) throw new Error('SUPPLIER_INVOICE_EVENT_NOT_FOUND');
      await projectSupplierInvoiceValidated(db, recordedEvent, { session, now });
      const alreadyLinked = (existing.sources || []).some((item) => item.sourceKey === invoice.sourceKey && item.sourceVersion === invoice.sourceVersion);
      return { invoice: { ...existing, sources: alreadyLinked ? existing.sources : [...(existing.sources || []), invoice.sources[0]] }, event: recordedEvent, duplicate: true };
    }
    const current = await db.collection('invoice_suppliers').findOne({ naturalKey: invoice.naturalKey, current: true }, { session });
    if (current) throw new Error('SUPPLIER_INVOICE_REQUIRES_SUPERSEDING_VERSION');
    await db.collection('invoice_suppliers').insertOne({ ...invoice, createdAt: now, updatedAt: now }, { session });
    const published = await publishDomainEventInSession(db, event, { session, now });
    const domainProjection = await projectSupplierInvoiceValidated(db, published.event, { session, now });
    return { invoice, event: published.event, domainProjection, duplicate: false };
  });
}
