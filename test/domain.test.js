import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLedger, canReconcile, normalizeMovement } from '../src/domain.js';
import { parseMoney } from '../src/money.js';

test('interpreta importi italiani e decimali JSON senza moltiplicarli per cento', () => {
  assert.equal(parseMoney('7.475,22 €'), 7475.22);
  assert.equal(parseMoney('123.45'), 123.45);
  assert.equal(parseMoney('12.000'), 12000);
  assert.throws(() => parseMoney('-1,00'), /non può essere negativo/);
});

test('un movimento usa direzione esplicita e rifiuta importi negativi', () => {
  assert.throws(() => normalizeMovement({ conto: 'CASSA', direzione: 'ENTRATA', importo: -10, descrizione: 'Errore' }), /negativo/);
  const movement = normalizeMovement({ conto: 'CASSA', direzione: 'USCITA', importo: '10,50', descrizione: 'Spesa' });
  assert.equal(movement.importo, 10.5);
  assert.equal(movement.direzione, 'USCITA');
});

test('il solo booleano provaReale non riconcilia un conto finanziario', () => {
  const movement = normalizeMovement({
    conto: 'BANCA', direzione: 'USCITA', importo: 100, descrizione: 'Pagamento',
    stato: 'RICONCILIATO', provaReale: true
  });
  assert.equal(movement.stato, 'DA_VERIFICARE');
  assert.equal(canReconcile(movement, { provaReale: true }).ok, false);
});

test('la Cassa richiede attestazione e Provvisoria non si riconcilia', () => {
  const cassa = normalizeMovement({ conto: 'CASSA', direzione: 'ENTRATA', importo: 10, descrizione: 'Incasso' });
  assert.equal(canReconcile(cassa, { attestazioneManuale: true, riferimento: 'Verifica operatore' }).ok, true);
  const provvisoria = normalizeMovement({ conto: 'PROVVISORIA', direzione: 'USCITA', importo: 10, descrizione: 'Da capire' });
  assert.equal(canReconcile(provvisoria, {}).ok, false);
});

test('il saldo progressivo è stabile anche a parità di data e ora', () => {
  const date = new Date('2026-01-02T10:00:00Z');
  const rows = [
    { _id: 'b', data: date, creatoIl: date, direzione: 'USCITA', importo: 2, tipo: 'ORDINARIO' },
    { _id: 'a', data: date, creatoIl: date, direzione: 'ENTRATA', importo: 5, tipo: 'ORDINARIO' }
  ];
  const ledger = buildLedger(rows, { conto: 'CASSA', saldo: 10 }, 2026);
  assert.equal(ledger[1]._id, 'a');
  assert.equal(ledger[1].saldoProgressivo, 15);
  assert.equal(ledger[2].saldoProgressivo, 13);
});
