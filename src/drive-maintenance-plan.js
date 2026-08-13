const PLAN_VERSION = 'drive-maintenance-plan/v1';
const ALLOWED_ACTIONS = new Set(['KEEP', 'MOVE_RENAME', 'REVIEW']);
const FOLDER_PLAN_VERSION = 'drive-folder-plan/v1';

export const DEFAULT_PROTECTED_PATHS = Object.freeze([
  'INDICI GESTIONALE',
  'Corrispettivi',
  'Fatture Xml Gestionale'
]);

function clean(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

function key(value) {
  return clean(value).normalize('NFKC').toLowerCase();
}

function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function safeInteger(value) {
  if (value === '' || value === null || value === undefined) return null;
  const numericShape = typeof value === 'number'
    ? Number.isSafeInteger(value) && value >= 0
    : typeof value === 'string' && /^\d+$/.test(value);
  if (!numericShape) return null;
  const result = Number(value);
  return Number.isSafeInteger(result) && result >= 0 ? result : null;
}

function validHash(value, length) {
  const result = clean(value).toLowerCase();
  return new RegExp(`^[a-f0-9]{${length}}$`).test(result) ? result : null;
}

function jsonSafeCopy(value, seen = new WeakSet()) {
  if (value === null || value === undefined) return value ?? null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value?.toHexString === 'function') return value.toHexString();
  if (typeof value === 'bigint') return String(value);
  if (['string', 'number', 'boolean'].includes(typeof value)) return value;
  if (Array.isArray(value)) return value.map((item) => jsonSafeCopy(item, seen));
  if (typeof value !== 'object') return String(value);
  if (seen.has(value)) throw new TypeError('Metadati sorgente circolari non supportati');
  seen.add(value);
  const result = {};
  for (const property of Object.keys(value).sort(compareText)) {
    result[property] = jsonSafeCopy(value[property], seen);
  }
  seen.delete(value);
  return result;
}

/**
 * Normalizza un percorso logico Drive senza consentire segmenti di traversal.
 * Non effettua alcuna chiamata a Google Drive e non modifica l'input.
 */
export function normalizeDrivePath(value) {
  const raw = clean(value).replaceAll('\\', '/').normalize('NFC');
  const segments = raw.split('/').map((segment) => segment.trim()).filter(Boolean);
  if (!segments.length) throw new TypeError('Percorso Drive mancante');
  for (const segment of segments) {
    if (segment === '.' || segment === '..') throw new TypeError(`Segmento percorso non sicuro: ${segment}`);
    if (/[\u0000-\u001f\u007f]/.test(segment)) throw new TypeError('Percorso Drive con caratteri di controllo');
  }
  return segments.join('/');
}

function normalizeAuthoritativeSegments(value, fallback) {
  if (!Array.isArray(value)) return normalizeDrivePath(fallback).split('/');
  if (!value.length) return [];
  return value.map((item) => {
    const segment = (item === null || item === undefined ? '' : String(item)).normalize('NFC');
    if (!segment) throw new TypeError('Segmento Drive mancante');
    if (new RegExp('[\\u0000-\\u001f\\u007f]').test(segment)) throw new TypeError('Segmento Drive con caratteri di controllo');
    return segment;
  });
}

function sameSegments(a, b) {
  return a.length === b.length && a.every((segment, index) => key(segment) === key(b[index]));
}

function displayPath(segments) {
  return segments.join('/');
}

function pathSegmentIssues(segments) {
  return [
    ...(segments.some((segment) => segment === '.' || segment === '..') ? ['SPECIAL_PATH_SEGMENT'] : []),
    ...(segments.some((segment) => /[\\/]/.test(segment)) ? ['SEPARATOR_IN_DRIVE_NAME'] : []),
    ...(segments.some((segment) => segment !== segment.trim()) ? ['BOUNDARY_WHITESPACE_IN_DRIVE_NAME'] : [])
  ];
}

function sourceMetadata(file) {
  const explicit = file.sourceMetadata ?? file.source ?? file.metadata ?? null;
  const reference = {
    sourceType: file.sourceType ?? null,
    sourceKey: file.sourceKey ?? null,
    sourceId: file.sourceId ?? null,
    sourceRevision: file.sourceRevision ?? file.versioneFonte ?? null,
    scanId: file.scanId ?? null,
    parentId: file.parentId ?? null,
    verifiedIndexMatch: file.verifiedIndexMatch === true,
    documentIndexId: file.documentIndexId ?? null,
    documentoId: file.documentoId ?? null,
    webViewLink: file.webViewLink ?? null,
    modifiedTime: file.modifiedTime ?? file.modificatoIlFonte ?? null
  };
  if (explicit !== null) reference.metadata = explicit;
  return jsonSafeCopy(reference);
}

