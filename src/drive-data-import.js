import crypto from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';
import { calculateF24Totals, normalizeF24Row } from './f24.js';
import { relationKey } from './domain.js';

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const INDEX_SOURCE = 'DRIVE_DOCUMENT_INDEX';

function clean(value) { return value === null || value === undefined ? '' : String(value).trim(); }
function asArray(value) { return value === undefined || value === null ? [] : Array.isArray(value) ? value : [value]; }
function money(value) { const result = Number(value || 0); return Number.isFinite(result) ? Math.round(result * 100) / 100 : 0; }
function driveSize(value) {
  const provided = value !== undefined && value !== null && value !== '';
  const numericShape = typeof value === 'number'
    ? Number.isSafeInteger(value) && value >= 0
    : typeof value === 'string' && /^\d+$/.test(value);
  const parsed = provided && numericShape ? Number(value) : null;
  const valid = !provided || (numericShape && Number.isSafeInteger(parsed) && parsed >= 0);
  return { value: valid ? parsed : null, invalid: provided && !valid };
}
function normalizedPath(value) { return clean(value).replaceAll('\\', '/').replace(/^\/+|\/+$/g, ''); }
function yearFromPath(value) { const match = normalizedPath(value).match(/(?:^|[^0-9])(20\d{2})(?:[^0-9]|$)/); return match ? Number(match[1]) : null; }
function sourceDate(value) {
  const raw = clean(value); const match = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  const date = match ? new Date(`${match[3]}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}T12:00:00.000Z`) : new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

function periodFields(value) {
  const match = clean(value).match(/^(\d{4})(?:-(\d{1,2}))?$/);
  if (!match) return {};
  const month = match[2]?.padStart(2, '0') || null;
  return { annoRiferimento: Number(match[1]), ...(month ? { rateazioneMeseRif: month, periodoDa: `${month}/${match[1]}`, periodoA: `${month}/${match[1]}` } : {}) };
}

export function proposedDocumentType(pathValue) {
  const authoritativeSegments = Array.isArray(pathValue) ? pathValue : null;
  const rawTopSegment = authoritativeSegments ? String(authoritativeSegments[0] || '') : normalizedPath(pathValue).split('/')[0];
  if (authoritativeSegments && (rawTopSegment !== rawTopSegment.trim() || /[\\/\u0000-\u001f\u007f]/.test(rawTopSegment) || rawTopSegment === '.' || rawTopSegment === '..')) return 'DOCUMENTO_DRIVE';
  const topSegment = rawTopSegment.trim();
  const top = topSegment.toUpperCase();
  const types = {
    'CORRISPETTIVI': 'CORRISPETTIVO_XML',
    'FATTURE XML GESTIONALE': 'FATTURA_XML',
    'FATTURE ESTERO': 'FATTURA_ESTERO',
    'CEDOLINI PAGA': 'CEDOLINO',
    'BONIFICI EFFETTUATI': 'BONIFICO',
    'ESTRATTI CONTO': 'ESTRATTO_CONTO',
    'F24': 'F24_DOCUMENTO',
    'QUIETANZE': 'QUIETANZA',
    'DICHIARAZIONI FISCALI': 'DICHIARAZIONE_FISCALE',
    'CARTELLE ESATTORIALI': 'ATTO_RISCOSSIONE',
    'AVVISI BONARI': 'AVVISO_BONARIO',
    'VERBALI AUTO': 'VERBALE_AUTO',
    'CBILL': 'CBILL',
    'ASSEGNI': 'ASSEGNO',
    'MUTUI': 'MUTUO',
    'CERTIFICAZIONI DIPENDENTI': 'CERTIFICAZIONE_UNICA',
    'CONTRATTI DIPENDENTI': 'CONTRATTO_DIPENDENTE',
    'DOCUMENTI DIPENDENTI': 'DOCUMENTO_DIPENDENTE',
    'UNILAV': 'UNILAV'
  };
  return types[top] || 'DOCUMENTO_DRIVE';
}

function documentRow(row, revision, now) {
  const path = normalizedPath(row.__path || row['Percorso Drive']);
  return {
    indexId: clean(row.__id || row['ID documento']), sha256: clean(row.__sha || row['SHA-256']).toLowerCase(),
    name: clean(row['Nome file']), path, domain: clean(row.Dominio), category: clean(row.Categoria),
    year: Number(row.Anno) || null, bytes: Number(row['Dimensione byte'] || 0), status: clean(row.Stato),
    number: clean(row['Numero documento']) || null, proposedType: proposedDocumentType(path), revision, now
  };
}

function f24IndexedRow(row, progressivo, revision) {
  const section = clean(row.Sezione).toUpperCase() === 'TRIB.LOCALI' ? 'IMU E ALTRI TRIBUTI LOCALI' : clean(row.Sezione);
  const contributive = ['INPS', 'INAIL'].includes(section.toUpperCase());
  const normalized = normalizeF24Row({
    sezione: section,
    ...(contributive ? { causaleContributo: row['Codice tributo'] } : { codiceTributo: row['Codice tributo'] }),
    ...periodFields(row['Periodo tributo']), debito: row.Debito, credito: row.Credito, raw: row['Testo sorgente']
  });
  return {
    ...normalized,
    sourceRowKey: `${clean(row['ID documento'])}:${progressivo}`,
    documentIndexId: clean(row['ID documento']),
    dataPagamento: sourceDate(row['Data pagamento']),
    annoPagamento: Number(row['Anno pagamento']) || null,
    protocollo: clean(row.Protocollo) === '-' ? null : clean(row.Protocollo) || null,
    tipoDocumento: clean(row['Tipo documento']),
    descrizioneIndice: clean(row.Descrizione) || null,
    enteIndice: clean(row.Ente) || null,
    pagina: Number(row.Pagina) || null,
    fonteIndice: clean(row.Fonte) || 'PDF_PRIMARIO',
    sha256: clean(row['SHA-256']).toLowerCase(),
    percorsoDrive: normalizedPath(row['Percorso Drive']),
    indexRevision: revision,
    attivo: true
  };
}

export function buildDriveIndexDataset(index, revision, now = new Date()) {
  const documents = index.documents.map((row) => documentRow(row, revision, now));
  const f24Rows = index.f24Rows.map((row, i) => f24IndexedRow(row, i + 1, revision));
  const groups = new Map();
  for (const row of f24Rows) {
    if (!groups.has(row.documentIndexId)) groups.set(row.documentIndexId, []);
    groups.get(row.documentIndexId).push(row);
  }
  const f24Documents = [...groups].map(([documentIndexId, rows]) => {
    const totals = calculateF24Totals(rows);
    const type = rows[0].tipoDocumento;
    return {
      sourceKey: `${INDEX_SOURCE}:F24:${documentIndexId}`, documentIndexId, rows, totals,
      dataVersamento: rows[0].dataPagamento, annoElenco: rows[0].annoPagamento,
      protocollo: rows.find((row) => row.protocollo)?.protocollo || null,
      tipoDocumento: type, sha256: rows[0].sha256, percorsoDrive: rows[0].percorsoDrive,
      quietanza: type.toUpperCase().includes('QUIETANZA'), indexRevision: revision
    };
  });
  const declarations = index.declarations.map((row, i) => ({
    sourceKey: `${INDEX_SOURCE}:DICHIARAZIONE:${row.__documentId}:${i + 1}`,
    documentIndexId: row.__documentId, anno: Number(row.Anno) || null, tipo: clean(row.Tipo),
    protocollo: clean(row.Protocollo) || null, percorsoArchivio: normalizedPath(row['Percorso archivio']), indexRevision: revision, attivo: true
  }));
  const discards = index.duplicates.map((row, i) => ({
    sourceKey: `${INDEX_SOURCE}:SCARTO:${clean(row['SHA-256']).toLowerCase()}:${i + 1}`,
    sha256: clean(row['SHA-256']).toLowerCase(), nome: clean(row.Nome), esito: clean(row.Esito),
    zipOrigine: clean(row['ZIP origine']), percorsoPacchetto: normalizedPath(row['Percorso nel pacchetto']),
    percorsoDriveCollegato: normalizedPath(row['Percorso Drive collegato']), dimensione: Number(row['Dimensione byte'] || 0),
    indexRevision: revision, attivo: true
  }));
  return { documents, f24Rows, f24Documents, declarations, discards };
}

async function runBulk(collection, operations, size = 500) {
  let matched = 0; let upserted = 0; let modified = 0;
  for (let i = 0; i < operations.length; i += size) {
    const result = await collection.bulkWrite(operations.slice(i, i + size), { ordered: false });
    matched += result.matchedCount || 0; upserted += result.upsertedCount || 0; modified += result.modifiedCount || 0;
  }
  return { matched, upserted, modified };
}

async function loadDriveSourceDocuments(db, files, size = 500) {
  const documents = [];
  for (let index = 0; index < files.length; index += size) {
    const sourceKeys = files.slice(index, index + size).map((file) => `DRIVE_FILE:${file.id}`);
    const batch = await db.collection('documenti').find(
      { primarySourceKey: { $in: sourceKeys } },
      { projection: { _id: 1, primarySourceKey: 1 } }
    ).toArray();
    documents.push(...batch);
  }
  return documents;
}

async function ensureIndexes(db) {
  await Promise.all([
    db.collection('documenti').createIndex({ sha256: 1 }, { unique: true, sparse: true }),
    db.collection('documenti').createIndex({ primarySourceKey: 1 }, { unique: true, sparse: true }),
    db.collection('drive_files').createIndex({ driveFileId: 1 }, { unique: true }),
    db.collection('drive_files').createIndex({ rootFolderId: 1, attivo: 1, scanId: 1 }),
    db.collection('drive_files').createIndex({ topFolder: 1, extension: 1 }),
    db.collection('drive_files').createIndex({ attivo: 1, scanId: 1, sha256Checksum: 1, dimensione: 1 }),
    db.collection('drive_files').createIndex({ attivo: 1, scanId: 1, md5Checksum: 1, dimensione: 1 }),
    db.collection('drive_document_links').createIndex({ driveFileId: 1 }, { unique: true }),
    db.collection('drive_document_links').createIndex({ documentoId: 1, verified: 1 }),
    db.collection('drive_document_links').createIndex({ scanId: 1, attivo: 1 }),
    db.collection('drive_folders').createIndex({ driveFolderId: 1 }, { unique: true }),
    db.collection('drive_folders').createIndex({ rootFolderId: 1, attivo: 1, scanId: 1 }),
    db.collection('drive_folders').createIndex({ scanId: 1, attivo: 1 }),
    db.collection('f24_operazioni').createIndex({ sourceKey: 1 }, { unique: true }),
    db.collection('quietanze_f24').createIndex({ sourceKey: 1 }, { unique: true }),
    db.collection('f24_righe_indice').createIndex({ sourceRowKey: 1 }, { unique: true }),
    db.collection('f24_righe').createIndex({ f24Id: 1, progressivo: 1 }, { unique: true }),
    db.collection('dichiarazioni_fiscali').createIndex({ sourceKey: 1 }, { unique: true }),
    db.collection('drive_import_scarti').createIndex({ sourceKey: 1 }, { unique: true }),
    db.collection('collegamenti').createIndex({ relationKey: 1 }, { unique: true }),
    db.collection('fatture').createIndex({ sourceKey: 1 }, { unique: true }),
    db.collection('corrispettivi_rt').createIndex({ sourceKey: 1 }, { unique: true }),
    db.collection('drive_import_runs').createIndex({ iniziatoIl: -1 }),
    db.collection('drive_import_locks').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 })
  ]);
}

