function daysBetween(a, b) {
  return Math.floor((new Date(b).getTime() - new Date(a).getTime()) / 86_400_000);
}

function alert(key, tipo, titolo, riferimento, severita = 'MEDIA', dettaglio = null) {
  return { alertKey: key, origine: 'CONTROLLO_FISCALE', tipo, titolo, riferimento, severita, dettaglio };
}

export function createFiscalControlsHandler({ logger = console } = {}) {
  return async function scadenzeFiscali({ db, now }) {
    await db.collection('alerts').createIndex({ alertKey: 1 }, { unique: true });
    const alerts = [];

    const f24Rows = await db.collection('f24_operazioni').find({ stato: { $ne: 'RICONCILIATO' } }).limit(2000).toArray();
    for (const f24 of f24Rows) {
      const id = String(f24._id);
      const date = f24.dataVersamento || f24.creatoIl;
      const age = date ? daysBetween(date, now) : 0;
      alerts.push(alert(
        `F24:${id}:RISCONTRO`,
        'F24_SENZA_RISCONTRO',
        'F24 senza riscontro finanziario',
        { tipo: 'F24', id },
        age > 7 ? 'ALTA' : 'MEDIA',
        { protocollo: f24.protocollo || null, saldo: f24.saldoModello ?? f24.saldoOperazione ?? null, giorni: age }
      ));
      if (f24.controlloSaldo?.stato === 'DIFFERENZA') {
        alerts.push(alert(
          `F24:${id}:SALDO`,
          'F24_DIFFERENZA_SALDO',
          'F24 con differenza tra righe e saldo',
          { tipo: 'F24', id },
          'ALTA',
          f24.controlloSaldo
        ));
      }
      if (Number(f24.codiciDaVerificare || 0) > 0) {
        alerts.push(alert(
          `F24:${id}:CODICI`,
          'F24_CODICI_DA_VERIFICARE',
          'F24 con codici o causali da classificare',
          { tipo: 'F24', id },
          'MEDIA',
          { quantita: Number(f24.codiciDaVerificare) }
        ));
      }
    }

    const atti = await db.collection('atti_riscossione').find({ stato: { $nin: ['CHIUSO', 'PAGATO', 'ANNULLATO'] } }).limit(2000).toArray();
    for (const atto of atti) {
      const id = String(atto._id);
      if (atto.stato === 'DA_VERIFICARE') {
        alerts.push(alert(`ADER:${id}:VERIFICA`, 'ATTO_DA_VERIFICARE', 'Atto della riscossione da verificare', { tipo: 'ATTO_RISCOSSIONE', id }, 'ALTA'));
      }
      if (!atto.ultimoSnapshotId) {
        alerts.push(alert(`ADER:${id}:SNAPSHOT`, 'ADER_SNAPSHOT_MANCANTE', 'Situazione ADER aggiornata non disponibile', { tipo: 'ATTO_RISCOSSIONE', id }, 'MEDIA'));
      }
      if (atto.scadenza && new Date(atto.scadenza) < now) {
        alerts.push(alert(
          `ADER:${id}:SCADENZA`,
          'ATTO_SCADUTO',
          'Scadenza riscossione superata',
          { tipo: 'ATTO_RISCOSSIONE', id },
          'ALTA',
          { scadenza: atto.scadenza }
        ));
      }
    }

    const currentKeys = alerts.map((item) => item.alertKey);
    for (const item of alerts) {
      await db.collection('alerts').updateOne(
        { alertKey: item.alertKey },
        {
          $set: { ...item, stato: 'APERTO', ultimaVerificaIl: now, aggiornatoIl: now },
          $setOnInsert: { creatoIl: now }
        },
        { upsert: true }
      );
    }

    await db.collection('alerts').updateMany(
      { origine: 'CONTROLLO_FISCALE', alertKey: { $nin: currentKeys }, stato: 'APERTO' },
      { $set: { stato: 'RISOLTO', risoltoIl: now, aggiornatoIl: now } }
    );

    logger.info?.(`[controllo-fiscale] alert aperti=${alerts.length}`);
    return { counts: { alertsOpen: alerts.length, errors: 0 } };
  };
}
