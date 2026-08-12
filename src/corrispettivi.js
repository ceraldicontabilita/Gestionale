import { parseMoney, roundMoney } from './money.js';

export const POS_GESTORI = Object.freeze(['NUMIA', 'SUMUP']);

function owns(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

export function validateIsoDay(value) {
  const raw = String(value || '').slice(0, 10);
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new Error('Data giornata non valida');
  const date = new Date(`${raw}T00:00:00.000Z`);
  if (
    Number(match[1]) !== date.getUTCFullYear() ||
    Number(match[2]) !== date.getUTCMonth() + 1 ||
    Number(match[3]) !== date.getUTCDate()
  ) throw new Error('Data giornata non valida');
  return raw;
}

function optionalNonNegative(value, label) {
  if (value === null || value === undefined || value === '') return null;
  return parseMoney(value, { label });
}

export function normalizeCorrispettivoDay(input = {}, existing = null) {
  const dataGiorno = validateIsoDay(input.data || input.dataGiorno || existing?.dataGiorno);

  const totaleXml = owns(input, 'totaleXml')
    ? optionalNonNegative(input.totaleXml, 'Totale XML')
    : existing?.totaleXml;
  if (totaleXml === null || totaleXml === undefined) throw new Error('Totale XML obbligatorio');

  let chiusuraOperativa = existing?.chiusuraOperativa ?? null;
  if (owns(input, 'chiusuraOperativa')) {
    chiusuraOperativa = optionalNonNegative(input.chiusuraOperativa, 'Chiusura operativa');
  }

  const pos = { ...(existing?.pos || {}) };
  const touched = [];
  const removed = [];
  for (const gestore of POS_GESTORI) {
    if (!owns(input.pos, gestore)) continue;
    touched.push(gestore);
    const raw = input.pos[gestore];
    if (raw === null || raw === undefined || raw === '') {
      delete pos[gestore];
      removed.push(gestore);
    } else {
      pos[gestore] = parseMoney(raw, { label: `POS ${gestore}` });
    }
  }

  const totalePos = roundMoney(Object.values(pos).reduce((sum, value) => sum + Number(value || 0), 0));
  const posCompleti = POS_GESTORI.every((gestore) => owns(pos, gestore));
  const contanteAtteso = chiusuraOperativa === null || !posCompleti
    ? null
    : roundMoney(chiusuraOperativa - totalePos);
  const differenzaFiscale = chiusuraOperativa === null
    ? null
    : roundMoney(chiusuraOperativa - totaleXml);

  const anomalie = [];
  if (differenzaFiscale !== null && differenzaFiscale !== 0) {
    anomalie.push({ tipo: 'DIFFERENZA_XML_CHIUSURA', importo: differenzaFiscale });
  }
  if (contanteAtteso !== null && contanteAtteso < 0) {
    anomalie.push({ tipo: 'POS_SUPERIORE_ALLA_CHIUSURA', importo: Math.abs(contanteAtteso) });
  }

  return {
    dataGiorno,
    totaleXml,
    chiusuraOperativa,
    pos,
    touched,
    removed,
    totalePos,
    posCompleti,
    contanteAtteso,
    controlloFiscale: chiusuraOperativa === null
      ? { stato: 'DATI_INCOMPLETI' }
      : { stato: differenzaFiscale === 0 ? 'ALLINEATO' : 'DIFFERENZA', differenza: differenzaFiscale },
    anomalie,
    nota: posCompleti ? null : 'Contante non determinato: manca almeno una chiusura POS reale'
  };
}
