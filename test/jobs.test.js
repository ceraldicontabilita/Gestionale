import test from 'node:test';
import assert from 'node:assert/strict';
import { checkpointWindow, normalizeJobName } from '../src/jobs.js';

test('normalizza soltanto job documentali conosciuti', () => {
  assert.equal(normalizeJobName('drive_fiscale_scan'), 'DRIVE_FISCALE_SCAN');
  assert.throws(() => normalizeJobName('job_inventato'), /Job non valido/);
});

test('il checkpoint riparte con finestra di sovrapposizione', () => {
  const checkpoint = { value: { lastSuccessfulAt: '2026-08-10T12:00:00.000Z' } };
  const start = checkpointWindow(checkpoint, 48 * 60 * 60 * 1000);
  assert.equal(start.toISOString(), '2026-08-08T12:00:00.000Z');
});

test('senza checkpoint non inventa una data di partenza', () => {
  assert.equal(checkpointWindow(null), null);
  assert.equal(checkpointWindow({ value: {} }), null);
});