function driveRootError(message, code) {
  return Object.assign(new Error(message), { code });
}

export async function ensureCanonicalDriveRoot(db, rootFolderId, adoptionConfirmation = null, now = new Date()) {
  const root = clean(rootFolderId);
  if (!root) throw driveRootError('Radice Drive non identificata', 'DRIVE_ROOT_NOT_IDENTIFIED');
  const configCollection = db.collection('drive_inventory_config');
  const current = await configCollection.findOne({ _id: 'CANONICAL_ROOT' });
  if (current?.rootFolderId && String(current.rootFolderId) !== root) {
    throw driveRootError('Radice Drive diversa dalla radice canonica registrata; migrazione esplicita richiesta', 'DRIVE_ROOT_CHANGED');
  }

  const rootedFilter = { attivo: true, rootFolderId: { $exists: true, $ne: null } };
  const [fileRoots, folderRoots] = await Promise.all([
    db.collection('drive_files').distinct('rootFolderId', rootedFilter),
    db.collection('drive_folders').distinct('rootFolderId', rootedFilter)
  ]);
  const activeRoots = [...new Set([...fileRoots, ...folderRoots].map(String))];
  if (activeRoots.some((value) => String(value) !== root)) {
    throw driveRootError('L’inventario attivo appartiene a una radice Drive diversa', 'DRIVE_ROOT_CHANGED');
  }
  const unscopedFilter = { attivo: true, $or: [{ rootFolderId: { $exists: false } }, { rootFolderId: null }] };
  const unscopedDriveDocuments = {
    primarySourceKey: /^DRIVE_FILE:/,
    $or: [{ rootFolderId: { $exists: false } }, { rootFolderId: null }]
  };
  const [unscopedFiles, unscopedFolders, unscopedLinks, unscopedDocuments] = await Promise.all([
    db.collection('drive_files').countDocuments(unscopedFilter),
    db.collection('drive_folders').countDocuments(unscopedFilter),
    db.collection('drive_document_links').countDocuments(unscopedFilter),
    db.collection('documenti').countDocuments(unscopedDriveDocuments)
  ]);
  const adoptUnscoped = unscopedFiles > 0 || unscopedFolders > 0 || unscopedLinks > 0 || unscopedDocuments > 0;
  if (adoptUnscoped && clean(adoptionConfirmation) !== root) {
    throw driveRootError('Inventario Drive esistente senza radice: confermare esplicitamente la radice configurata', 'DRIVE_ROOT_ADOPTION_REQUIRED');
  }
  if (adoptUnscoped) {
    await db.collection('documenti').updateMany(
      unscopedDriveDocuments,
      { $set: { rootFolderId: root, recordKind: 'DRIVE_SOURCE', sourceActive: true, aggiornatoIl: now } }
    );
    await db.collection('drive_document_links').updateMany(
      { $or: [{ rootFolderId: { $exists: false } }, { rootFolderId: null }] },
      { $set: { rootFolderId: root, aggiornatoIl: now } }
    );
  }

  try {
    await configCollection.updateOne(
      { _id: 'CANONICAL_ROOT' },
      { $setOnInsert: { rootFolderId: root, creatoIl: now }, $set: { aggiornatoIl: now } },
      { upsert: true }
    );
  } catch (error) {
    if (error?.code !== 11000) throw error;
  }
  const canonical = await configCollection.findOne({ _id: 'CANONICAL_ROOT' });
  if (!canonical || String(canonical.rootFolderId) !== root) {
    throw driveRootError('Un’altra radice Drive è stata registrata come canonica', 'DRIVE_ROOT_CHANGED');
  }
  return { rootFolderId: root, adoptUnscoped };
}

