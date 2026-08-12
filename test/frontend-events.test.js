import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('i form conservano il riferimento prima delle richieste asincrone', () => {
  const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /event\.currentTarget\.reset\s*\(/);
  assert.match(source, /const formElement = event\.currentTarget/);
});

test('le pagine operative espongono i controlli di riconciliazione e verifica', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

  for (const id of [
    'reconciliationYear',
    'reconciliationMovementRows',
    'reconciliationCauseRows',
    'confirmReconciliation',
    'controlYear',
    'controlIssues',
    'riscossioneForm',
    'riscossioneRows'
  ]) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }

  assert.match(source, /\/api\/riconciliazione/);
  assert.match(source, /\/api\/riscossione\/atti/);
});
