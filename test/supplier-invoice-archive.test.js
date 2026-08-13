import assert from 'node:assert/strict';
import test from 'node:test';
import { strToU8, zipSync } from 'fflate';

import { collectSupplierInvoiceXmlEntries } from '../src/supplier-invoice-archive.js';

const invoiceXml = `<?xml version="1.0" encoding="UTF-8"?>
<FatturaElettronica>
  <FatturaElettronicaHeader><CedentePrestatore><DatiAnagrafici><IdFiscaleIVA><IdCodice>00000000000</IdCodice></IdFiscaleIVA><Anagrafica><Denominazione>Fornitore test</Denominazione></Anagrafica></DatiAnagrafici></CedentePrestatore></FatturaElettronicaHeader>
  <FatturaElettronicaBody><DatiGenerali><DatiGeneraliDocumento><TipoDocumento>TD01</TipoDocumento><Divisa>EUR</Divisa><Data>2026-08-01</Data><Numero>ZIP-1</Numero><ImportoTotaleDocumento>12.20</ImportoTotaleDocumento></DatiGeneraliDocumento></DatiGenerali><DatiBeniServizi><DettaglioLinee><NumeroLinea>1</NumeroLinea><Descrizione>Test</Descrizione><PrezzoUnitario>10</PrezzoUnitario><PrezzoTotale>10</PrezzoTotale><AliquotaIVA>22</AliquotaIVA></DettaglioLinee><DatiRiepilogo><AliquotaIVA>22</AliquotaIVA><ImponibileImporto>10</ImponibileImporto><Imposta>2.20</Imposta></DatiRiepilogo></DatiBeniServizi></FatturaElettronicaBody>
</FatturaElettronica>`;

test('estrae XML singoli, ZIP multipli e ZIP annidati conservando il percorso', () => {
  const nested = zipSync({ 'seconda.xml': strToU8(invoiceXml) });
  const outer = Buffer.from(zipSync({
    'prima.xml': strToU8(invoiceXml),
    'cartella/inner.zip': nested,
    'leggimi.txt': strToU8('ignorato')
  }));
  const result = collectSupplierInvoiceXmlEntries(outer, 'lotto.zip');
  assert.equal(result.entries.length, 2);
  assert.equal(result.summary.archives, 2);
  assert.equal(result.summary.skipped, 1);
  assert.equal(result.entries[0].sha256, result.entries[1].sha256);
  assert.match(result.entries[1].path, /inner\.zip!\/seconda\.xml$/);
});

test('rifiuta traversal e limiti da ZIP bomb prima di accettare i contenuti', () => {
  const traversal = Buffer.from(zipSync({ '../fuori.xml': strToU8(invoiceXml) }));
  assert.throws(
    () => collectSupplierInvoiceXmlEntries(traversal, 'unsafe.zip'),
    (error) => error.code === 'UNSAFE_ARCHIVE_PATH'
  );

  const many = Buffer.from(zipSync({ 'a.xml': strToU8(invoiceXml), 'b.xml': strToU8(invoiceXml) }));
  assert.throws(
    () => collectSupplierInvoiceXmlEntries(many, 'many.zip', { maxEntries: 1 }),
    (error) => error.code === 'ARCHIVE_ENTRY_LIMIT'
  );
});

test('non tratta un file arbitrario come XML o ZIP', () => {
  assert.throws(
    () => collectSupplierInvoiceXmlEntries(Buffer.from('non xml'), 'documento.pdf'),
    (error) => error.code === 'NO_INVOICE_XML'
  );
});
