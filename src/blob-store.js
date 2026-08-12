import { GridFSBucket } from 'mongodb';

export async function storeOriginalOnce(db, content, { sha256, filename, contentType, metadata = {} }) {
  if (!db || !sha256) throw new Error('Database e SHA-256 richiesti');
  const registry = db.collection('originali_registry');
  await registry.createIndex({ sha256: 1 }, { unique: true });

  const existing = await registry.findOne({ sha256 });
  if (existing) return existing;

  const bucket = new GridFSBucket(db, { bucketName: 'documenti_originali' });
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
  const upload = bucket.openUploadStream(filename || sha256, {
    contentType: contentType || 'application/octet-stream',
    metadata: { sha256, ...metadata }
  });

  await new Promise((resolve, reject) => {
    upload.once('error', reject);
    upload.once('finish', resolve);
    upload.end(buffer);
  });

  const record = {
    sha256,
    gridFsId: upload.id,
    filename: filename || sha256,
    contentType: contentType || 'application/octet-stream',
    size: buffer.length,
    creatoIl: new Date()
  };

  try {
    await registry.insertOne(record);
    return record;
  } catch (error) {
    if (error?.code !== 11000) throw error;
    try { await bucket.delete(upload.id); } catch {}
    return registry.findOne({ sha256 });
  }
}