function normalizeFile(file, index) {
  if (!file || typeof file !== 'object') throw new TypeError(`File Drive non valido alla posizione ${index}`);
  const driveFileId = clean(file.driveFileId ?? file.id ?? file.sourceId);
  if (!driveFileId) throw new TypeError(`driveFileId mancante alla posizione ${index}`);
  const suppliedPath = file.percorso ?? file.path ?? file.percorsoDrive;
  const suppliedName = file.nome ?? file.name ?? file.nomeOriginale;
  const pathSegments = normalizeAuthoritativeSegments(file.pathSegments, suppliedPath || suppliedName);
  if (!pathSegments.length) throw new TypeError(`Percorso file Drive mancante alla posizione ${index}`);
  const path = displayPath(pathSegments);
  const name = clean(suppliedName) || pathSegments.at(-1);
  const size = safeInteger(file.dimensione ?? file.size ?? file.bytes);
  const rawSize = file.dimensione ?? file.size ?? file.bytes;
  const rawSha256 = clean(file.sha256Checksum ?? file.sha256);
  const rawMd5 = clean(file.md5Checksum ?? file.md5);
  return {
    driveFileId,
    name,
    path,
    pathSegments,
    pathIssues: pathSegmentIssues(pathSegments),
    size,
    sha256: validHash(rawSha256, 64),
    md5: validHash(rawMd5, 32),
    checksumIssues: [
      ...(rawSha256 && !validHash(rawSha256, 64) ? ['INVALID_SHA256'] : []),
      ...(rawMd5 && !validHash(rawMd5, 32) ? ['INVALID_MD5'] : [])
    ],
    metadataIssues: [...new Set([
      ...(rawSize !== '' && rawSize !== null && rawSize !== undefined && size === null ? ['INVALID_SIZE'] : []),
      ...(file.dimensioneFonteNonValida === true ? ['INVALID_SIZE'] : [])
    ])],
    verifiedIndexMatch: file.verifiedIndexMatch === true || file.indiceVerificato === true,
    preferredCanonical: file.preferredCanonical === true || file.canonical === true,
    sourceMetadata: sourceMetadata(file)
  };
}

function taxonomyEntries(taxonomy) {
  if (!taxonomy) return [];
  const records = Array.isArray(taxonomy)
    ? taxonomy
    : Object.entries(taxonomy).map(([alias, value]) => typeof value === 'string'
      ? { canonicalPath: value, aliases: [alias] }
      : { ...value, aliases: [alias, ...(value?.aliases || [])] });
  const mappings = new Map();
  for (const record of records) {
    const item = typeof record === 'string' ? { canonicalPath: record, aliases: [record] } : record;
    const canonicalPath = normalizeDrivePath(item.canonicalPath ?? item.path ?? item.name);
    const canonicalSegments = canonicalPath.split('/');
    const aliases = [canonicalPath, ...(item.aliases || [])];
    for (const aliasValue of aliases) {
      const alias = normalizeDrivePath(aliasValue);
      const aliasKey = key(alias);
      const previous = mappings.get(aliasKey);
      if (previous && key(previous.canonicalPath) !== key(canonicalPath)) {
        throw new TypeError(`Alias tassonomia ambiguo: ${alias}`);
      }
      mappings.set(aliasKey, { alias, aliasSegments: alias.split('/'), canonicalPath, canonicalSegments });
    }
  }
  return [...mappings.values()].sort((a, b) => {
    const depth = b.alias.split('/').length - a.alias.split('/').length;
    return depth || compareText(key(a.alias), key(b.alias));
  });
}

function proposedPath(pathSegments, taxonomy) {
  for (const mapping of taxonomy) {
    const prefix = pathSegments.slice(0, mapping.aliasSegments.length);
    if (!sameSegments(prefix, mapping.aliasSegments)) continue;
    const proposedSegments = [...mapping.canonicalSegments, ...pathSegments.slice(mapping.aliasSegments.length)];
    return { matched: true, path: displayPath(proposedSegments), pathSegments: proposedSegments };
  }
  return { matched: false, path: displayPath(pathSegments), pathSegments: [...pathSegments] };
}

