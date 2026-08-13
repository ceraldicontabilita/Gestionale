import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..');

export const historicalConnectionsDirectory = path.join(
  repositoryRoot,
  'docs/anatomia-gestionale/inventari/connessioni-storiche'
);
export const historicalConnectionsManifestPath = path.join(
  historicalConnectionsDirectory,
  'manifest.json'
);

export const HISTORICAL_CONNECTIONS_SHARD_LAYOUT = Object.freeze({
  nodes: 4,
  edges: 8,
  gaps: 2
});

const MANIFEST_KIND = 'historical_connections_manifest';
const MANIFEST_SCHEMA_VERSION = '1.0.0';
const DATASET_KIND = 'historical_connections';
const GENERATED_BY = 'scripts/historical-connections-shards.js';
const PARTITION_ALGORITHM = 'SHA256_UINT32_BE_MODULO';
const RECORD_ORDER = 'BYTEWISE_ASCENDING_ID';
const SHARD_FORMAT = 'JSONL_COMPACT_JSON_ONE_RECORD_PER_LINE_PRESERVE_FIELD_ORDER';
const DATASETS = Object.keys(HISTORICAL_CONNECTIONS_SHARD_LAYOUT);

function fail(message) {
  throw new Error(`Connessioni storiche: ${message}`);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(String(left), 'utf8'), Buffer.from(String(right), 'utf8'));
}

