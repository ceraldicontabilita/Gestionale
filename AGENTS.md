# Istruzioni permanenti — Impresa Semplice

## Repository canonico

Il solo repository di sviluppo e destinazione delle modifiche è:

`ceraldicontabilita/Gestionale`

Ogni nuova funzionalità, correzione, test, documento tecnico, configurazione e migrazione di Impresa Semplice deve essere letta, progettata, implementata e pubblicata in questo repository.

## Repository storico di sola consultazione

`ceraldicontabilita/GestionaleCloud` è un archivio storico e una fonte di riferimento. Può essere letto soltanto per comprendere parser, formati documentali, regole di dominio o comportamenti precedenti.

È vietato nel repository `GestionaleCloud`:

- creare branch;
- creare, modificare, rinominare o eliminare file;
- eseguire commit o push;
- aprire pull request contenenti modifiche;
- usarlo come destinazione di deploy o come base del nuovo gestionale.

Il codice estratto dal repository storico non va copiato automaticamente: deve essere riesaminato, adattato all'architettura corrente, coperto da test e scritto esclusivamente in `ceraldicontabilita/Gestionale`.

## Controllo obbligatorio prima di ogni scrittura

Prima di qualsiasi operazione mutante, l'agente deve verificare che il repository risolto sia esattamente `ceraldicontabilita/Gestionale`. Se il repository è diverso, deve interrompere la scrittura e correggere il contesto. L'assenza di una nuova indicazione dell'utente non autorizza mai a scegliere `GestionaleCloud`.

## Flusso Git

- Non modificare direttamente `main`.
- Creare o riutilizzare un branch dedicato con prefisso `codex/`.
- Eseguire controlli di sintassi e test pertinenti.
- Aprire una pull request in bozza verso `main`.
- Non effettuare il merge senza approvazione esplicita dell'utente.
- Non includere documenti fiscali reali, credenziali, token o dati personali nelle fixture e nei commit.

## Richiamo iniziale per le nuove chat

All'avvio di un'attività sul progetto, considerare sempre questa frase come istruzione permanente:

> Lavora esclusivamente su `ceraldicontabilita/Gestionale`. Usa `ceraldicontabilita/GestionaleCloud` soltanto in lettura come riferimento storico e non modificarlo mai.
