import assert from 'node:assert/strict';
import test from 'node:test';
import {
  acquireDriveImportLease,
  buildDriveIndexDataset,
  ensureCanonicalDriveRoot,
  persistDriveMetadata,
  proposedDocumentType,
  scanDriveTree
} from '../src/drive-data-import.js';

function document(id, sha, path) {
  return { __id: id, __sha: sha, __path: path, 'ID documento': id, 'SHA-256': sha, 'Percorso Drive': path, 'Nome file': path.split('/').at(-1), Dominio: 'F24 E QUIETANZE', Categoria: '02_F24_QUIETANZE', Anno: 2026, Stato: 'CARICATO_UNICO' };
}

function row(id, sha, type, debit, credit = 0) {
  return { 'ID documento': id, 'Anno pagamento': 2026, 'Data pagamento': '20/07/2026', Sezione: 'ERARIO', 'Codice tributo': '1001', Descrizione: 'Ritenute', 'Periodo tributo': '2026-06', Debito: debit, Credito: credit, Protocollo: 'ABC', 'Tipo documento': type, 'SHA-256': sha, 'Percorso Drive': `F24/${id}.pdf`, Pagina: 1, Fonte: 'PDF_PRIMARIO' };
}

test('separa quietanze e modelli senza trasformare una ricevuta in prova bancaria', () => {
  const sha1 = 'a'.repeat(64); const sha2 = 'b'.repeat(64);
  const data = buildDriveIndexDataset({
    documents: [document('DOC-1', sha1, 'F24/DOC-1.pdf'), document('DOC-2', sha2, 'Quietanze/DOC-2.pdf')],
    f24Rows: [row('DOC-1', sha1, 'F24_STAMPABILE_CON_ESTREMI', 100), row('DOC-2', sha2, 'QUIETANZA_AE', 100)],
    declarations: [], duplicates: []
  }, 'rev-1');

  assert.equal(data.f24Documents.length, 2);
  assert.equal(data.f24Documents.filter((item) => item.quietanza).length, 1);
  assert.equal(data.f24Documents.find((item) => item.quietanza).totals.saldo, 100);
  assert.equal(data.f24Rows[0].annoRiferimento, 2026);
  assert.equal(data.f24Rows[0].rateazioneMeseRif, '06');
});

test('la cartella propone il dominio senza dedurre un pagamento', () => {
  assert.equal(proposedDocumentType('Cedolini Paga/Rossi/cedolino.pdf'), 'CEDOLINO');
  assert.equal(proposedDocumentType('Estratti conto/2026/conto.pdf'), 'ESTRATTO_CONTO');
  assert.equal(proposedDocumentType('Nuova cartella/file.pdf'), 'DOCUMENTO_DRIVE');
  assert.equal(proposedDocumentType([' F24', 'modello.pdf']), 'DOCUMENTO_DRIVE');
  assert.equal(proposedDocumentType(['F24 ', 'modello.pdf']), 'DOCUMENTO_DRIVE');
});

test('la scansione conserva radice, cartelle vuote, relazioni e segmenti Drive esatti', async () => {
  const children = new Map([
    ['root-id', [
      { id: 'empty-id', name: 'Cartella vuota', mimeType: 'application/vnd.google-apps.folder' },
      { id: 'slash-id', name: 'Periodo 2025/2026', mimeType: 'application/vnd.google-apps.folder' }
    ]],
    ['empty-id', []],
    ['slash-id', [{ id: 'file-id', name: 'modello.pdf', mimeType: 'application/pdf', size: '42' }]]
  ]);
  const calls = [];
  const scan = await scanDriveTree({
    async listChildren(folderId) { calls.push(folderId); return children.get(folderId) || []; }
  }, 'root-id');

  assert.equal(scan.folders, 3);
  assert.equal(scan.folderRecords.length, 3);
  assert.deepEqual(new Set(calls), new Set(['root-id', 'empty-id', 'slash-id']));
  assert.deepEqual(scan.folderRecords.find((folder) => folder.id === 'root-id'), {
    id: 'root-id', driveFolderId: 'root-id', name: '(radice)', nome: '(radice)',
    mimeType: 'application/vnd.google-apps.folder', parentId: null, path: '', pathSegments: []
  });
  assert.deepEqual(scan.folderRecords.find((folder) => folder.id === 'empty-id').pathSegments, ['Cartella vuota']);
  const slashFolder = scan.folderRecords.find((folder) => folder.id === 'slash-id');
  assert.equal(slashFolder.parentId, 'root-id');
  assert.equal(slashFolder.path, 'Periodo 2025/2026');
  assert.deepEqual(slashFolder.pathSegments, ['Periodo 2025/2026']);
  assert.equal(scan.files[0].parentId, 'slash-id');
  assert.deepEqual(scan.files[0].pathSegments, ['Periodo 2025/2026', 'modello.pdf']);
  assert.equal(proposedDocumentType(['F24/2026', 'modello.pdf']), 'DOCUMENTO_DRIVE');
});

