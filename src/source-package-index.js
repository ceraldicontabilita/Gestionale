import crypto from 'node:crypto';
import { strFromU8, unzipSync } from 'fflate';
import { parseDelimitedText } from './csv.js';

const PACKAGE_TYPES = Object.freeze([
  { kind: 'FISCALE_CODEX', pattern: /CERALDI_GROUP_FISCALE_CODEX_COMPLETO_2020_2026/i },
  { kind: 'ESTRAZIONE_5_MITTENTI', pattern: /ESTRAZIONE_5_MITTENTI/i },
  { kind: 'PARTENOPAY', pattern: /PARTENOPAY_COMPLETO_ETICHETTE/i }
]);
const MAX_INDEX_ENTRY_BYTES = 25 * 1024 * 1024;
const MAX_INDEX_TOTAL_BYTES = 50 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 250;

function clean(value) { return value === null || value === undefined ? '' : String(value).trim(); }
function normalizedPath(value) { return clean(value).replaceAll('\\', '/').replace(/^\/+/, ''); }
function recordHash(value) { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

export function sourcePackageKind(filename) {
  return PACKAGE_TYPES.find((entry) => entry.pattern.test(clean(filename)))?.kind || null;
}

function recordType(kind, entryName) {
  const path = normalizedPath(entryName).toUpperCase();
  if (kind === 'FISCALE_CODEX' && path.endsWith('/01_DICHIARAZIONI_FISCALI/INDICE.CSV')) return 'DICHIARAZIONE_FISCALE';
  if (kind === 'FISCALE_CODEX' && path.endsWith('/02_F24_QUIETANZE/INDICE_UNICO_DOCUMENTI_F24.CSV')) return 'F24_DOCUMENTO';
  if (kind === 'ESTRAZIONE_5_MITTENTI' && path.endsWith('/04_INDICI/INDICE_ALLEGATI.CSV')) return 'ALLEGATO_EMAIL';
  if (kind === 'ESTRAZIONE_5_MITTENTI' && path.endsWith('/04_INDICI/INDICE_EMAIL.CSV')) return 'EMAIL';
  if (kind === 'PARTENOPAY' && path.endsWith('/INDICE_ALLEGATI.CSV')) return 'ALLEGATO_EMAIL';
  if (kind === 'PARTENOPAY' && path.endsWith('/INDICE_EMAIL.CSV')) return 'EMAIL';
  return null;
}

function normalizedRecord(kind, type, row) {
  const date = clean(row.data_email || row.data_versamento);
  const fileName = clean(row.nome_allegato || row.file);
  const category = clean(row.mittente_gruppo || row.tipo || (kind === 'PARTENOPAY' ? 'partenopay' : type));
  const year = Number(clean(row.anno_dichiarazione || row.anno_elenco || date).match(/20\d{2}/)?.[0]) || null;
  const declarationType = clean(row.tipo).toUpperCase();
  const declaration = type === 'DICHIARAZIONE_FISCALE' ? {
    model: declarationType === '770' ? 'MODELLO 770'
      : declarationType === '760' ? 'MODELLO 760'
        : declarationType === 'IVA' ? 'DICHIARAZIONE IVA'
          : declarationType.replaceAll('_', ' ') || 'ALTRA DICHIARAZIONE',
    category: declarationType === '770' || declarationType.includes('PERCIPIENT') ? "SOSTITUTI D'IMPOSTA"
      : declarationType === 'IRAP' ? 'IRAP'
        : ['IVA', 'LIPE'].includes(declarationType) ? 'IVA'
          : declarationType.includes('REDDITI') || declarationType === '760' ? 'REDDITI'
            : 'ALTRE DICHIARAZIONI',
    year: clean(row.anno_dichiarazione),
    taxYear: clean(row.anno_imposta),
    protocol: clean(row.protocollo_o_id) || null
  } : null;
  return {
    category,
    year,
    date: date || null,
    fileName: fileName || null,
    relativePath: clean(row.file) || null,
    sha256: clean(row.sha256).toLowerCase() || null,
    sourceUrl: clean(row.gmail_url || row.url_sorgente) || null,
    subject: clean(row.oggetto) || null,
    sender: clean(row.mittente_gruppo || row.mittente) || null,
    status: clean(row.stato_estrazione || row.stato) || null,
    declaration
  };
}

export function extractSourcePackageIndex(content, filename) {
  const kind = sourcePackageKind(filename);
  if (!kind) return { kind: null, records: [], entries: [] };
  let acceptedBytes = 0;
  const archive = unzipSync(new Uint8Array(content), {
    filter(file) {
      if (!recordType(kind, file.name)) return false;
      const originalSize = Number(file.originalSize || 0);
      const compressedSize = Number(file.size || 0);
      if (!Number.isSafeInteger(originalSize) || originalSize < 0 || originalSize > MAX_INDEX_ENTRY_BYTES) {
        throw new Error('Indice ZIP oltre il limite di decompressione');
      }
      if (compressedSize > 0 && originalSize / compressedSize > MAX_COMPRESSION_RATIO) {
        throw new Error('Indice ZIP con rapporto di compressione anomalo');
      }
      acceptedBytes += originalSize;
      if (acceptedBytes > MAX_INDEX_TOTAL_BYTES) throw new Error('Indici ZIP oltre il limite totale di decompressione');
      return true;
    }
  });
  const records = [];
  const entries = [];
  for (const [entryName, bytes] of Object.entries(archive)) {
    const type = recordType(kind, entryName);
    if (!type) continue;
    const rows = parseDelimitedText(strFromU8(bytes), { delimiter: ';' });
    entries.push({ entryName: normalizedPath(entryName), recordType: type, rows: rows.length });
    rows.forEach((fields, index) => {
      const normalized = normalizedRecord(kind, type, fields);
      records.push({
        sourceRecordKey: `${kind}:${type}:${recordHash({ fields, entryName: normalizedPath(entryName) })}`,
        packageKind: kind,
        recordType: type,
        sourceEntry: normalizedPath(entryName),
        sourceRow: index + 2,
        fields,
        ...normalized
      });
    });
  }
  return { kind, records, entries };
}

async function bulkUpsert(collection, operations, size = 500) {
  let upserted = 0; let matched = 0;
  for (let index = 0; index < operations.length; index += size) {
    const result = await collection.bulkWrite(operations.slice(index, index + size), { ordered: false });
    upserted += result.upsertedCount || 0;
    matched += result.matchedCount || 0;
  }
  return { upserted, matched };
}

export async function importSourcePackageIndexes(db, driveClient, files, now = new Date()) {
  const targets = files.filter((file) => sourcePackageKind(file.name) && String(file.extension || '').toLowerCase() === '.zip');
  const results = [];
  const errors = [];
  let recordCount = 0;
  for (const file of targets) {
    const version = clean(file.version || file.modifiedTime || file.md5Checksum || file.size || '1');
    const importKey = `${file.id}:${version}`;
    const existing = await db.collection('source_package_imports').findOne({ importKey, stato: 'COMPLETATO' });
    if (existing) {
      recordCount += Number(existing.records || 0);
      results.push({ importKey, packageKind: existing.packageKind, records: existing.records, skipped: true });
      continue;
    }
    try {
      if (Number(file.size || 0) > 200 * 1024 * 1024) throw new Error('Pacchetto oltre il limite di 200 MB');
      const buffer = await driveClient.downloadBuffer(file.id);
      const extracted = extractSourcePackageIndex(buffer, file.name);
      const packageSource = {
        drivePackageFileId: file.id,
        drivePackageName: file.name,
        drivePackagePath: file.path,
        drivePackageWebViewLink: file.webViewLink || null,
        packageVersion: version
      };
      const operations = extracted.records.map((record) => ({ updateOne: {
        filter: { sourceRecordKey: record.sourceRecordKey },
        update: {
          $set: {
            ...record,
            ...packageSource,
            attivo: true,
            aggiornatoIl: now
          },
          $addToSet: { packageSources: packageSource },
          $setOnInsert: { creatoIl: now }
        },
        upsert: true
      } }));
      const writes = await bulkUpsert(db.collection('source_package_records'), operations);
      await db.collection('source_package_imports').updateOne(
        { importKey },
        { $set: { importKey, driveFileId: file.id, packageKind: extracted.kind, packageVersion: version, entries: extracted.entries, records: extracted.records.length, stato: 'COMPLETATO', aggiornatoIl: now }, $setOnInsert: { creatoIl: now } },
        { upsert: true }
      );
      await db.collection('source_package_records').updateMany(
        { drivePackageFileId: file.id, packageVersion: { $ne: version }, attivo: true },
        { $set: { attivo: false, aggiornatoIl: now } }
      );
      recordCount += extracted.records.length;
      results.push({ importKey, packageKind: extracted.kind, records: extracted.records.length, writes, skipped: false });
    } catch (error) {
      errors.push({ driveFileId: file.id, name: file.name, message: String(error?.message || error).slice(0, 500) });
      await db.collection('source_package_imports').updateOne(
        { importKey },
        { $set: { importKey, driveFileId: file.id, packageVersion: version, stato: 'ERRORE', errore: String(error?.message || error).slice(0, 500), aggiornatoIl: now }, $setOnInsert: { creatoIl: now } },
        { upsert: true }
      );
    }
  }
  return { counts: { packages: targets.length, sourcePackageRecords: recordCount, sourcePackageErrors: errors.length }, results, errors };
}
