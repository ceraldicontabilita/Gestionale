import assert from 'node:assert/strict';
import test from 'node:test';
import { strToU8, zipSync } from 'fflate';

import { extractSourcePackageIndex, sourcePackageKind } from '../src/source-package-index.js';

test('riconosce soltanto i tre pacchetti documentali attesi', () => {
  assert.equal(sourcePackageKind('CERALDI_GROUP_FISCALE_CODEX_COMPLETO_2020_2026_V2.zip'), 'FISCALE_CODEX');
  assert.equal(sourcePackageKind('ESTRAZIONE_5_MITTENTI_2026-08-10.zip'), 'ESTRAZIONE_5_MITTENTI');
  assert.equal(sourcePackageKind('PARTENOPAY_COMPLETO_ETICHETTE_2026-08-10.zip'), 'PARTENOPAY');
  assert.equal(sourcePackageKind('archivio-generico.zip'), null);
});

test('legge gli indici fiscali conservando ogni campo sorgente', () => {
  const declarations = [
    'tipo;anno_dichiarazione;anno_imposta;protocollo_o_id;file;pagine;byte;sha256;note',
    '770;2022;2021;T220000000001;770/2022/modello.pdf;7;100;' + 'a'.repeat(64) + ';PDF ricomposto'
  ].join('\n');
  const f24 = [
    'anno_elenco;data_versamento;tipo_documento;file;sha256;saldo_del_modello',
    '2022;20/12/2022;Quietanza;2022/quietanza.pdf;' + 'b'.repeat(64) + ';100,00'
  ].join('\n');
  const buffer = Buffer.from(zipSync({
    'ROOT/01_DICHIARAZIONI_FISCALI/INDICE.csv': strToU8(declarations),
    'ROOT/02_F24_QUIETANZE/INDICE_UNICO_DOCUMENTI_F24.csv': strToU8(f24),
    'ROOT/documento.pdf': strToU8('non estrarre')
  }));
  const result = extractSourcePackageIndex(buffer, 'CERALDI_GROUP_FISCALE_CODEX_COMPLETO_2020_2026_V2.zip');
  assert.equal(result.records.length, 2);
  const declaration = result.records.find((row) => row.recordType === 'DICHIARAZIONE_FISCALE');
  assert.equal(declaration.fields.anno_imposta, '2021');
  assert.equal(declaration.declaration.model, 'MODELLO 770');
  assert.equal(declaration.declaration.protocol, 'T220000000001');
  assert.equal(declaration.relativePath, '770/2022/modello.pdf');
});

test('l indice dei mittenti conserva categoria, oggetto e URL della fonte', () => {
  const csv = [
    'data_email;mittente_gruppo;mittente;oggetto;nome_allegato;estensione;dimensione_byte;leggibile_direttamente;stato_estrazione;gmail_url',
    '"2026-08-01T10:00:00+02:00";"notifica_polizia_locale";"PEC";"Verbale; notifica";"verbale.pdf";"pdf";"100";"true";"estratto";"https://mail.google.com/mail/#all/example"'
  ].join('\n');
  const buffer = Buffer.from(zipSync({ 'ROOT/04_INDICI/INDICE_ALLEGATI.csv': strToU8(csv) }));
  const [record] = extractSourcePackageIndex(buffer, 'ESTRAZIONE_5_MITTENTI_2026-08-10.zip').records;
  assert.equal(record.category, 'notifica_polizia_locale');
  assert.equal(record.fields.oggetto, 'Verbale; notifica');
  assert.equal(record.sourceUrl, 'https://mail.google.com/mail/#all/example');
});

test('rifiuta un indice ZIP con rapporto di compressione anomalo', () => {
  const bomb = Buffer.from(zipSync({
    'ROOT/01_DICHIARAZIONI_FISCALI/INDICE.csv': strToU8('x'.repeat(2 * 1024 * 1024))
  }));
  assert.throws(
    () => extractSourcePackageIndex(bomb, 'CERALDI_GROUP_FISCALE_CODEX_COMPLETO_2020_2026_V2.zip'),
    /rapporto di compressione anomalo/
  );
});
