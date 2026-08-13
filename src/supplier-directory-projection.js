function clean(value) { return value === null || value === undefined ? '' : String(value).trim(); }

function supplierIdentity(supplier = {}) {
  const vatId = clean(supplier.partitaIva || supplier.vatId).toUpperCase();
  const taxId = clean(supplier.codiceFiscale || supplier.taxId).toUpperCase();
  if (vatId) return { key: `VAT:${vatId}`, vatId, taxId: taxId || null, exact: true };
  if (taxId) return { key: `TAX:${taxId}`, vatId: null, taxId, exact: true };
  return null;
}

function dateValue(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : null;
}

export function buildSupplierDirectory(staging = [], canonical = [], openItems = []) {
  const openByKey = new Map(openItems.map((row) => [row.obligationKey, row]));
  const canonicalSourceKeys = new Set(canonical.flatMap((row) => [row.sourceKey, ...(row.sources || []).map((source) => source.sourceKey)]).filter(Boolean));
  const grouped = new Map();

  function group(identity, name, fallbackKey) {
    const key = identity?.key || `REVIEW:${fallbackKey}`;
    if (!grouped.has(key)) grouped.set(key, {
      supplierKey: key,
      name: clean(name) || 'Fornitore da identificare',
      vatId: identity?.vatId || null,
      taxId: identity?.taxId || null,
      identityStatus: identity?.exact ? 'IDENTIFICATIVO_ESTRATTO' : 'IDENTITA_DA_VERIFICARE',
      pendingInvoices: 0,
      canonicalInvoices: 0,
      residualCents: 0,
      invoices: []
    });
    const result = grouped.get(key);
    if (clean(name) && (result.name === 'Fornitore da identificare' || identity?.exact)) result.name = clean(name);
    return result;
  }

  for (const row of staging) {
    if (canonicalSourceKeys.has(row.sourceKey) || String(row.stato || '').toUpperCase() === 'VALIDATA') continue;
    const identity = supplierIdentity(row.fornitore);
    const target = group(identity, row.fornitore?.denominazione, row.sourceKey);
    target.pendingInvoices += 1;
    target.invoices.push({
      stage: 'DA_VERIFICARE',
      sourceKey: row.sourceKey,
      invoiceId: null,
      number: clean(row.numero) || 'Senza numero',
      documentType: clean(row.tipoDocumento) || null,
      documentDate: dateValue(row.data),
      totalCents: Math.round(Number(row.totaleDocumento || 0) * 100),
      residualCents: null
    });
  }

  for (const row of canonical) {
    const identity = supplierIdentity(row.supplier);
    const target = group(identity, row.supplier?.name, row.invoiceId);
    const openItem = openByKey.get(`SUPPLIER_INVOICE:${row.invoiceId}:PAYABLE`);
    const residualCents = Number(openItem?.residualCents || 0);
    target.canonicalInvoices += 1;
    target.residualCents += residualCents;
    target.invoices.push({
      stage: residualCents > 0 ? 'DA_PAGARE' : 'REGOLATA',
      sourceKey: null,
      invoiceId: row.invoiceId,
      number: clean(row.number) || 'Senza numero',
      documentType: clean(row.documentType) || null,
      documentDate: dateValue(row.dates?.documentDate),
      totalCents: Number(row.amounts?.totalCents || 0),
      residualCents
    });
  }

  const rows = [...grouped.values()].map((row) => ({
    ...row,
    status: row.pendingInvoices > 0 ? 'FATTURE_DA_VERIFICARE' : 'FATTURE_CANONICHE',
    invoices: row.invoices.sort((left, right) => String(right.documentDate || '').localeCompare(String(left.documentDate || '')) || left.number.localeCompare(right.number))
  })).sort((left, right) => left.name.localeCompare(right.name, 'it', { sensitivity: 'base' }));

  return {
    counts: {
      suppliers: rows.length,
      suppliersToReview: rows.filter((row) => row.pendingInvoices > 0).length,
      pendingInvoices: rows.reduce((sum, row) => sum + row.pendingInvoices, 0),
      canonicalInvoices: rows.reduce((sum, row) => sum + row.canonicalInvoices, 0),
      residualCents: rows.reduce((sum, row) => sum + row.residualCents, 0)
    },
    rows
  };
}
