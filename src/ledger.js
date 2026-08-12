import { parseMoney, roundMoney } from './money.js';

export function validateYear(value) {
  const year = Number(value);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new Error('Anno non valido');
  return year;
}

export function startOfYear(year) {
  return new Date(`${validateYear(year)}-01-01T00:00:00.000Z`);
}

export function startOfNextYear(year) {
  return startOfYear(validateYear(year) + 1);
}

export async function sumMovements(db, conto, { from = null, to = null, session = null } = {}) {
  const match = { conto };
  if (from || to) {
    match.data = {};
    if (from) match.data.$gte = from;
    if (to) match.data.$lt = to;
  }

  const rows = await db.collection('movimenti').aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        total: {
          $sum: {
            $switch: {
              branches: [
                { case: { $eq: ['$direzione', 'ENTRATA'] }, then: '$importo' },
                { case: { $eq: ['$direzione', 'USCITA'] }, then: { $multiply: ['$importo', -1] } }
              ],
              default: 0
            }
          }
        }
      }
    }
  ], session ? { session } : {}).toArray();

  return roundMoney(rows[0]?.total || 0);
}

export async function deriveOpeningBalance(db, conto, year, { session = null } = {}) {
  const anno = validateYear(year);
  const previous = await db.collection('riporti').findOne(
    { conto, anno: { $lt: anno } },
    { sort: { anno: -1 }, ...(session ? { session } : {}) }
  );
  const base = parseMoney(previous?.saldo ?? 0, { allowNegative: true, label: 'Saldo riporto' }) ?? 0;
  const from = previous ? startOfYear(previous.anno) : null;
  const delta = await sumMovements(db, conto, { from, to: startOfYear(anno), session });
  return roundMoney(base + delta);
}

export async function calculateClosingBalance(db, conto, year, { session = null } = {}) {
  const anno = validateYear(year);
  const saved = await db.collection('riporti').findOne(
    { conto, anno },
    session ? { session } : {}
  );
  const opening = saved
    ? parseMoney(saved.saldo, { allowNegative: true, label: 'Saldo riporto' })
    : await deriveOpeningBalance(db, conto, anno, { session });
  const delta = await sumMovements(db, conto, {
    from: startOfYear(anno),
    to: startOfNextYear(anno),
    session
  });
  return roundMoney(opening + delta);
}

export async function getOrCreateRiporto(db, conto, year, { session = null, now = new Date() } = {}) {
  const anno = validateYear(year);
  const expected = await deriveOpeningBalance(db, conto, anno, { session });
  await db.collection('riporti').updateOne(
    { conto, anno },
    {
      $setOnInsert: {
        conto,
        anno,
        saldo: expected,
        origine: 'CHIUSURA_ANNO_PRECEDENTE',
        consolidato: false,
        creatoIl: now,
        aggiornatoIl: now
      }
    },
    { upsert: true, ...(session ? { session } : {}) }
  );

  const saved = await db.collection('riporti').findOne(
    { conto, anno },
    session ? { session } : {}
  );
  if (!saved) throw new Error('Impossibile creare il riporto');
  const saldo = parseMoney(saved.saldo, { allowNegative: true, label: 'Saldo riporto' });
  return {
    ...saved,
    saldo,
    saldoAtteso: expected,
    daRiallineare: roundMoney(saldo) !== roundMoney(expected)
  };
}

export async function upsertProjectedMovement(db, projectionKey, movement, { session = null } = {}) {
  if (!projectionKey) throw new Error('Chiave proiezione mancante');
  const now = new Date();
  const { creatoIl, ...mutable } = movement;
  await db.collection('movimenti').updateOne(
    { proiezioneKey: projectionKey },
    {
      $set: { ...mutable, proiezioneKey: projectionKey, aggiornatoIl: now },
      $setOnInsert: { creatoIl: creatoIl || now }
    },
    { upsert: true, ...(session ? { session } : {}) }
  );
  return db.collection('movimenti').findOne(
    { proiezioneKey: projectionKey },
    session ? { session } : {}
  );
}
