import { strFromU8, unzipSync } from 'fflate';
import { XMLParser } from 'fast-xml-parser';
import { documentRole } from './document-index-metadata.js';

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const INDEX_FOLDER = 'INDICI GESTIONALE';
const INDEX_FILE = 'INDICE_DOCUMENTALE_DRIVE.xlsx';

function clean(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

function normalizedPath(value) {
  return clean(value).replaceAll('\\', '/').replace(/^\/+|\/+$/g, '');
}

function asArray(value) { return value === undefined ? [] : Array.isArray(value) ? value : [value]; }

function columnIndex(reference) {
  const letters = String(reference || '').match(/^[A-Z]+/i)?.[0]?.toUpperCase() || 'A';
  return [...letters].reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0) - 1;
}

function sharedText(node) {
  if (node === undefined || node === null) return '';
  if (typeof node !== 'object') return String(node);
  if (node.t !== undefined) return typeof node.t === 'object' ? clean(node.t['#text']) : clean(node.t);
  return asArray(node.r).map((run) => sharedText(run)).join('');
}

export function readXlsxSheets(buffer) {
  const archive = unzipSync(new Uint8Array(buffer));
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', parseTagValue: false, processEntities: false, removeNSPrefix: true });
  const xml = (name) => {
    if (!archive[name]) throw new Error(`Parte XLSX mancante: ${name}`);
    return parser.parse(strFromU8(archive[name]));
  };
  const strings = archive['xl/sharedStrings.xml'] ? asArray(xml('xl/sharedStrings.xml').sst?.si).map(sharedText) : [];
  const relationships = new Map(asArray(xml('xl/_rels/workbook.xml.rels').Relationships?.Relationship).map((rel) => [rel.Id, rel.Target]));
  const sheets = asArray(xml('xl/workbook.xml').workbook?.sheets?.sheet);
  return new Map(sheets.map((sheet) => {
    const target = relationships.get(sheet.id || sheet['r:id']);
    if (!target) throw new Error(`Relazione foglio XLSX mancante: ${sheet.name}`);
    const part = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
    const rows = asArray(xml(part).worksheet?.sheetData?.row).map((row) => {
      const values = [];
      for (const cell of asArray(row.c)) {
        let value = cell.v ?? '';
        if (cell.t === 's') value = strings[Number(value)] ?? '';
        else if (cell.t === 'inlineStr') value = sharedText(cell.is);
        else if (cell.t === 'b') value = String(value) === '1';
        else if (value !== '' && !Number.isNaN(Number(value))) value = Number(value);
        values[columnIndex(cell.r)] = value;
      }
      return values;
    });
    return [sheet.name, rows];
  }));
}

function rowsFromSheet(sheets, name) {
  const sheet = sheets.get(name);
  if (!sheet) throw new Error(`Foglio ${name} mancante nell'indice Drive`);
  const headers = (sheet[0] || []).map(clean);
  if (!headers.length || headers.some((header) => !header)) throw new Error(`Intestazioni non valide nel foglio ${name}`);
  const rows = [];
  for (const values of sheet.slice(1)) {
    if (values.every((value) => clean(value) === '')) continue;
    rows.push(Object.fromEntries(headers.map((header, index) => [header, values[index] ?? null])));
  }
  return rows;
}

function requireHeaders(rows, sheet, required) {
  const headers = new Set(Object.keys(rows[0] || {}));
  const missing = required.filter((header) => !headers.has(header));
  if (missing.length) throw new Error(`Colonne mancanti in ${sheet}: ${missing.join(', ')}`);
}