test('la persistenza aggiorna cartelle e file e disattiva gli assenti solo dopo una scansione completa', async () => {
  const writes = new Map(); const deactivations = new Map();
  const db = { collection(name) { return {
    async bulkWrite(operations) { writes.set(name, operations); return { matchedCount: 0, upsertedCount: operations.length, modifiedCount: 0 }; },
    async updateMany(filter, update) { deactivations.set(name, { filter, update }); return { matchedCount: 1, modifiedCount: 1 }; },
    find() { return { async toArray() { return name === 'documenti' ? [{ _id: 'doc-file', primarySourceKey: 'DRIVE_FILE:file-id' }] : []; } }; }
  }; } };
  const scan = {
    folders: 2,
    folderRecords: [
      { id: 'root-id', driveFolderId: 'root-id', name: '(radice)', nome: '(radice)', mimeType: 'application/vnd.google-apps.folder', parentId: null, path: '', pathSegments: [] },
      { id: 'folder-id', driveFolderId: 'folder-id', name: 'A/B', nome: 'A/B', mimeType: 'application/vnd.google-apps.folder', parentId: 'root-id', path: 'A/B', pathSegments: ['A/B'] }
    ],
    files: [{ id: 'file-id', name: 'x.pdf', mimeType: 'application/pdf', size: '7', path: 'A/B/x.pdf', pathSegments: ['A/B', 'x.pdf'], topFolder: 'A/B', extension: '.pdf', year: null, parentId: 'folder-id' }],
    errors: []
  };
  const now = new Date('2026-08-13T10:00:00.000Z');
  const result = await persistDriveMetadata(db, scan, new Map(), now, 'scan-1', 'root-id');

  assert.equal(result.folderResult.upserted, 2);
  assert.equal(result.writes.driveFolders.upserted, 2);
  assert.deepEqual(writes.get('drive_folders')[1].updateOne.update.$set.pathSegments, ['A/B']);
  assert.deepEqual(writes.get('drive_files')[0].updateOne.update.$set.pathSegments, ['A/B', 'x.pdf']);
  assert.deepEqual(writes.get('documenti')[0].updateOne.update.$set['datiEstratti.drive'].pathSegments, ['A/B', 'x.pdf']);
  assert.deepEqual(deactivations.get('drive_folders').filter, { rootFolderId: 'root-id', scanId: { $ne: 'scan-1' }, attivo: true });

  deactivations.clear();
  await persistDriveMetadata(db, { ...scan, errors: [{ folderId: 'folder-id' }] }, new Map(), now, 'scan-2', 'root-id');
  assert.equal(deactivations.size, 0);
});

test('collega per SHA senza sovrascrivere il documento canonico e conserva identita Drive separate', async () => {
  const hash = 'a'.repeat(64); const writes = new Map();
  const driveDocs = [
    { _id: 'source-a', primarySourceKey: 'DRIVE_FILE:file-a' },
    { _id: 'source-b', primarySourceKey: 'DRIVE_FILE:file-b' }
  ];
  const db = { collection(name) { return {
    async bulkWrite(operations) { writes.set(name, operations); return { matchedCount: 0, upsertedCount: operations.length, modifiedCount: 0 }; },
    async updateMany() { return { matchedCount: 0, modifiedCount: 0 }; },
    find() { return { async toArray() { return name === 'documenti' ? driveDocs : []; } }; }
  }; } };
  const indexDocument = { _id: 'canonical', sha256: hash, datiEstratti: { driveIndex: { id: 'IDX-1', dimensione: 10 } } };
  const scan = {
    folders: 1,
    folderRecords: [{ id: 'root', driveFolderId: 'root', name: '(radice)', nome: '(radice)', mimeType: 'application/vnd.google-apps.folder', parentId: null, path: '', pathSegments: [] }],
    files: [
      { id: 'file-a', name: 'a.pdf', mimeType: 'application/pdf', size: '10', sha256Checksum: hash, path: 'a.pdf', pathSegments: ['a.pdf'], topFolder: '(radice)', extension: '.pdf', year: null, parentId: 'root' },
      { id: 'file-b', name: 'b.pdf', mimeType: 'application/pdf', size: '10', sha256Checksum: hash, path: 'b.pdf', pathSegments: ['b.pdf'], topFolder: '(radice)', extension: '.pdf', year: null, parentId: 'root' }
    ],
    errors: []
  };
  await persistDriveMetadata(db, scan, new Map([['IDX-1', indexDocument]]), new Date('2026-08-13T10:00:00Z'), 'scan-1', 'root');

  const documentWrites = writes.get('documenti');
  assert.ok(documentWrites.every((operation) => String(operation.updateOne.filter.primarySourceKey).startsWith('DRIVE_FILE:')));
  const links = writes.get('drive_document_links').map((operation) => operation.updateOne.update.$set);
  assert.deepEqual(links.map((link) => link.documentoId), ['canonical', 'canonical']);
  assert.deepEqual(links.map((link) => link.documentoDriveId), ['source-a', 'source-b']);
  assert.ok(links.every((link) => link.verified));
});

