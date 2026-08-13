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

## Anatomia funzionale obbligatoria

- `docs/anatomia-gestionale/catalogo.json` è la fonte canonica per sezioni, pagine, proprietari funzionali, entità, relazioni e stato di implementazione.
- `docs/anatomia-gestionale/topologia-flussi.json` è il contratto canonico per eventi, proiezioni delle pagine, azioni consentite, idempotenza, propagazione degli errori e collegamenti fra domini.
- Gli inventari in `docs/anatomia-gestionale/inventari/` sono lo snapshot storico autosufficiente usato per decidere consolidamento, ridisegno o esclusione; non sono codice da copiare né una dipendenza runtime.
- Prima di aggiungere una pagina, un endpoint, una collezione, un job o un motore, cercare nel catalogo l'equivalente esistente. Se esiste, estenderlo o correggerlo: non creare implementazioni parallele.
- Ogni nuova capacità deve avere un solo proprietario funzionale, una fonte autorevole per ciascun fatto, regole di deduplicazione e un esito esplicito in caso di ambiguità.
- Le pagine sono proiezioni/read model dei fatti canonici. Un comando avviato da una pagina deve scrivere attraverso il proprietario del dominio e pubblicare un evento idempotente; non creare copie modificabili dello stesso fatto per alimentare più pagine.
- Qualunque modifica che aggiunge un ingresso, cambia un'entità o produce effetti su altre pagine deve aggiornare insieme catalogo e topologia, includendo deduplicazione, provenienza, quadrature, invalidazione/storno e stato di errore.
- La pagina Coerenza legge e valuta i domini con regole versionate, ma non corregge direttamente i loro fatti autorevoli. La correzione avviene nel dominio proprietario e genera un nuovo evento sottoposto nuovamente ai controlli.
- La presenza di un file, una classe, una route o una schermata non prova che una capacità sia completa. Aggiornare lo stato nel catalogo soltanto con test e collegamenti reali tra ingresso, persistenza, uso e controllo.
- Le sorgenti storiche restano riferimenti di sola lettura. Il catalogo e i documenti presenti in questo repository devono essere sufficienti per proseguire il lavoro senza interrogarle di nuovo.
- Eseguire `npm run validate:anatomia` quando si modifica il catalogo o la struttura funzionale.

## Richiamo iniziale

All'inizio di ogni nuova attività sul progetto, il primo aggiornamento deve dichiarare:

> Sto lavorando esclusivamente su `ceraldicontabilita/Gestionale`, con `main` come base e destinazione.
