import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('i form conservano il riferimento prima delle richieste asincrone', () => {
  const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /event\.currentTarget\.reset\s*\(/);
  assert.match(source, /const formElement = event\.currentTarget/);
});
