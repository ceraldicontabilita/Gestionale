import crypto from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';
import { calculateF24Totals, normalizeF24Row } from './f24.js';
import { relationKey } from './domain.js';

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const INDEX_SOURCE = 'DRIVE_DOCUMENT_INDEX';

function clean(value) { return value === null || value === undefined ? '' : String(value).trim(); }
function asArray(value) { return value === undefined || value === null ? [] : Array.isArray(value) ? value : [value]; }
function money(value) { const result = Number(value || 0); return Number.isFinite(result) ? Math.round(result * 100) / 100 : 0; }
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
  const top = normalizedPath(pathValue).split('/')[0].toUpperCase();
  const types = {
    'CORRISPETTIVI': 'CORRISPETTIVO_XML',
    'FATTURE XML GESTIONALE': 'FATTURA_XML',
    'FATTURE ESTERO': 'FATTURA_ESTERO',
    'FATTURE PDF LEGACY': 'FATTURA_PDF_LEGACY',
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

async function ensureIndexes(db) {
  await Promise.all([
    db.collection('documenti').createIndex({ sha256: 1 }, { unique: true, sparse: true }),
    db.collection('documenti').createIndex({ primarySourceKey: 1 }, { unique: true, sparse: true }),
    db.collection('drive_files').createIndex({ driveFileId: 1 }, { unique: true }),
    db.collection('drive_files').createIndex({ topFolder: 1, extension: 1 }),
    db.collection('f24_operazioni').createIndex({ sourceKey: 1 }, { unique: true }),
    db.collection('quietanze_f24').createIndex({ sourceKey: 1 }, { unique: true }),
    db.collection('f24_righe_indice').createIndex({ sourceRowKey: 1 }, { unique: true }),
    db.collection('f24_righe').createIndex({ f24Id: 1, progressivo: 1 }, { unique: true }),
    db.collection('dichiarazioni_fiscali').createIndex({ sourceKey: 1 }, { unique: true }),
    db.collection('drive_import_scarti').createIndex({ sourceKey: 1 }, { unique: true }),
    db.collection('collegamenti').createIndex({ relationKey: 1 }, { unique: true }),
    db.collection('fatture').createIndex({ sourceKey: 1 }, { unique: true }),
    db.collection('corrispettivi_rt').createIndex({ sourceKey: 1 }, { unique: true }),
    db.collection('drive_import_runs').createIndex({ iniziatoIl: -1 })
  ]);
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

  const savedDocuments = await db.collection('documenti').find({ sha256: { $in: data.documents.map((row) => row.sha256) } }, { projection: { sha256: 1, 'datiEstratti.driveIndex.id': 1, 'datiEstratti.driveIndex.percorso': 1 } }).toArray();
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

async function scanDrive(driveClient, rootFolderId) {
  const stack = [{ id: rootFolderId, path: [] }]; const visited = new Set(); const files = []; const errors = [];
  while (stack.length) {
    const current = stack.pop(); if (visited.has(current.id)) continue; visited.add(current.id);
    try {
      const children = await driveClient.listChildren(current.id);
      for (const item of children) {
        if (item.mimeType === FOLDER_MIME) stack.push({ id: item.id, path: [...current.path, item.name] });
        else {
          const fullPath = [...current.path, item.name].join('/'); const topFolder = current.path[0] || '(radice)';
          files.push({ ...item, path: fullPath, topFolder, extension: item.name.includes('.') ? `.${item.name.split('.').at(-1).toLowerCase()}` : '', year: yearFromPath(fullPath), parentId: current.id });
        }
      }
    } catch (error) { errors.push({ folderId: current.id, path: current.path.join('/'), code: error.code || 'DRIVE_LIST_FAILED', message: error.message }); }
  }
  return { files, folders: visited.size, errors };
}

async function importDriveMetadata(db, scan, documentByIndexId, now, scanId) {
  const indexedPathMap = new Map([...documentByIndexId.values()].map((row) => [normalizedPath(row.datiEstratti?.driveIndex?.percorso).toLowerCase(), row]));
  const driveResult = await runBulk(db.collection('drive_files'), scan.files.map((file) => ({ updateOne: { filter: { driveFileId: file.id }, update: { $set: { driveFileId: file.id, nome: file.name, mimeType: file.mimeType, dimensione: Number(file.size || 0), md5Checksum: file.md5Checksum || null, sha256Checksum: file.sha256Checksum || null, versioneFonte: file.version || file.modifiedTime || null, percorso: normalizedPath(file.path), topFolder: file.topFolder, extension: file.extension, anno: file.year, parentId: file.parentId, webViewLink: file.webViewLink || null, modificatoIlFonte: file.modifiedTime ? new Date(file.modifiedTime) : null, tipoProposto: proposedDocumentType(file.path), scanId, attivo: true, aggiornatoIl: now }, $setOnInsert: { creatoIl: now } }, upsert: true } })));

  const documentOperations = scan.files.map((file) => {
    const indexed = indexedPathMap.get(normalizedPath(file.path).toLowerCase());
    const filter = indexed ? { _id: indexed._id } : { primarySourceKey: `DRIVE_FILE:${file.id}` };
    const set = { nomeOriginale: file.name, 'datiEstratti.drive': { fileId: file.id, percorso: normalizedPath(file.path), topFolder: file.topFolder, mimeType: file.mimeType, dimensione: Number(file.size || 0), modificatoIl: file.modifiedTime || null }, aggiornatoIl: now };
    if (!indexed) set.primarySourceKey = `DRIVE_FILE:${file.id}`;
    return { updateOne: { filter, update: { $set: set, $setOnInsert: { tipo: proposedDocumentType(file.path), stato: 'DA_VERIFICARE', creatoIl: now }, $addToSet: { fonti: { sourceKey: `DRIVE_FILE:${file.id}`, tipo: 'GOOGLE_DRIVE', riferimento: file.webViewLink || normalizedPath(file.path) } } }, upsert: true } };
  });
  const documentResult = await runBulk(db.collection('documenti'), documentOperations);
  if (!scan.errors.length) await db.collection('drive_files').updateMany({ scanId: { $ne: scanId }, attivo: true }, { $set: { attivo: false, aggiornatoIl: now } });
  return { driveResult, documentResult };
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

export function createDriveDataImportService({ getDb, getIndex, driveClient, rootFolderId, logger = console }) {
  let running = null;
  async function run({ force = false } = {}) {
    if (running) return running;
    running = (async () => {
      const db = getDb(); if (!db) throw new Error('MongoDB non configurato');
      await ensureIndexes(db);
      const now = new Date(); const scanId = crypto.randomUUID();
      const runRecord = { scanId, stato: 'IN_CORSO', iniziatoIl: now, force };
      const inserted = await db.collection('drive_import_runs').insertOne(runRecord);
      try {
        const index = await getIndex({ force }); const revision = index.revision;
        await db.collection('drive_import_runs').updateOne({ _id: inserted.insertedId }, { $set: { indexRevision: revision, indiceConteggi: index.counts } });
        const indexResult = await importIndex(db, index, revision, now);
        const scan = await scanDrive(driveClient, rootFolderId);
        const metadataResult = await importDriveMetadata(db, scan, indexResult.documentByIndexId, now, scanId);
        const xmlResult = await importStructuredXml(db, driveClient, scan.files, now);
        const counts = { ...indexResult.counts, driveFiles: scan.files.length, driveFolders: scan.folders, driveErrors: scan.errors.length, ...xmlResult.counts };
        await db.collection('drive_import_runs').updateOne({ _id: inserted.insertedId }, { $set: { stato: scan.errors.length ? 'COMPLETATO_CON_AVVISI' : 'COMPLETATO', counts, erroriDrive: scan.errors.slice(0, 100), completatoIl: new Date() } });
        logger.info?.(`[drive-data] documenti=${counts.documents} file=${counts.driveFiles} F24=${counts.f24Canonical} quietanze=${counts.quietanze} righe=${counts.f24Rows} fatture=${counts.fatture} corrispettivi=${counts.corrispettivi}`);
        return { scanId, counts, indexResult: indexResult.writes, metadataResult, xmlResult };
      } catch (error) {
        await db.collection('drive_import_runs').updateOne({ _id: inserted.insertedId }, { $set: { stato: 'ERRORE', errore: { code: error.code || 'IMPORT_FAILED', message: error.message }, completatoIl: new Date() } });
        throw error;
      }
    })().finally(() => { running = null; });
    return running;
  }
  async function status() { const db = getDb(); if (!db) throw new Error('MongoDB non configurato'); return db.collection('drive_import_runs').findOne({}, { sort: { iniziatoIl: -1 } }); }
  async function summary() {
    const db = getDb(); if (!db) throw new Error('MongoDB non configurato');
    const [documents, driveFiles, f24, quietanze, rows, declarations, invoices, receipts, byDomain, lastRun] = await Promise.all([
      db.collection('documenti').countDocuments({}), db.collection('drive_files').countDocuments({ attivo: true }), db.collection('f24_operazioni').countDocuments({}), db.collection('quietanze_f24').countDocuments({}), db.collection('f24_righe_indice').countDocuments({ attivo: true }), db.collection('dichiarazioni_fiscali').countDocuments({ attivo: true }), db.collection('fatture').countDocuments({}), db.collection('corrispettivi_rt').countDocuments({}), db.collection('drive_files').aggregate([{ $match: { attivo: true } }, { $group: { _id: '$topFolder', count: { $sum: 1 } } }, { $sort: { count: -1 } }]).toArray(), status()
    ]);
    return { counts: { documents, driveFiles, f24, quietanze, f24Rows: rows, declarations, invoices, corrispettivi: receipts }, byDomain, lastRun };
  }
  return { run, status, summary, isRunning: () => Boolean(running) };
}