function canonicalJson(value) {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('il JSON canonico non ammette numeri non finiti.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isPlainObject(value)) {
    const fields = Object.keys(value).sort(compareUtf8).map((key) => {
      if (value[key] === undefined) fail(`il JSON canonico non ammette undefined nel campo ${key}.`);
      return `${JSON.stringify(key)}:${canonicalJson(value[key])}`;
    });
    return `{${fields.join(',')}}`;
  }
  fail(`valore non serializzabile nel JSON canonico (${typeof value}).`);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function logicalDocument(document) {
  return {
    ...document,
    nodes: [...document.nodes].sort((left, right) => compareUtf8(left.id, right.id)),
    edges: [...document.edges].sort((left, right) => compareUtf8(left.id, right.id)),
    gaps: [...document.gaps].sort((left, right) => compareUtf8(left.id, right.id))
  };
}

function logicalDigest(document) {
  return sha256(canonicalJson(logicalDocument(document)));
}

function bucketForId(id, modulus) {
  if (typeof id !== 'string' || !id) fail('ogni record deve avere un id stringa non vuoto.');
  return crypto.createHash('sha256').update(id, 'utf8').digest().readUInt32BE(0) % modulus;
}

function shardFileName(dataset, bucket, modulus) {
  const width = Math.max(2, String(modulus - 1).length);
  return `${dataset}-${String(bucket).padStart(width, '0')}.jsonl`;
}

function encodeShard(records) {
  if (!records.length) return '';
  return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
}

function objectCounts(records, field) {
  const counts = {};
  for (const record of records) {
    const value = record[field];
    if (typeof value !== 'string' || !value) fail(`campo ${field} mancante nel record ${record.id}.`);
    counts[value] = (counts[value] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => compareUtf8(left, right)));
}

function assertEqual(actual, expected, label) {
  if (canonicalJson(actual) !== canonicalJson(expected)) fail(`${label} non coincide con il manifest.`);
}

function assertDocumentShape(document) {
  if (!isPlainObject(document)) fail('il documento deve essere un oggetto JSON.');
  if (document.kind !== DATASET_KIND) fail(`kind documento inatteso: ${String(document.kind)}.`);
  if (typeof document.schemaVersion !== 'string' || !document.schemaVersion) fail('schemaVersion documento mancante.');
  for (const dataset of DATASETS) {
    if (!Array.isArray(document[dataset])) fail(`${dataset} deve essere un array.`);
  }
  if (!isPlainObject(document.summary)) fail('summary documento mancante.');
  if (document.sourceSnapshot?.runtimeDependency !== false) {
    fail('sourceSnapshot deve dichiarare runtimeDependency=false.');
  }
}

function assertUniqueIds(document) {
  const globalIds = new Map();
  for (const dataset of DATASETS) {
    for (const record of document[dataset]) {
      if (!isPlainObject(record) || typeof record.id !== 'string' || !record.id) {
        fail(`record non valido in ${dataset}: id mancante.`);
      }
      if (globalIds.has(record.id)) {
        fail(`ID duplicato ${record.id} in ${dataset} e ${globalIds.get(record.id)}.`);
      }
      globalIds.set(record.id, dataset);
    }
  }
}

function assertReferences(document) {
  const nodeIds = new Set(document.nodes.map((node) => node.id));
  for (const edge of document.edges) {
    if (!nodeIds.has(edge.from)) fail(`arco ${edge.id}: nodo from sconosciuto ${String(edge.from)}.`);
    if (!nodeIds.has(edge.to)) fail(`arco ${edge.id}: nodo to sconosciuto ${String(edge.to)}.`);
  }
  for (const gap of document.gaps) {
    if (!nodeIds.has(gap.nodeId)) fail(`gap ${gap.id}: nodo sconosciuto ${String(gap.nodeId)}.`);
  }
}

function assertSummary(document) {
  const { nodes, edges, gaps, summary } = document;
  if (summary.nodeCount !== nodes.length) fail(`summary.nodeCount=${summary.nodeCount}, record=${nodes.length}.`);
  if (summary.edgeCount !== edges.length) fail(`summary.edgeCount=${summary.edgeCount}, record=${edges.length}.`);
  if (summary.gapCount !== gaps.length) fail(`summary.gapCount=${summary.gapCount}, record=${gaps.length}.`);

  const inventoryNodes = nodes.filter((node) => node.inventory !== null);
  const canonicalNodes = nodes.filter((node) => node.nodeType === 'CANONICAL_DESTINATION');
  const inventoryReferences = new Set(inventoryNodes.map((node) => `${node.inventory}:${node.recordId}`));
  if (inventoryReferences.size !== inventoryNodes.length) fail('riferimento inventory+recordId duplicato nei nodi.');

  const mappingCounts = new Map();
  for (const edge of edges) {
    if (edge.type === 'MAPS_TO_CANONICAL') {
      mappingCounts.set(edge.from, (mappingCounts.get(edge.from) || 0) + 1);
    }
  }
  const mappedInventoryRecords = inventoryNodes.filter((node) => mappingCounts.get(node.id) === 1).length;
  const computed = {
    inventoryRecordCount: inventoryReferences.size,
    inventoryRecordsMappedToCanonical: mappedInventoryRecords,
    nodeCount: nodes.length,
    inventoryNodeCount: inventoryNodes.length,
    codeNodeCount: nodes.length - inventoryNodes.length - canonicalNodes.length,
    canonicalDestinationNodeCount: canonicalNodes.length,
    edgeCount: edges.length,
    gapCount: gaps.length,
    nodesByType: objectCounts(nodes, 'nodeType'),
    edgesByType: objectCounts(edges, 'type'),
    edgesByConfidence: objectCounts(edges, 'confidence'),
    gapsByReason: objectCounts(gaps, 'reason')
  };
  assertEqual(summary, computed, 'summary');
}

function assertDocument(document) {
  assertDocumentShape(document);
  assertUniqueIds(document);
  assertReferences(document);
  assertSummary(document);
}

function safeManifestPath(manifestPath) {
  const resolved = path.resolve(manifestPath || historicalConnectionsManifestPath);
  const stat = fs.lstatSync(resolved, { throwIfNoEntry: false });
  if (!stat || !stat.isFile() || stat.isSymbolicLink()) fail(`manifest non leggibile o non regolare: ${resolved}.`);
  if (path.basename(resolved) !== 'manifest.json') fail('il manifest deve chiamarsi manifest.json.');
  return resolved;
}

function safeShardPath(directory, relativePath) {
  if (typeof relativePath !== 'string' || path.basename(relativePath) !== relativePath) {
    fail(`path shard non sicuro: ${String(relativePath)}.`);
  }
  const resolved = path.resolve(directory, relativePath);
  if (path.dirname(resolved) !== directory) fail(`path shard fuori directory: ${relativePath}.`);
  const stat = fs.lstatSync(resolved, { throwIfNoEntry: false });
  if (!stat || !stat.isFile() || stat.isSymbolicLink()) fail(`shard mancante o non regolare: ${relativePath}.`);
  return resolved;
}

function parseShard(buffer, descriptor) {
  const raw = buffer.toString('utf8');
  if (!raw) return [];
  if (!raw.endsWith('\n')) fail(`shard ${descriptor.path}: newline finale mancante.`);
  const lines = raw.slice(0, -1).split('\n');
  if (lines.some((line) => !line)) fail(`shard ${descriptor.path}: linea vuota non ammessa.`);
  return lines.map((line, index) => {
    let record;
    try {
      record = JSON.parse(line);
    } catch (error) {
      fail(`shard ${descriptor.path}, linea ${index + 1}: JSON non valido (${error.message}).`);
    }
    if (!isPlainObject(record) || typeof record.id !== 'string' || !record.id) {
      fail(`shard ${descriptor.path}, linea ${index + 1}: record/id non valido.`);
    }
    if (line !== JSON.stringify(record)) {
      fail(`shard ${descriptor.path}, linea ${index + 1}: JSON non compatto o ordine campi instabile.`);
    }
    return record;
  });
}

function readManifest(manifestPath) {
  const resolved = safeManifestPath(manifestPath);
  const manifestSource = fs.readFileSync(resolved, 'utf8');
  let manifest;
  try {
    manifest = JSON.parse(manifestSource);
  } catch (error) {
    fail(`manifest JSON non valido (${error.message}).`);
  }
  if (!isPlainObject(manifest)) fail('manifest non strutturato.');
  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION || manifest.kind !== MANIFEST_KIND) {
    fail(`manifest kind/schema non supportati (${String(manifest.kind)} ${String(manifest.schemaVersion)}).`);
  }
  if (manifest.generatedBy !== GENERATED_BY) fail(`generatedBy inatteso: ${String(manifest.generatedBy)}.`);
  if (
    manifest.partition?.algorithm !== PARTITION_ALGORITHM ||
    manifest.partition?.recordOrder !== RECORD_ORDER ||
    manifest.partition?.format !== SHARD_FORMAT ||
    manifest.partition?.idEncoding !== 'UTF-8'
  ) {
    fail('contratto di partizione del manifest non valido.');
  }
  if (!isPlainObject(manifest.document)) fail('header document mancante nel manifest.');
  if (DATASETS.some((dataset) => Object.hasOwn(manifest.document, dataset))) {
    fail('il manifest non può incorporare gli array partizionati nel proprio header.');
  }
  if (!Array.isArray(manifest.shards)) fail('elenco shards mancante nel manifest.');
  if (!/^[a-f0-9]{64}$/.test(manifest.logicalSha256 || '')) fail('logicalSha256 non valido.');
  if (
    manifest.originalArtifact?.fileName !== 'connessioni-storiche.json' ||
    !Number.isInteger(manifest.originalArtifact?.bytes) || manifest.originalArtifact.bytes <= 0 ||
    !/^[a-f0-9]{64}$/.test(manifest.originalArtifact?.sha256 || '')
  ) {
    fail('metadati originalArtifact non validi.');
  }
  if (manifestSource.replaceAll('\r\n', '\n') !== `${JSON.stringify(manifest, null, 2)}\n`) {
    fail('manifest non serializzato nel formato deterministico atteso.');
  }
  return { manifest, resolved };
}

