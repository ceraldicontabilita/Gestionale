import { stableFingerprint } from './fingerprint.js';
import {
  createExpectations,
  supplierInvoiceExpectationDefinitions,
  supplierInvoiceProcessId,
  SUPPLIER_INVOICE_EXPECTATION_TYPES,
  transitionExpectation
} from './expectation-engine.js';
import { createSupplierPayable } from './obligation-engine.js';

export async function projectSupplierInvoiceValidated(db, event, { session = null, now = new Date() } = {}) {
  if (event?.type !== 'invoice.supplier_validated') return { projected: false };
  const payload = event.payload?.supplierInvoice;
  if (!payload?.obligationKey || !payload?.vatEntryKey) throw new Error('SUPPLIER_INVOICE_EVENT_PAYLOAD_INVALID');
  const options = session ? { session } : {};
  const amount = payload.amounts;
  const { obligation, openItem } = await createSupplierPayable(db, event, { session, now });

  const vatEntry = {
    vatEntryKey: payload.vatEntryKey, sourceEntityType: 'INVOICE_SUPPLIER', sourceEntityId: event.aggregate.id,
    sourceVersion: event.aggregate.version, sourceEventKey: event.eventKey, currency: event.accounting.currency,
    competenceDate: event.accounting.dates.vatDate || event.accounting.dates.receiptDate,
    taxableCents: amount.taxableCents, exposedVatCents: amount.exposedVatCents,
    deductibleVatCents: amount.deductibleVatCents,
    nonDeductibleVatCents: amount.nonDeductibleVatCents,
    pendingVatCents: amount.pendingVatCents || 0,
    status: amount.pendingVatCents > 0 ? 'PENDING_CLASSIFICATION' : 'PROJECTED', createdAt: now, updatedAt: now
  };
  vatEntry.fingerprint = stableFingerprint({
    vatEntryKey: vatEntry.vatEntryKey, sourceEntityType: vatEntry.sourceEntityType,
    sourceEntityId: vatEntry.sourceEntityId, sourceVersion: vatEntry.sourceVersion,
    sourceEventKey: vatEntry.sourceEventKey, currency: vatEntry.currency, competenceDate: vatEntry.competenceDate,
    taxableCents: vatEntry.taxableCents, exposedVatCents: vatEntry.exposedVatCents,
    deductibleVatCents: vatEntry.deductibleVatCents, nonDeductibleVatCents: vatEntry.nonDeductibleVatCents,
    pendingVatCents: vatEntry.pendingVatCents,
    status: vatEntry.status
  });
  const existingVat = await db.collection('vat_entries').findOne({ vatEntryKey: vatEntry.vatEntryKey }, options);
  if (existingVat && existingVat.fingerprint !== vatEntry.fingerprint) throw new Error('SUPPLIER_VAT_ENTRY_CONFLICT');
  if (!existingVat) await db.collection('vat_entries').insertOne(vatEntry, options);
  const expectations = await createExpectations(db, supplierInvoiceExpectationDefinitions(event), { session, now });
  return { projected: true, obligation, openItem, vatEntry: existingVat || vatEntry, expectations };
}

export async function completeSupplierInvoiceAccountingExpectation(db, event, { session = null, now = new Date() } = {}) {
  if (event?.type !== 'invoice.supplier_validated') return { updated: false };
  const processId = supplierInvoiceProcessId(event.aggregate.id, event.aggregate.version);
  const process = await transitionExpectation(db, {
    processId,
    expectationType: SUPPLIER_INVOICE_EXPECTATION_TYPES.ACCOUNTING_COMPETENCE,
    nextStatus: 'SODDISFATTO',
    eventId: event.eventKey,
    evidence: [event.accounting.projectionKey, event.eventKey],
    reason: 'Scrittura di competenza e IVA registrata'
  }, { session, now });
  return { updated: true, process };
}

export async function completeSupplierInvoiceSettlementLedgerExpectation(db, event, { session = null, now = new Date() } = {}) {
  const settlement = event?.payload?.supplierSettlement;
  if (event?.type !== 'ledger.entry_projected' || !settlement?.invoiceId || !settlement?.invoiceVersion) return { updated: false };
  const processId = supplierInvoiceProcessId(settlement.invoiceId, settlement.invoiceVersion);
  const nextStatus = Number(settlement.residualCents || 0) === 0 ? 'SODDISFATTO' : 'IN_ELABORAZIONE';
  const process = await transitionExpectation(db, {
    processId,
    expectationType: SUPPLIER_INVOICE_EXPECTATION_TYPES.FINANCIAL_LEDGER,
    nextStatus,
    eventId: event.eventKey,
    evidence: [event.accounting.projectionKey, settlement.reconciliationKey, ...(event.accounting.evidence || []).map((item) => item.reference)],
    reason: nextStatus === 'SODDISFATTO' ? 'Prima Nota finanziaria registrata e debito chiuso' : 'Prima Nota finanziaria parziale registrata'
  }, { session, now });
  return { updated: true, process };
}
