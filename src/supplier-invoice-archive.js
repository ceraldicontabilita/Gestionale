import crypto from 'node:crypto';
import { unzipSync } from 'fflate';

export const DEFAULT_SUPPLIER_ARCHIVE_LIMITS = Object.freeze({
  maxDepth: 4,
  maxEntries: 5_000,
  maxXmlFiles: 2_500,
  maxSingleFileBytes: 20 * 1024 * 1024,
  maxExpandedBytes: 250 * 1024 * 1024
});

function safeArchivePath(value) {
  const normalized = String(value || '').replaceAll('\\', '/').replace(/^\.\//, '');
  if (!normalized || normalized.includes('\0') || normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) {
    throw Object.assign(new Error('Percorso non valido nello ZIP'), { code: 'UNSAFE_ARCHIVE_PATH' });
  }
  const segments = normalized.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw Object.assign(new Error('Percorso relativo non sicuro nello ZIP'), { code: 'UNSAFE_ARCHIVE_PATH' });
  }
  return normalized;
}

function isZip(buffer) {
  return buffer.length >= 4
    && buffer[0] === 0x50
    && buffer[1] === 0x4b
    && ((buffer[2] === 0x03 && buffer[3] === 0x04)
      || (buffer[2] === 0x05 && buffer[3] === 0x06)
      || (buffer[2] === 0x07 && buffer[3] === 0x08));
}

function looksLikeXml(buffer) {
  const prefix = buffer.subarray(0, Math.min(buffer.length, 256)).toString('utf8').replace(/^\uFEFF/, '').trimStart();
  return prefix.startsWith('<');
}

function extension(name) {
  return String(name || '').toLowerCase().match(/\.[^.\/]+$/)?.[0] || '';
}

function enforceNumber(value, fallback, minimum, maximum) {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error('Limite archivio non valido');
  return parsed;
}

function normalizedLimits(options = {}) {
  return {
    maxDepth: enforceNumber(options.maxDepth, DEFAULT_SUPPLIER_ARCHIVE_LIMITS.maxDepth, 0, 10),
    maxEntries: enforceNumber(options.maxEntries, DEFAULT_SUPPLIER_ARCHIVE_LIMITS.maxEntries, 1, 50_000),
    maxXmlFiles: enforceNumber(options.maxXmlFiles, DEFAULT_SUPPLIER_ARCHIVE_LIMITS.maxXmlFiles, 1, 25_000),
    maxSingleFileBytes: enforceNumber(options.maxSingleFileBytes, DEFAULT_SUPPLIER_ARCHIVE_LIMITS.maxSingleFileBytes, 1, 100 * 1024 * 1024),
    maxExpandedBytes: enforceNumber(options.maxExpandedBytes, DEFAULT_SUPPLIER_ARCHIVE_LIMITS.maxExpandedBytes, 1, 1024 * 1024 * 1024)
  };
}

function limitError(message, code) {
  return Object.assign(new Error(message), { code });
}

export function collectSupplierInvoiceXmlEntries(content, filename = 'fatture.xml', options = {}) {
  const root = Buffer.isBuffer(content) ? content : Buffer.from(content || []);
  if (!root.length) throw new Error('File caricato vuoto');
  const limits = normalizedLimits(options);
  const state = { entryCount: 0, expandedBytes: 0, archiveCount: 0, skipped: 0, entries: [] };

  function registerExpandedEntry(name, originalSize) {
    state.entryCount += 1;
    if (state.entryCount > limits.maxEntries) throw limitError('ZIP con troppi elementi', 'ARCHIVE_ENTRY_LIMIT');
    const size = Number(originalSize || 0);
    if (!Number.isSafeInteger(size) || size < 0) throw limitError('Dimensione elemento ZIP non valida', 'ARCHIVE_SIZE_INVALID');
    state.expandedBytes += size;
    if (state.expandedBytes > limits.maxExpandedBytes) throw limitError('ZIP oltre il limite di espansione', 'ARCHIVE_EXPANDED_LIMIT');
    if (size > limits.maxSingleFileBytes && ['.xml', '.zip'].includes(extension(name))) {
      throw limitError('Elemento XML/ZIP oltre il limite consentito', 'ARCHIVE_FILE_LIMIT');
    }
  }

  function addXml(buffer, path) {
    if (buffer.length > limits.maxSingleFileBytes) throw limitError('XML oltre il limite consentito', 'ARCHIVE_FILE_LIMIT');
    if (state.entries.length >= limits.maxXmlFiles) throw limitError('ZIP con troppi file XML', 'ARCHIVE_XML_LIMIT');
    state.entries.push({
      path,
      filename: path.split('/').at(-1),
      buffer: Buffer.from(buffer),
      sha256: crypto.createHash('sha256').update(buffer).digest('hex')
    });
  }

  function walk(buffer, name, depth, prefix, rootAsset = false) {
    const path = rootAsset ? String(name || 'caricamento') : safeArchivePath(name);
    const kind = isZip(buffer) ? '.zip' : extension(path);
    if (kind === '.xml' || (rootAsset && looksLikeXml(buffer) && !isZip(buffer))) {
      addXml(buffer, prefix ? `${prefix}/${path}` : path);
      return;
    }
    if (kind !== '.zip') {
      state.skipped += 1;
      return;
    }
    if (depth > limits.maxDepth) throw limitError('ZIP annidato oltre la profondità consentita', 'ARCHIVE_DEPTH_LIMIT');
    state.archiveCount += 1;
    const currentPrefix = prefix ? `${prefix}/${path}!` : `${path}!`;
    let archive;
    try {
      archive = unzipSync(new Uint8Array(buffer), {
        filter(file) {
          if (String(file.name || '').endsWith('/')) return false;
          const safeName = safeArchivePath(file.name);
          registerExpandedEntry(safeName, file.originalSize);
          const childExtension = extension(safeName);
          const include = childExtension === '.xml' || childExtension === '.zip';
          if (!include) state.skipped += 1;
          return include;
        }
      });
    } catch (error) {
      if (error?.code) throw error;
      throw Object.assign(new Error(`ZIP non leggibile o non supportato: ${path}`), { code: 'ARCHIVE_INVALID', cause: error });
    }
    for (const [childName, childContent] of Object.entries(archive)) {
      walk(Buffer.from(childContent), childName, depth + 1, currentPrefix);
    }
  }

  walk(root, filename, 0, '', true);
  if (!state.entries.length) throw Object.assign(new Error('Nessuna fattura XML trovata nel caricamento'), { code: 'NO_INVOICE_XML' });
  return {
    entries: state.entries,
    summary: {
      xmlFiles: state.entries.length,
      archives: state.archiveCount,
      entriesInspected: state.entryCount,
      expandedBytes: state.expandedBytes,
      skipped: state.skipped
    }
  };
}
