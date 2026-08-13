import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeAccountingProjection,
  normalizeDomainEvent,
  stableFingerprint
} from '../src/event-engine.js';

function competence(overrides = {}) {
  return {
    entryKind: 'DOCUMENT_COMPETENCE',
    source: { type: 'INVOICE_SUPPLIER', id: 'fattura-1', version: '1' },
    postingRule: { id: 'FATTURA_PASSIVA_ORDINARIA', version: '2026.1' },
    dates: {
      documentDate: '2026-08-01',
      receiptDate: '2026-08-02',
      competenceDate: '2026-08-01',
      registrationDate: '2026-08-03',
      vatDate: '2026-08-02',
      dueDate: '2026-09-01'
    },
    lines: [
      { accountCode: 'COSTI_MERCI', debit: 100, credit: 0 },
      { accountCode: 'IVA_CREDITO', debit: 22, credit: 0 },
      { accountCode: 'DEBITI_FORNITORI', debit: 0, credit: 122 }
    ],
    description: 'Fattura fornitore sintetica',
    ...overrides
  };
}

test('la competenza è quadrata e non richiede una prova di pagamento', () => {
  const entry = normalizeAccountingProjection(competence());
  assert.equal(entry.entryKind, 'DOCUMENT_COMPETENCE');
  assert.deepEqual(entry.totals, { debit: 122, credit: 122 });
  assert.deepEqual(entry.evidence, []);
  assert.equal(entry.dates.valueDate, null);
  assert.match(entry.projectionKey, /DOCUMENT_COMPETENCE/);
});

test('rifiuta una competenza subordinata al pagamento', () => {
  assert.throws(
    () => normalizeAccountingProjection(competence({ requiresPayment: true })),
    /non può dipendere dal pagamento/
  );
});

test('il regolamento richiede una prova finanziaria riferita', () => {
  const settlement = {
    ...competence({
      entryKind: 'FINANCIAL_SETTLEMENT',
      dates: {
        competenceDate: '2026-08-15',
        registrationDate: '2026-08-15',
        valueDate: '2026-08-15'
      },
      lines: [
        { accountCode: 'DEBITI_FORNITORI', debit: 122 },
        { accountCode: 'BANCA', credit: 122 }
      ],
      postingRule: { id: 'PAGAMENTO_FORNITORE', version: '2026.1' }
    })
  };
  assert.throws(() => normalizeAccountingProjection(settlement), /richiede una prova riferita/);
  const entry = normalizeAccountingProjection({
    ...settlement,
    evidence: [{ type: 'MOVIMENTO_BANCARIO', reference: 'TRN:SINTETICO-1' }]
  });
  assert.equal(entry.entryKind, 'FINANCIAL_SETTLEMENT');
  assert.equal(entry.evidence[0].reference, 'TRN:SINTETICO-1');
});

test('rifiuta scritture non quadrate e righe ambigue', () => {
  assert.throws(
    () => normalizeAccountingProjection(competence({ lines: [{ accountCode: 'COSTI', debit: 100 }, { accountCode: 'DEBITI', credit: 99 }] })),
    /non quadrata/
  );
  assert.throws(
    () => normalizeAccountingProjection(competence({ lines: [{ accountCode: 'COSTI', debit: 100, credit: 1 }, { accountCode: 'DEBITI', credit: 99 }] })),
    /esclusivamente Dare oppure Avere/
  );
});

test('impedisce di usare un evento documento come regolamento finanziario', () => {
  const settlement = competence({
    entryKind: 'FINANCIAL_SETTLEMENT',
    postingRule: { id: 'PAGAMENTO_FORNITORE', version: '2026.1' },
    lines: [
      { accountCode: 'DEBITI_FORNITORI', debit: 122 },
      { accountCode: 'BANCA', credit: 122 }
    ],
    evidence: [{ type: 'MOVIMENTO_BANCARIO', reference: 'TRN:SINTETICO-1' }]
  });
  assert.throws(() => normalizeDomainEvent({
    type: 'invoice.supplier_validated',
    aggregate: { type: 'INVOICE_SUPPLIER', id: 'fattura-1', version: '1' },
    accounting: settlement,
    provenance: { source: 'XML_SDI', reference: 'sha256:sintetico' }
  }), /non compatibili/);
});