export async function acquireDriveImportLease(db, rootFolderId, ownerId, {
  leaseMs = 30 * 60 * 1000,
  now = () => new Date()
} = {}) {
  const duration = Number(leaseMs);
  if (!Number.isSafeInteger(duration) || duration < 30_000) throw new TypeError('Durata lock Drive non valida');
  const collection = db.collection('drive_import_locks');
  const lockId = `ROOT:${rootFolderId}`;
  const acquiredAt = now();
  try {
    await collection.updateOne(
      { _id: lockId, $or: [{ expiresAt: { $lte: acquiredAt } }, { ownerId }] },
      { $set: { ownerId, rootFolderId, acquiredAt, expiresAt: new Date(acquiredAt.getTime() + duration) } },
      { upsert: true }
    );
  } catch (error) {
    if (error?.code === 11000) throw driveRootError('Una scansione Drive è già in corso per questa radice', 'DRIVE_IMPORT_ALREADY_RUNNING');
    throw error;
  }
  const acquired = await collection.findOne({ _id: lockId, ownerId });
  if (!acquired) throw driveRootError('Una scansione Drive è già in corso per questa radice', 'DRIVE_IMPORT_ALREADY_RUNNING');

  let stopped = false;
  let leaseError = null;
  const heartbeatMs = Math.max(10_000, Math.floor(duration / 3));
  const heartbeat = setInterval(async () => {
    if (stopped) return;
    try {
      const heartbeatAt = now();
      const result = await collection.updateOne(
        { _id: lockId, ownerId },
        { $set: { expiresAt: new Date(heartbeatAt.getTime() + duration), heartbeatAt } }
      );
      if (result.matchedCount !== 1) leaseError = driveRootError('Titolarità della scansione Drive persa', 'DRIVE_IMPORT_LEASE_LOST');
    } catch (error) {
      leaseError = driveRootError(`Rinnovo del lock Drive fallito: ${error.message}`, 'DRIVE_IMPORT_LEASE_LOST');
    }
  }, heartbeatMs);
  heartbeat.unref?.();

  return {
    async assertOwned() {
      if (leaseError) throw leaseError;
      const record = await collection.findOne({ _id: lockId, ownerId, expiresAt: { $gt: now() } });
      if (!record) throw driveRootError('Titolarità della scansione Drive persa', 'DRIVE_IMPORT_LEASE_LOST');
    },
    async release() {
      stopped = true;
      clearInterval(heartbeat);
      await collection.deleteOne({ _id: lockId, ownerId });
    }
  };
}