export async function parseDriveIndex(buffer) {
  const sheets = readXlsxSheets(buffer);
  const documents = rowsFromSheet(sheets, 'DOCUMENTI');
  const f24Rows = rowsFromSheet(sheets, 'F24_RIGHE');
  const declarations = rowsFromSheet(sheets, 'DICHIARAZIONI');
  const duplicates = rowsFromSheet(sheets, 'DUPLICATI_SCARTI');

  requireHeaders(documents, 'DOCUMENTI', ['ID documento', 'Nome file', 'SHA-256', 'Percorso Drive', 'Stato']);
  requireHeaders(f24Rows, 'F24_RIGHE', ['ID documento', 'Codice tributo', 'Debito', 'Credito', 'SHA-256', 'Percorso Drive']);
  requireHeaders(declarations, 'DICHIARAZIONI', ['Anno', 'Tipo', 'Percorso archivio']);
  requireHeaders(duplicates, 'DUPLICATI_SCARTI', ['SHA-256', 'Esito']);

  const byId = new Map();
  const bySha = new Map();
  const byPath = new Map();
  for (const document of documents) {
    const id = clean(document['ID documento']);
    const sha = clean(document['SHA-256']).toLowerCase();
    const path = normalizedPath(document['Percorso Drive']);
    if (!id || byId.has(id)) throw new Error(`ID documento mancante o duplicato: ${id || '(vuoto)'}`);
    if (!/^[a-f0-9]{64}$/.test(sha) || bySha.has(sha)) throw new Error(`SHA-256 mancante o duplicato per ${id}`);
    if (!path || byPath.has(path.toLowerCase())) throw new Error(`Percorso Drive mancante o duplicato per ${id}`);
    document.__id = id; document.__sha = sha; document.__path = path;
    byId.set(id, document); bySha.set(sha, document); byPath.set(path.toLowerCase(), document);
  }

  for (const row of f24Rows) {
    const document = byId.get(clean(row['ID documento']));
    if (!document) throw new Error(`Riga F24 riferita a documento inesistente: ${clean(row['ID documento'])}`);
    if (clean(row['SHA-256']).toLowerCase() !== document.__sha || normalizedPath(row['Percorso Drive']) !== document.__path) {
      throw new Error(`Riga F24 non coerente con ${document.__id}`);
    }
  }

  const declarationRows = declarations.map((row) => {
    const archivePath = normalizedPath(row['Percorso archivio']);
    const archiveName = archivePath.split('/').at(-1)?.toLowerCase();
    const suffixMatches = documents.filter((document) => document.__path.endsWith(archivePath));
    const matches = suffixMatches.length ? suffixMatches : documents.filter((document) => {
      return clean(document['Nome file']).toLowerCase() === archiveName;
    });
    if (matches.length !== 1) throw new Error(`Dichiarazione non collegabile in modo univoco: ${archivePath}`);
    return { ...row, __documentId: matches[0].__id };
  });

  return {
    documents,
    f24Rows,
    declarations: declarationRows,
    duplicates,
    byId,
    counts: { documents: documents.length, f24Rows: f24Rows.length, declarations: declarations.length, duplicates: duplicates.length }
  };
}

function exact(items, name, predicate = () => true) {
  const matches = items.filter((item) => item.name === name && predicate(item));
  if (matches.length !== 1) throw new Error(`${name}: atteso un solo elemento, trovati ${matches.length}`);
  return matches[0];
}

export function createDriveDocumentIndex({ drive, rootFolderId, maxIndexBytes = 10 * 1024 * 1024 }) {
  if (!drive || !rootFolderId) throw new Error('Google Drive o cartella radice indice non configurati');
  let cache = null;
  const resolvedPaths = new Map();

  async function locateIndex() {
    const root = await drive.listChildren(rootFolderId);
    const folder = exact(root, INDEX_FOLDER, (item) => item.mimeType === FOLDER_MIME);
    const files = await drive.listChildren(folder.id);
    const file = exact(files, INDEX_FILE, (item) => item.mimeType !== FOLDER_MIME);
    if (Number(file.size || 0) > maxIndexBytes) throw new Error('Indice Drive troppo grande');
    return file;
  }

  async function load({ force = false } = {}) {
    const file = await locateIndex();
    const revision = `${file.id}:${file.version || file.modifiedTime || ''}:${file.md5Checksum || ''}`;
    if (!force && cache?.revision === revision) return cache;
    const parsed = await parseDriveIndex(await drive.downloadBuffer(file.id));
    cache = { ...parsed, revision, indexFile: file, loadedAt: new Date().toISOString() };
    resolvedPaths.clear();
    return cache;
  }

  async function resolvePath(pathValue) {
    const path = normalizedPath(pathValue);
    if (resolvedPaths.has(path)) return resolvedPaths.get(path);
    let parentId = rootFolderId;
    const parts = path.split('/');
    for (let index = 0; index < parts.length; index += 1) {
      const children = await drive.listChildren(parentId);
      const isLast = index === parts.length - 1;
      const item = exact(children, parts[index], (candidate) => isLast || candidate.mimeType === FOLDER_MIME);
      parentId = item.id;
      if (isLast) {
        const resolved = { id: item.id, name: item.name, webViewLink: item.webViewLink || `https://drive.google.com/open?id=${item.id}`, path };
        resolvedPaths.set(path, resolved);
        return resolved;
      }
    }
    throw new Error(`Percorso Drive non risolto: ${path}`);
  }

  async function downloadDocument(documentId) {
    const index = await load();
    const row = index.byId.get(clean(documentId));
    if (!row) throw new Error('Documento non trovato nell indice Drive');
    const document = publicDocument(row);
    const resolved = await resolvePath(document.path);
    return { document, drive: resolved, buffer: await drive.downloadBuffer(resolved.id) };
  }

  return { load, resolvePath, downloadDocument };
}

export function publicDocument(row) {
  return {
    id: row.__id,
    domain: clean(row.Dominio),
    category: clean(row.Categoria),
    year: clean(row.Anno),
    name: clean(row['Nome file']),
    extension: clean(row.Estensione),
    bytes: Number(row['Dimensione byte'] || 0),
    sha256: row.__sha,
    path: row.__path,
    status: clean(row.Stato),
    number: clean(row['Numero documento']) || null,
    role: documentRole(row)
  };
}