test('un retry dello stesso fatto resta idempotente anche se cambia l orario tecnico', () => {
  const input = {
    type: 'invoice.supplier_validated',
    aggregate: { type: 'INVOICE_SUPPLIER', id: 'fattura-1', version: '1' },
    accounting: competence(),
    provenance: { source: 'XML_SDI', reference: 'sha256:sintetico' }
  };
  const first = normalizeDomainEvent(input, { now: new Date('2026-08-03T10:00:00Z') });
  const retry = normalizeDomainEvent(input, { now: new Date('2026-08-03T10:05:00Z') });
  assert.notEqual(first.occurredAt.toISOString(), retry.occurredAt.toISOString());
  assert.equal(first.fingerprint, retry.fingerprint);
});

test('conserva distinte tutte le date contabili italiane', () => {
  const entry = normalizeAccountingProjection(competence());
  assert.equal(entry.dates.documentDate.toISOString().slice(0, 10), '2026-08-01');
  assert.equal(entry.dates.receiptDate.toISOString().slice(0, 10), '2026-08-02');
  assert.equal(entry.dates.competenceDate.toISOString().slice(0, 10), '2026-08-01');
  assert.equal(entry.dates.registrationDate.toISOString().slice(0, 10), '2026-08-03');
  assert.equal(entry.dates.vatDate.toISOString().slice(0, 10), '2026-08-02');
  assert.equal(entry.dates.dueDate.toISOString().slice(0, 10), '2026-09-01');
});

test('genera un evento deterministico con aggregato e fonte coincidenti', () => {
  const input = {
    type: 'invoice.supplier_validated',
    aggregate: { type: 'INVOICE_SUPPLIER', id: 'fattura-1', version: '1' },
    accounting: competence(),
    provenance: { source: 'XML_SDI', reference: 'sha256:sintetico' }
  };
  const first = normalizeDomainEvent(input, { now: new Date('2026-08-03T10:00:00Z') });
  const second = normalizeDomainEvent(input, { now: new Date('2026-08-03T10:00:00Z') });
  assert.equal(first.eventKey, 'invoice.supplier_validated:INVOICE_SUPPLIER:fattura-1:1:DOCUMENT_COMPETENCE');
  assert.equal(first.fingerprint, second.fingerprint);
  assert.throws(
    () => normalizeDomainEvent({ ...input, aggregate: { type: 'INVOICE_SUPPLIER', id: 'altra', version: '1' } }),
    /non coincidono/
  );
});

test('il fingerprint è stabile rispetto all ordine delle chiavi', () => {
  assert.equal(stableFingerprint({ b: 2, a: 1 }), stableFingerprint({ a: 1, b: 2 }));
});

test('un movimento osservato entra nel registro eventi senza creare una scrittura contabile', () => {
  const event = normalizeDomainEvent({
    type: 'financial.movement_observed',
    aggregate: { type: 'FINANCIAL_MOVEMENT', id: 'movement-synthetic-1', version: '1' },
    payload: { movementKey: 'movement-synthetic-1', amountCents: 1220, currency: 'EUR' },
    provenance: { source: 'BANK_STATEMENT_CSV', reference: 'sha256:synthetic:row:2' }
  });
  assert.equal(event.accounting, null);
  assert.equal(event.eventKey, 'financial.movement_observed:FINANCIAL_MOVEMENT:movement-synthetic-1:1');
  assert.throws(() => normalizeDomainEvent({
    type: 'financial.movement_observed',
    aggregate: { type: 'FINANCIAL_MOVEMENT', id: 'movement-synthetic-1', version: '1' },
    accounting: competence(),
    provenance: { source: 'BANK_STATEMENT_CSV', reference: 'sha256:synthetic:row:2' }
  }), /non contiene una scrittura contabile/);
});