function pathIsProtected(pathSegments, protectedPaths) {
  return protectedPaths.some((protectedPath) => {
    const protectedSegments = protectedPath.split('/');
    return pathSegments.length >= protectedSegments.length
      && sameSegments(pathSegments.slice(0, protectedSegments.length), protectedSegments);
  });
}

function fileSummary(file, canonicalDriveFileId = null) {
  return {
    driveFileId: file.driveFileId,
    name: file.name,
    path: file.path,
    pathSegments: [...file.pathSegments],
    pathIssues: [...file.pathIssues],
    size: file.size,
    sha256: file.sha256,
    md5: file.md5,
    checksumIssues: [...file.checksumIssues],
    metadataIssues: [...file.metadataIssues],
    isCanonical: canonicalDriveFileId === file.driveFileId,
    sourceMetadata: jsonSafeCopy(file.sourceMetadata)
  };
}

function canonicalComparator(taxonomy) {
  return (a, b) => {
    const verified = Number(b.verifiedIndexMatch) - Number(a.verifiedIndexMatch);
    if (verified) return verified;
    const preferred = Number(b.preferredCanonical) - Number(a.preferredCanonical);
    if (preferred) return preferred;
    const aCanonical = sameSegments(proposedPath(a.pathSegments, taxonomy).pathSegments, a.pathSegments);
    const bCanonical = sameSegments(proposedPath(b.pathSegments, taxonomy).pathSegments, b.pathSegments);
    if (aCanonical !== bCanonical) return Number(bCanonical) - Number(aCanonical);
    const pathResult = compareText(key(a.path), key(b.path));
    return pathResult || compareText(a.driveFileId, b.driveFileId);
  };
}

function groupFiles(files, selector) {
  const result = new Map();
  for (const file of files) {
    const groupKey = selector(file);
    if (!groupKey) continue;
    if (!result.has(groupKey)) result.set(groupKey, []);
    result.get(groupKey).push(file);
  }
  return result;
}

function exactDuplicateGroups(files, taxonomy) {
  const groups = [];
  const addGroup = (members, basis, evidence) => {
    const sorted = [...members].sort(canonicalComparator(taxonomy));
    const canonicalDriveFileId = sorted[0].driveFileId;
    const groupId = `EXACT_DUPLICATE:${basis}:${evidence}`;
    groups.push({
      groupId,
      status: 'EXACT_DUPLICATE',
      matchBasis: basis,
      canonicalDriveFileId,
      selectionRule: 'VERIFIED_INDEX_THEN_PREFERRED_THEN_CANONICAL_PATH_THEN_PATH_THEN_ID',
      memberCount: sorted.length,
      members: sorted.map((file) => fileSummary(file, canonicalDriveFileId))
    });
  };

  for (const [sha256, members] of groupFiles(files, (file) => file.sha256).entries()) {
    if (members.length < 2) continue;
    const knownSizes = new Set(members.map((file) => file.size).filter((size) => size !== null));
    if (knownSizes.size <= 1) addGroup(members, 'SHA256', sha256);
  }
  return groups.sort((a, b) => compareText(a.groupId, b.groupId));
}

