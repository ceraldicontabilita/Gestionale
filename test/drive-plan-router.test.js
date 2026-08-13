import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDriveReadonlyReports, registerDrivePlanRoutes } from '../src/drive-plan-router.js';

const SHA = 'a'.repeat(64);

function completeRun(overrides = {}) {
  return {
    scanId: 'scan-1',
    rootFolderId: 'root',
    stato: 'COMPLETATO',
    completatoIl: new Date('2026-08-13T10:00:00.000Z'),
    counts: { driveFiles: 2, driveFolders: 2, driveErrors: 0 },
    erroriDrive: [],
    ...overrides
  };
}

function inventory() {
  return {
    lastRun: completeRun(),
    files: [
      { driveFileId: 'a', nome: 'modello.pdf', percorso: 'F24/modello.pdf', pathSegments: ['F24', 'modello.pdf'], parentId: 'f24', rootFolderId: 'root', dimensione: 10, sha256Checksum: SHA, scanId: 'scan-1' },
      { driveFileId: 'b', nome: 'copia.pdf', percorso: 'F24/copia.pdf', pathSegments: ['F24', 'copia.pdf'], parentId: 'f24', rootFolderId: 'root', dimensione: 10, sha256Checksum: SHA, scanId: 'scan-1' }
    ],
    folders: [
      { driveFolderId: 'root', nome: '(radice)', parentId: null, rootFolderId: 'root', percorso: '', pathSegments: [], scanId: 'scan-1' },
      { driveFolderId: 'f24', nome: 'F24', parentId: 'root', rootFolderId: 'root', percorso: 'F24', pathSegments: ['F24'], scanId: 'scan-1' }
    ],
    totals: { files: 2, folders: 2 }
  };
}

test('genera report auditabili ma mai azionabili da una scansione completa', () => {
  const reports = buildDriveReadonlyReports({
    ...inventory(),
    generatedAt: '2026-08-13T11:00:00.000Z'
  });
  assert.equal(reports.duplicates.readyForReview, true);
  assert.equal(reports.duplicates.actionable, false);
  assert.equal(reports.duplicates.source.complete, true);
  assert.equal(reports.duplicates.summary.exactDuplicateGroups, 1);
  assert.match(reports.duplicates.source.fileInventoryDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(reports.duplicates.safeguards, {
    driveMutationSupported: false,
    automaticActions: false,
    deletionSupported: false,
    physicalActionsExecuted: false,
    humanReviewRequired: true
  });
  assert.equal(reports.folders.readyForReview, true);
  assert.doesNotMatch(JSON.stringify(reports), /DELETE|TRASH/);
});

test('blocca report e proposte quando inventario e run non coincidono', () => {
  const data = inventory();
  data.lastRun = completeRun({ stato: 'COMPLETATO_CON_AVVISI', counts: { driveFiles: 3, driveFolders: 2, driveErrors: 1 } });
  data.files[1].scanId = 'scan-precedente';
  const reports = buildDriveReadonlyReports({ ...data, generatedAt: '2026-08-13T11:00:00.000Z' });
  assert.equal(reports.duplicates.readyForReview, false);
  assert.equal(reports.duplicates.source.complete, false);
  assert.ok(reports.duplicates.blockers.includes('LAST_SCAN_NOT_COMPLETE'));
  assert.ok(reports.duplicates.blockers.includes('LAST_SCAN_HAS_ERRORS'));
  assert.ok(reports.duplicates.blockers.includes('MIXED_FILE_SCANS'));
  assert.ok(reports.duplicates.blockers.includes('FILE_COUNT_MISMATCH'));
  assert.deepEqual(reports.duplicates.groups, []);
  assert.deepEqual(reports.duplicates.proposals, []);
  assert.equal(reports.folders.readyForReview, false);
  assert.ok(reports.folders.blockers.includes('MIXED_FILE_SCANS'));
  assert.deepEqual(reports.folders.proposals, []);
});

test('blocca record senza scanId e letture con conteggio incompleto', () => {
  const data = inventory();
  delete data.files[0].scanId;
  data.totals.files = 3;
  data.lastRun = completeRun({ counts: { driveFiles: 3, driveFolders: 2, driveErrors: 0 } });
  const reports = buildDriveReadonlyReports({ ...data, generatedAt: '2026-08-13T11:00:00.000Z' });
  assert.ok(reports.duplicates.blockers.includes('FILE_SCAN_ID_MISSING'));
  assert.ok(reports.duplicates.blockers.includes('FILE_INVENTORY_READ_COUNT_MISMATCH'));
  assert.equal(reports.duplicates.readyForReview, false);
  assert.deepEqual(reports.duplicates.groups, []);
});

test('blocca i run che non registrano il conteggio degli errori Drive', () => {
  const data = inventory();
  data.lastRun = completeRun({ counts: { driveFiles: 2, driveFolders: 2 } });
  const reports = buildDriveReadonlyReports({ ...data, generatedAt: '2026-08-13T11:00:00.000Z' });
  assert.equal(reports.duplicates.readyForReview, false);
  assert.ok(reports.duplicates.blockers.includes('DRIVE_ERROR_COUNT_NOT_RECORDED'));
  assert.deepEqual(reports.duplicates.proposals, []);
});

function cursor(rows) {
  return {
    sort() { return this; },
    limit(value) { this.value = value; return this; },
    async toArray() { return rows.slice(0, this.value); }
  };
}

test('registra endpoint GET indipendenti dalle credenziali Drive e imposta no-store', async () => {
  const data = inventory();
  const collections = {
    drive_inventory_config: { async findOne() { return { _id: 'CANONICAL_ROOT', rootFolderId: 'root' }; } },
    drive_import_runs: { async findOne() { return data.lastRun; } },
    drive_files: { async countDocuments() { return data.totals.files; }, find() { return cursor(data.files); } },
    drive_folders: { async countDocuments() { return data.totals.folders; }, find() { return cursor(data.folders); } }
  };
  const routes = new Map();
  const app = { get(path, handler) { routes.set(path, handler); } };
  registerDrivePlanRoutes(app, { getDb: () => ({ collection: (name) => collections[name] }), env: {} });
  assert.deepEqual([...routes.keys()].sort(), ['/api/drive-data/duplicates', '/api/drive-data/folder-plan']);

  const response = {
    statusCode: 200,
    headers: {},
    set(name, value) { this.headers[name] = value; },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; }
  };
  await routes.get('/api/drive-data/duplicates')({}, response);
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['Cache-Control'], 'no-store');
  assert.equal(response.body.mode, 'READ_ONLY');
});
