import crypto from 'node:crypto';
import { buildDriveFolderPlan, buildDriveMaintenancePlan } from './drive-maintenance-plan.js';
import { extractDriveId } from './google-drive-client.js';

const REPORT_VERSION = 'drive-readonly-report/v1';

export const DEFAULT_DRIVE_TAXONOMY = Object.freeze([
  { canonicalPath: '00_Sistema/Indici', aliases: ['INDICI GESTIONALE'] },
  { canonicalPath: '01_Vendite/Corrispettivi', aliases: ['Corrispettivi'] },
  { canonicalPath: '02_Fatture/XML', aliases: ['Fatture Xml Gestionale'] },
  { canonicalPath: '02_Fatture/Estero', aliases: ['Fatture Estero'] },
  { canonicalPath: '02_Fatture/PDF Archivio', aliases: ['Fatture PDF Archivio'] },
  { canonicalPath: '03_Personale/Cedolini', aliases: ['Cedolini Paga'] },
  { canonicalPath: '03_Personale/Certificazioni', aliases: ['Certificazioni Dipendenti'] },
  { canonicalPath: '03_Personale/Contratti', aliases: ['Contratti Dipendenti'] },
  { canonicalPath: '03_Personale/Documenti', aliases: ['Documenti Dipendenti'] },
  { canonicalPath: '03_Personale/Comunicazioni', aliases: ['UNILAV'] },
  { canonicalPath: '04_Banca/Bonifici', aliases: ['Bonifici Effettuati'] },
  { canonicalPath: '04_Banca/Estratti conto', aliases: ['Estratti conto'] },
  { canonicalPath: '04_Banca/CBILL', aliases: ['CBILL'] },
  { canonicalPath: '04_Banca/Assegni', aliases: ['Assegni'] },
  { canonicalPath: '05_Fisco/F24', aliases: ['F24'] },
  { canonicalPath: '05_Fisco/Quietanze', aliases: ['Quietanze'] },
  { canonicalPath: '05_Fisco/Dichiarazioni', aliases: ['Dichiarazioni Fiscali'] },
  { canonicalPath: '05_Fisco/Avvisi', aliases: ['Avvisi Bonari'] },
  { canonicalPath: '06_Riscossione/Atti', aliases: ['Cartelle Esattoriali'] },
  { canonicalPath: '07_Veicoli/Verbali', aliases: ['Verbali Auto'] },
  { canonicalPath: '08_Finanziamenti/Mutui', aliases: ['Mutui'] }
]);

const FILE_PROJECTION = {
  _id: 0,
  driveFileId: 1,
  nome: 1,
  percorso: 1,
  pathSegments: 1,
  dimensione: 1,
  dimensioneFonteNonValida: 1,
  sha256Checksum: 1,
  md5Checksum: 1,
  mimeType: 1,
  parentId: 1,
  rootFolderId: 1,
  scanId: 1,
  verifiedIndexMatch: 1,
  documentIndexId: 1,
  documentoId: 1,
  webViewLink: 1,
  modificatoIlFonte: 1,
  versioneFonte: 1
};

const FOLDER_PROJECTION = {
  _id: 0,
  driveFolderId: 1,
  nome: 1,
  percorso: 1,
  pathSegments: 1,
  parentId: 1,
  rootFolderId: 1,
  scanId: 1,
  webViewLink: 1,
  versioneFonte: 1,
  modificatoIlFonte: 1
};

function safeLimit(value) {
  const parsed = Number(value || 50_000);
  return Number.isSafeInteger(parsed) && parsed >= 100 && parsed <= 250_000 ? parsed : 50_000;
}

