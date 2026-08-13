import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { buildOpenItemsView } from '../src/reconciliation-router.js';

test('le partite aperte conservano identita, centesimi, scadenza e stato', () => {
  const view = buildOpenItemsView([
    { obligationKey: 'O1', currency: 'EUR', originalCents: 12_200, allocatedCents: 2_200, residualCents: 10_000, status: 'PARTIAL', sourceEventKey: 'E1' },
    { obligationKey: 'O2', currency: 'EUR', originalCents: 5_000, allocatedCents: 5_000, residualCents: 0, status: 'CLOSED', sourceEventKey: 'E2' },
    { obligationKey: 'O3', currency: 'EUR', originalCents: 8_000, allocatedCents: 0, residualCents: 8_000, status: 'OPEN', sourceEventKey: 'E3' }
  ], [
    { obligationKey: 'O1', sourceEntityId: 'I1', dueDate: new Date('2026-08-01T00:00:00Z') },
    { obligationKey: 'O2', sourceEntityId: 'I2', dueDate: new Date('2026-07-01T00:00:00Z') },
    { obligationKey: 'O3', sourceEntityId: 'I3', dueDate: null }
  ], [
    { invoiceId: 'I1', naturalKey: 'N1', number: '10', documentType: 'TD01', supplier: { name: 'Alfa', vatId: 'IT1' }, dates: { documentDate: new Date('2026-07-01T00:00:00Z') } },
    { invoiceId: 'I2', naturalKey: 'N2', number: '11', documentType: 'TD01', supplier: { name: 'Beta', vatId: 'IT2' }, dates: { documentDate: new Date('2026-06-01T00:00:00Z') } },
    { invoiceId: 'I3', naturalKey: 'N3', number: '12', documentType: 'TD01', supplier: { name: 'Gamma', vatId: 'IT3' }, dates: { documentDate: new Date('2026-08-01T00:00:00Z') } }
  ], { now: new Date('2026-08-13T00:00:00Z') });

  assert.deepEqual(view.counts, {
    total: 3,
    open: 1,
    partial: 1,
    closed: 1,
    overdue: 1,
    withoutDueDate: 1,
    residualCents: 18_000
  });
  assert.equal(view.rows[0].invoiceId, 'I2');
  assert.equal(view.rows[1].invoiceNaturalKey, 'N1');
  assert.equal(view.rows[1].residualCents, 10_000);
  assert.equal(view.rows[1].overdue, true);
  assert.equal(view.rows[2].dueDate, null);
});

test('la UI espone partite aperte e fatture come cause identificate', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(html, /id=["']openItemRows["']/);
  assert.match(html, /value=["']FATTURA_FORNITORE["']/);
  assert.match(source, /api\(`\/api\/riconciliazione\/partite-aperte\?status=/);
  assert.match(source, /invoiceNaturalKey: cause\.invoiceNaturalKey/);
  assert.match(source, /movementReference: movement\.movementReference/);
  assert.match(source, /Math\.min\(Number\(movement\.availableAmount/);
  assert.match(source, /openItems\?\.candidates/);
});