export function verifyHistoricalConnections({ manifestPath = historicalConnectionsManifestPath } = {}) {
  const { manifest, resolved } = readManifest(manifestPath);
  const directory = path.dirname(resolved);
  const expectedShardCount = Object.values(HISTORICAL_CONNECTIONS_SHARD_LAYOUT)
    .reduce((total, value) => total + value, 0);
  if (manifest.shards.length !== expectedShardCount) {
    fail(`attesi ${expectedShardCount} shard, trovati ${manifest.shards.length}.`);
  }

  const descriptors = new Map();
  const expectedFileNames = new Set(['manifest.json']);
  for (const dataset of DATASETS) {
    const modulus = HISTORICAL_CONNECTIONS_SHARD_LAYOUT[dataset];
    for (let bucket = 0; bucket < modulus; bucket += 1) {
      descriptors.set(`${dataset}:${bucket}`, null);
      expectedFileNames.add(shardFileName(dataset, bucket, modulus));
    }
  }

  for (const descriptor of manifest.shards) {
    if (!isPlainObject(descriptor) || !DATASETS.includes(descriptor.dataset)) {
      fail('descrittore shard con dataset non valido.');
    }
    const modulus = HISTORICAL_CONNECTIONS_SHARD_LAYOUT[descriptor.dataset];
    const key = `${descriptor.dataset}:${descriptor.bucket}`;
    const expectedPath = shardFileName(descriptor.dataset, descriptor.bucket, modulus);
    if (
      !Number.isInteger(descriptor.bucket) || descriptor.bucket < 0 || descriptor.bucket >= modulus ||
      descriptor.modulus !== modulus || descriptor.path !== expectedPath ||
      !Number.isInteger(descriptor.recordCount) || descriptor.recordCount < 0 ||
      !Number.isInteger(descriptor.bytes) || descriptor.bytes < 0 ||
      !/^[a-f0-9]{64}$/.test(descriptor.sha256 || '')
    ) {
      fail(`descrittore shard non valido: ${String(descriptor.path)}.`);
    }
    if (!descriptors.has(key) || descriptors.get(key)) fail(`descrittore shard duplicato o inatteso: ${key}.`);
    descriptors.set(key, descriptor);
  }
  for (const [key, descriptor] of descriptors) {
    if (!descriptor) fail(`descrittore shard mancante: ${key}.`);
  }
  const expectedDescriptorOrder = [];
  for (const dataset of DATASETS) {
    const modulus = HISTORICAL_CONNECTIONS_SHARD_LAYOUT[dataset];
    for (let bucket = 0; bucket < modulus; bucket += 1) expectedDescriptorOrder.push(`${dataset}:${bucket}`);
  }
  assertEqual(
    manifest.shards.map((descriptor) => `${descriptor.dataset}:${descriptor.bucket}`),
    expectedDescriptorOrder,
    'ordine descrittori shard'
  );

  const actualFileNames = new Set(fs.readdirSync(directory));
  assertEqual([...actualFileNames].sort(compareUtf8), [...expectedFileNames].sort(compareUtf8), 'file della directory shard');

  const records = Object.fromEntries(DATASETS.map((dataset) => [dataset, []]));
  for (const dataset of DATASETS) {
    const modulus = HISTORICAL_CONNECTIONS_SHARD_LAYOUT[dataset];
    for (let bucket = 0; bucket < modulus; bucket += 1) {
      const descriptor = descriptors.get(`${dataset}:${bucket}`);
      const shardPath = safeShardPath(directory, descriptor.path);
      const buffer = fs.readFileSync(shardPath);
      const normalizedBuffer = Buffer.from(buffer.toString('utf8').replaceAll('\r\n', '\n'), 'utf8');
      if (normalizedBuffer.length !== descriptor.bytes) {
        fail(`shard ${descriptor.path}: bytes attesi ${descriptor.bytes}, trovati ${normalizedBuffer.length}.`);
      }
      const digest = sha256(normalizedBuffer);
      if (digest !== descriptor.sha256) {
        fail(`shard ${descriptor.path}: hash SHA-256 atteso ${descriptor.sha256}, trovato ${digest}.`);
      }
      const shardRecords = parseShard(normalizedBuffer, descriptor);
      if (shardRecords.length !== descriptor.recordCount) {
        fail(`shard ${descriptor.path}: record attesi ${descriptor.recordCount}, trovati ${shardRecords.length}.`);
      }
      for (let index = 0; index < shardRecords.length; index += 1) {
        const record = shardRecords[index];
        if (bucketForId(record.id, modulus) !== bucket) {
          fail(`shard ${descriptor.path}: record ${record.id} nel bucket errato.`);
        }
        if (index > 0 && compareUtf8(shardRecords[index - 1].id, record.id) >= 0) {
          fail(`shard ${descriptor.path}: ordine ID non strettamente crescente presso ${record.id}.`);
        }
      }
      records[dataset].push(...shardRecords);
    }
  }

  const document = logicalDocument({ ...manifest.document, ...records });
  assertDocument(document);
  const digest = logicalDigest(document);
  if (digest !== manifest.logicalSha256) {
    fail(`digest logico atteso ${manifest.logicalSha256}, trovato ${digest}.`);
  }
  const assembled = `${JSON.stringify(document, null, 2)}\n`;
  const assembledBytes = Buffer.byteLength(assembled);
  const assembledSha256 = sha256(assembled);
  if (
    assembledBytes !== manifest.originalArtifact.bytes ||
    assembledSha256 !== manifest.originalArtifact.sha256
  ) {
    fail(
      `round-trip originale non valido: attesi ${manifest.originalArtifact.bytes} byte/${manifest.originalArtifact.sha256}, ` +
      `trovati ${assembledBytes} byte/${assembledSha256}.`
    );
  }
  return {
    document,
    manifest,
    summary: {
      manifestPath: resolved,
      shardCount: manifest.shards.length,
      nodeCount: document.nodes.length,
      edgeCount: document.edges.length,
      gapCount: document.gaps.length,
      logicalSha256: digest,
      originalArtifactSha256: assembledSha256
    }
  };
}

