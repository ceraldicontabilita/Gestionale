import assert from 'node:assert/strict';
import test from 'node:test';

import { supplierInvoiceExpectationDefinitions } from '../src/expectation-engine.js';
import { parseInvoiceXml } from '../src/supplier-invoice-xml.js';
import { buildSupplierInvoiceValidation } from '../src/supplier-invoice.js';

function source(overrides = {}) {
  return {
    _id: 'synthetic-source-id',
    sourceKey: 'DRIVE_FILE:synthetic-invoice:1',
    extractionVersion: 'FATTURAPA_XML_V2',
    quadraturaEstrazione: { status: 'EXACT', checks: { supplierIdentity: true, documentIdentity: true, vatSummaries: true, invoiceLines: true, positiveTotal: true, euroCurrency: true } },
    fornitore: { partitaIva: 'IT00000000000', codiceFiscale: null, denominazione: 'Fornitore sintetico' },
    tipoDocumento: 'TD01',
    numero: 'SYN-1',
    data: new Date('2026-08-01T00:00:00Z'),
    divisa: 'EUR',
    imponibile: 100,
    ivaEsposta: 22,
    totaleDocumento: 122,
    ritenuta: 0,
    stato: 'IMPORTATA_DA_VERIFICARE',
    righe: [{ numero: 1, descrizione: 'Merce sintetica', prezzoTotale: 100, aliquotaIva: 22 }],
    riepiloghiIva: [{ aliquotaIva: 22, imponibile: 100, imposta: 22 }],
    aggiornatoIl: new Date('2026-08-02T00:00:00Z'),
    ...overrides
  };
}

function input(overrides = {}) {
  return {
    version: '1',
    sourceVersion: 'fixture-1',
    ivaDetraibile: 22,
    receiptDate: '2026-08-02',
    competenceDate: '2026-08-01',
    registrationDate: '2026-08-03',
    vatDate: '2026-08-02',
    dueDate: '2026-09-01',
    costAccountCode: 'COSTI_MERCI',
    vatAccountCode: 'IVA_CREDITO',
    payableAccountCode: 'DEBITI_FORNITORI',
    postingRule: { id: 'FATTURA_PASSIVA', version: '1' },
    reason: 'Fixture sintetica',
    ...overrides
  };
}

test('la validazione canonica pubblica competenza e debito senza dipendere dal pagamento', () => {
  const { invoice, event } = buildSupplierInvoiceValidation(source(), input(), {
    actor: 'TEST', now: new Date('2026-08-03T10:00:00Z')
  });
  assert.equal(invoice.amounts.exposedVatCents, 2200);
  assert.equal(invoice.amounts.deductibleVatCents, 2200);
  assert.equal(event.type, 'invoice.supplier_validated');
  assert.equal(event.accounting.entryKind, 'DOCUMENT_COMPETENCE');
  assert.equal(event.accounting.requiresPayment, false);
  assert.deepEqual(event.accounting.evidence, undefined);
  assert.equal(event.payload.supplierInvoice.amounts.payableCents, 12_200);
  assert.equal(event.accounting.lines.reduce((sum, row) => sum + Math.round(row.debit * 100), 0), 12_200);
  assert.equal(event.accounting.lines.reduce((sum, row) => sum + Math.round(row.credit * 100), 0), 12_200);
});

test('IVA esposta e IVA detraibile restano decisioni distinte', () => {
  assert.throws(
    () => buildSupplierInvoiceValidation(source(), input({ ivaDetraibile: undefined }), { actor: 'TEST' }),
    /IVA detraibile obbligatorio/
  );
  const { invoice, event } = buildSupplierInvoiceValidation(source(), input({ ivaDetraibile: 0, vatAccountCode: undefined }), { actor: 'TEST' });
  assert.equal(invoice.amounts.nonDeductibleVatCents, 2_200);
  assert.equal(invoice.amounts.costCents, 12_200);
  assert.equal(event.accounting.lines.some((row) => row.accountCode === 'IVA_CREDITO'), false);
});

test('la ritenuta crea una passività distinta e mantiene la quadratura', () => {
  const { invoice, event } = buildSupplierInvoiceValidation(
    source({ totaleDocumento: 122, ritenuta: 20 }),
    input({ withholdingAccountCode: 'ERARIO_RITENUTE' }),
    { actor: 'TEST' }
  );
  assert.equal(invoice.amounts.payableCents, 10_200);
  assert.deepEqual(event.accounting.lines.filter((row) => row.credit > 0).map((row) => [row.accountCode, row.credit]), [
    ['DEBITI_FORNITORI', 102],
    ['ERARIO_RITENUTE', 20]
  ]);
});

