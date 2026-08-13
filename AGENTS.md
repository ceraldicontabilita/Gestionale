# Contratto operativo canonico

Queste istruzioni si applicano all'intero repository. Prevalgono su note, chat,
ZIP, report storici e indicazioni operative meno specifiche.

## 1. Autorità e perimetro

- L'unico repository autorizzato è `ceraldicontabilita/Gestionale`.
- `main` è sempre la base di confronto e la destinazione delle pull request.
- Il lavoro deve avvenire su un branch dedicato `codex/*` derivato da `main`.
- Non effettuare commit diretti su `main`.
- Non recuperare, copiare o pubblicare codice del vecchio GestionaleCloud o di
  altri repository. Fonti esterne e storiche sono consultabili soltanto in
  lettura come evidenza di audit.
- Il codice, i test, i dati correnti e le autorizzazioni reali prevalgono sui
  resoconti precedenti. Una vecchia chat non prova lo stato attuale.

All'inizio di ogni nuova attività dichiarare:

> Sto lavorando esclusivamente su `ceraldicontabilita/Gestionale`, con `main` come base e destinazione.

## 2. Controllo obbligatorio del repository

Prima della prima modifica e prima di ogni commit, push o pull request eseguire:

```bash
git rev-parse --show-toplevel
git remote get-url origin
git remote get-url --push origin
git branch --show-current
git fetch origin --prune
git rev-parse HEAD
git rev-parse origin/main
git status --short --branch
```

Gli URL fetch e push devono identificare esattamente
`ceraldicontabilita/Gestionale`, in forma HTTPS o SSH. Se il repository, il
remote, la base o il branch non sono verificabili, fermarsi senza modificare
remote o trasferire automaticamente il lavoro altrove.

Preservare sempre modifiche locali non pertinenti. Non usare comandi distruttivi
come `git reset --hard` o `git checkout --` per eliminare lavoro esistente.

## 3. Autorizzazioni di pubblicazione

Modificare e verificare il codice locale non autorizza automaticamente azioni
esterne. Richiedere autorizzazione esplicita per ciascuna fase:

1. commit;
2. push;
3. apertura o aggiornamento della pull request;
4. merge su `main`;
5. deploy Render;
6. importazione o modifica di dati reali.

Le pull request devono essere inizialmente in bozza e indirizzate a `main`.
Non dichiarare un blocco concluso al solo merge: servono deploy e smoke test
pubblico verificato.

## 4. Letture obbligatorie prima di cambiare il dominio

Leggere integralmente, nell'ordine utile al lavoro:

1. `docs/ALBERO_COMPLETO_FLUSSI_ATTESE.md`;
2. `docs/anatomia-gestionale/albero-flussi-attese.json`;
3. `docs/anatomia-gestionale/TOPOLOGIA_FLUSSI.md`;
4. `docs/anatomia-gestionale/topologia-flussi.json`;
5. `docs/anatomia-gestionale/catalogo.json`;
6. `docs/MOTORE_EVENTI_CONTABILITA.md`;
7. `docs/REGOLE_DOMINIO.md`;
8. `src/event-engine.js` e `src/event-engine-router.js`;
9. i produttori, consumer e router del dominio interessato;
10. i relativi test unitari, HTTP e MongoDB.

Non leggere parzialmente questi contratti per poi dedurne l'architettura. Se
catalogo, topologia, albero e codice divergono, non scegliere in silenzio:
correggere insieme contratto e implementazione, mantenendo lo stato della pagina
prudente.

## 5. Principio vincolante delle attese

> **Il ramo nasce quando nasce l'obbligo; l'evidenza futura lo soddisfa, non lo crea.**

Conseguenze obbligatorie:

- l'evento di dominio validato crea subito obbligo, processo e attese future;
- pagamento, quietanza, movimento, estratto conto o attestazione di cassa non
  devono creare retroattivamente il ramo amministrativo;
- gli stati terminali positivi sono `SODDISFATTO`, `NON_APPLICABILE` e
  `SUPERATO`;
