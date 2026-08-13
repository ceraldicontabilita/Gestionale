import crypto from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';
import { stableFingerprint } from './fingerprint.js';

const xmlParser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, parseTagValue: true, trimValues: true });
const readyDatabases = new WeakSet();

function clean(value) { return value === null || value === undefined ? '' : String(value).trim(); }
function asArray(value) { return value === undefined || value === null ? [] : Array.isArray(value) ? value : [value]; }
function money(value) { const result = Number(value || 0); return Number.isFinite(result) ? Math.round(result * 100) / 100 : 0; }
function sourceDate(value) {
  const raw = clean(value);
  const match = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  const result = match ? new Date(`${match[3]}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}T12:00:00.000Z`) : new Date(raw);
  return Number.isNaN(result.getTime()) ? null : result;
}

function sourceKeyBase(file) {
  if (file.sourceKeyBase) return clean(file.sourceKeyBase);
  return `DRIVE_FILE:${clean(file.id)}`;
}

export function parseInvoiceXml(buffer, file = {}) {
  const content = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '');
  const parsed = xmlParser.parse(content.toString('utf8'))?.FatturaElettronica;
  if (!parsed?.FatturaElettronicaHeader) throw Object.assign(new Error('XML fattura non riconosciuto'), { code: 'SUPPLIER_INVOICE_REVIEW_REQUIRED' });
  const header = parsed.FatturaElettronicaHeader;
  const supplier = header.CedentePrestatore?.DatiAnagrafici || {};
  const vat = clean(supplier.IdFiscaleIVA?.IdCodice) || clean(supplier.CodiceFiscale);
  const name = clean(supplier.Anagrafica?.Denominazione) || [supplier.Anagrafica?.Nome, supplier.Anagrafica?.Cognome].filter(Boolean).join(' ');
  return asArray(parsed.FatturaElettronicaBody).map((body, index) => {
    const general = body.DatiGenerali?.DatiGeneraliDocumento || {};
    const summaries = asArray(body.DatiBeniServizi?.DatiRiepilogo);
    const details = asArray(body.DatiBeniServizi?.DettaglioLinee);
    const imponibile = money(summaries.reduce((sum, row) => sum + Number(row.ImponibileImporto || 0), 0));
    const iva = money(summaries.reduce((sum, row) => sum + Number(row.Imposta || 0), 0));
    const payments = asArray(body.DatiPagamento).flatMap((section) => asArray(section.DettaglioPagamento));
    const total = money(general.ImportoTotaleDocumento || imponibile + iva);
    const structuralChecks = {
      supplierIdentity: Boolean(vat),
      documentIdentity: Boolean(clean(general.TipoDocumento) && clean(general.Numero) && sourceDate(general.Data)),
      vatSummaries: summaries.length > 0,
      invoiceLines: details.length > 0,
      positiveTotal: total > 0,
      euroCurrency: (clean(general.Divisa) || 'EUR').toUpperCase() === 'EUR'
    };
    return {
      sourceKey: `${sourceKeyBase(file)}:${index + 1}`,
      driveFileId: file.id || null,
      percorsoDrive: file.path || null,
      extractionVersion: 'FATTURAPA_XML_V2',
      fornitore: {
        partitaIva: vat || null,
        codiceFiscale: clean(supplier.CodiceFiscale) || null,
        denominazione: name || null
      },
      tipoDocumento: clean(general.TipoDocumento),
      numero: clean(general.Numero),
      data: sourceDate(general.Data),
      divisa: clean(general.Divisa) || 'EUR',
      imponibile,
      ivaEsposta: iva,
      ivaDetraibile: null,
      totaleDocumento: total,
      ritenuta: money(asArray(general.DatiRitenuta).reduce((sum, row) => sum + Number(row.ImportoRitenuta || 0), 0)),
      righe: details.map((row, rowIndex) => ({
        numero: Number(row.NumeroLinea || rowIndex + 1),
        descrizione: clean(row.Descrizione) || null,
        quantita: Number(row.Quantita || 0) || null,
        prezzoUnitario: money(row.PrezzoUnitario),
        prezzoTotale: money(row.PrezzoTotale),
        aliquotaIva: Number(row.AliquotaIVA || 0),
        natura: clean(row.Natura) || null,
        codiciArticolo: asArray(row.CodiceArticolo).map((code) => ({ tipo: clean(code.CodiceTipo), valore: clean(code.CodiceValore) })).filter((code) => code.tipo || code.valore)
      })),
      riepiloghiIva: summaries.map((row) => ({
        aliquotaIva: Number(row.AliquotaIVA || 0),
        natura: clean(row.Natura) || null,
        imponibile: money(row.ImponibileImporto),
        imposta: money(row.Imposta),
        esigibilitaIva: clean(row.EsigibilitaIVA) || null
      })),
      pagamenti: payments.map((row) => ({
        modalita: clean(row.ModalitaPagamento),
        scadenza: row.DataScadenzaPagamento ? sourceDate(row.DataScadenzaPagamento) : null,
        importo: money(row.ImportoPagamento),
        iban: clean(row.IBAN) || null
      })),
      quadraturaEstrazione: { status: Object.values(structuralChecks).every(Boolean) ? 'EXACT' : 'REVIEW', checks: structuralChecks },
      stato: 'IMPORTATA_DA_VERIFICARE'
    };
  });
}