function relationOperation(aTipo, aId, bTipo, bId, relazione, now) {
  const key = relationKey(aTipo, aId, bTipo, bId, relazione);
  return { updateOne: { filter: { relationKey: key }, update: { $setOnInsert: { relationKey: key, a: { tipo: aTipo, id: String(aId) }, b: { tipo: bTipo, id: String(bId) }, relazione, creatoIl: now } }, upsert: true } };
}

async function importIndex(db, index, revision, now) {
  const data = buildDriveIndexDataset(index, revision, now);
  const documentResult = await runBulk(db.collection('documenti'), data.documents.map((row) => ({ updateOne: {
    filter: { sha256: row.sha256 },
    update: {
      $set: {
        nomeOriginale: row.name, sha256: row.sha256, annoImposta: row.year,
        statoDocumentale: row.status, 'datiEstratti.driveIndex': {
          id: row.indexId, dominio: row.domain, categoria: row.category, percorso: row.path,
          dimensione: row.bytes, numeroDocumento: row.number, revisione: revision
        }, aggiornatoIl: now
      },
      $setOnInsert: { tipo: row.proposedType, stato: 'DOCUMENTATO', creatoIl: now },
      $addToSet: { fonti: { sourceKey: `${INDEX_SOURCE}:${row.indexId}`, tipo: INDEX_SOURCE, riferimento: row.path } },
      $unset: { primarySourceKey: '' }
    }, upsert: true
  } })));

  const savedDocuments = await db.collection('documenti').find({ sha256: { $in: data.documents.map((row) => row.sha256) } }, { projection: { sha256: 1, 'datiEstratti.driveIndex.id': 1, 'datiEstratti.driveIndex.percorso': 1, 'datiEstratti.driveIndex.dimensione': 1 } }).toArray();
  const documentByIndexId = new Map(savedDocuments.map((row) => [row.datiEstratti?.driveIndex?.id, row]));

  const canonical = data.f24Documents.filter((row) => !row.quietanza);
  const receipts = data.f24Documents.filter((row) => row.quietanza);
  const f24Result = await runBulk(db.collection('f24_operazioni'), canonical.map((row) => ({ updateOne: {
    filter: { sourceKey: row.sourceKey }, update: {
      $set: { operationKey: row.sourceKey, annoElenco: row.annoElenco, indicePortale: 0, dataVersamento: row.dataVersamento, numeroModelliF24: 1, numeroModelloNelGruppo: 1, saldoOperazione: row.totals.saldo, saldoModello: row.totals.saldo, protocollo: row.protocollo, tipoDocumento: 'F24_FORMATO_STAMPABILE', sha256: row.sha256, file: row.percorsoDrive.split('/').at(-1), fonteIndice: INDEX_SOURCE, provaPagamento: false, statoDocumentale: 'DOCUMENTATO', indexRevision: revision, aggiornatoIl: now },
      $setOnInsert: { stato: row.totals.saldo === 0 ? 'COMPENSATO' : 'IN_ATTESA_RISCONTRO', creatoIl: now }
    }, upsert: true
  } })));
  const receiptResult = await runBulk(db.collection('quietanze_f24'), receipts.map((row) => ({ updateOne: {
    filter: { sourceKey: row.sourceKey }, update: {
      $set: { documentIndexId: row.documentIndexId, dataVersamento: row.dataVersamento, annoElenco: row.annoElenco, protocollo: row.protocollo, totaliRighe: row.totals, pdfHash: row.sha256, percorsoDrive: row.percorsoDrive, provaBancaria: false, indexRevision: revision, aggiornatoIl: now },
      $setOnInsert: { stato: 'DA_ASSOCIARE_AL_MODELLO', creatoIl: now }
    }, upsert: true
  } })));

  const [savedF24, savedReceipts] = await Promise.all([
    db.collection('f24_operazioni').find({ sourceKey: { $in: canonical.map((row) => row.sourceKey) } }, { projection: { sourceKey: 1 } }).toArray(),
    db.collection('quietanze_f24').find({ sourceKey: { $in: receipts.map((row) => row.sourceKey) } }, { projection: { sourceKey: 1 } }).toArray()
  ]);
  const entityByDocument = new Map();
  for (const row of savedF24) entityByDocument.set(row.sourceKey.split(':').at(-1), { tipo: 'F24', id: row._id });
  for (const row of savedReceipts) entityByDocument.set(row.sourceKey.split(':').at(-1), { tipo: 'QUIETANZA_F24', id: row._id });

  const indexedRowsResult = await runBulk(db.collection('f24_righe_indice'), data.f24Rows.map((row) => {
    const entity = entityByDocument.get(row.documentIndexId);
    return { updateOne: { filter: { sourceRowKey: row.sourceRowKey }, update: { $set: { ...row, entityType: entity?.tipo || null, entityId: entity?.id || null, aggiornatoIl: now }, $setOnInsert: { creatoIl: now } }, upsert: true } };
  }));

  const f24Rows = data.f24Rows.filter((row) => entityByDocument.get(row.documentIndexId)?.tipo === 'F24');
  const progress = new Map();
  const canonicalRowResult = await runBulk(db.collection('f24_righe'), f24Rows.map((row) => {
    const entity = entityByDocument.get(row.documentIndexId); const p = (progress.get(row.documentIndexId) || 0) + 1; progress.set(row.documentIndexId, p);
    return { updateOne: { filter: { f24Id: entity.id, progressivo: p }, update: { $set: { ...row, f24Id: entity.id, progressivo: p, aggiornatoIl: now }, $setOnInsert: { creatoIl: now } }, upsert: true } };
  }));

  const declarationResult = await runBulk(db.collection('dichiarazioni_fiscali'), data.declarations.map((row) => ({ updateOne: { filter: { sourceKey: row.sourceKey }, update: { $set: { ...row, documentoId: documentByIndexId.get(row.documentIndexId)?._id || null, aggiornatoIl: now }, $setOnInsert: { creatoIl: now } }, upsert: true } })));
  const discardResult = await runBulk(db.collection('drive_import_scarti'), data.discards.map((row) => ({ updateOne: { filter: { sourceKey: row.sourceKey }, update: { $set: { ...row, aggiornatoIl: now }, $setOnInsert: { creatoIl: now } }, upsert: true } })));

  const relations = [];
  for (const [documentIndexId, entity] of entityByDocument) {
    const document = documentByIndexId.get(documentIndexId); if (document) relations.push(relationOperation(entity.tipo, entity.id, 'DOCUMENTO', document._id, 'DOCUMENTATO_DA', now));
  }
  for (const declaration of data.declarations) {
    const document = documentByIndexId.get(declaration.documentIndexId); if (document) relations.push(relationOperation('DICHIARAZIONE_FISCALE', declaration.sourceKey, 'DOCUMENTO', document._id, 'DOCUMENTATO_DA', now));
  }
  const relationResult = await runBulk(db.collection('collegamenti'), relations);

  await Promise.all([
    db.collection('f24_righe_indice').updateMany({ indexRevision: { $ne: revision }, attivo: true }, { $set: { attivo: false, aggiornatoIl: now } }),
    db.collection('dichiarazioni_fiscali').updateMany({ indexRevision: { $ne: revision }, attivo: true }, { $set: { attivo: false, aggiornatoIl: now } }),
    db.collection('drive_import_scarti').updateMany({ indexRevision: { $ne: revision }, attivo: true }, { $set: { attivo: false, aggiornatoIl: now } })
  ]);

  return { data, documentByIndexId, counts: { documents: data.documents.length, f24Canonical: canonical.length, quietanze: receipts.length, f24Rows: data.f24Rows.length, declarations: data.declarations.length, discards: data.discards.length }, writes: { documentResult, f24Result, receiptResult, indexedRowsResult, canonicalRowResult, declarationResult, discardResult, relationResult } };
}

