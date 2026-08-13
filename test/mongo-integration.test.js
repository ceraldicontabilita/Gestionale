import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { MongoClient } from 'mongodb';
import { strToU8, zipSync } from 'fflate';
import { normalizeMovement } from '../src/domain.js';
import { getOrCreateRiporto } from '../src/ledger.js';
import { withMongoTransaction } from '../src/mongo-transaction.js';
import { acquireJobLease, releaseJobLease } from '../src/jobs.js';
import { storeOriginalOnce } from '../src/blob-store.js';
import { importF24IndexRows } from '../src/f24-import-service.js';
import { importSourcePackageIndexes } from '../src/source-package-index.js';

const uri = process.env.TEST_MONGODB_URI;

test('integrazione MongoDB: transazioni, riporti, lock, originali e F24 idempotenti', {
  skip: !uri,
  timeout: 90_000
}, async (t) => {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10_000 });
  await client.connect();
  const databaseName = `impresa_test_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const db = client.db(databaseName);
  t.after(async () => {
    await db.dropDatabase().catch(() => {});
    await client.close();
  });

  await db.collection('riporti').insertOne({
    conto: 'CASSA', anno: 2023, saldo: 100, consolidato: true, creatoIl: new Date()
  });
  await db.collection('movimenti').insertMany([
    normalizeMovement({ data: '2023-06-01', conto: 'CASSA', direzione: 'ENTRATA', importo: 50, descrizione: '2023' }),
    normalizeMovement({ data: '2024-06-01', conto: 'CASSA', direzione: 'USCITA', importo: 20, descrizione: '2024' }),
    normalizeMovement({ data: '2025-06-01', conto: 'CASSA', direzione: 'ENTRATA', importo: 5, descrizione: '2025' })
  ]);
  const opening2026 = await getOrCreateRiporto(db, 'CASSA', 2026);
  assert.equal(opening2026.saldo, 135);
  assert.equal(opening2026.daRiallineare, false);

  await assert.rejects(
    withMongoTransaction(client, async (session) => {
      await db.collection('rollback_test').insertOne({ value: 1 }, { session });
      throw new Error('rollback-voluto');
    }),
    /rollback-voluto/
  );
  assert.equal(await db.collection('rollback_test').countDocuments(), 0);

  const [leaseA, leaseB] = await Promise.all([
    acquireJobLease(db, 'DRIVE_FISCALE_SCAN', { owner: 'runner-a', leaseMs: 60_000 }),
    acquireJobLease(db, 'DRIVE_FISCALE_SCAN', { owner: 'runner-b', leaseMs: 60_000 })
  ]);
  assert.equal(Number(Boolean(leaseA)) + Number(Boolean(leaseB)), 1);
  await releaseJobLease(db, leaseA || leaseB);

  const content = Buffer.from('originale fiscale sintetico');
  const firstOriginal = await storeOriginalOnce(db, content, { filename: 'esempio.txt', contentType: 'text/plain' });
  const secondOriginal = await storeOriginalOnce(db, content, { filename: 'duplicato.txt', contentType: 'text/plain' });
  assert.equal(String(firstOriginal.gridFsId), String(secondOriginal.gridFsId));
  assert.equal(await db.collection('originali_registry').countDocuments(), 1);
  assert.equal(await db.collection('documenti_originali.files').countDocuments(), 1);

  const indexRow = {
    anno_elenco: 2026,
    indice_portale: 7,
    data_versamento: '16/06/2026',
    numero_modelli_f24: 1,
    saldo_operazione: '100,00',
    protocollo_telematico: '26061612345678901/000001',
    numero_modello_nel_gruppo: 1,
    saldo_del_modello: '100,00',
    tipo_documento: 'Quietanza AE',
    file: '2026/quietanza-sintetica.pdf',
    sha256: 'a'.repeat(64),
    url_sorgente: 'https://example.invalid/f24'
  };
  const [firstImport] = await importF24IndexRows(db, [indexRow]);
  await db.collection('f24_operazioni').updateOne(
    { _id: firstImport.f24Id },
    { $set: { stato: 'RICONCILIATO', pagamento: { riferimento: 'movimento-sintetico' } } }
  );
  await importF24IndexRows(db, [indexRow]);
  const f24 = await db.collection('f24_operazioni').findOne({ _id: firstImport.f24Id });
  assert.equal(f24.stato, 'RICONCILIATO');
  assert.equal(f24.statoDocumentale, 'IN_ATTESA_RISCONTRO');
  assert.equal(await db.collection('f24_operazioni').countDocuments(), 1);

  const sourceIndex = [
    'tipo;anno_dichiarazione;anno_imposta;protocollo_o_id;file;sha256',
    `770;2026;2025;T260000000001;770/2026/modello.pdf;${'b'.repeat(64)}`
  ].join('\n');
  const packageBuffer = Buffer.from(zipSync({
    'ROOT/01_DICHIARAZIONI_FISCALI/INDICE.csv': strToU8(sourceIndex)
  }));
  const packageFile = {
    id: 'drive-package-synthetic',
    name: 'CERALDI_GROUP_FISCALE_CODEX_COMPLETO_2020_2026_V2.zip',
    extension: '.zip',
    version: '1',
    size: packageBuffer.length,
    path: 'ARCHIVIO/PACCHETTO.zip',
    webViewLink: 'https://drive.google.com/file/d/synthetic/view'
  };
  const driveClient = { downloadBuffer: async () => packageBuffer };
  const firstPackageImport = await importSourcePackageIndexes(db, driveClient, [packageFile]);
  const secondPackageImport = await importSourcePackageIndexes(db, driveClient, [packageFile]);
  assert.equal(firstPackageImport.counts.sourcePackageRecords, 1);
  assert.equal(secondPackageImport.results[0].skipped, true);
  assert.equal(await db.collection('source_package_records').countDocuments({ attivo: true }), 1);
  const sourceRecord = await db.collection('source_package_records').findOne({});
  assert.equal(sourceRecord.fields.anno_imposta, '2025');
  assert.equal(sourceRecord.drivePackageFileId, 'drive-package-synthetic');
  assert.equal(sourceRecord.packageSources.length, 1);
});