test('una seconda fonte identica conserva la stessa identità canonica', () => {
  const first = buildSupplierInvoiceValidation(source(), input(), { actor: 'TEST' });
  const duplicateSource = buildSupplierInvoiceValidation(
    source({ _id: 'second-source-id', sourceKey: 'DRIVE_FILE:synthetic-invoice-copy:1' }),
    input({ sourceVersion: 'fixture-copy-1' }),
    { actor: 'TEST' }
  );
  assert.equal(first.invoice.invoiceId, duplicateSource.invoice.invoiceId);
  assert.equal(first.invoice.fingerprint, duplicateSource.invoice.fingerprint);
  assert.equal(first.event.eventKey, duplicateSource.event.eventKey);
});

test('il ramo delle attese nasce con la fattura e il pagamento resta futuro', () => {
  const { event } = buildSupplierInvoiceValidation(source(), input(), { actor: 'TEST' });
  const expectations = supplierInvoiceExpectationDefinitions(event);
  assert.equal(expectations.length, 12);
  assert.equal(expectations.find((row) => row.expectationType === 'ACCOUNTING_COMPETENCE').status, 'IN_ELABORAZIONE');
  assert.equal(expectations.find((row) => row.expectationType === 'PAYMENT').status, 'ATTESO');
  assert.equal(expectations.find((row) => row.expectationType === 'FINANCIAL_EVIDENCE').status, 'ATTESO');
  assert.equal(expectations.find((row) => row.expectationType === 'DEBT_CLOSURE').status, 'ATTESO');
});

test('l intake FatturaPA conserva righe, IVA e scadenza senza inventare la detraibilita', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
  <p:FatturaElettronica xmlns:p="urn:test">
    <FatturaElettronicaHeader><CedentePrestatore><DatiAnagrafici><IdFiscaleIVA><IdPaese>IT</IdPaese><IdCodice>00000000000</IdCodice></IdFiscaleIVA><Anagrafica><Denominazione>Fornitore sintetico</Denominazione></Anagrafica></DatiAnagrafici></CedentePrestatore></FatturaElettronicaHeader>
    <FatturaElettronicaBody>
      <DatiGenerali><DatiGeneraliDocumento><TipoDocumento>TD01</TipoDocumento><Divisa>EUR</Divisa><Data>2026-08-01</Data><Numero>SYN-XML-1</Numero><ImportoTotaleDocumento>122.00</ImportoTotaleDocumento></DatiGeneraliDocumento></DatiGenerali>
      <DatiBeniServizi><DettaglioLinee><NumeroLinea>1</NumeroLinea><Descrizione>Merce sintetica</Descrizione><Quantita>1</Quantita><PrezzoUnitario>100.00</PrezzoUnitario><PrezzoTotale>100.00</PrezzoTotale><AliquotaIVA>22.00</AliquotaIVA></DettaglioLinee><DatiRiepilogo><AliquotaIVA>22.00</AliquotaIVA><ImponibileImporto>100.00</ImponibileImporto><Imposta>22.00</Imposta></DatiRiepilogo></DatiBeniServizi>
      <DatiPagamento><DettaglioPagamento><ModalitaPagamento>MP05</ModalitaPagamento><DataScadenzaPagamento>2026-09-01</DataScadenzaPagamento><ImportoPagamento>122.00</ImportoPagamento></DettaglioPagamento></DatiPagamento>
    </FatturaElettronicaBody>
  </p:FatturaElettronica>`;
  const [parsed] = parseInvoiceXml(Buffer.from(xml), { sourceKeyBase: 'UPLOAD:fixture:1' });
  assert.equal(parsed.sourceKey, 'UPLOAD:fixture:1:1');
  assert.equal(parsed.quadraturaEstrazione.status, 'EXACT');
  assert.equal(parsed.righe.length, 1);
  assert.equal(parsed.riepiloghiIva.length, 1);
  assert.equal(parsed.pagamenti[0].scadenza.toISOString().slice(0, 10), '2026-09-01');
  assert.equal(parsed.ivaDetraibile, null);
});