export async function scanDriveTree(driveClient, rootFolderId) {
  const root = {
    id: rootFolderId,
    driveFolderId: rootFolderId,
    name: '(radice)',
    nome: '(radice)',
    mimeType: FOLDER_MIME,
    parentId: null,
    path: '',
    pathSegments: []
  };
  const stack = [root]; const visited = new Set(); const files = []; const folderRecords = []; const errors = [];
  while (stack.length) {
    const current = stack.pop(); if (visited.has(current.id)) continue; visited.add(current.id);
    folderRecords.push(current);
    try {
      const children = await driveClient.listChildren(current.id);
      for (const item of children) {
        const pathSegments = [...current.pathSegments, item.name];
        if (item.mimeType === FOLDER_MIME) stack.push({
          ...item,
          driveFolderId: item.id,
          nome: item.name,
          parentId: current.id,
          path: pathSegments.join('/'),
          pathSegments
        });
        else {
          const fullPath = pathSegments.join('/'); const topFolder = current.pathSegments[0] || '(radice)';
          files.push({ ...item, path: fullPath, pathSegments, topFolder, extension: item.name.includes('.') ? `.${item.name.split('.').at(-1).toLowerCase()}` : '', year: yearFromPath(fullPath), parentId: current.id });
        }
      }
    } catch (error) { errors.push({ folderId: current.id, path: current.path, pathSegments: [...current.pathSegments], code: error.code || 'DRIVE_LIST_FAILED', message: error.message }); }
  }
  return { files, folders: visited.size, folderRecords, errors };
}

