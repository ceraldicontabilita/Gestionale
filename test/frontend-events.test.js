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
  assert.match(html, /id=["']f24ReceiptRows["']/);
  assert.match(source, /\/api\/f24-quietanze/);
});

test('la pagina fatture espone intake automatico, fornitori e albero delle attese', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  for (const id of [
    'supplierInvoiceIntakeForm',
    'supplierImportMonitor',
    'supplierImportProgress',
    'supplierInvoiceStagingRows',
    'supplierInvoiceCanonicalRows',
    'supplierInvoiceTree',
    'view-fornitori',
    'supplierDirectoryRows',
    'view-archivi',
    'archiveVerbaliRows',
    'sourcePackageRows'
  ]) assert.match(html, new RegExp(`id=["']${id}["']`));
  assert.match(html, /name=["']invoiceFiles["'][^>]*multiple/);
  assert.match(html, /accept=["'][^"']*\.zip/);
  assert.match(source, /\/api\/supplier-invoices\/import-jobs/);
  assert.match(source, /new XMLHttpRequest\(\)/);
  assert.match(source, /localStorage\.setItem\(SUPPLIER_IMPORT_JOB_KEY/);
  assert.match(source, /\/api\/supplier-invoices\/suppliers\/directory/);
  assert.match(source, /target\.protocol !== 'https:'/);
  assert.doesNotMatch(source, /\/api\/supplier-invoices\/validate/);
  assert.doesNotMatch(html, /id=["']supplierInvoiceValidationForm["']/);
  assert.match(source, /supplier-invoices\/\$\{encodeURIComponent\(invoiceId\)\}\/tree/);
  assert.match(source, /PIN_CONFIRMATION_REQUIRED/);
  assert.match(source, /\/api\/auth\/pin-confirm/);
  assert.doesNotMatch(`${html}\n${source}`, /MFA|TOTP|authenticator/i);
});
