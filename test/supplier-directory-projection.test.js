import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSupplierDirectory } from '../src/supplier-directory-projection.js';

test('raggruppa fornitori solo per identificativo fiscale esatto', () => {
  const staging = [
    { sourceKey: 'S1', stato: 'IMPORTATA', fornitore: { denominazione: 'Alfa', partitaIva: 'IT00000000001' }, numero: '1', data: '2026-01-01', totaleDocumento: 10 },
    { sourceKey: 'S2', stato: 'IMPORTATA', fornitore: { denominazione: 'Alfa omonima' }, numero: '2', data: '2026-01-02', totaleDocumento: 20 }
  ];
  const canonical = [{ invoiceId: 'I1', sourceKey: 'S1', sources: [{ sourceKey: 'S1' }], supplier: { name: 'Alfa', vatId: 'IT00000000001' }, number: '1', documentType: 'TD01', dates: { documentDate: '2026-01-01' }, amounts: { totalCents: 1000 } }];
  const openItems = [{ obligationKey: 'SUPPLIER_INVOICE:I1:PAYABLE', residualCents: 1000 }];
  const result = buildSupplierDirectory(staging, canonical, openItems);
  assert.equal(result.counts.suppliers, 2);
  assert.equal(result.counts.pendingInvoices, 1);
  assert.equal(result.counts.canonicalInvoices, 1);
  assert.equal(result.rows.find((row) => row.vatId).residualCents, 1000);
  assert.equal(result.rows.find((row) => !row.vatId).identityStatus, 'IDENTITA_DA_VERIFICARE');
});