export async function persistDriveMetadata(db, scan, documentByIndexId, now, scanId, rootFolderId, { adoptUnscoped = false, assertLease = async () => {} } = {}) {
  if (!rootFolderId) throw Object.assign(new Error('Radice Drive non identificata'), { code: 'DRIVE_ROOT_NOT_IDENTIFIED' });
  await assertLease();
  const indexedBySha = new Map();
  for (const document of documentByIndexId.values()) {
    const hash = clean(document.sha256).toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(hash)) continue;
    if (!indexedBySha.has(hash)) indexedBySha.set(hash, []);
    indexedBySha.get(hash).push(document);
  }
  function verifiedIndexMatch(file) {
    const hash = clean(file.sha256Checksum).toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(hash)) return null;
    const matches = indexedBySha.get(hash) || [];
    if (matches.length !== 1) return null;
    const fileBytes = driveSize(file.size).value;
    const indexBytes = driveSize(matches[0].datiEstratti?.driveIndex?.dimensione).value;
    if (fileBytes !== null && indexBytes !== null && fileBytes !== indexBytes) return null;
    return matches[0];
  }
  const folderResult = await runBulk(db.collection('drive_folders'), scan.folderRecords.map((folder) => ({ updateOne: { filter: { driveFolderId: folder.driveFolderId || folder.id }, update: { $set: {
    driveFolderId: folder.driveFolderId || folder.id,
    nome: folder.nome || folder.name,
    mimeType: folder.mimeType || FOLDER_MIME,
    parentId: folder.parentId ?? null,
    percorso: folder.path,
    pathSegments: [...folder.pathSegments],
    versioneFonte: folder.version || folder.modifiedTime || null,
    modificatoIlFonte: folder.modifiedTime ? new Date(folder.modifiedTime) : null,
    webViewLink: folder.webViewLink || null,
    rootFolderId,
    scanId,
    attivo: true,
    aggiornatoIl: now
  }, $setOnInsert: { creatoIl: now } }, upsert: true } })));
  const driveResult = await runBulk(db.collection('drive_files'), scan.files.map((file) => {
    const bytes = driveSize(file.size); const indexed = verifiedIndexMatch(file);
    return { updateOne: { filter: { driveFileId: file.id }, update: { $set: { driveFileId: file.id, nome: file.name, mimeType: file.mimeType, dimensione: bytes.value, dimensioneFonteNonValida: bytes.invalid, md5Checksum: file.md5Checksum || null, sha256Checksum: file.sha256Checksum || null, versioneFonte: file.version || file.modifiedTime || null, percorso: normalizedPath(file.path), pathSegments: [...file.pathSegments], topFolder: file.topFolder, extension: file.extension, anno: file.year, parentId: file.parentId, rootFolderId, webViewLink: file.webViewLink || null, modificatoIlFonte: file.modifiedTime ? new Date(file.modifiedTime) : null, tipoProposto: proposedDocumentType(file.pathSegments), verifiedIndexMatch: Boolean(indexed), documentIndexId: indexed?.datiEstratti?.driveIndex?.id || null, documentoId: indexed?._id || null, scanId, attivo: true, aggiornatoIl: now }, $setOnInsert: { creatoIl: now } }, upsert: true } };
  }));

  const documentOperations = scan.files.map((file) => {
    const indexed = verifiedIndexMatch(file); const bytes = driveSize(file.size);
    const filter = { primarySourceKey: `DRIVE_FILE:${file.id}` };
    const set = { nomeOriginale: file.name, recordKind: 'DRIVE_SOURCE', rootFolderId, sourceActive: true, sourceScanId: scanId, sourceDeletedAt: null, 'datiEstratti.drive': { fileId: file.id, percorso: normalizedPath(file.path), pathSegments: [...file.pathSegments], topFolder: file.topFolder, mimeType: file.mimeType, dimensione: bytes.value, dimensioneFonteNonValida: bytes.invalid, modificatoIl: file.modifiedTime || null }, aggiornatoIl: now };
    set.primarySourceKey = `DRIVE_FILE:${file.id}`;
    return { updateOne: { filter, update: { $set: set, $setOnInsert: { tipo: proposedDocumentType(file.pathSegments), stato: 'DA_VERIFICARE', creatoIl: now }, $addToSet: { fonti: { sourceKey: `DRIVE_FILE:${file.id}`, tipo: 'GOOGLE_DRIVE', riferimento: file.webViewLink || normalizedPath(file.path) } } }, upsert: true } };
  });
  const documentResult = await runBulk(db.collection('documenti'), documentOperations);
  const savedDriveDocuments = await loadDriveSourceDocuments(db, scan.files);
  const driveDocumentByFileId = new Map(savedDriveDocuments.map((document) => [String(document.primarySourceKey).slice('DRIVE_FILE:'.length), document]));
  const linkResult = await runBulk(db.collection('drive_document_links'), scan.files.map((file) => {
    const indexed = verifiedIndexMatch(file); const sourceDocument = driveDocumentByFileId.get(file.id);
    return { updateOne: { filter: { driveFileId: file.id }, update: { $set: {
      driveFileId: file.id,
      documentoDriveId: sourceDocument?._id || null,
      documentoId: indexed?._id || sourceDocument?._id || null,
      documentIndexId: indexed?.datiEstratti?.driveIndex?.id || null,
      verified: Boolean(indexed),
      matchBasis: indexed ? 'SHA256_AND_OPTIONAL_SIZE' : 'STABLE_DRIVE_FILE_ID',
      rootFolderId,
      scanId,
      attivo: true,
      aggiornatoIl: now
    }, $setOnInsert: { creatoIl: now } }, upsert: true } };
  }));
  let driveDeactivationResult = null; let folderDeactivationResult = null; let linkDeactivationResult = null; let documentDeactivationResult = null;
  if (!scan.errors.length) {
    await assertLease();
    const rootScope = adoptUnscoped
      ? { $or: [{ rootFolderId }, { rootFolderId: { $exists: false } }, { rootFolderId: null }] }
      : { rootFolderId };
    [driveDeactivationResult, folderDeactivationResult, linkDeactivationResult] = await Promise.all([
      db.collection('drive_files').updateMany({ ...rootScope, scanId: { $ne: scanId }, attivo: true }, { $set: { attivo: false, aggiornatoIl: now } }),
      db.collection('drive_folders').updateMany({ ...rootScope, scanId: { $ne: scanId }, attivo: true }, { $set: { attivo: false, aggiornatoIl: now } }),
      db.collection('drive_document_links').updateMany({ ...rootScope, scanId: { $ne: scanId }, attivo: true }, { $set: { attivo: false, aggiornatoIl: now } })
    ]);
    documentDeactivationResult = await db.collection('documenti').updateMany(
      { ...rootScope, primarySourceKey: /^DRIVE_FILE:/, sourceScanId: { $ne: scanId }, sourceActive: { $ne: false } },
      { $set: { sourceActive: false, sourceDeletedAt: now, aggiornatoIl: now } }
    );
  }
  const writes = {
    driveFiles: driveResult,
    driveFolders: folderResult,
    documents: documentResult,
    documentLinks: linkResult,
    inactiveDriveFiles: driveDeactivationResult,
    inactiveDriveFolders: folderDeactivationResult,
    inactiveDocumentLinks: linkDeactivationResult,
    inactiveDocuments: documentDeactivationResult
  };
  return { driveResult, folderResult, documentResult, linkResult, driveDeactivationResult, folderDeactivationResult, linkDeactivationResult, documentDeactivationResult, writes };
}

