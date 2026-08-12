import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDelimitedText } from '../src/csv.js';
import { extractDriveId } from '../src/google-drive-client.js';

test('parser CSV conserva campi quotati con punto e virgola', () => {
  const rows = parseDelimitedText('\uFEFFanno;file;nota\r\n2026;f24.pdf;"testo; con separatore"\r\n');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].anno, '2026');
  assert.equal(rows[0].file, 'f24.pdf');
  assert.equal(rows[0].nota, 'testo; con separatore');
});

test('estrae ID da cartella e file Google Drive senza memorizzare URL personali', () => {
  assert.equal(extractDriveId('https://drive.google.com/drive/folders/ABC_123-xyz'), 'ABC_123-xyz');
  assert.equal(extractDriveId('https://drive.google.com/file/d/FILE_456/view'), 'FILE_456');
  assert.equal(extractDriveId('RAW_ID'), 'RAW_ID');
});
