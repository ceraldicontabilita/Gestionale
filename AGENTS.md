# Regola canonica del repository

Queste istruzioni si applicano all'intero progetto e prevalgono sulle indicazioni operative meno specifiche.

## Repository autorizzato

- L'unico repository sul quale è consentito scrivere è `ceraldicontabilita/Gestionale`.
- Il branch base e la destinazione delle pull request sono sempre `main`.
- Le modifiche devono essere sviluppate su un branch dedicato con prefisso `codex/`, derivato da `main`; non eseguire commit diretti su `main`.
- Qualunque altra sorgente può essere consultata esclusivamente in lettura e come riferimento. Non modificarla, non pubblicarvi branch e non usarla come destinazione di commit o pull request.

## Controllo obbligatorio prima di ogni scrittura

Prima di creare, modificare, rinominare o eliminare file, e prima di qualsiasi operazione Git che scriva dati, eseguire e verificare:

```bash
git rev-parse --show-toplevel
git remote get-url origin
git remote get-url --push origin
git branch --show-current
```

Gli URL di fetch e push di `origin`, normalizzati fra forma HTTPS e SSH, devono identificare entrambi esattamente `ceraldicontabilita/Gestionale`. Sono validi, ad esempio:

```text
https://github.com/ceraldicontabilita/Gestionale.git
git@github.com:ceraldicontabilita/Gestionale.git
```

Se `origin` manca, uno degli URL di fetch o push punta altrove, il repository non è identificabile con certezza oppure il branch di lavoro non deriva da `main`, fermarsi senza effettuare scritture e chiedere conferma all'utente. Non correggere automaticamente il remote e non spostare le modifiche verso un altro repository.

Prima di commit, push o apertura di una pull request, ripetere il controllo del remote e verificare che la destinazione sia `main` nello stesso repository canonico.

## Flusso e dati protetti

- Eseguire i controlli di sintassi e i test pertinenti prima di pubblicare.
- Aprire le pull request inizialmente in bozza verso `main` e non unirle senza approvazione esplicita dell'utente.
- Non inserire documenti fiscali reali, credenziali, token, identificativi privati o dati personali in codice, fixture, log e commit.

## Richiamo iniziale

All'inizio di ogni nuova attività sul progetto, il primo aggiornamento deve dichiarare:

> Sto lavorando esclusivamente su `ceraldicontabilita/Gestionale`, con `main` come base e destinazione.