export function loadHistoricalConnections(options = {}) {
  return verifyHistoricalConnections(options).document;
}

function assertSpecializedOutputDirectory(outputDirectory) {
  const resolved = path.resolve(outputDirectory);
  if (path.basename(resolved) !== 'connessioni-storiche') {
    fail('la directory di output deve chiamarsi connessioni-storiche.');
  }
  const parent = path.dirname(resolved);
  const parentStat = fs.lstatSync(parent, { throwIfNoEntry: false });
  if (!parentStat || !parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    fail(`directory padre non valida: ${parent}.`);
  }
  return resolved;
}

function assertReplaceableShardDirectory(directory) {
  const stat = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (!stat) return;
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`output esistente non sostituibile: ${directory}.`);
  const allowed = /^(manifest\.json|(nodes|edges|gaps)-\d{2}\.jsonl)$/;
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  if (entries.some((entry) => !entry.isFile() || !allowed.test(entry.name))) {
    fail(`output ${directory} contiene file non appartenenti all'inventario; sostituzione rifiutata.`);
  }
  if (entries.length) {
    const manifestEntry = entries.find((entry) => entry.name === 'manifest.json');
    if (!manifestEntry) fail(`output ${directory} non contiene un manifest riconoscibile; sostituzione rifiutata.`);
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
    } catch {
      fail(`output ${directory} contiene un manifest illeggibile; sostituzione rifiutata.`);
    }
    if (manifest.kind !== MANIFEST_KIND || manifest.generatedBy !== GENERATED_BY) {
      fail(`output ${directory} non è un inventario generato da questo script; sostituzione rifiutata.`);
    }
  }
}

