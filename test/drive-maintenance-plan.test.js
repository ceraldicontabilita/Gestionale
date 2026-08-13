import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDriveFolderPlan, buildDriveMaintenancePlan, normalizeDrivePath } from '../src/drive-maintenance-plan.js';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const MD5_A = '1'.repeat(32);

function file(id, path, size = 100, extra = {}) {
  return { driveFileId: id, nome: path.split('/').at(-1), percorso: path, dimensione: size, scanId: 'scan-1', ...extra };
}

test('rileva ID Drive diversi con lo stesso SHA-256 e sceglie un canonico deterministico', () => {
  const result = buildDriveMaintenancePlan([
    file('id-z', 'Da elaborare/F24.pdf', 100, { sha256Checksum: SHA_A }),
    file('id-a', 'F24/F24.pdf', 100, { sha256Checksum: SHA_A, verifiedIndexMatch: true })
  ], { taxonomy: { 'Da elaborare': 'F24' } });

  assert.equal(result.counts.exactDuplicateGroups, 1);
  assert.equal(result.groups[0].status, 'EXACT_DUPLICATE');
  assert.equal(result.groups[0].matchBasis, 'SHA256');
  assert.equal(result.groups[0].canonicalDriveFileId, 'id-a');
  assert.equal(result.proposals.find((item) => item.driveFileId === 'id-z').action, 'REVIEW');
  assert.equal(result.proposals.find((item) => item.driveFileId === 'id-a').action, 'KEEP');
});

test('usa MD5 e dimensione solo come candidato forte da verificare', () => {
  const result = buildDriveMaintenancePlan([
    file('md5-a', 'Archivio/a.pdf', 42, { md5Checksum: MD5_A }),
    file('md5-b', 'Archivio/b.pdf', 42, { md5Checksum: MD5_A })
  ]);
  assert.equal(result.groups[0].status, 'DA_VERIFICARE');
  assert.equal(result.groups[0].matchBasis, 'MD5_AND_SIZE');
  assert.equal(result.counts.exactDuplicateGroups, 0);
  assert.ok(result.proposals.every((item) => item.action === 'REVIEW'));
});

test('stesso nome e dimensione senza hash resta solo candidato DA_VERIFICARE', () => {
  const result = buildDriveMaintenancePlan([
    file('id-1', 'F24/2025/modello.pdf'),
    file('id-2', 'F24/2026/modello.pdf')
  ]);
  const group = result.groups.find((item) => item.status === 'DA_VERIFICARE');
  assert.ok(group);
  assert.equal(group.matchBasis, 'NAME_AND_SIZE');
  assert.equal(group.canonicalDriveFileId, null);
  assert.deepEqual(result.proposals.map((item) => item.action), ['REVIEW', 'REVIEW']);
});

test('hash discordanti non vengono promossi a duplicato certo', () => {
  const result = buildDriveMaintenancePlan([
    file('id-1', 'F24/2025/modello.pdf', 100, { sha256Checksum: SHA_A, md5Checksum: MD5_A }),
    file('id-2', 'F24/2026/modello.pdf', 100, { sha256Checksum: SHA_B, md5Checksum: MD5_A })
  ]);
  assert.equal(result.counts.exactDuplicateGroups, 0);
  assert.ok(result.groups.some((item) => item.status === 'HASH_CONFLICT'));
  assert.ok(result.proposals.every((item) => item.action === 'REVIEW'));
});

test('stesso SHA-256 con dimensioni dichiarate discordanti blocca la deduplica', () => {
  const result = buildDriveMaintenancePlan([
    file('id-1', 'F24/a.pdf', 100, { sha256Checksum: SHA_A }),
    file('id-2', 'F24/b.pdf', 101, { sha256Checksum: SHA_A })
  ], { taxonomy: [{ canonicalPath: 'F24' }] });
  assert.equal(result.counts.exactDuplicateGroups, 0);
  assert.ok(result.groups.some((item) => item.matchBasis === 'SHA256_WITH_SIZE_CONFLICT'));
  assert.ok(result.proposals.every((item) => item.action === 'REVIEW'));
});

