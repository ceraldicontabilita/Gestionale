import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTargetedOcrPlan,
  compareNativeAndOcrField,
  evaluateF24ExtractionPolicy
} from '../src/f24-extraction-policy.js';

const completeFields = {
  taxpayerFiscalCode: '04523831214',
  modelDate: '10/11/2020',
  lines: [{ code: '2003', debit: '2.009,67' }],
  totalDebit: '2.029,67',
  totalCredit: '0,00',
  finalBalance: '2.029,67'
};

const nativePages = [{ page: 1, text: 'MODELLO F24 CODICE FISCALE 04523831214 SEZIONE ERARIO CODICE TRIBUTO IMPORTI A DEBITO IMPORTI A CREDITO SALDO FINALE 2.029,67' }];

test('usa soltanto testo nativo quando campi e quadrature sono completi', () => {
  const policy = evaluateF24ExtractionPolicy({ pages: nativePages, fields: completeFields, accountingStatus: 'QUADRATO', documentOrigin: 'AGENZIA_ENTRATE' });
  assert.equal(policy.mode, 'NATIVE_ONLY');
  assert.equal(policy.ocrPurpose, 'NONE');
  assert.equal(policy.ocrCanOverwriteNative, false);
  assert.equal(policy.requiresHumanReview, false);
});

test('attiva OCR mirato se manca un campo essenziale', () => {
  const fields = { ...completeFields, finalBalance: null };
  const policy = evaluateF24ExtractionPolicy({ pages: nativePages, fields, accountingStatus: 'NON_VERIFICATO' });
  assert.equal(policy.mode, 'NATIVE_PLUS_TARGETED_OCR');
  assert.deepEqual(policy.missingFields, ['finalBalance']);
  const plan = buildTargetedOcrPlan({ policy, fieldLocations: { finalBalance: { page: 1, box: [10, 10, 100, 30] } } });
  assert.equal(plan.fullDocument, false);
  assert.equal(plan.targets[0].field, 'finalBalance');
});

test('attiva OCR completo soltanto quando il testo nativo è insufficiente', () => {
  const policy = evaluateF24ExtractionPolicy({ pages: [{ page: 1, text: '' }], fields: {}, accountingStatus: 'NON_VERIFICATO' });
  assert.equal(policy.mode, 'OCR_FULL');
  assert.equal(policy.nativeTextAuthoritative, false);
  assert.equal(policy.ocrPurpose, 'RECOVERY');
});

test('quadratura fallita richiede OCR mirato degli importi', () => {
  const policy = evaluateF24ExtractionPolicy({ pages: nativePages, fields: completeFields, accountingStatus: 'CONTESTATO' });
  assert.equal(policy.mode, 'NATIVE_PLUS_TARGETED_OCR');
  const plan = buildTargetedOcrPlan({ policy });
  assert.deepEqual(plan.targets.map((item) => item.field), ['amountColumns', 'sectionTotals', 'finalBalance']);
});

test('OCR concorde valida il campo ma non sostituisce il testo sorgente', () => {
  const result = compareNativeAndOcrField({
    field: 'finalBalance', fieldType: 'AMOUNT', nativeValue: '2.029,67', ocrValue: '2 029 67',
    nativeSource: { page: 1, method: 'NATIVE_TEXT' }, ocrSource: { page: 1, method: 'OCR_TARGETED' }, ocrConfidence: 0.98
  });
  assert.equal(result.comparison, 'MATCH');
  assert.equal(result.acceptedValue, '2029.67');
  assert.equal(result.autoConfirm, true);
  assert.equal(result.native.rawValue, '2.029,67');
});

test('OCR discordante non sceglie automaticamente alcun valore', () => {
  const result = compareNativeAndOcrField({ field: 'finalBalance', fieldType: 'AMOUNT', nativeValue: '528,79', ocrValue: '526,79', ocrConfidence: 0.99 });
  assert.equal(result.comparison, 'CONFLICT');
  assert.equal(result.acceptedValue, null);
  assert.equal(result.state, 'CONTESTATO');
  assert.equal(result.requiresHumanReview, true);
});

test('un valore presente soltanto in OCR richiede verifica umana', () => {
  const result = compareNativeAndOcrField({ field: 'modelDate', fieldType: 'DATE', nativeValue: null, ocrValue: '16/10/2025', ocrConfidence: 0.99 });
  assert.equal(result.comparison, 'OCR_RECOVERY_REQUIRES_REVIEW');
  assert.equal(result.acceptedValue, null);
  assert.equal(result.autoConfirm, false);
});
