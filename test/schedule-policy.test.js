import test from 'node:test';
import assert from 'node:assert/strict';
import { isDue, overlapStart, policyFor } from '../src/schedule-policy.js';

test('PEC e Drive hanno frequenze distinte', () => {
  assert.equal(policyFor('EMAIL_PEC_SCAN').everyMinutes, 30);
  assert.equal(policyFor('DRIVE_FISCALE_SCAN').everyMinutes, 60);
  assert.equal(policyFor('DOCUMENTI_RIPROCESSA').everyMinutes, 120);
});

test('ADER non abilita scraping remoto automatico', () => {
  assert.equal(policyFor('ADER_SNAPSHOT_IMPORT').automaticRemoteFetch, false);
});

test('calcola quando un job è dovuto', () => {
  const now = new Date('2026-08-12T10:00:00Z');
  assert.equal(isDue('2026-08-12T09:20:00Z', now, 30), true);
  assert.equal(isDue('2026-08-12T09:45:00Z', now, 30), false);
});

test('la scansione Drive riparte con sovrapposizione di 72 ore', () => {
  const start = overlapStart('2026-08-12T10:00:00Z', 'DRIVE_FISCALE_SCAN');
  assert.equal(start.toISOString(), '2026-08-09T10:00:00.000Z');
});
