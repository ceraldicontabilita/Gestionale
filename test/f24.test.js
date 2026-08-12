import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildF24FromIndexRow,
  normalizeF24Row,
  parseItalianAmount,
  parseQuietanzaText
} from '../src/f24.js';

test('converte importi italiani senza perdere centesimi', () => {
  assert.equal(parseItalianAmount('7.066,65 €'), 7066.65);
  assert.equal(parseItalianAmount('0,00 €'), 0);
  assert.equal(parseItalianAmount(123.456), 123.46);
});

test('normalizza una riga dell’indice F24 del Cassetto Fiscale', () => {
  const row = buildF24FromIndexRow({
    anno_elenco: '2026',
    indice_portale: '23',
    data_versamento: '22/07/2026',
    numero_modelli_f24: '2',
    saldo_operazione: '7.066,65 €',
    protocollo_telematico: '26072212345678901/000002',
    numero_modello_nel_gruppo: '2',
    saldo_del_modello: '7.066,65 €',
    tipo_documento: 'Quietanza AE',
    origine_portale: 'Link PDF diretto nella tabella',
    file: '2026/quietanza-esempio.pdf',
    sha256: 'a'.repeat(64),
    url_sorgente: 'https://example.invalid/f24'
  });

  assert.equal(row.tipoDocumento, 'F24_QUIETANZA_AE');
  assert.equal(row.saldoModello, 7066.65);
  assert.equal(row.protocollo, '26072212345678901/000002');
  assert.equal(row.provaPagamento, false);
  assert.equal(row.stato, 'IN_ATTESA_RISCONTRO');
});

test('la sezione INPS usa la causale contributo, non un finto codice tributo', () => {
  const row = normalizeF24Row({
    sezione: 'INPS',
    codiceSede: '5100',
    causaleContributo: 'CXX',
    matricolaCodiceInps: '00000ESEMPIO',
    periodoDa: '06/2026',
    periodoA: '06/2026',
    debito: '1.000,00',
    credito: '0,00'
  });

  assert.equal(row.namespace, 'CAUSALE_INPS');
  assert.equal(row.codice, 'CXX');
  assert.equal(row.codiceTributo, null);
  assert.equal(row.causaleContributo, 'CXX');
  assert.equal(row.debito, 1000);
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
  assert.equal(parsed.righe.filter((row) => row.sezione === 'INPS').length, 2);
  assert.equal(parsed.righe.filter((row) => row.sezione === 'IMU_E_TRIBUTI_LOCALI').length, 4);
});