test('la radice canonica blocca una radice diversa anche con sole cartelle attive', async () => {
  const config = new Map();
  const db = { collection(name) { return {
    async distinct() { return name === 'drive_folders' ? ['root-a'] : []; },
    async countDocuments() { return 0; },
    async findOne(filter) { return config.get(filter._id) || null; },
    async updateOne(filter, update) {
      if (!config.has(filter._id)) config.set(filter._id, { _id: filter._id, ...update.$setOnInsert, ...update.$set });
      else Object.assign(config.get(filter._id), update.$set);
      return { matchedCount: 1 };
    }
  }; } };

  await assert.rejects(
    ensureCanonicalDriveRoot(db, 'root-b'),
    (error) => error.code === 'DRIVE_ROOT_CHANGED'
  );
  assert.equal(config.size, 0);
});

test('l adozione della radice comprende documenti Drive orfani preesistenti', async () => {
  const updates = []; const config = new Map();
  const db = { collection(name) { return {
    async distinct() { return []; },
    async countDocuments() { return name === 'documenti' ? 1 : 0; },
    async findOne(filter) { return config.get(filter._id) || null; },
    async updateMany(filter, update) { updates.push({ name, filter, update }); return { matchedCount: 1, modifiedCount: 1 }; },
    async updateOne(filter, update) {
      if (!config.has(filter._id)) config.set(filter._id, { _id: filter._id, ...update.$setOnInsert, ...update.$set });
      else Object.assign(config.get(filter._id), update.$set);
      return { matchedCount: 1 };
    }
  }; } };

  await assert.rejects(
    ensureCanonicalDriveRoot(db, 'root'),
    (error) => error.code === 'DRIVE_ROOT_ADOPTION_REQUIRED'
  );
  const result = await ensureCanonicalDriveRoot(db, 'root', 'root');
  assert.equal(result.adoptUnscoped, true);
  const documentUpdate = updates.find((item) => item.name === 'documenti');
  assert.equal(documentUpdate.update.$set.rootFolderId, 'root');
  assert.equal(documentUpdate.update.$set.recordKind, 'DRIVE_SOURCE');
  assert.equal(documentUpdate.update.$set.sourceActive, true);
});

test('il lease Mongo impedisce due scansioni concorrenti sulla stessa radice', async () => {
  const records = new Map();
  const collection = {
    async updateOne(filter, update, options = {}) {
      const current = records.get(filter._id);
      const now = filter.$or?.[0]?.expiresAt?.$lte;
      const matches = current && (!filter.$or || current.expiresAt <= now || current.ownerId === filter.$or[1].ownerId);
      if (matches) { Object.assign(current, update.$set); return { matchedCount: 1 }; }
      if (options.upsert) {
        if (current) throw Object.assign(new Error('duplicate key'), { code: 11000 });
        records.set(filter._id, { _id: filter._id, ...update.$set });
        return { matchedCount: 0, upsertedCount: 1 };
      }
      return { matchedCount: 0 };
    },
    async findOne(filter) {
      const current = records.get(filter._id);
      if (!current || (filter.ownerId && current.ownerId !== filter.ownerId)) return null;
      if (filter.expiresAt?.$gt && current.expiresAt <= filter.expiresAt.$gt) return null;
      return current;
    },
    async deleteOne(filter) {
      const current = records.get(filter._id);
      if (current?.ownerId === filter.ownerId) records.delete(filter._id);
      return { deletedCount: current ? 1 : 0 };
    }
  };
  const db = { collection(name) { assert.equal(name, 'drive_import_locks'); return collection; } };
  const first = await acquireDriveImportLease(db, 'root', 'scan-a', { leaseMs: 30_000 });
  await assert.rejects(
    acquireDriveImportLease(db, 'root', 'scan-b', { leaseMs: 30_000 }),
    (error) => error.code === 'DRIVE_IMPORT_ALREADY_RUNNING'
  );
  await first.assertOwned();
  await first.release();
  const second = await acquireDriveImportLease(db, 'root', 'scan-b', { leaseMs: 30_000 });
  await second.release();
});
