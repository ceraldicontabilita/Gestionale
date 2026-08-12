import crypto from 'node:crypto';

function daysBetween(a, b) {
  return Math.floor((new Date(b).getTime() - new Date(a).getTime()) / 86_400_000);
}

function alert(key, tipo, titolo, riferimento, severita = 'MEDIA', dettaglio = null) {
  return { alertKey: key, origine: 'CONTROLLO_FISCALE', tipo, titolo, riferimento, severita, dettaglio };
}

export function createFiscalControlsHandler({ logger = console } = {}) {
  return async function scadenzeFiscali({ db, now }) {
    await db.collection('alerts').createIndex({ alertKey: 1 }, { unique: true });
    const scanId = crypto.randomUUID();
    let open = 0;

    async function save(item) {
      await db.collection('alerts').updateOne(
        { alertKey: item.alertKey },
        {
          $set: { ...item, stato: 'APERTO', ultimoScanId: scanId, ultimaVerificaIl: now, aggiornatoIl: now },
          $unset: { risoltoIl: '' },
          $setOnInsert: { creatoIl: now }
        },
        { upsert: true }
      );
      open += 1;
    }

    for await (const f24 of db.collection('f24_operazioni').find({})) {
      const id = String(f24._id);
      const saldo = Number(f24.saldoModello ?? f24.saldoOperazione ?? 0);
      if (!['RICONCILIATO', 'COMPENSATO'].includes(f24.stato) && Math.abs(saldo) > 0.01) {
        const date = f24.dataVersamento || f24.creatoIl;
        const age = date ? daysBetween(date, now) : 0;
        await save(alert(
          `F24:${id}:RISCONTRO`,
          'F24_SENZA_RISCONTRO',
          'F24 senza riscontro finanziario',
          { tipo: 'F24', id },
          age > 7 ? 'ALTA' : 'MEDIA',
          { protocollo: f24.protocollo || null, saldo, giorni: age }
        ));
      }
      if (f24.controlloSaldo?.stato === 'DIFFERENZA') {
        await save(alert(`F24:${id}:SALDO`, 'F24_DIFFERENZA_SALDO', 'F24 con differenza tra righe e saldo', { tipo: 'F24', id }, 'ALTA', f24.controlloSaldo));
      }
      if (Number(f24.codiciDaVerificare || 0) > 0) {
        await save(alert(`F24:${id}:CODICI`, 'F24_CODICI_DA_VERIFICARE', 'F24 con codici o causali da classificare', { tipo: 'F24', id }, 'MEDIA', { quantita: Number(f24.codiciDaVerificare) }));
      }
    }

    for await (const atto of db.collection('atti_riscossione').find({ stato: { $nin: ['PAGATO', 'ANNULLATO'] } })) {
      const id = String(atto._id);
      if (atto.stato === 'DA_VERIFICARE') {
        await save(alert(`ADER:${id}:VERIFICA`, 'ATTO_DA_VERIFICARE', 'Atto della riscossione da verificare', { tipo: 'ATTO_RISCOSSIONE', id }, 'ALTA'));
      }
      if (!atto.ultimoSnapshot) {
        await save(alert(`ADER:${id}:SNAPSHOT`, 'ADER_SNAPSHOT_MANCANTE', 'Situazione ADER aggiornata non disponibile', { tipo: 'ATTO_RISCOSSIONE', id }, 'MEDIA'));
      }
      if (atto.scadenza && new Date(atto.scadenza) < now) {
        await save(alert(`ADER:${id}:SCADENZA`, 'ATTO_SCADUTO', 'Scadenza riscossione superata', { tipo: 'ATTO_RISCOSSIONE', id }, 'ALTA', { scadenza: atto.scadenza }));
      }
    }

    await db.collection('alerts').updateMany(
      { origine: 'CONTROLLO_FISCALE', stato: 'APERTO', ultimoScanId: { $ne: scanId } },
      { $set: { stato: 'RISOLTO', risoltoIl: now, aggiornatoIl: now } }
    );

    logger.info?.(`[controllo-fiscale] alert aperti=${open}`);
    return { counts: { alertsOpen: open, errors: 0 } };
  };
}