test('normalizza la tassonomia senza traversal e propone soltanto azioni non distruttive', () => {
  assert.equal(normalizeDrivePath(' /Documenti\\F24//2026/ '), 'Documenti/F24/2026');
  assert.throws(() => normalizeDrivePath('Documenti/../segreti'), /non sicuro/);
  const result = buildDriveMaintenancePlan([
    file('id-1', 'Vecchi F24/2026/modello.pdf'),
    file('id-2', 'F24/2026/quietanza.pdf')
  ], { taxonomy: [{ canonicalPath: 'F24', aliases: ['Vecchi F24'] }] });
  assert.equal(result.proposals.find((item) => item.driveFileId === 'id-1').action, 'MOVE_RENAME');
  assert.equal(result.proposals.find((item) => item.driveFileId === 'id-1').proposedPath, 'F24/2026/modello.pdf');
  assert.equal(result.mode, 'READ_ONLY');
  assert.equal(result.destructiveActionsAllowed, false);
  assert.ok(result.proposals.every((item) => ['KEEP', 'MOVE_RENAME', 'REVIEW'].includes(item.action)));
  assert.doesNotMatch(JSON.stringify(result), /DELETE|TRASH/);
});

test('produce lo stesso piano a prescindere dall ordine dei file', () => {
  const files = [
    file('b', 'Da elaborare/a.pdf', 12, { sha256Checksum: SHA_A, sourceMetadata: { batch: 2 } }),
    file('a', 'F24/a.pdf', 12, { sha256Checksum: SHA_A, sourceMetadata: { batch: 1 } }),
    file('c', 'Altro/c.pdf', 7)
  ];
  const options = { taxonomy: { 'Da elaborare': 'F24' }, generatedAt: '2026-08-13T10:00:00.000Z' };
  assert.deepEqual(buildDriveMaintenancePlan(files, options), buildDriveMaintenancePlan([...files].reverse(), options));
});

test('usa pathSegments come fonte autorevole quando un nome Drive contiene slash', () => {
  const result = buildDriveMaintenancePlan([
    file('slash', 'Periodo 2025/2026/modello.pdf', 10, {
      pathSegments: ['Periodo 2025/2026', 'modello.pdf']
    })
  ], { taxonomy: [{ canonicalPath: 'Periodo', aliases: ['Periodo 2025'] }] });
  assert.deepEqual(result.proposals[0].currentPathSegments, ['Periodo 2025/2026', 'modello.pdf']);
  assert.equal(result.proposals[0].action, 'REVIEW');
  assert.equal(result.proposals[0].reason, 'AMBIGUOUS_PATH_SEGMENTS');
});

test('un segmento logico speciale resta in revisione anche sotto una cartella nota', () => {
  const result = buildDriveMaintenancePlan([
    file('special', 'F24/../modello.pdf', 10, { pathSegments: ['F24', '..', 'modello.pdf'] })
  ], { taxonomy: [{ canonicalPath: '05_Fisco/F24', aliases: ['F24'] }] });
  assert.equal(result.proposals[0].action, 'REVIEW');
  assert.equal(result.proposals[0].reason, 'AMBIGUOUS_PATH_SEGMENTS');
});