- `ATTESO`, `IN_ELABORAZIONE`, `DA_VERIFICARE` ed `ERRORE` mantengono aperto il
  processo quando l'attesa è obbligatoria;
- ogni transizione deve avere evento, evidenza, motivo, idempotenza e audit;
- correzioni e nuove versioni non cancellano la storia: superano, rettificano o
  compensano il fatto precedente.

## 6. Confini dei domini

- Ogni fatto ha un solo proprietario funzionale e una sola fonte autorevole.
- Le pagine sono proiezioni dei fatti canonici, non database paralleli.
- Una pagina non può scrivere direttamente fatti di un altro dominio: invia un
  comando al proprietario, che valida e pubblica un evento idempotente.
- Import Documenti, Drive e PEC devono convergere nello stesso intake
  documentale. Non creare pipeline duplicate per fonte.
- Identità, provenienza, versione, SHA-256 e centesimi esatti sono parte del
  contratto. Nome, dimensione o importo da soli non identificano un fatto.
- La pagina Coerenza è read-only sui fatti autorevoli: apre o aggiorna anomalie,
  ma la correzione avviene nel dominio proprietario.

## 7. Invarianti contabili e finanziarie

- La competenza documentale è distinta dal regolamento finanziario.
- Una fattura validata genera costo, IVA, debito e partita aperta senza attendere
  il pagamento.
- Una quietanza o una disposizione PDF è evidenza documentale, non prova
  bancaria.
- Il regolamento finanziario è ammesso soltanto con movimento bancario, carta o
  attestazione di cassa reale e riferita.
- Una riconciliazione richiede identità della causa, riferimento del movimento e
  quadratura in centesimi; l'importo da solo non basta.
- Le scritture Dare/Avere devono quadrare esattamente al centesimo.
- Le regole contabili devono essere versionate e approvate.
- Il periodo contabile deve essere aperto; riapertura e chiusura richiedono
  motivo, riconferma del PIN amministratore e audit secondo la policy.
- Non cancellare una scrittura registrata: usare storni compensativi o versioni
  sostitutive.
- Registro eventi e outbox sono immutabili e transazionali; dispatcher e
  proiezioni devono essere idempotenti, con lease, retry e dead letter.

## 8. Anatomia funzionale

- `docs/anatomia-gestionale/catalogo.json` è la fonte canonica per sezioni,
  pagine, proprietari, entità, relazioni e stato di implementazione.
- `docs/anatomia-gestionale/topologia-flussi.json` è il contratto per eventi,
  processor, comandi, proiezioni, errori e passaggi tra domini.
- `docs/anatomia-gestionale/albero-flussi-attese.json` è il contratto per rami,
  attese, stati e criteri di chiusura.
- Gli inventari storici sono snapshot di audit, non dipendenze runtime e non
  codice da copiare.
- Prima di aggiungere pagina, endpoint, collezione, job o motore, cercare
  l'equivalente esistente e consolidarlo.
- Una modifica che cambia ingressi, entità, eventi o consumatori deve aggiornare
  insieme catalogo, topologia e, se coinvolge obblighi, albero delle attese.
- Non promuovere una pagina a `PRESENTE` finché ingresso, persistenza,
  proiezione, errori, sicurezza, test e uso reale non sono completi.

## 9. Dati reali, Drive e segreti

- Non inserire in codice, fixture, log o commit documenti fiscali reali, dati
  personali, PIN, password, token, URI MongoDB o credenziali Google.
- Non mostrare in output nomi di fornitori, identificativi fiscali o importi
  reali quando bastano conteggi tecnici aggregati.
- Le prove su documenti reali devono essere in sola lettura salvo autorizzazione
  esplicita all'importazione.
- Gli originali Drive rimangono su Drive; MongoDB conserva fatti strutturati,
  provenienza e riferimenti secondo il contratto del dominio.
- Non eliminare duplicati Drive soltanto per nome o dimensione. Verificare hash e
  genitori; ogni operazione distruttiva richiede un bersaglio certo e auditabile.