const xmlParser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, parseTagValue: true, trimValues: true });
export function parseCorrispettivoXml(buffer, file) {
  const root = xmlParser.parse(buffer.toString('utf8'))?.DatiCorrispettivi;
  if (!root?.DatiRT) throw new Error('XML corrispettivi non riconosciuto');
  const summaries = asArray(root.DatiRT.Riepilogo); const totals = root.DatiRT.Totali || {};
  const imponibile = money(summaries.reduce((sum, row) => sum + Number(row.Ammontare || 0), 0));
  const iva = money(summaries.reduce((sum, row) => sum + Number(row.IVA?.Imposta || 0), 0));
  const contanti = money(totals.PagatoContanti); const elettronico = money(totals.PagatoElettronico);
  const paymentTotal = money(contanti + elettronico);
  return { sourceKey: `DRIVE_FILE:${file.id}`, driveFileId: file.id, percorsoDrive: file.path, dataGiorno: clean(root.DataOraRilevazione).slice(0, 10), dataOraRilevazione: root.DataOraRilevazione ? new Date(root.DataOraRilevazione) : null, dispositivo: clean(root.Trasmissione?.Dispositivo?.IdDispositivo) || null, progressivo: clean(root.Trasmissione?.Progressivo) || null, imponibile, iva, totaleDocumento: paymentTotal || money(imponibile + iva), pagatoContanti: contanti, pagatoElettronico: elettronico, numeroDocumenti: Number(totals.NumeroDocCommerciali || 0), riepiloghiIva: summaries.map((row) => ({ aliquota: Number(row.IVA?.AliquotaIVA || 0), natura: clean(row.Natura) || null, imponibile: money(row.Ammontare), iva: money(row.IVA?.Imposta) })) };
}

export function parseInvoiceXml(buffer, file) {
  const parsed = xmlParser.parse(buffer.toString('utf8'))?.FatturaElettronica;
  if (!parsed?.FatturaElettronicaHeader) throw new Error('XML fattura non riconosciuto');
  const header = parsed.FatturaElettronicaHeader; const supplier = header.CedentePrestatore?.DatiAnagrafici || {};
  const vat = clean(supplier.IdFiscaleIVA?.IdCodice) || clean(supplier.CodiceFiscale); const name = clean(supplier.Anagrafica?.Denominazione) || [supplier.Anagrafica?.Nome, supplier.Anagrafica?.Cognome].filter(Boolean).join(' ');
  return asArray(parsed.FatturaElettronicaBody).map((body, index) => {
    const general = body.DatiGenerali?.DatiGeneraliDocumento || {}; const summaries = asArray(body.DatiBeniServizi?.DatiRiepilogo);
    const imponibile = money(summaries.reduce((sum, row) => sum + Number(row.ImponibileImporto || 0), 0)); const iva = money(summaries.reduce((sum, row) => sum + Number(row.Imposta || 0), 0));
    const payments = asArray(body.DatiPagamento).flatMap((section) => asArray(section.DettaglioPagamento));
    return { sourceKey: `DRIVE_FILE:${file.id}:${index + 1}`, driveFileId: file.id, percorsoDrive: file.path, fornitore: { partitaIva: vat || null, codiceFiscale: clean(supplier.CodiceFiscale) || null, denominazione: name || null }, tipoDocumento: clean(general.TipoDocumento), numero: clean(general.Numero), data: sourceDate(general.Data), divisa: clean(general.Divisa) || 'EUR', imponibile, ivaEsposta: iva, ivaDetraibile: null, totaleDocumento: money(general.ImportoTotaleDocumento || imponibile + iva), ritenuta: money(asArray(general.DatiRitenuta).reduce((sum, row) => sum + Number(row.ImportoRitenuta || 0), 0)), pagamenti: payments.map((row) => ({ modalita: clean(row.ModalitaPagamento), scadenza: row.DataScadenzaPagamento ? sourceDate(row.DataScadenzaPagamento) : null, importo: money(row.ImportoPagamento), iban: clean(row.IBAN) || null })), stato: 'IMPORTATA_DA_VERIFICARE' };
  });
}

async function mapConcurrent(items, concurrency, worker) {
  let cursor = 0; const results = [];
  async function run() { while (cursor < items.length) { const index = cursor; cursor += 1; results[index] = await worker(items[index]); } }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run)); return results;
}