test('il piano cartelle include la radice, protegge le integrazioni e rileva collisioni', () => {
  const result = buildDriveFolderPlan([
    { driveFolderId: 'root', nome: '(radice)', parentId: null, pathSegments: [] },
    { driveFolderId: 'corr', nome: 'Corrispettivi', parentId: 'root', pathSegments: ['Corrispettivi'] },
    { driveFolderId: 'a', nome: 'F24 vecchi', parentId: 'root', pathSegments: ['F24 vecchi'] },
    { driveFolderId: 'b', nome: 'Tributi', parentId: 'root', pathSegments: ['Tributi'] }
  ], { taxonomy: [
    { canonicalPath: '01_Vendite/Corrispettivi', aliases: ['Corrispettivi'] },
    { canonicalPath: '05_Fisco/F24', aliases: ['F24 vecchi', 'Tributi'] }
  ] });
  assert.equal(result.proposals.find((item) => item.driveFolderId === 'root').action, 'KEEP');
  assert.equal(result.proposals.find((item) => item.driveFolderId === 'corr').reason, 'PROTECTED_INTEGRATION_PATH');
  assert.equal(result.proposals.find((item) => item.driveFolderId === 'a').reason, 'TARGET_PATH_COLLISION');
  assert.equal(result.proposals.find((item) => item.driveFolderId === 'b').reason, 'TARGET_PATH_COLLISION');
  assert.doesNotMatch(JSON.stringify(result), /DELETE|TRASH/);
});

test('due file con la stessa destinazione proposta restano in revisione', () => {
  const result = buildDriveMaintenancePlan([
    file('a', 'Area A/2026/modello.pdf', 10, { sha256Checksum: SHA_A }),
    file('b', 'Area B/2026/modello.pdf', 11, { sha256Checksum: SHA_B })
  ], { taxonomy: [
    { canonicalPath: '05_Fisco/F24', aliases: ['Area A', 'Area B'] }
  ] });
  assert.ok(result.proposals.every((item) => item.action === 'REVIEW'));
  assert.ok(result.proposals.every((item) => item.reason === 'TARGET_PATH_COLLISION'));
});

test('due file diversi già nello stesso percorso segnalano una collisione sorgente', () => {
  const result = buildDriveMaintenancePlan([
    file('a', 'F24/modello.pdf', 10, { sha256Checksum: SHA_A }),
    file('b', 'F24/modello.pdf', 11, { sha256Checksum: SHA_B })
  ], { taxonomy: [{ canonicalPath: 'F24' }] });
  assert.ok(result.proposals.every((item) => item.action === 'REVIEW'));
  assert.ok(result.proposals.every((item) => item.reason === 'SOURCE_PATH_COLLISION'));
});

test('preserva spazi nei segmenti Drive e blocca metadati sorgente invalidi', () => {
  const result = buildDriveMaintenancePlan([
    file('space', 'F24/x.pdf', 'dimensione-errata', {
      pathSegments: [' F24', 'x.pdf'],
      sha256Checksum: 'not-a-hash'
    })
  ], { taxonomy: [{ canonicalPath: '05_Fisco/F24', aliases: ['F24'] }] });
  const proposal = result.proposals[0];
  assert.deepEqual(proposal.currentPathSegments, [' F24', 'x.pdf']);
  assert.equal(proposal.action, 'REVIEW');
  assert.equal(proposal.reason, 'INVALID_SOURCE_METADATA');
  assert.deepEqual(new Set(proposal.sourceIssues), new Set(['INVALID_SHA256', 'INVALID_SIZE', 'BOUNDARY_WHITESPACE_IN_DRIVE_NAME']));
});

test('protegge una cartella che contiene file collegati all indice verificato', () => {
  const result = buildDriveFolderPlan([
    { driveFolderId: 'root', nome: '(radice)', parentId: null, pathSegments: [] },
    { driveFolderId: 'f24', nome: 'F24', parentId: 'root', pathSegments: ['F24'] }
  ], {
    taxonomy: [{ canonicalPath: '05_Fisco/F24', aliases: ['F24'] }],
    protectedFolderIds: ['f24']
  });
  assert.equal(result.proposals.find((item) => item.driveFolderId === 'f24').action, 'REVIEW');
  assert.equal(result.proposals.find((item) => item.driveFolderId === 'f24').reason, 'CONTAINS_VERIFIED_INDEX_FILE');
});