function writeFileDurably(filePath, content) {
  const descriptor = fs.openSync(filePath, 'wx', 0o644);
  try {
    fs.writeFileSync(descriptor, content);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function promoteDirectory(temporaryDirectory, outputDirectory, replace) {
  const existing = fs.lstatSync(outputDirectory, { throwIfNoEntry: false });
  if (existing && !replace) fail(`output già esistente: ${outputDirectory}; usare --replace esplicitamente.`);
  let backup = null;
  if (existing) {
    assertReplaceableShardDirectory(outputDirectory);
    backup = `${outputDirectory}.backup-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
    fs.renameSync(outputDirectory, backup);
  }
  try {
    fs.renameSync(temporaryDirectory, outputDirectory);
    verifyHistoricalConnections({ manifestPath: path.join(outputDirectory, 'manifest.json') });
    if (backup) fs.rmSync(backup, { recursive: true, force: false });
  } catch (error) {
    if (fs.existsSync(outputDirectory)) fs.rmSync(outputDirectory, { recursive: true, force: false });
    if (backup && fs.existsSync(backup)) fs.renameSync(backup, outputDirectory);
    throw error;
  }
}

function buildManifest(document, inputBuffer) {
  const normalized = logicalDocument(document);
  const header = Object.fromEntries(
    Object.entries(normalized).filter(([key]) => !DATASETS.includes(key))
  );
  const shards = [];
  const contents = new Map();
  for (const dataset of DATASETS) {
    const modulus = HISTORICAL_CONNECTIONS_SHARD_LAYOUT[dataset];
    const buckets = Array.from({ length: modulus }, () => []);
    for (const record of normalized[dataset]) buckets[bucketForId(record.id, modulus)].push(record);
    for (let bucket = 0; bucket < modulus; bucket += 1) {
      buckets[bucket].sort((left, right) => compareUtf8(left.id, right.id));
      const relativePath = shardFileName(dataset, bucket, modulus);
      const content = encodeShard(buckets[bucket]);
      contents.set(relativePath, content);
      shards.push({
        dataset,
        path: relativePath,
        bucket,
        modulus,
        recordCount: buckets[bucket].length,
        bytes: Buffer.byteLength(content),
        sha256: sha256(content)
      });
    }
  }
  return {
    manifest: {
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      kind: MANIFEST_KIND,
      generatedBy: GENERATED_BY,
      partition: {
        algorithm: PARTITION_ALGORITHM,
        idEncoding: 'UTF-8',
        recordOrder: RECORD_ORDER,
        format: SHARD_FORMAT
      },
      originalArtifact: {
        fileName: 'connessioni-storiche.json',
        bytes: inputBuffer.length,
        sha256: sha256(inputBuffer)
      },
      logicalSha256: logicalDigest(normalized),
      document: header,
      shards
    },
    contents
  };
}

function readSourceDocument(inputPath) {
  const resolved = path.resolve(inputPath);
  if (path.basename(resolved) !== 'connessioni-storiche.json') {
    fail('il file sorgente deve chiamarsi connessioni-storiche.json.');
  }
  const stat = fs.lstatSync(resolved, { throwIfNoEntry: false });
  if (!stat || !stat.isFile() || stat.isSymbolicLink()) fail(`sorgente non regolare: ${resolved}.`);
  const buffer = fs.readFileSync(resolved);
  let document;
  try {
    document = JSON.parse(buffer.toString('utf8'));
  } catch (error) {
    fail(`sorgente JSON non valido (${error.message}).`);
  }
  document = logicalDocument(document);
  assertDocument(document);
  return { buffer, document, resolved };
}

export function splitHistoricalConnections({
  inputPath,
  outputDirectory = historicalConnectionsDirectory,
  replace = false
} = {}) {
  if (!inputPath) fail('split richiede inputPath esplicito.');
  const source = readSourceDocument(inputPath);
  const output = assertSpecializedOutputDirectory(outputDirectory);
  if (source.resolved.startsWith(`${output}${path.sep}`)) fail('il sorgente non può trovarsi nella directory shard.');
  const existing = fs.lstatSync(output, { throwIfNoEntry: false });
  if (existing && !replace) fail(`output già esistente: ${output}; usare --replace esplicitamente.`);
  if (existing) assertReplaceableShardDirectory(output);

  const { manifest, contents } = buildManifest(source.document, source.buffer);
  const parent = path.dirname(output);
  const temporary = fs.mkdtempSync(path.join(parent, '.connessioni-storiche.tmp-'));
  try {
    for (const descriptor of manifest.shards) {
      writeFileDurably(path.join(temporary, descriptor.path), contents.get(descriptor.path));
    }
    writeFileDurably(path.join(temporary, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    const checked = verifyHistoricalConnections({ manifestPath: path.join(temporary, 'manifest.json') });
    const assembled = `${JSON.stringify(checked.document, null, 2)}\n`;
    const assembledHash = sha256(assembled);
    if (assembledHash !== manifest.originalArtifact.sha256 || Buffer.byteLength(assembled) !== manifest.originalArtifact.bytes) {
      fail('round-trip non identico al monolite sorgente; split rifiutato.');
    }
    promoteDirectory(temporary, output, replace);
    if (replace) fs.unlinkSync(source.resolved);
    return verifyHistoricalConnections({ manifestPath: path.join(output, 'manifest.json') });
  } catch (error) {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { recursive: true, force: false });
    throw error;
  }
}

function atomicWriteAssembled(outputPath, content, replace) {
  const resolved = path.resolve(outputPath);
  if (path.basename(resolved) !== 'connessioni-storiche.json') {
    fail('il file assemblato deve chiamarsi connessioni-storiche.json.');
  }
  const parent = path.dirname(resolved);
  const parentStat = fs.lstatSync(parent, { throwIfNoEntry: false });
  if (!parentStat || !parentStat.isDirectory() || parentStat.isSymbolicLink()) fail(`directory output non valida: ${parent}.`);
  const existing = fs.lstatSync(resolved, { throwIfNoEntry: false });
  if (existing && (!replace || !existing.isFile() || existing.isSymbolicLink())) {
    fail(`output già esistente o non sostituibile: ${resolved}; usare --replace su un file regolare.`);
  }
  if (existing) {
    let existingDocument;
    try {
      existingDocument = JSON.parse(fs.readFileSync(resolved, 'utf8'));
    } catch {
      fail(`output esistente ${resolved} non è un inventario JSON riconoscibile; sostituzione rifiutata.`);
    }
    if (existingDocument.kind !== DATASET_KIND) {
      fail(`output esistente ${resolved} non è un inventario di connessioni storiche; sostituzione rifiutata.`);
    }
  }
  const temporary = path.join(parent, `.connessioni-storiche.json.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
  let backup = null;
  try {
    writeFileDurably(temporary, content);
    if (existing) {
      backup = `${resolved}.backup-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
      fs.renameSync(resolved, backup);
    }
    fs.renameSync(temporary, resolved);
    if (backup) fs.unlinkSync(backup);
  } catch (error) {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    if (backup && fs.existsSync(backup)) {
      if (fs.existsSync(resolved)) fs.unlinkSync(resolved);
      fs.renameSync(backup, resolved);
    }
    throw error;
  }
  return resolved;
}

export function assembleHistoricalConnections({
  manifestPath = historicalConnectionsManifestPath,
  outputPath = null,
  replace = false
} = {}) {
  const checked = verifyHistoricalConnections({ manifestPath });
  const content = `${JSON.stringify(checked.document, null, 2)}\n`;
  const digest = sha256(content);
  const bytes = Buffer.byteLength(content);
  if (
    digest !== checked.manifest.originalArtifact?.sha256 ||
    bytes !== checked.manifest.originalArtifact?.bytes
  ) {
    fail('assemble non riproduce esattamente hash e dimensione del monolite originale.');
  }
  const resolvedOutput = outputPath ? atomicWriteAssembled(outputPath, content, replace) : null;
  return { ...checked, outputPath: resolvedOutput, assembledSha256: digest, assembledBytes: bytes };
}

function parseCli(argv) {
  const args = [...argv];
  const command = args[0] && !args[0].startsWith('-') ? args.shift() : 'verify';
  const options = { replace: false, positional: [] };
  while (args.length) {
    const argument = args.shift();
    if (argument === '--replace') options.replace = true;
    else if (['--manifest', '--input', '--output', '--output-dir'].includes(argument)) {
      if (!args.length) fail(`${argument} richiede un valore.`);
      options[argument.slice(2).replace('-dir', 'Directory')] = args.shift();
    } else if (argument.startsWith('-')) fail(`opzione sconosciuta ${argument}.`);
    else options.positional.push(argument);
  }
  return { command, options };
}

function runCli(argv) {
  const { command, options } = parseCli(argv);
  let result;
  if (command === 'verify') {
    const manifestPath = options.manifest || options.positional[0] || historicalConnectionsManifestPath;
    if (options.positional.length > 1) fail('verify accetta al massimo un manifest posizionale.');
    result = verifyHistoricalConnections({ manifestPath });
  } else if (command === 'assemble') {
    let manifestPath = options.manifest || historicalConnectionsManifestPath;
    let outputPath = options.output || null;
    if (options.positional.length === 1 && !outputPath) outputPath = options.positional[0];
    else if (options.positional.length === 2 && !options.manifest && !outputPath) {
      [manifestPath, outputPath] = options.positional;
    } else if (options.positional.length) fail('argomenti assemble ambigui; usare --manifest e --output.');
    if (!outputPath) fail('assemble richiede --output per evitare dump accidentali su stdout.');
    result = assembleHistoricalConnections({ manifestPath, outputPath, replace: options.replace });
  } else if (command === 'split') {
    if (options.positional.length) fail('split richiede opzioni esplicite, non argomenti posizionali.');
    result = splitHistoricalConnections({
      inputPath: options.input,
      outputDirectory: options.outputDirectory || historicalConnectionsDirectory,
      replace: options.replace
    });
  } else {
    fail(`comando sconosciuto ${command}; usare verify, assemble o split.`);
  }
  console.log(JSON.stringify({ ok: true, ...result.summary, outputPath: result.outputPath || undefined }, null, 2));
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
