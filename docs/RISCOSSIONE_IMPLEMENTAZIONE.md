# Riscossione / ADER

## Principio

L'atto originale, i pagamenti collegati e la situazione debitoria aggiornata sono fatti distinti.

Un pagamento bancario collegato non modifica automaticamente il residuo ADER. Il residuo cambia soltanto quando viene acquisito un nuovo snapshot della situazione debitoria.

## Entità

### Atto

Conserva almeno:

- tipo;
- numero/identificativo;
- contribuente;
- ente o enti creditori;
- data atto;
- data notifica;
- scadenza;
- importo originario;
- componenti quando disponibili;
- documento originale e fonte.

### Snapshot ADER

È versionato e conserva:

- data acquisizione;
- importo originario riportato dalla fonte;
- pagato;
- residuo;
- stato;
- eventuale rateizzazione;
- procedure/misure collegate;
- riferimento della fonte.

Ogni snapshot resta nello storico. La scheda dell'atto mostra l'ultimo, senza cancellare i precedenti.

## Riconoscimento

Il riconoscimento testuale propone il tipo sulla base di segnali forti come `Cartella di pagamento`, `Avviso di addebito`, `Intimazione`, `Accertamento esecutivo` e riferimenti ADER. È una proposta: i casi non sufficientemente certi restano `DA_VERIFICARE`.

## Pagamenti

Il collegamento richiede un movimento `BANCA` o `MASTERCARD`, in uscita e con evidenza finanziaria reale. Il totale dei pagamenti collegati è informativo e non sostituisce lo snapshot ufficiale del residuo.

## API

- `GET /api/riscossione/atti`
- `POST /api/riscossione/atti`
- `GET /api/riscossione/atti/:id`
- `POST /api/riscossione/riconosci`
- `POST /api/riscossione/atti/:id/snapshot`
- `POST /api/riscossione/atti/:id/collega-movimento`
- `GET /api/riscossione/controlli`
