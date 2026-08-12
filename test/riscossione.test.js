import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeAderSnapshot,
  normalizeRiscossioneAtto,
  recognizeRiscossioneText,
  snapshotSummary
} from '../src/riscossione.js';

test('l’atto conserva importo originale e identità della fonte', () => {
  const atto = normalizeRiscossioneAtto({
    tipo: 'CARTELLA_PAGAMENTO',
    numeroAtto: 'ATTO-ESEMPIO-001',
    dataAtto: '10/01/2026',
    dataNotifica: '15/01/2026',
    importoOriginario: '12.000,00',
    enteCreditore: 'ENTE ESEMPIO',
    fonte: 'PEC',
    fonteRiferimento: 'message-id-sintetico'
  }, { now: new Date('2026-01-16T10:00:00Z') });

  assert.equal(atto.tipo, 'CARTELLA_PAGAMENTO');
  assert.equal(atto.importoOriginario, 12000);
  assert.deepEqual(atto.entiCreditori, ['ENTE ESEMPIO']);
  assert.equal(atto.fonte, 'PEC');
});

test('snapshot ADER è una fotografia distinta e versionabile', () => {
  const primo = normalizeAderSnapshot({
    sourceKey: 'snapshot-2026-02-01',
    acquisitoIl: '01/02/2026',
    importoOriginario: '12.000,00',
    pagato: '2.000,00',
    residuo: '10.000,00',
    statoAder: 'APERTO'
  });
  const secondo = normalizeAderSnapshot({
    sourceKey: 'snapshot-2026-03-01',
    acquisitoIl: '01/03/2026',
    importoOriginario: '12.000,00',
    pagato: '5.000,00',
    residuo: '7.000,00',
    statoAder: 'RATEIZZATO',
    rateizzazione: { numeroRate: 12, ratePagate: 3, importoRata: '600,00' }
  });

  const latest = snapshotSummary([primo, secondo]);
  assert.equal(primo.importoResiduo, 10000);
  assert.equal(secondo.importoResiduo, 7000);
  assert.equal(latest.importoResiduo, 7000);
  assert.equal(latest.importoOriginario, 12000);
  assert.equal(latest.rateizzazione.numeroRate, 12);
});

test('riconosce una cartella come proposta forte senza finalizzare la classificazione', () => {
  const result = recognizeRiscossioneText(`
    AGENZIA DELLE ENTRATE-RISCOSSIONE
    CARTELLA DI PAGAMENTO
    Numero atto: ATTO-ESEMPIO-001
  `);

  assert.equal(result.tipoProposto, 'CARTELLA_PAGAMENTO');
  assert.equal(result.stato, 'PROPOSTA_FORTE');
  assert.ok(result.confidenza >= 0.9);
  assert.ok(result.segnali.includes('ADER'));
});

test('un testo ambiguo resta da verificare', () => {
  const result = recognizeRiscossioneText('Comunicazione relativa a somme da esaminare');
  assert.equal(result.stato, 'DA_VERIFICARE');
  assert.equal(result.tipoProposto, 'ALTRO_ATTO_RISCOSSIONE');
});
