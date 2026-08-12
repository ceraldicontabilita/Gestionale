import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCorrispettivoDay } from '../src/corrispettivi.js';

test('correggere Numia conserva SumUp già registrato', () => {
  const existing = { dataGiorno: '2026-08-10', totaleXml: 1000, chiusuraOperativa: 1000, pos: { NUMIA: 500, SUMUP: 100 } };
  const result = normalizeCorrispettivoDay({ data: '2026-08-10', pos: { NUMIA: 510 } }, existing);
  assert.deepEqual(result.pos, { NUMIA: 510, SUMUP: 100 });
  assert.equal(result.contanteAtteso, 390);
});

test('zero è un dato POS valido, null rimuove esplicitamente il dato', () => {
  const base = normalizeCorrispettivoDay({ data: '2026-08-10', totaleXml: 100, chiusuraOperativa: 100, pos: { NUMIA: 0, SUMUP: 20 } });
  assert.equal(base.pos.NUMIA, 0);
  assert.equal(base.contanteAtteso, 80);
  const removed = normalizeCorrispettivoDay({ data: '2026-08-10', pos: { SUMUP: null } }, base);
  assert.equal(Object.hasOwn(removed.pos, 'SUMUP'), false);
  assert.equal(removed.contanteAtteso, null);
});

test('non inventa il contante quando manca un terminale', () => {
  const result = normalizeCorrispettivoDay({ data: '2026-08-10', totaleXml: 100, chiusuraOperativa: 100, pos: { NUMIA: 30 } });
  assert.equal(result.contanteAtteso, null);
  assert.match(result.nota, /manca almeno una chiusura POS/);
});

test('rifiuta date impossibili e valori negativi', () => {
  assert.throws(() => normalizeCorrispettivoDay({ data: '2026-02-31', totaleXml: 10 }), /Data giornata/);
  assert.throws(() => normalizeCorrispettivoDay({ data: '2026-02-28', totaleXml: -1 }), /negativo/);
});