function reviewGroups(files, exactGroups) {
  const groups = [];
  const exactSets = exactGroups.map((group) => new Set(group.members.map((member) => member.driveFileId)));
  const isOneExactSet = (members) => exactSets.some((set) => members.every((file) => set.has(file.driveFileId)));
  const add = (status, basis, evidence, members) => {
    const sorted = [...members].sort((a, b) => compareText(key(a.path), key(b.path)) || compareText(a.driveFileId, b.driveFileId));
    groups.push({
      groupId: `${status}:${basis}:${evidence}`,
      status,
      matchBasis: basis,
      canonicalDriveFileId: null,
      selectionRule: null,
      memberCount: sorted.length,
      members: sorted.map((file) => fileSummary(file))
    });
  };

  const md5Buckets = groupFiles(files.filter((file) => file.md5 && file.size !== null), (file) => `${file.md5}:${file.size}`);
  for (const [evidence, members] of md5Buckets.entries()) {
    if (members.length < 2) continue;
    const shaValues = new Set(members.map((file) => file.sha256).filter(Boolean));
    if (shaValues.size > 1) add('HASH_CONFLICT', 'MD5_AND_SIZE_WITH_SHA256_CONFLICT', evidence, members);
    else if (!isOneExactSet(members)) add('DA_VERIFICARE', 'MD5_AND_SIZE', evidence, members);
  }

  const shaBuckets = groupFiles(files.filter((file) => file.sha256), (file) => file.sha256);
  for (const [evidence, members] of shaBuckets.entries()) {
    if (members.length < 2) continue;
    const knownSizes = new Set(members.map((file) => file.size).filter((size) => size !== null));
    if (knownSizes.size > 1) add('HASH_CONFLICT', 'SHA256_WITH_SIZE_CONFLICT', evidence, members);
  }

  const nameBuckets = groupFiles(files.filter((file) => file.name && file.size !== null), (file) => `${key(file.name)}:${file.size}`);
  for (const [evidence, members] of nameBuckets.entries()) {
    if (members.length < 2 || isOneExactSet(members)) continue;
    const shaValues = new Set(members.map((file) => file.sha256).filter(Boolean));
    const md5Values = new Set(members.map((file) => file.md5).filter(Boolean));
    const conflict = shaValues.size > 1 || md5Values.size > 1;
    add(conflict ? 'HASH_CONFLICT' : 'DA_VERIFICARE', conflict ? 'NAME_AND_SIZE_WITH_HASH_CONFLICT' : 'NAME_AND_SIZE', evidence, members);
  }

  const unique = new Map();
  for (const group of groups) unique.set(group.groupId, group);
  return [...unique.values()].sort((a, b) => compareText(a.groupId, b.groupId));
}

/**
 * Costruisce esclusivamente un piano auditabile. Non riceve un client Drive e
 * non può eseguire spostamenti, rinomine, cancellazioni o cestinamenti.
 */
