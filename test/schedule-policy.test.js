import test from 'node:test';
import assert from 'node:assert/strict';
import { isDue, isPolicyDue, overlapStart, policyFor } from '../src/schedule-policy.js';

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

test('il controllo fiscale giornaliero rispetta le 03 Europe/Rome e recupera dopo un riavvio', () => {
  const policy = policyFor('SCADENZE_FISCALI');
  assert.equal(isPolicyDue('2026-08-11T02:00:00Z', new Date('2026-08-12T00:55:00Z'), policy), false);
  assert.equal(isPolicyDue('2026-08-11T02:00:00Z', new Date('2026-08-12T01:05:00Z'), policy), true);
  assert.equal(isPolicyDue('2026-08-12T01:01:00Z', new Date('2026-08-12T10:00:00Z'), policy), false);
});
