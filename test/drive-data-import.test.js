import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDriveIndexDataset, proposedDocumentType } from '../src/drive-data-import.js';

function document(id, sha, path) {
  return { __id: id, __sha: sha, __path: path, 'ID documento': id, 'SHA-256': sha, 'Percorso Drive': path, 'Nome file': path.split('/').at(-1), Dominio: 'F24 E QUIETANZE', Categoria: '02_F24_QUIETANZE', Anno: 2026, Stato: 'CARICATO_UNICO' };
}

function row(id, sha, type, debit, credit = 0) {
  return { 'ID documento': id, 'Anno pagamento': 2026, 'Data pagamento': '20/07/2026', Sezione: 'ERARIO', 'Codice tributo': '1001', Descrizione: 'Ritenute', 'Periodo tributo': '2026-06', Debito: debit, Credito: credit, Protocollo: 'ABC', 'Tipo documento': type, 'SHA-256': sha, 'Percorso Drive': `F24/${id}.pdf`, Pagina: 1, Fonte: 'PDF_PRIMARIO' };
}

test('separa quietanze e modelli senza trasformare una ricevuta in prova bancaria', () => {
  const sha1 = 'a'.repeat(64); const sha2 = 'b'.repeat(64);
  const data = buildDriveIndexDataset({
    documents: [document('DOC-1', sha1, 'F24/DOC-1.pdf'), document('DOC-2', sha2, 'Quietanze/DOC-2.pdf')],
    f24Rows: [row('DOC-1', sha1, 'F24_STAMPABILE_CON_ESTREMI', 100), row('DOC-2', sha2, 'QUIETANZA_AE', 100)],
    declarations: [], duplicates: []
  }, 'rev-1');

  assert.equal(data.f24Documents.length, 2);
  assert.equal(data.f24Documents.filter((item) => item.quietanza).length, 1);
  assert.equal(data.f24Documents.find((item) => item.quietanza).totals.saldo, 100);
  assert.equal(data.f24Rows[0].annoRiferimento, 2026);
  assert.equal(data.f24Rows[0].rateazioneMeseRif, '06');
});

test('la cartella propone il dominio senza dedurre un pagamento', () => {
  assert.equal(proposedDocumentType('Cedolini Paga/Rossi/cedolino.pdf'), 'CEDOLINO');
  assert.equal(proposedDocumentType('Estratti conto/2026/conto.pdf'), 'ESTRATTO_CONTO');
  assert.equal(proposedDocumentType('Nuova cartella/file.pdf'), 'DOCUMENTO_DRIVE');
});