export function buildDriveMaintenancePlan(files, options = {}) {
  if (!Array.isArray(files)) throw new TypeError('files deve essere un array');
  const normalized = files.map(normalizeFile);
  const ids = new Set();
  for (const file of normalized) {
    if (ids.has(file.driveFileId)) throw new TypeError(`driveFileId duplicato nel report: ${file.driveFileId}`);
    ids.add(file.driveFileId);
  }
  normalized.sort((a, b) => compareText(a.driveFileId, b.driveFileId));

  const taxonomy = taxonomyEntries(options.taxonomy);
  const protectedPaths = (options.protectedPaths ?? DEFAULT_PROTECTED_PATHS).map(normalizeDrivePath);
  const exactGroups = exactDuplicateGroups(normalized, taxonomy);
  const reviews = reviewGroups(normalized, exactGroups);
  const groups = [...exactGroups, ...reviews].sort((a, b) => compareText(a.groupId, b.groupId));
  const exactByFile = new Map();
  const reviewByFile = new Map();
  for (const group of exactGroups) for (const member of group.members) exactByFile.set(member.driveFileId, group);
  for (const group of reviews) {
    for (const member of group.members) {
      if (!reviewByFile.has(member.driveFileId)) reviewByFile.set(member.driveFileId, []);
      reviewByFile.get(member.driveFileId).push(group);
    }
  }

  const proposals = normalized.map((file) => {
    const target = proposedPath(file.pathSegments, taxonomy);
    const exactGroup = exactByFile.get(file.driveFileId) || null;
    const fileReviews = reviewByFile.get(file.driveFileId) || [];
    let action = 'KEEP';
    let reason = 'ALREADY_CANONICAL';
    if (fileReviews.length) {
      action = 'REVIEW';
      reason = fileReviews.some((group) => group.status === 'HASH_CONFLICT') ? 'HASH_CONFLICT' : 'POSSIBLE_DUPLICATE';
    } else if (file.checksumIssues.length || file.metadataIssues.length) {
      action = 'REVIEW';
      reason = 'INVALID_SOURCE_METADATA';
    } else if (file.pathIssues.length) {
      action = 'REVIEW';
      reason = 'AMBIGUOUS_PATH_SEGMENTS';
    } else if (exactGroup && exactGroup.canonicalDriveFileId !== file.driveFileId) {
      action = 'REVIEW';
      reason = 'EXACT_DUPLICATE_NON_CANONICAL';
    } else if (!sameSegments(target.pathSegments, file.pathSegments) && file.verifiedIndexMatch) {
      action = 'REVIEW';
      reason = 'VERIFIED_INDEX_PATH';
    } else if (!sameSegments(target.pathSegments, file.pathSegments) && pathIsProtected(file.pathSegments, protectedPaths)) {
      action = 'REVIEW';
      reason = 'PROTECTED_INTEGRATION_PATH';
    } else if (!sameSegments(target.pathSegments, file.pathSegments)) {
      action = 'MOVE_RENAME';
      reason = 'TAXONOMY_PATH_MISMATCH';
    } else if (!target.matched) {
      action = 'REVIEW';
      reason = 'TAXONOMY_UNMAPPED';
    } else if (exactGroup) {
      reason = 'EXACT_DUPLICATE_CANONICAL';
    }
    if (!ALLOWED_ACTIONS.has(action)) throw new Error(`Azione piano non consentita: ${action}`);
    return {
      proposalId: `FILE:${file.driveFileId}`,
      action,
      reason,
      driveFileId: file.driveFileId,
      sourceMetadata: jsonSafeCopy(file.sourceMetadata),
      currentPath: file.path,
      currentPathSegments: [...file.pathSegments],
      sourceIssues: [...file.checksumIssues, ...file.metadataIssues, ...file.pathIssues],
      proposedPath: target.path,
      proposedPathSegments: [...target.pathSegments],
      exactDuplicateGroupId: exactGroup?.groupId || null,
      reviewGroupIds: fileReviews.map((group) => group.groupId).sort(compareText)
    };
  });

  const proposalTargets = new Map();
  for (const proposal of proposals) {
    const targetKey = proposal.proposedPathSegments.map(key).join('\u0000');
    if (!proposalTargets.has(targetKey)) proposalTargets.set(targetKey, []);
    proposalTargets.get(targetKey).push(proposal);
  }
  for (const colliding of proposalTargets.values()) {
    if (colliding.length < 2) continue;
    const exactGroupIds = new Set(colliding.map((item) => item.exactDuplicateGroupId).filter(Boolean));
    if (exactGroupIds.size === 1 && colliding.every((item) => item.exactDuplicateGroupId === [...exactGroupIds][0])) continue;
    const currentKeys = new Set(colliding.map((item) => item.currentPathSegments.map(key).join('\u0000')));
    for (const proposal of colliding) {
      proposal.action = 'REVIEW';
      proposal.reason = currentKeys.size < 2 ? 'SOURCE_PATH_COLLISION' : 'TARGET_PATH_COLLISION';
    }
  }

  const proposalCounts = Object.fromEntries([...ALLOWED_ACTIONS].map((action) => [action, proposals.filter((item) => item.action === action).length]));
  return {
    planVersion: clean(options.planVersion) || PLAN_VERSION,
    generatedAt: options.generatedAt ? new Date(options.generatedAt).toISOString() : null,
    mode: 'READ_ONLY',
    decision: 'REVIEW_REQUIRED',
    destructiveActionsAllowed: false,
    counts: {
      files: normalized.length,
      exactDuplicateGroups: exactGroups.length,
      exactDuplicateMembers: new Set(exactGroups.flatMap((group) => group.members.map((member) => member.driveFileId))).size,
      reviewGroups: reviews.filter((group) => group.status === 'DA_VERIFICARE').length,
      hashConflictGroups: reviews.filter((group) => group.status === 'HASH_CONFLICT').length,
      proposals: proposalCounts
    },
    groups,
    proposals
  };
}

function normalizeFolder(folder, index) {
  if (!folder || typeof folder !== 'object') throw new TypeError(`Cartella Drive non valida alla posizione ${index}`);
  const driveFolderId = clean(folder.driveFolderId ?? folder.id);
  if (!driveFolderId) throw new TypeError(`driveFolderId mancante alla posizione ${index}`);
  const rawSegments = folder.pathSegments;
  const isRoot = folder.parentId === null && (Array.isArray(rawSegments) ? rawSegments.length === 0 : !clean(folder.percorso ?? folder.path));
  const pathSegments = isRoot ? [] : normalizeAuthoritativeSegments(rawSegments, folder.percorso ?? folder.path ?? folder.nome ?? folder.name);
  return {
    driveFolderId,
    name: clean(folder.nome ?? folder.name) || (isRoot ? '(radice)' : pathSegments.at(-1)),
    parentId: folder.parentId ?? null,
    path: displayPath(pathSegments),
    pathSegments,
    pathIssues: pathSegmentIssues(pathSegments),
    isRoot,
    sourceMetadata: jsonSafeCopy({
      scanId: folder.scanId ?? null,
      sourceRevision: folder.sourceRevision ?? folder.versioneFonte ?? null,
      webViewLink: folder.webViewLink ?? null
    })
  };
}

