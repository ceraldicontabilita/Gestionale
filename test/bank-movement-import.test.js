import assert from 'node:assert/strict';
import test from 'node:test';
import { parseBankStatementCsv } from '../src/bank-movement-import.js';

const header = '"Ragione Sociale";"Data contabile";"Data valuta";"Banca";"Rapporto";"Importo";"Divisa";"Descrizione";"Categoria/sottocategoria";"Hashtag"';

function csv(lines) {
  return Buffer.from([header, ...lines].join('\r\n'), 'utf8');
}

test('normalizza l export bancario in centesimi con prova e identità stabili', () => {
  const rows = parseBankStatementCsv(csv([
    '"Impresa sintetica";"01/08/2026";"02/08/2026";"BANCA TEST";"0000";"-1.234,56";"EUR";"BONIFICO NS RIF. ABCDE12345";"PAGAMENTI";""',
    '"Impresa sintetica";"03/08/2026";"03/08/2026";"BANCA TEST";"0000";"25,10";"EUR";"ACCREDITO TEST";"INCASSI";"#TEST"'
  ]));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].amountCents, 123456);
  assert.equal(rows[0].direction, 'USCITA');
  assert.equal(rows[0].sourceTransactionId, 'BANK_REFERENCE:ABCDE12345');
  assert.equal(rows[1].amountCents, 2510);
  assert.equal(rows[1].direction, 'ENTRATA');
  assert.match(rows[1].sourceTransactionId, /^ROW_FINGERPRINT:[a-f0-9]{64}:1$/);
  assert.match(rows[0].movementKey, /^[a-f0-9]{64}$/);
  assert.equal(rows[0].bookingDate.toISOString(), '2026-08-01T00:00:00.000Z');
});

test('distingue due righe legittimamente identiche senza usare solo data e importo', () => {
  const line = '"Impresa sintetica";"01/08/2026";"01/08/2026";"BANCA TEST";"0000";"-10,00";"EUR";"ADDEBITO SENZA RIFERIMENTO";"ALTRO";""';
  const rows = parseBankStatementCsv(csv([line, line]));
  assert.notEqual(rows[0].movementKey, rows[1].movementKey);
  assert.match(rows[0].sourceTransactionId, /:1$/);
  assert.match(rows[1].sourceTransactionId, /:2$/);
});

test('rifiuta CSV POS o schemi generici invece di inventare movimenti bancari', () => {
  assert.throws(
    () => parseBankStatementCsv(Buffer.from('Data e ora;Codice autorizzazione;Importo\n01/08/2026;ABC;10,00')),
    /CSV non riconosciuto/
  );
});