- Non usare il MongoDB di Render come ambiente di test. Prima usare fixture e un
  replica set isolato; l'importazione reale avviene soltanto dopo deploy e
  autorizzazione.

## 10. Gate di qualità

Prima di proporre la pubblicazione eseguire almeno:

```bash
npm run check
npm test
npm run validate:anatomia
npm run validate:connessioni
git diff --check
```

Per motore eventi, obbligazioni, riconciliazione o proiezioni contabili eseguire
anche i test end-to-end con `TEST_MONGODB_URI` puntato a un replica set MongoDB
isolato. I test saltati non costituiscono prova: riportare chiaramente quanti
test sono passati, falliti o saltati.

Prima di commit controllare il diff per segreti e dati reali. Prima del deploy
eseguire la checklist di rilascio; dopo il deploy verificare almeno health,
autenticazione, riconferma PIN sulle operazioni sensibili, caricamento UI, API del dominio,
persistenza e lettura delle proiezioni.

## 11. Stato verificato del ramo fatture — 2026-08-13

Baseline verificata di `main`: merge commit
`b250774ff50124aba23460493f9bd4ac4eac4234`, pubblicato con la PR #5 e
distribuito su Render come versione `0.10.0`. Verificare sempre che
`origin/main` non sia cambiato prima di proseguire.

`main` contiene:

- intake FatturaPA unico da Drive, PEC e upload;
- staging con SHA-256, provenienza e deduplicazione;
- validazione canonica `invoice.supplier_validated`;
- Expectation Engine con processo e dodici attese per la fattura fornitore;
- competenza, IVA detraibile esplicita, obbligazione e partita aperta;
- riconciliazione parziale o integrale con prova finanziaria riferita;
- `ledger.entry_projected` separato per `FINANCIAL_SETTLEMENT`;
- consumer di `projection_outbox` per giornale, mastro, bilancio e Coerenza;
- UI Documenti per intake e visualizzazione dell'albero;
- test MongoDB replica set end-to-end per competenza, retry, pagamento e
  chiusura delle attese.

La pubblicazione della baseline è stata verificata il 2026-08-13 con UI
versione `0.10.0`, MongoDB collegato e API anonime bloccate. Nessuna fattura
reale è stata importata durante lo smoke test.

Il branch locale `codex/dichiarazioni-dimissioni-categorie`, derivato da tale
baseline, aggiunge la canonizzazione automatica degli XML FatturaPA esatti,
conti tecnici per costo e IVA ancora da classificare, proiezione Fornitori,
dichiarazioni raggruppate con anno d'imposta e protocollo, identità delle
dimissioni letta dal PDF, Archivio per domini e verbali, fallback documentale
F24/quietanze, registro codici osservati e indici originali dei pacchetti
fiscali/PEC. I casi non esatti restano in revisione; regolamento, eliminazioni e
modifiche amministrative sensibili richiedono il PIN secondo la policy. Questo
lavoro locale non equivale a pubblicazione: prima di commit, push, PR, merge,
deploy e importazione reale si applicano le autorizzazioni separate della
sezione 3.

## 12. Priorità successiva dopo la pubblicazione del verticale

1. note di credito e supersessione della fattura;
2. UI dedicata alla riconciliazione fatture e gestione multi-candidato;
3. importazione reale controllata e verifica delle righe `DA_VERIFICARE`;
4. consumer e controlli mancanti senza duplicare fatti tra domini;
5. un solo produttore reale nuovo alla volta, con test e aggiornamento simultaneo
   di catalogo, topologia e albero.

## 13. Definition of done

Un blocco è concluso soltanto quando sono verificati tutti i punti applicabili:

- ingresso reale e deduplicazione;
- persistenza canonica e provenienza;
- evento e consumer idempotenti;
- gestione errori, retry, dead letter e correzione;
- proiezioni e Coerenza;
- UI e autorizzazioni;
- test unitari, HTTP e MongoDB end-to-end;
- catalogo, topologia e albero aggiornati;
- assenza di segreti e dati reali nei commit;
- commit, push, PR e merge autorizzati;
- deploy Render riuscito;
- smoke test pubblico verificato.