/**
 * Propone una tassonomia per le cartelle inventariate, incluse quelle vuote.
 * L'output non contiene un esecutore e non effettua alcuna mutazione Drive.
 */
export function buildDriveFolderPlan(folders, options = {}) {
  if (!Array.isArray(folders)) throw new TypeError('folders deve essere un array');
  const normalized = folders.map(normalizeFolder);
  const ids = new Set();
  for (const folder of normalized) {
    if (ids.has(folder.driveFolderId)) throw new TypeError(`driveFolderId duplicato nel report: ${folder.driveFolderId}`);
    ids.add(folder.driveFolderId);
  }
  normalized.sort((a, b) => compareText(a.driveFolderId, b.driveFolderId));
  const taxonomy = taxonomyEntries(options.taxonomy);
  const protectedPaths = (options.protectedPaths ?? DEFAULT_PROTECTED_PATHS).map(normalizeDrivePath);

  const proposals = normalized.map((folder) => {
    const target = folder.isRoot
      ? { matched: true, path: '', pathSegments: [] }
      : proposedPath(folder.pathSegments, taxonomy);
    let action = 'KEEP';
    let reason = folder.isRoot ? 'ROOT_FOLDER' : 'ALREADY_CANONICAL';
    if (!folder.isRoot && folder.pathIssues.length) {
      action = 'REVIEW';
      reason = 'AMBIGUOUS_PATH_SEGMENTS';
    } else if (!folder.isRoot && !sameSegments(target.pathSegments, folder.pathSegments) && pathIsProtected(folder.pathSegments, protectedPaths)) {
      action = 'REVIEW';
      reason = 'PROTECTED_INTEGRATION_PATH';
    } else if (!folder.isRoot && !sameSegments(target.pathSegments, folder.pathSegments)) {
      action = 'MOVE_RENAME';
      reason = 'TAXONOMY_PATH_MISMATCH';
    } else if (!folder.isRoot && !target.matched) {
      action = 'REVIEW';
      reason = 'TAXONOMY_UNMAPPED';
    }
    return {
      proposalId: `FOLDER:${folder.driveFolderId}`,
      action,
      reason,
      driveFolderId: folder.driveFolderId,
      parentId: folder.parentId,
      name: folder.name,
      sourceMetadata: jsonSafeCopy(folder.sourceMetadata),
      currentPath: folder.path,
      currentPathSegments: [...folder.pathSegments],
      proposedPath: target.path,
      proposedPathSegments: [...target.pathSegments]
    };
  });

  const targets = new Map();
  for (const proposal of proposals.filter((item) => item.proposedPathSegments.length)) {
    const targetKey = proposal.proposedPathSegments.map(key).join('\u0000');
    if (!targets.has(targetKey)) targets.set(targetKey, []);
    targets.get(targetKey).push(proposal);
  }
  for (const colliding of targets.values()) {
    if (colliding.length < 2) continue;
    const currentKeys = new Set(colliding.map((item) => item.currentPathSegments.map(key).join('\u0000')));
    for (const proposal of colliding) {
      proposal.action = 'REVIEW';
      proposal.reason = currentKeys.size < 2 ? 'SOURCE_PATH_COLLISION' : 'TARGET_PATH_COLLISION';
    }
  }

  const protectedFolderIds = new Set(options.protectedFolderIds || []);
  for (const proposal of proposals) {
    if (!protectedFolderIds.has(proposal.driveFolderId) || proposal.parentId === null) continue;
    proposal.action = 'REVIEW';
    proposal.reason = 'CONTAINS_VERIFIED_INDEX_FILE';
  }

  const proposalCounts = Object.fromEntries([...ALLOWED_ACTIONS].map((action) => [action, proposals.filter((item) => item.action === action).length]));
  return {
    planVersion: clean(options.planVersion) || FOLDER_PLAN_VERSION,
    generatedAt: options.generatedAt ? new Date(options.generatedAt).toISOString() : null,
    mode: 'READ_ONLY',
    decision: 'REVIEW_REQUIRED',
    destructiveActionsAllowed: false,
    counts: { folders: normalized.length, proposals: proposalCounts },
    proposals
  };
}
