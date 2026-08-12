import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildF24FromIndexRow,
  normalizeF24Row,
  parseItalianAmount,
  parseQuietanzaText
} from '../src/f24.js';

test('converte importi italiani e decimali JSON senza perdere centesimi', () => {
  assert.equal(parseItalianAmount('7.066,65 €'), 7066.65);
  assert.equal(parseItalianAmount('0,00 €'), 0);
  assert.equal(parseItalianAmount('123.45'), 123.45);
  assert.equal(parseItalianAmount(123.456), 123.46);
});

test('normalizza una riga dell’indice F24 preservando il tipo tecnico', () => {
  const row = buildF24FromIndexRow({
    anno_elenco: '2026', indice_portale: '23', data_versamento: '22/07/2026',
    numero_modelli_f24: '2', saldo_operazione: '7.066,65 €',
    protocollo_telematico: '26072212345678901/000002', numero_modello_nel_gruppo: '2',
    saldo_del_modello: '7.066,65 €', tipo_documento: 'Formato stampabile (considerato quietanza)',
    origine_portale: 'Dettaglio aperto dalla lente', file: '2026/formato-esempio.pdf',
    sha256: 'a'.repeat(64), url_sorgente: 'https://example.invalid/f24'
  });
  assert.equal(row.tipoDocumento, 'F24_FORMATO_STAMPABILE');
  assert.equal(row.operationKey, '2026:23');
  assert.equal(row.saldoModello, 7066.65);
  assert.equal(row.stato, 'IN_ATTESA_RISCONTRO');
});

test('un F24 a saldo zero è compensato e non attende un addebito', () => {
  const row = buildF24FromIndexRow({
    anno_elenco: 2026, indice_portale: 1, numero_modello_nel_gruppo: 1,
    saldo_operazione: '0,00', saldo_del_modello: '0,00', tipo_documento: 'Quietanza AE', file: 'zero.pdf'
  });
  assert.equal(row.stato, 'COMPENSATO');
});

test('INPS e INAIL usano causali contributive, non finti codici tributo', () => {
  const inps = normalizeF24Row({
    sezione: 'INPS', codiceSede: '5100', causaleContributo: 'CXX', matricolaCodiceInps: '00000ESEMPIO',
    periodoDa: '06/2026', periodoA: '06/2026', debito: '1.000,00', credito: '0,00'
  });
  const inail = normalizeF24Row({ sezione: 'INAIL', causale: 'P', codiceDitta: '12345678', debito: '10,00', credito: 0 });
  assert.equal(inps.namespace, 'CAUSALE_INPS');
  assert.equal(inps.codiceTributo, null);
  assert.equal(inail.namespace, 'CAUSALE_INAIL');
  assert.equal(inail.codiceTributo, null);
  assert.equal(inail.codice, 'P');
});

test('estrae le sezioni principali da una quietanza con struttura reale e dati sintetici', () => {
  const text = `QUIETANZA DI VERSAMENTO
Soggetto: AZIENDA ESEMPIO S.R.L. ( 00000000000 )
ERARIO 1001 06 2026 1.200,00 0,00
ERARIO 1012 06 2026 80,00 0,00
ERARIO 1704 06 2026 0,00 600,00
INPS 5100 RC01 0000000001 6 2026 6 2026 5.000,00 0,00
INPS 5100 CXX 00000ESEMPIO 6 2026 6 2026 1.000,00 0,00
REGIONI 05 3802 00/06 2025 300,00 0,00
REGIONI 05 3802 00/06 2026 70,00 0,00
REGIONI 05 8950 00/06 2025 1,00 0,00
REGIONI 05 8950 00/06 2026 0,50 0,00
TRIB.LOCALI B000 3848 00/06 2025 10,00 0,00
TRIB.LOCALI B000 3847 00/06 2026 5,00 0,00
TRIB.LOCALI B000 8952 00/06 2025 0,10 0,00
TRIB.LOCALI B000 8952 00/06 2026 0,05 0,00`;
  const parsed = parseQuietanzaText(text);
  assert.equal(parsed.riconosciuto, true);
  assert.equal(parsed.codiceFiscale, '00000000000');
  assert.equal(parsed.righe.length, 13);
  assert.equal(parsed.totali.debiti, 7666.65);
  assert.equal(parsed.totali.crediti, 600);
  assert.equal(parsed.totali.saldo, 7066.65);
});
