import { normalizeMovement } from './domain.js';
import { normalizeCorrispettivoDay } from './corrispettivi.js';
import { roundMoney } from './money.js';
import { upsertProjectedMovement } from './ledger.js';
import { withMongoTransaction } from './mongo-transaction.js';

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function creditedAmount(credit) {
  if (!credit) return 0;
  if (Number.isFinite(Number(credit.importoAccreditato))) return roundMoney(credit.importoAccreditato);
  return roundMoney(Math.max(0, Number(credit.importoVenduto || 0) - Number(credit.residuo || 0)));
}

function creditState(sold, credited) {
  const residual = roundMoney(sold - credited);
  if (residual < 0) throw Object.assign(new Error('Accrediti già registrati superiori al nuovo valore POS'), { code: 'POS_BELOW_SETTLED' });
  if (sold === 0) return { residuo: 0, stato: 'NESSUN_INCASSO' };
  if (residual === 0) return { residuo: 0, stato: 'ACCREDITATO' };
  if (credited > 0) return { residuo: residual, stato: 'PARZIALE' };
  return { residuo: residual, stato: 'IN_ATTESA_ACCREDITO' };
}

export function registerCorrispettiviRoutes(app, { getDb, getClient }) {
  app.post('/api/corrispettivi/giornata', async (req, res) => {
    try {
      const db = getDb();
      const client = getClient();
      if (!db || !client) return res.status(503).json({ error: 'MongoDB non configurato' });

      const response = await withMongoTransaction(client, async (session) => {
        const rawDate = String(req.body.data || req.body.dataGiorno || '').slice(0, 10);
        const existing = rawDate
          ? await db.collection('giornate_corrispettivi').findOne({ dataGiorno: rawDate }, { session })
          : null;
        const normalized = normalizeCorrispettivoDay(req.body, existing);
        const now = new Date();
        const dataMovimento = new Date(`${normalized.dataGiorno}T12:00:00.000Z`);
        const originePos = { ...(existing?.originePos || {}) };
        for (const gestore of normalized.touched) {
          if (normalized.removed.includes(gestore)) delete originePos[gestore];
          else originePos[gestore] = String(req.body.originePos?.[gestore] || originePos[gestore] || 'MANUALE').toUpperCase();
        }

        for (const gestore of normalized.touched) {
          const existingCredit = await db.collection('crediti_pos').findOne(
            { dataGiorno: normalized.dataGiorno, gestore },
            { session }
          );
          const credited = creditedAmount(existingCredit);
          if (normalized.removed.includes(gestore) && credited > 0) {
            throw Object.assign(new Error(`Impossibile rimuovere ${gestore}: esistono accrediti già collegati`), { code: 'POS_HAS_SETTLEMENTS' });
          }
          if (!normalized.removed.includes(gestore) && normalized.pos[gestore] < credited) {
            throw Object.assign(new Error(`Il valore POS ${gestore} non può essere inferiore agli accrediti già collegati`), { code: 'POS_BELOW_SETTLED' });
          }
        }

        const record = {
          dataGiorno: normalized.dataGiorno,
          totaleXml: normalized.totaleXml,
          documentoXmlId: hasOwn(req.body, 'documentoXmlId') ? (req.body.documentoXmlId || null) : (existing?.documentoXmlId || null),
          chiusuraOperativa: normalized.chiusuraOperativa,
          pos: normalized.pos,
          originePos,
          totalePos: normalized.totalePos,
          contanteAtteso: normalized.contanteAtteso,
          controlloFiscale: normalized.controlloFiscale,
          anomalie: normalized.anomalie,
          aggiornatoIl: now
        };
        await db.collection('giornate_corrispettivi').updateOne(
          { dataGiorno: normalized.dataGiorno },
          { $set: record, $setOnInsert: { creatoIl: now } },
          { upsert: true, session }
        );

        const xmlProjection = `CORRISPETTIVO:${normalized.dataGiorno}`;
        if (normalized.totaleXml > 0) {
          await upsertProjectedMovement(db, xmlProjection, normalizeMovement({
            data: dataMovimento,
            conto: 'CASSA',
            direzione: 'ENTRATA',
            importo: normalized.totaleXml,
            descrizione: `Corrispettivi giornalieri ${normalized.dataGiorno}`,
            tipo: 'CORRISPETTIVO_GIORNALIERO',
            stato: 'DOCUMENTATO',
            fonte: 'XML_RT',
            documentoId: record.documentoXmlId,
            riferimentoEsterno: normalized.dataGiorno
          }, { now }), { session });
        } else {
          await db.collection('movimenti').deleteOne({ proiezioneKey: xmlProjection }, { session });
        }

        for (const gestore of normalized.touched) {
          const projectionKey = `POS:${normalized.dataGiorno}:${gestore}`;
          const existingCredit = await db.collection('crediti_pos').findOne(
            { dataGiorno: normalized.dataGiorno, gestore },
            { session }
          );
          const credited = creditedAmount(existingCredit);

          if (normalized.removed.includes(gestore)) {
            await db.collection('movimenti').deleteOne({ proiezioneKey: projectionKey }, { session });
            await db.collection('crediti_pos').deleteOne({ dataGiorno: normalized.dataGiorno, gestore }, { session });
            continue;
          }

          const amount = normalized.pos[gestore];
          if (amount > 0) {
            await upsertProjectedMovement(db, projectionKey, normalizeMovement({
              data: dataMovimento,
              conto: 'CASSA',
              direzione: 'USCITA',
              importo: amount,
              descrizione: `POS ${gestore} verso accredito`,
              tipo: 'TRASFERIMENTO_POS',
              stato: 'DOCUMENTATO',
              fonte: originePos[gestore],
              contropartita: `CREDITO_POS_${gestore}`,
              riferimentoEsterno: `${normalized.dataGiorno}:${gestore}`
            }, { now }), { session });
          } else {
            await db.collection('movimenti').deleteOne({ proiezioneKey: projectionKey }, { session });
          }

          const calculated = creditState(amount, credited);
          await db.collection('crediti_pos').updateOne(
            { dataGiorno: normalized.dataGiorno, gestore },
            {
              $set: {
                importoVenduto: amount,
                importoAccreditato: credited,
                residuo: calculated.residuo,
                stato: calculated.stato,
                datoPosPresente: true,
                origine: originePos[gestore],
                aggiornatoIl: now
              },
              $setOnInsert: { creatoIl: now }
            },
            { upsert: true, session }
          );
        }

        return { created: !existing, normalized: { ...normalized, originePos } };
      });

      res.status(response.created ? 201 : 200).json({ ok: true, ...response.normalized });
    } catch (error) {
      const status = ['POS_HAS_SETTLEMENTS', 'POS_BELOW_SETTLED'].includes(error.code)
        ? 409
        : /Transaction numbers|replica set|mongos/i.test(error.message)
          ? 503
          : 400;
      res.status(status).json({ error: error.message });
    }
  });

  app.get('/api/corrispettivi/:data', async (req, res) => {
    try {
      const db = getDb();
      if (!db) return res.status(503).json({ error: 'MongoDB non configurato' });
      const dataGiorno = String(req.params.data).slice(0, 10);
      const giornata = await db.collection('giornate_corrispettivi').findOne({ dataGiorno });
      if (!giornata) return res.status(404).json({ error: 'Giornata non trovata' });
      const crediti = await db.collection('crediti_pos').find({ dataGiorno }).sort({ gestore: 1 }).toArray();
      res.json({ giornata, crediti });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });
}
