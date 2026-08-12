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
    tipo: 'CARTELLA_PAGAMENTO', numeroAtto: 'ATTO-ESEMPIO-001', dataAtto: '10/01/2026',
    dataNotifica: '15/01/2026', importoOriginario: '12.000,00', enteCreditore: 'ENTE ESEMPIO',
    fonte: 'PEC', fonteRiferimento: 'message-id-sintetico'
  }, { now: new Date('2026-01-16T10:00:00Z') });
  assert.equal(atto.tipo, 'CARTELLA_PAGAMENTO');
  assert.equal(atto.importoOriginario, 12000);
  assert.deepEqual(atto.entiCreditori, ['ENTE ESEMPIO']);
  assert.equal(atto.fonte, 'PEC');
});

test('snapshot ADER è una fotografia distinta e il riepilogo sceglie davvero la più recente', () => {
  const primo = { _id: 'a', ...normalizeAderSnapshot({
    sourceKey: 'snapshot-2026-02-01', acquisitoIl: '01/02/2026', importoOriginario: '12.000,00',
    pagato: '2.000,00', residuo: '10.000,00', statoAder: 'APERTO'
  }) };
  const secondo = { _id: 'b', ...normalizeAderSnapshot({
    sourceKey: 'snapshot-2026-03-01', acquisitoIl: '01/03/2026', importoOriginario: '12.000,00',
    pagato: '5.000,00', residuo: '7.000,00', statoAder: 'RATEIZZATO',
    rateizzazione: { numeroRate: 12, ratePagate: 3, importoRata: '600,00' }
  }) };
  const latest = snapshotSummary([secondo, primo]);
  assert.equal(latest.snapshotId, 'b');
  assert.equal(latest.importoResiduo, 7000);
  assert.equal(latest.rateizzazione.numeroRate, 12);
});

test('riconosce una cartella come proposta forte senza finalizzare la classificazione', () => {
  const result = recognizeRiscossioneText(`AGENZIA DELLE ENTRATE-RISCOSSIONE\nCARTELLA DI PAGAMENTO\nNumero atto: ATTO-ESEMPIO-001`);
  assert.equal(result.tipoProposto, 'CARTELLA_PAGAMENTO');
  assert.equal(result.stato, 'PROPOSTA_FORTE');
  assert.ok(result.confidenza >= 0.9);
});

test('rifiuta date e importi non validi invece di cancellarli silenziosamente', () => {
  assert.throws(() => normalizeRiscossioneAtto({ tipo: 'CARTELLA_PAGAMENTO', numeroAtto: 'ABC12345678', dataAtto: 'data-impossibile' }), /Data atto/);
  assert.throws(() => normalizeAderSnapshot({ sourceKey: 'x', residuo: '-1,00' }), /negativo/);
});