async function importStructuredXml(db, driveClient, files, now) {
  const targets = files.filter((file) => file.extension === '.xml' && ['Corrispettivi', 'Fatture Xml Gestionale'].includes(file.topFolder) && Number(file.size || 0) <= 5 * 1024 * 1024);
  const errors = []; const corr = []; const invoices = [];
  await mapConcurrent(targets, 8, async (file) => {
    try {
      const buffer = await driveClient.downloadBuffer(file.id);
      if (file.topFolder === 'Corrispettivi') corr.push(parseCorrispettivoXml(buffer, file));
      else invoices.push(...parseInvoiceXml(buffer, file));
    } catch (error) { errors.push({ driveFileId: file.id, percorso: file.path, code: error.code || 'XML_PARSE_FAILED', message: error.message }); }
  });
  const corrResult = await runBulk(db.collection('corrispettivi_rt'), corr.map((row) => ({ updateOne: { filter: { sourceKey: row.sourceKey }, update: { $set: { ...row, aggiornatoIl: now }, $setOnInsert: { creatoIl: now } }, upsert: true } })));
  const invoiceResult = await runBulk(db.collection('fatture'), invoices.map((row) => ({ updateOne: { filter: { sourceKey: row.sourceKey }, update: { $set: { ...row, aggiornatoIl: now }, $setOnInsert: { creatoIl: now } }, upsert: true } })));
  if (errors.length) await db.collection('drive_import_errori').insertMany(errors.map((row) => ({ ...row, importatoIl: now })));
  return { counts: { targets: targets.length, corrispettivi: corr.length, fatture: invoices.length, errors: errors.length }, corrResult, invoiceResult, errors: errors.slice(0, 100) };
}

export function createDriveDataImportService({ getDb, getIndex, driveClient, rootFolderId, rootAdoptionConfirmation = null, leaseMs = 30 * 60 * 1000, logger = console }) {
  let running = null;
  async function run({ force = false } = {}) {
    if (running) return running;
    running = (async () => {
      const db = getDb(); if (!db) throw new Error('MongoDB non configurato');
      await ensureIndexes(db);
      const rootState = await ensureCanonicalDriveRoot(db, rootFolderId, rootAdoptionConfirmation);
      const now = new Date(); const scanId = crypto.randomUUID();
      const lease = await acquireDriveImportLease(db, rootState.rootFolderId, scanId, { leaseMs });
      let inserted = null;
      try {
        const runRecord = { scanId, rootFolderId: rootState.rootFolderId, stato: 'IN_CORSO', iniziatoIl: now, force };
        inserted = await db.collection('drive_import_runs').insertOne(runRecord);
        try {
          const index = await getIndex({ force }); const revision = index.revision;
          await db.collection('drive_import_runs').updateOne({ _id: inserted.insertedId }, { $set: { indexRevision: revision, indiceConteggi: index.counts } });
          const indexResult = await importIndex(db, index, revision, now);
          const scan = await scanDriveTree(driveClient, rootState.rootFolderId);
          await lease.assertOwned();
          const metadataResult = await persistDriveMetadata(db, scan, indexResult.documentByIndexId, now, scanId, rootState.rootFolderId, {
            adoptUnscoped: rootState.adoptUnscoped,
            assertLease: lease.assertOwned
          });
          const xmlResult = await importStructuredXml(db, driveClient, scan.files, now);
          await lease.assertOwned();
          const counts = { ...indexResult.counts, driveFiles: scan.files.length, driveFolders: scan.folders, driveErrors: scan.errors.length, ...xmlResult.counts };
          await db.collection('drive_import_runs').updateOne({ _id: inserted.insertedId }, { $set: { stato: scan.errors.length ? 'COMPLETATO_CON_AVVISI' : 'COMPLETATO', counts, erroriDrive: scan.errors.slice(0, 100), completatoIl: new Date() } });
          logger.info?.(`[drive-data] documenti=${counts.documents} file=${counts.driveFiles} F24=${counts.f24Canonical} quietanze=${counts.quietanze} righe=${counts.f24Rows} fatture=${counts.fatture} corrispettivi=${counts.corrispettivi}`);
          return { scanId, counts, indexResult: indexResult.writes, metadataResult, xmlResult };
        } catch (error) {
          await db.collection('drive_import_runs').updateOne({ _id: inserted.insertedId }, { $set: { stato: 'ERRORE', errore: { code: error.code || 'IMPORT_FAILED', message: error.message }, completatoIl: new Date() } });
          throw error;
        }
      } finally {
        await lease.release().catch((error) => logger.error?.(`[drive-data] rilascio lock fallito: ${error.message}`));
      }
    })().finally(() => { running = null; });
    return running;
  }
  async function status() { const db = getDb(); if (!db) throw new Error('MongoDB non configurato'); return db.collection('drive_import_runs').findOne({ rootFolderId }, { sort: { iniziatoIl: -1 } }); }
  async function summary() {
    const db = getDb(); if (!db) throw new Error('MongoDB non configurato');
    const [documents, driveFiles, driveFolders, f24, quietanze, rows, declarations, invoices, receipts, byDomain, lastRun] = await Promise.all([
      db.collection('documenti').countDocuments({ recordKind: { $ne: 'DRIVE_SOURCE' }, sourceActive: { $ne: false } }), db.collection('drive_files').countDocuments({ attivo: true, rootFolderId }), db.collection('drive_folders').countDocuments({ attivo: true, rootFolderId }), db.collection('f24_operazioni').countDocuments({}), db.collection('quietanze_f24').countDocuments({}), db.collection('f24_righe_indice').countDocuments({ attivo: true }), db.collection('dichiarazioni_fiscali').countDocuments({ attivo: true }), db.collection('fatture').countDocuments({}), db.collection('corrispettivi_rt').countDocuments({}), db.collection('drive_files').aggregate([{ $match: { attivo: true, rootFolderId } }, { $group: { _id: '$topFolder', count: { $sum: 1 } } }, { $sort: { count: -1 } }]).toArray(), status()
    ]);
    return { counts: { documents, driveFiles, driveFolders, f24, quietanze, f24Rows: rows, declarations, invoices, corrispettivi: receipts }, byDomain, lastRun };
  }
  return { run, status, summary, isRunning: () => Boolean(running) };
}