function stableDigest(rows, fields) {
  const normalized = [...rows].map((row) => Object.fromEntries(fields.map((field) => [field, row?.[field] ?? null])))
    .sort((a, b) => {
      const aJson = JSON.stringify(a); const bJson = JSON.stringify(b);
      return aJson < bJson ? -1 : aJson > bJson ? 1 : 0;
    });
  return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

function scanIds(rows) {
  return [...new Set(rows.map((row) => String(row.scanId || '')).filter(Boolean))].sort();
}

function sourceStatus(lastRun, files, folders, totals, limit) {
  const commonBlockers = [];
  const fileBlockers = [];
  const folderBlockers = [];
  const expectedFiles = Number(lastRun?.counts?.driveFiles);
  const expectedFolders = Number(lastRun?.counts?.driveFolders);
  const runErrors = Number(lastRun?.counts?.driveErrors);
  const runScanId = lastRun?.scanId ? String(lastRun.scanId) : null;
  const runRootFolderId = lastRun?.rootFolderId ? String(lastRun.rootFolderId) : null;

  if (!lastRun) commonBlockers.push('LAST_SCAN_NOT_AVAILABLE');
  else if (lastRun.stato !== 'COMPLETATO') commonBlockers.push('LAST_SCAN_NOT_COMPLETE');
  if (lastRun && !Number.isFinite(runErrors)) commonBlockers.push('DRIVE_ERROR_COUNT_NOT_RECORDED');
  if (runErrors > 0 || (lastRun?.erroriDrive?.length || 0) > 0) commonBlockers.push('LAST_SCAN_HAS_ERRORS');
  if (!runScanId) commonBlockers.push('SOURCE_SCAN_ID_MISSING');
  if (!runRootFolderId) commonBlockers.push('ROOT_FOLDER_ID_NOT_RECORDED');
  if (totals.files > limit) fileBlockers.push('FILE_INVENTORY_LIMIT_EXCEEDED');
  if (totals.folders > limit) folderBlockers.push('FOLDER_INVENTORY_LIMIT_EXCEEDED');

  const fileScanIds = scanIds(files);
  const folderScanIds = scanIds(folders);
  if (files.some((row) => !row.scanId)) fileBlockers.push('FILE_SCAN_ID_MISSING');
  if (folders.some((row) => !row.scanId)) folderBlockers.push('FOLDER_SCAN_ID_MISSING');
  if (files.some((row) => !row.rootFolderId)) fileBlockers.push('FILE_ROOT_ID_MISSING');
  if (folders.some((row) => !row.rootFolderId)) folderBlockers.push('FOLDER_ROOT_ID_MISSING');
  if (runRootFolderId && files.some((row) => String(row.rootFolderId) !== runRootFolderId)) fileBlockers.push('FILE_ROOT_ID_MISMATCH');
  if (runRootFolderId && folders.some((row) => String(row.rootFolderId) !== runRootFolderId)) folderBlockers.push('FOLDER_ROOT_ID_MISMATCH');
  if (totals.files <= limit && files.length !== totals.files) fileBlockers.push('FILE_INVENTORY_READ_COUNT_MISMATCH');
  if (totals.folders <= limit && folders.length !== totals.folders) folderBlockers.push('FOLDER_INVENTORY_READ_COUNT_MISMATCH');
  if (fileScanIds.length > 1 || (fileScanIds.length === 1 && runScanId && fileScanIds[0] !== runScanId)) fileBlockers.push('MIXED_FILE_SCANS');
  if (folderScanIds.length > 1 || (folderScanIds.length === 1 && runScanId && folderScanIds[0] !== runScanId)) folderBlockers.push('MIXED_FOLDER_SCANS');
  if (!Number.isFinite(expectedFiles)) fileBlockers.push('FILE_COUNT_NOT_RECORDED');
  else if (expectedFiles !== totals.files) fileBlockers.push('FILE_COUNT_MISMATCH');
  if (!Number.isFinite(expectedFolders)) folderBlockers.push('FOLDER_COUNT_NOT_RECORDED');
  else if (expectedFolders !== totals.folders) folderBlockers.push('FOLDER_COUNT_MISMATCH');
  if (!Number.isFinite(expectedFolders) || expectedFolders < 1 || totals.folders < 1) folderBlockers.push('FOLDER_TREE_NOT_AVAILABLE');

  const folderById = new Map(folders.map((folder) => [String(folder.driveFolderId || ''), folder]));
  const roots = folders.filter((folder) => folder.parentId === null || folder.parentId === undefined);
  if (folders.length && roots.length !== 1) folderBlockers.push('FOLDER_ROOT_COUNT_INVALID');
  if (roots.length === 1 && lastRun?.rootFolderId && String(roots[0].driveFolderId) !== String(lastRun.rootFolderId)) folderBlockers.push('FOLDER_ROOT_ID_MISMATCH');
  for (const folder of folders) {
    if (folder.parentId === null || folder.parentId === undefined) continue;
    if (!folderById.has(String(folder.parentId))) folderBlockers.push('ORPHAN_FOLDER');
    const seen = new Set([String(folder.driveFolderId)]); let parentId = folder.parentId;
    while (parentId !== null && parentId !== undefined) {
      const parentKey = String(parentId);
      if (seen.has(parentKey)) { folderBlockers.push('FOLDER_CYCLE'); break; }
      seen.add(parentKey);
      const parent = folderById.get(parentKey);
      if (!parent) break;
      parentId = parent.parentId;
    }
    const parent = folderById.get(String(folder.parentId));
    if (parent && Array.isArray(parent.pathSegments) && Array.isArray(folder.pathSegments)) {
      const expected = [...parent.pathSegments, folder.nome];
      if (JSON.stringify(expected) !== JSON.stringify(folder.pathSegments)) folderBlockers.push('FOLDER_PATH_INCONSISTENT');
    }
  }
  for (const file of files) {
    const parent = folderById.get(String(file.parentId || ''));
    if (!parent) { fileBlockers.push('FILE_PARENT_MISSING'); continue; }
    if (Array.isArray(parent.pathSegments) && Array.isArray(file.pathSegments)) {
      const expected = [...parent.pathSegments, file.nome];
      if (JSON.stringify(expected) !== JSON.stringify(file.pathSegments)) fileBlockers.push('FILE_PATH_INCONSISTENT');
    }
  }

  return {
    scanId: runScanId,
    state: lastRun?.stato || null,
    completedAt: lastRun?.completatoIl || null,
    commonBlockers: [...new Set(commonBlockers)],
    fileBlockers: [...new Set(fileBlockers)],
    folderBlockers: [...new Set(folderBlockers)],
    filesComplete: commonBlockers.length === 0 && fileBlockers.length === 0,
    foldersComplete: commonBlockers.length === 0 && folderBlockers.length === 0,
    fileScanIds,
    folderScanIds
  };
}

async function loadInventory(db, limit, configuredRootFolderId = null) {
  const config = await db.collection('drive_inventory_config').findOne({ _id: 'CANONICAL_ROOT' });
  const rootFolderId = configuredRootFolderId || config?.rootFolderId || null;
  const runScope = rootFolderId ? { rootFolderId } : {};
  const lastRun = await db.collection('drive_import_runs').findOne(runScope, { sort: { iniziatoIl: -1 } });
  const activeScope = rootFolderId ? { attivo: true, rootFolderId } : { attivo: true };
  const [fileTotal, folderTotal] = await Promise.all([
    db.collection('drive_files').countDocuments(activeScope),
    db.collection('drive_folders').countDocuments(activeScope)
  ]);
  if (fileTotal > limit || folderTotal > limit) {
    const files = []; const folders = [];
    return { lastRun, files, folders, totals: { files: fileTotal, folders: folderTotal }, status: sourceStatus(lastRun, files, folders, { files: fileTotal, folders: folderTotal }, limit) };
  }
  const [files, folders] = await Promise.all([
    db.collection('drive_files').find(activeScope, { projection: FILE_PROJECTION }).sort({ driveFileId: 1 }).limit(limit + 1).toArray(),
    db.collection('drive_folders').find(activeScope, { projection: FOLDER_PROJECTION }).sort({ driveFolderId: 1 }).limit(limit + 1).toArray()
  ]);
  const totals = { files: fileTotal, folders: folderTotal };
  return { lastRun, files, folders, totals, status: sourceStatus(lastRun, files, folders, totals, limit) };
}

function safeguards() {
  return {
    driveMutationSupported: false,
    automaticActions: false,
    deletionSupported: false,
    physicalActionsExecuted: false,
    humanReviewRequired: true
  };
}

function commonReport(source, blockers, generatedAt) {
  return {
    schemaVersion: REPORT_VERSION,
    mode: 'READ_ONLY',
    generatedAt,
    actionable: false,
    readyForReview: blockers.length === 0,
    source,
    safeguards: safeguards(),
    blockers
  };
}

export function buildDriveReadonlyReports({ lastRun, files, folders, totals, limit = 50_000, taxonomy = DEFAULT_DRIVE_TAXONOMY, generatedAt = new Date() }) {
  const timestamp = new Date(generatedAt).toISOString();
  const status = sourceStatus(lastRun, files, folders, totals, limit);
  const source = {
    scanId: status.scanId,
    state: status.state,
    completedAt: status.completedAt,
    activeFiles: totals.files,
    activeFolders: totals.folders,
    fileScanIds: status.fileScanIds,
    folderScanIds: status.folderScanIds,
    fileInventoryDigest: stableDigest(files, ['driveFileId', 'rootFolderId', 'parentId', 'percorso', 'pathSegments', 'mimeType', 'dimensione', 'dimensioneFonteNonValida', 'sha256Checksum', 'md5Checksum', 'versioneFonte', 'modificatoIlFonte', 'verifiedIndexMatch', 'documentIndexId', 'scanId']),
    folderInventoryDigest: stableDigest(folders, ['driveFolderId', 'rootFolderId', 'parentId', 'percorso', 'pathSegments', 'versioneFonte', 'modificatoIlFonte', 'scanId'])
  };
  const duplicateBlockers = [...new Set([...status.commonBlockers, ...status.fileBlockers, ...status.folderBlockers])];
  const folderBlockers = [...new Set([...status.commonBlockers, ...status.fileBlockers, ...status.folderBlockers])];
  const duplicatePlan = duplicateBlockers.length ? null : buildDriveMaintenancePlan(files, { taxonomy, generatedAt: timestamp });
  const protectedFolderIds = new Set();
  const folderById = new Map(folders.map((folder) => [String(folder.driveFolderId), folder]));
  for (const file of (folderBlockers.length ? [] : files.filter((item) => item.verifiedIndexMatch === true))) {
    let parentId = file.parentId;
    const seen = new Set();
    while (parentId !== null && parentId !== undefined) {
      const parentKey = String(parentId);
      if (seen.has(parentKey)) break;
      seen.add(parentKey);
      const parent = folderById.get(parentKey);
      if (!parent) break;
      protectedFolderIds.add(parent.driveFolderId);
      parentId = parent.parentId;
    }
  }
  const folderPlan = folderBlockers.length ? null : buildDriveFolderPlan(folders, { taxonomy, generatedAt: timestamp, protectedFolderIds: [...protectedFolderIds] });
  return {
    duplicates: {
      ...commonReport({ ...source, complete: duplicateBlockers.length === 0 }, duplicateBlockers, timestamp),
      summary: duplicatePlan?.counts || { files: totals.files, exactDuplicateGroups: 0, exactDuplicateMembers: 0, reviewGroups: 0, hashConflictGroups: 0, proposals: { KEEP: 0, MOVE_RENAME: 0, REVIEW: 0 } },
      groups: duplicatePlan?.groups || [],
      proposals: duplicatePlan?.proposals || []
    },
    folders: {
      ...commonReport({ ...source, complete: folderBlockers.length === 0 }, folderBlockers, timestamp),
      summary: folderPlan?.counts || { folders: totals.folders, proposals: { KEEP: 0, MOVE_RENAME: 0, REVIEW: 0 } },
      proposals: folderPlan?.proposals || []
    }
  };
}

export function registerDrivePlanRoutes(app, { getDb, env = process.env, taxonomy = DEFAULT_DRIVE_TAXONOMY } = {}) {
  const limit = safeLimit(env.DRIVE_PLAN_MAX_FILES);
  const configuredRootFolderId = extractDriveId(env.DRIVE_DOCUMENT_INDEX_ROOT_FOLDER_ID);
  async function reports(res) {
    const db = getDb();
    if (!db) throw new Error('MongoDB non configurato');
    const inventory = await loadInventory(db, limit, configuredRootFolderId);
    res.set('Cache-Control', 'no-store');
    return buildDriveReadonlyReports({ ...inventory, limit, taxonomy });
  }

  app.get('/api/drive-data/duplicates', async (_req, res) => {
    try { res.json((await reports(res)).duplicates); }
    catch (error) { res.status(503).json({ error: error.message }); }
  });
  app.get('/api/drive-data/folder-plan', async (_req, res) => {
    try { res.json((await reports(res)).folders); }
    catch (error) { res.status(503).json({ error: error.message }); }
  });
}
