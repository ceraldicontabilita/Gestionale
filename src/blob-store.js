import crypto from 'node:crypto';
import { GridFSBucket } from 'mongodb';

const readyDatabases = new WeakSet();

async function ensureIndex(db) {
  if (readyDatabases.has(db)) return;
  await db.collection('originali_registry').createIndex({ sha256: 1 }, { unique: true });
  readyDatabases.add(db);
}

export async function storeOriginalOnce(db, content, { sha256 = null, filename, contentType, metadata = {} } = {}) {
  if (!db) throw new Error('Database richiesto');
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content || []);
  if (!buffer.length) throw new Error('Originale vuoto');
  const computed = crypto.createHash('sha256').update(buffer).digest('hex');
  if (sha256 && String(sha256).toLowerCase() !== computed) {
    throw Object.assign(new Error('SHA-256 dichiarato non coincide con il contenuto'), { code: 'SHA256_MISMATCH' });
  }
  await ensureIndex(db);
  const registry = db.collection('originali_registry');
  const existing = await registry.findOne({ sha256: computed });
  if (existing) return existing;

  const bucket = new GridFSBucket(db, { bucketName: 'documenti_originali' });
  const safeFilename = String(filename || computed).slice(0, 500);
  const safeContentType = String(contentType || 'application/octet-stream').slice(0, 200);
  const upload = bucket.openUploadStream(safeFilename, {
    contentType: safeContentType,
    metadata: { ...metadata, sha256: computed }
  });

  await new Promise((resolve, reject) => {
    upload.once('error', reject);
    upload.once('finish', resolve);
    upload.end(buffer);
  });

  const record = {
    sha256: computed,
    gridFsId: upload.id,
    filename: safeFilename,
    contentType: safeContentType,
    size: buffer.length,
    creatoIl: new Date()
  };

  try {
    await registry.insertOne(record);
    return record;
  } catch (error) {
    try { await bucket.delete(upload.id); } catch {}
    if (error?.code === 11000) return registry.findOne({ sha256: computed });
    throw error;
  }
}
