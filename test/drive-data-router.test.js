import assert from 'node:assert/strict';
import test from 'node:test';

import { DRIVE_DOMAIN_DEFINITIONS } from '../src/drive-data-router.js';

test('l archivio espone tutti i domini top-level richiesti senza fondere le fonti', () => {
  for (const domain of [
    'f24', 'quietanze', 'riscossione', 'verbali', 'dipendenti', 'fatture',
    'banca', 'corrispettivi', 'fiscale', 'azienda', 'rettifiche', 'da_classificare'
  ]) assert.ok(DRIVE_DOMAIN_DEFINITIONS[domain], `Dominio mancante: ${domain}`);
});
