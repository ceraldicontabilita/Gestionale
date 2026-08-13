import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyDeclaration,
  documentRole,
  extractResignationMetadata,
  resignationFileIdentity
} from '../src/document-index-metadata.js';

test('classifica il modello dichiarativo senza perdere anno imposta e protocollo', () => {
  const result = classifyDeclaration({
    Anno: '2022',
    Tipo: 'DICHIARAZIONE',
    Protocollo: 'T220000000001',
    'Anno imposta': '2021',
    'Percorso archivio': '02_ANNI/2022/DICHIARAZIONI/REDDITI_SC/redditi_sc_imposta_2021.pdf'
  });
  assert.equal(result.model, 'REDDITI SC');
  assert.equal(result.category, 'REDDITI');
  assert.equal(result.year, '2022');
  assert.equal(result.taxYear, '2021');
  assert.equal(result.protocol, 'T220000000001');
});

test('estrae identità e decorrenza dal testo del PDF dimissioni', () => {
  const text = `Nome Mario\nCognome Rossi\nCodice Fiscale RSSMRA80A01F839X\nData Inizio 01/02/2020\nData Decorrenza 31/12/2026\nTipo Comunicazione Dimissioni volontarie\nData Trasmissione 20/12/2026\nCodice Identificativo Modulo MOD-001`;
  const result = extractResignationMetadata(text);
  assert.equal(result.employeeName, 'Mario Rossi');
  assert.equal(result.effectiveDate, '31/12/2026');
  assert.equal(result.communicationType, 'Dimissioni volontarie');
  assert.equal(result.moduleId, 'MOD-001');
  assert.match(result.employeeTaxIdMasked, /^RSS.+F839X$/);
  assert.notEqual(result.employeeTaxIdMasked, 'RSSMRA80A01F839X');
});

test('riconosce il PDF dimissioni anche quando il nome contiene il percorso ZIP', () => {
  const identity = resignationFileIdentity({
    name: 'archivio\\allegati\\2023-12-21-18-54-24__18c8d83a54c16937__SGRFBA83B22F839E_Dimissione.pdf'
  });
  assert.equal(identity?.documentDate, '2023-12-21');
  assert.equal(identity?.employeeTaxId, 'SGRFBA83B22F839E');
  assert.equal(identity?.fileKind, 'DIMISSIONE');
});

test('distingue il PDF principale dalle prove tecniche PEC', () => {
  assert.equal(documentRole({ name: 'daticert.xml' }), 'PROVA_TECNICA');
  assert.equal(documentRole({ name: 'smime.p7s' }), 'PROVA_TECNICA');
  assert.equal(documentRole({ name: 'dimissione.pdf' }), 'DOCUMENTO_PRINCIPALE');
  const identity = resignationFileIdentity({ name: '2026-12-20-10-11-12__abc123def456__RSSMRA80A01F839X_Dimissione.pdf' });
  assert.equal(identity.employeeTaxId, 'RSSMRA80A01F839X');
});
