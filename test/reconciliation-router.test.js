import assert from 'node:assert/strict';
import test from 'node:test';
import { hasRealFinancialEvidence } from '../src/reconciliation-router.js';

test('accetta soltanto evidenze reali compatibili con il conto', () => {
  assert.equal(hasRealFinancialEvidence({
    conto: 'BANCA',
    evidenze: [{ tipo: 'MOVIMENTO_BANCARIO', reale: true, riferimento: 'riga-123' }]
  }), true);
  assert.equal(hasRealFinancialEvidence({
    conto: 'BANCA',
    evidenze: [{ tipo: 'MOVIMENTO_CARTA', reale: true, riferimento: 'riga-123' }]
  }), false);
  assert.equal(hasRealFinancialEvidence({
    conto: 'MASTERCARD',
    evidenze: [{ tipo: 'MOVIMENTO_CARTA', reale: false, riferimento: 'riga-123' }]
  }), false);
});

test('un riferimento mancante non costituisce prova finanziaria', () => {
  assert.equal(hasRealFinancialEvidence({
    conto: 'BANCA',
    evidenze: [{ tipo: 'ESTRATTO_CONTO', reale: true }]
  }), false);
});
