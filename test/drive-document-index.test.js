import assert from 'node:assert/strict';
import test from 'node:test';
import { strToU8, zipSync } from 'fflate';
import { createDriveDocumentIndex, parseDriveIndex } from '../src/drive-document-index.js';

const escapeXml = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const column = (index) => String.fromCharCode(65 + index);
function sheetXml(rows) {
  return `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.map((row, rowIndex) => `<row r="${rowIndex + 1}">${row.map((value, index) => typeof value === 'number' ? `<c r="${column(index)}${rowIndex + 1}"><v>${value}</v></c>` : `<c r="${column(index)}${rowIndex + 1}" t="inlineStr"><is><t>${escapeXml(value)}</t></is></c>`).join('')}</row>`).join('')}</sheetData></worksheet>`;
}
function workbookBuffer() {
  const sheets = [
    ['DOCUMENTI', [['ID documento', 'Nome file', 'SHA-256', 'Percorso Drive', 'Stato'], ['DOC-1', 'modello.pdf', 'a'.repeat(64), 'F24\\2026\\modello.pdf', 'VERIFICATO']]],
    ['F24_RIGHE', [['ID documento', 'Codice tributo', 'Debito', 'Credito', 'SHA-256', 'Percorso Drive'], ['DOC-1', '1001', 100, 0, 'a'.repeat(64), 'F24\\2026\\modello.pdf']]],
    ['DICHIARAZIONI', [['Anno', 'Tipo', 'Percorso archivio'], ['2026', 'DICHIARAZIONE', 'F24/2026/modello.pdf']]],
    ['DUPLICATI_SCARTI', [['SHA-256', 'Esito'], ['b'.repeat(64), 'DUPLICATO_INTERNO_SCARTATO']]]
  ];
  const workbook = `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map(([name], index) => `<sheet name="${name}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('')}</sheets></workbook>`;
  const relationships = `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, index) => `<Relationship Id="rId${index + 1}" Target="worksheets/sheet${index + 1}.xml" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"/>`).join('')}</Relationships>`;
  return Buffer.from(zipSync(Object.fromEntries([
    ['xl/workbook.xml', workbook], ['xl/_rels/workbook.xml.rels', relationships],
    ...sheets.map(([, rows], index) => [`xl/worksheets/sheet${index + 1}.xml`, sheetXml(rows)])
  ].map(([name, value]) => [name, strToU8(value)]))));
}

test('valida relazioni e identita dell indice senza importare originali', async () => {
  const result = await parseDriveIndex(await workbookBuffer());
  assert.deepEqual(result.counts, { documents: 1, f24Rows: 1, declarations: 1, duplicates: 1 });
  assert.equal(result.declarations[0].__documentId, 'DOC-1');
});

test('risolve un percorso solo tramite genitori esatti', async () => {
  const buffer = await workbookBuffer();
  const children = new Map([
    ['root', [{ id: 'idx', name: 'INDICI GESTIONALE', mimeType: 'application/vnd.google-apps.folder' }, { id: 'f24', name: 'F24', mimeType: 'application/vnd.google-apps.folder' }]],
    ['idx', [{ id: 'xlsx', name: 'INDICE_DOCUMENTALE_DRIVE.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size: String(buffer.length), version: '1' }]],
    ['f24', [{ id: 'year', name: '2026', mimeType: 'application/vnd.google-apps.folder' }]],
    ['year', [{ id: 'pdf', name: 'modello.pdf', mimeType: 'application/pdf', webViewLink: 'https://drive.google.com/file/d/pdf/view' }]]
  ]);
  const service = createDriveDocumentIndex({ drive: { listChildren: async (id) => children.get(id) || [], downloadBuffer: async () => buffer }, rootFolderId: 'root' });
  const loaded = await service.load();
  assert.equal(loaded.counts.documents, 1);
  assert.equal((await service.resolvePath('F24\\2026\\modello.pdf')).id, 'pdf');
});