async function ensureIndexes(db) {
  if (readyDatabases.has(db)) return;
  await Promise.all([
    db.collection('fatture').createIndex({ sourceKey: 1 }, { unique: true }),
    db.collection('fatture').createIndex({ documentSha256: 1, bodyIndex: 1 }),
    db.collection('fatture').createIndex({ 'fornitore.partitaIva': 1, numero: 1, data: 1 })
  ]);
  readyDatabases.add(db);
}

export async function stageSupplierInvoiceXml(db, {
  buffer,
  source,
  now = new Date()
}) {
  if (!db) throw new Error('Database richiesto');
  const content = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '');
  if (!content.length) throw new Error('XML fattura vuoto');
  await ensureIndexes(db);
  const sha256 = crypto.createHash('sha256').update(content).digest('hex');
  if (source?.sha256 && clean(source.sha256).toLowerCase() !== sha256) throw new Error('SHA256_MISMATCH');
  const sourceType = clean(source?.sourceType || 'UPLOAD').toUpperCase();
  const externalId = clean(source?.externalId || sha256);
  const sourceVersion = clean(source?.version || '1');
  const base = source?.sourceKeyBase || (sourceType === 'GOOGLE_DRIVE' ? `DRIVE_FILE:${externalId}` : `${sourceType}:${externalId}:${sourceVersion}`);
  const invoices = parseInvoiceXml(content, {
    id: source?.driveFileId || (sourceType === 'GOOGLE_DRIVE' ? externalId : null),
    path: source?.path || source?.filename || null,
    sourceKeyBase: base
  });
  let inserted = 0;
  let duplicates = 0;
  const records = [];
  for (let index = 0; index < invoices.length; index += 1) {
    const invoice = invoices[index];
    const record = {
      ...invoice,
      bodyIndex: index + 1,
      documentSha256: sha256,
      sourceType,
      sourceExternalId: externalId,
      sourceVersion,
      sourceAsset: {
        sourceType,
        externalId,
        version: sourceVersion,
        filename: clean(source?.filename) || null,
        path: clean(source?.path) || null,
        gridFsId: source?.gridFsId || null,
        emailMessageKey: source?.emailMessageKey || null,
        driveFileId: source?.driveFileId || null
      }
    };
    record.extractionFingerprint = stableFingerprint({
      sourceKey: record.sourceKey,
      documentSha256: record.documentSha256,
      extractionVersion: record.extractionVersion,
      fornitore: record.fornitore,
      tipoDocumento: record.tipoDocumento,
      numero: record.numero,
      data: record.data,
      divisa: record.divisa,
      imponibile: record.imponibile,
      ivaEsposta: record.ivaEsposta,
      totaleDocumento: record.totaleDocumento,
      ritenuta: record.ritenuta,
      righe: record.righe,
      riepiloghiIva: record.riepiloghiIva,
      pagamenti: record.pagamenti,
      quadraturaEstrazione: record.quadraturaEstrazione
    });
    const existing = await db.collection('fatture').findOne({ sourceKey: record.sourceKey });
    if (existing) {
      if (existing.extractionFingerprint && existing.extractionFingerprint !== record.extractionFingerprint) throw new Error('SUPPLIER_INVOICE_STAGING_CONFLICT');
      await db.collection('fatture').updateOne({ _id: existing._id }, { $set: { sourceAsset: record.sourceAsset, aggiornatoIl: now } });
      records.push({ ...existing, sourceAsset: record.sourceAsset, aggiornatoIl: now });
      duplicates += 1;
      continue;
    }
    await db.collection('fatture').insertOne({ ...record, creatoIl: now, aggiornatoIl: now });
    records.push(record);
    inserted += 1;
  }
  return { sha256, invoices: records, counts: { total: records.length, inserted, duplicates } };
}
