# Impresa Semplice — Albero completo dei flussi, delle attese e delle relazioni

Questa specifica estende la topologia canonica già presente in `docs/anatomia-gestionale/TOPOLOGIA_FLUSSI.md` con una regola esplicita che diventa vincolante per il nuovo gestionale:

> **Un ramo nasce quando nasce l'obbligo o l'aspettativa. L'evidenza futura lo soddisfa, non lo crea.**

L'obiettivo è evitare che il sistema consideri implicitamente “completo” un processo soltanto perché non è arrivato altro. Ogni evento validato deve dichiarare fin dall'inizio cosa è stato soddisfatto, cosa è ancora atteso, cosa è da verificare e cosa blocca la chiusura.

---

## 1. Regola di chiusura del processo

Ogni evento di dominio validato genera:

1. fatti canonici;
2. relazioni;
3. proiezioni di pagina;
4. `expectation` obbligatorie per tutto ciò che deve ancora accadere.

Stati terminali positivi:

- `SODDISFATTO`
- `NON_APPLICABILE`
- `SUPERATO`

Stati che mantengono aperto il processo:

- `ATTESO`
- `IN_ELABORAZIONE`
- `DA_VERIFICARE`
- `ERRORE`

Il processo è chiuso solo quando tutte le expectation obbligatorie sono in uno stato terminale positivo.

```text
EVENTO VALIDATO
      ↓
FATTI CANONICI
      ↓
EXPECTATION CREATE SUBITO
      ↓
ATTESO / IN_ELABORAZIONE / DA_VERIFICARE
      ↓
NUOVE EVIDENZE / EVENTI
      ↓
SODDISFATTO / NON_APPLICABILE / SUPERATO
      ↓
TUTTI I RAMI OBBLIGATORI SONO TERMINALI POSITIVI?
      ↓
SÌ → CERCHIO CHIUSO
NO → PROCESSO ANCORA APERTO
```

Questa regola deve essere implementata come `Expectation Engine` e non come semplice comportamento UI.

---

## 2. Albero canonico delle pagine

Le sezioni principali restano sei.

```text
Impresa Semplice
├── Home
│   ├── Quadro operativo
│   ├── Attività da completare
│   ├── Scadenze e priorità
│   └── Assistente e memoria operativa
├── Prima Nota
│   ├── Cassa
│   ├── Banca
│   ├── Carte e circuiti
│   ├── Salari
│   ├── Finanziamenti soci
│   ├── Provvisoria
│   ├── Corrispettivi e POS
│   └── Libro giornale e mastro
├── Documenti
│   ├── Acquisizione e inbox
│   ├── Archivio e viewer
│   ├── Indice e albero Drive
│   ├── Duplicati e piano cartelle
│   ├── Fatture fornitori e clienti
│   ├── Corrispettivi XML RT
│   ├── F24, quietanze e dichiarazioni
│   ├── Cedolini e riepiloghi paghe
│   ├── Estratti banca e carte
│   └── Riscossione, PagoPA e altri atti
├── Riconciliazione
│   ├── Coda generale e partite aperte
│   ├── Fatture e pagamenti
│   ├── F24 e riscossione
│   ├── Salari
│   ├── Carte, POS e accrediti
│   ├── Assegni
│   ├── PayPal e PagoPA
│   └── Verbali e audit di chiusura
├── Amministrazione
│   ├── Fornitori e soggetti
│   ├── Dizionario prodotti acquistati
│   ├── Dipendenti contabili minimi
│   ├── Fisco, IVA e codici tributo
│   ├── Riscossione e rateizzazioni
│   ├── Cespiti, finanziamenti e veicoli
│   ├── Commercialista e consulente
│   ├── Integrazioni e scheduler
│   ├── Utenti, ruoli e riconferma PIN
│   └── Configurazione agenti
└── Controllo
    ├── Coerenza e anomalie operative
    ├── Provenienza e grafo delle relazioni
    ├── Comparazione prezzi di acquisto
    ├── Controllo mensile e chiusura esercizio
    ├── Piano dei conti
    ├── Bilancio e IVA
    ├── Budget, previsioni e scadenze fiscali
    ├── Registro audit e rollback
    └── Stato importazioni e manutenzione Drive
```

Le pagine sono proiezioni dei fatti canonici. Non possiedono copie concorrenti della verità.

---

## 3. Fattura fornitore

Quando una fattura fornitore viene validata, i rami seguenti esistono immediatamente.

```text
FATTURA FORNITORE
│
├── Documento originale .............. SODDISFATTO
├── Fornitore / fattura / righe ...... SODDISFATTO
├── IVA ............................... SODDISFATTO o DA_VERIFICARE
├── Costo + debito .................... SODDISFATTO
├── Partita aperta .................... SODDISFATTO
├── Scadenza .......................... SODDISFATTO
├── Bilancio / budget / controllo ..... SODDISFATTO
│
├── Pagamento ......................... ATTESO
├── Movimento banca/cassa ............. ATTESO
├── Riconciliazione ................... ATTESA
├── Prima Nota finanziaria ............ ATTESA
└── Chiusura debito ................... ATTESA
```

Pagine alimentate:

- `Documenti → Archivio e viewer`
- `Documenti → Fatture fornitori e clienti`
- `Amministrazione → Fornitori e soggetti`
- `Amministrazione → Dizionario prodotti acquistati`
- `Controllo → Bilancio e IVA`
- `Controllo → Piano dei conti`
- `Riconciliazione → Coda generale e partite aperte`
- `Home → Scadenze e priorità`
- `Riconciliazione → Fatture e pagamenti`
- `Prima Nota → Banca / Cassa`
- `Home → Quadro operativo`
- `Controllo → Coerenza e anomalie operative`

Regola non negoziabile:

> **Fattura = documento, costo, debito e aspettativa di pagamento. Fattura ≠ pagamento eseguito.**

Il metodo di pagamento indicato nella fattura non prova l'esecuzione finanziaria.

---

## 4. Fattura cliente

Rami immediati:

- documento / cliente / fattura → `SODDISFATTO`;
- IVA vendite → `SODDISFATTO`;
- credito cliente / partita aperta → `SODDISFATTO`;
- incasso → `ATTESO`;
- movimento banca/cassa → `ATTESO`;
- riconciliazione → `ATTESA`;
- chiusura credito → `ATTESA`.

Relazione principale:

```text
fattura cliente ↔ credito ↔ riconciliazione ↔ movimento finanziario
```

---

## 5. Corrispettivo RT / POS

Quando entra un XML RT ufficiale:

- XML RT → `SODDISFATTO`;
- giorno fiscale → `SODDISFATTO`;
- ricavo → `SODDISFATTO`;
- IVA vendite → `SODDISFATTO`;
- chiusura NUMIA → `ATTESO`;
- chiusura SUMUP → `ATTESO`;
- credito verso gestore POS → `ATTESO`;
- payout → `ATTESO`;
- accredito bancario → `ATTESO`;
- commissioni → `ATTESO`;
- quadratura RT↔POS↔Banca → `ATTESO`.

Il totale fiscale non autorizza a inventare la ripartizione NUMIA/SUMUP.

```text
XML RT
 ↕
giorno fiscale
 ↕
IVA + ricavo
 ↕
chiusure terminali
 ↕
crediti gestori
 ↕
payout
 ↕
accredito banca
```

---

## 6. Banca / carte

L'import di un estratto non nasce per cercare casualmente cosa collegare. Deve soddisfare expectation già esistenti.

Rami:

- estratto originale → `SODDISFATTO`;
- movimenti normalizzati → `SODDISFATTO`;
- prove finanziarie → `SODDISFATTO`;
- candidati di riconciliazione → `SODDISFATTO`;
- allocazione → `DA_VERIFICARE` oppure confermata se univoca e quadrata;
- Prima Nota → `ATTESO` finché i gate non sono superati;
- quadratura saldo conto → `ATTESO` finché il periodo non è verificato.

La sola uguaglianza dell'importo non basta.

---

## 7. F24

Rami immediati:

- modello e righe → `SODDISFATTO`;
- codici tributo/versioni → `SODDISFATTO`;
- debiti / crediti / compensazioni → `SODDISFATTO`;
- quietanza/esito → `ATTESO` quando applicabile;
- movimento bancario → `ATTESO` soltanto se saldo finanziario > 0;
- chiusura finanziaria → `ATTESO`;
- collegamenti con dichiarazioni/paghe → `DA_VERIFICARE` quando non deterministici.

Caso saldo esattamente zero:

- non si attende movimento bancario;
- i debiti possono essere chiusi per compensazione;
- l'effetto fiscale e quello finanziario restano distinti.

---

## 8. Cedolino / paghe

Rami immediati:

- PDF / dipendente / periodo → `SODDISFATTO`;
- componenti paga → `SODDISFATTO`;
- netto dovuto → `SODDISFATTO`;
- TFR / componenti → `SODDISFATTO` o `DA_VERIFICARE`;
- acconti → `ATTESO`;
- saldo → `ATTESO`;
- movimenti bancari/cassa → `ATTESO`;
- expectation F24 contributive/fiscali → `ATTESO`;
- chiusura mese dipendente → `ATTESO`.

```text
cedolino ↔ dipendente ↔ netto dovuto ↔ acconti/saldo ↔ banca
                    ↘ componenti / TFR
                    ↘ F24 attesi
```

PDF cedolino e PDF bonifico non provano l'addebito bancario.

---

## 9. ADER / PagoPA / cartelle esattoriali / avvisi

Rami:

- atto originale → `SODDISFATTO`;
- identificativi pratica → `SODDISFATTO`;
- snapshot debito ufficiale → `ATTESO` quando non presente;
- piano rate / RAV / PagoPA → `ATTESO` quando applicabile;
- scadenze → `ATTESO`/`SODDISFATTO` secondo dati disponibili;
- quietanza/attestazione → `ATTESO`;
- movimento finanziario → `ATTESO`;
- nuovo snapshot ufficiale → `ATTESO` dopo pagamento quando necessario;
- chiusura fascicolo → `ATTESO`.

Il pagamento collegato non modifica automaticamente il residuo ADER ufficiale.

---

## 10. Assegni

```text
assegno ↔ carnet
assegno ↔ allocazioni N:M ↔ fatture
assegno ↔ addebito bancario
```

Rami:

- assegno/carnet → `SODDISFATTO`;
- allocazioni → `DA_VERIFICARE` salvo chiavi certe;
- addebito bancario → `ATTESO`;
- chiusura allocazioni → `ATTESO`.

Emissione assegno ≠ addebito.

---

## 11. PayPal

Rami:

- transazioni → `SODDISFATTO`;
- collegamento fornitore/fattura → `DA_VERIFICARE` quando non univoco;
- commissioni → `SODDISFATTO`;
- payout → `ATTESO`;
- accredito bancario → `ATTESO`.

---

## 12. Mutui / finanziamenti

Rami:

- contratto / estratto mutuo → `SODDISFATTO`;
- piano rate → `SODDISFATTO`;
- quota capitale / interessi → `SODDISFATTO` o `DA_VERIFICARE`;
- rata bancaria → `ATTESO`;
- residuo aggiornato → `ATTESO`.

```text
mutuo ↔ piano rate ↔ capitale/interessi ↔ movimento banca ↔ residuo
```

---

## 13. Verbali auto

Rami:

- verbale originale → `SODDISFATTO`;
- veicolo/targa → `SODDISFATTO`;
- conducente → `DA_VERIFICARE` quando non documentato;
- scadenza/importo → `SODDISFATTO`;
- pagamento → `ATTESO`;
- movimento banca/cassa → `ATTESO`;
- chiusura pratica → `ATTESO`.

---

## 14. Import Documenti ↔ Google Drive

### Principio

`Import Documenti`, `Drive/Da elaborare` e `PEC/email` sono ingressi diversi dello stesso `INTAKE_DOCUMENTALE`.

Non devono esistere pipeline indipendenti con logiche divergenti.

```text
Import Documenti ─┐
Drive watcher ─────┼→ INTAKE DOCUMENTALE → CLASSIFICAZIONE → VALIDATORE DOMINIO
PEC / Email ───────┘
```

### Upload da Import Documenti

Sequenza obbligatoria:

```text
UPLOAD
 ↓
source_asset
 ↓
hash / deduplica
 ↓
classificazione
 ↓
parser
 ↓
validazione
 ↓
fatti canonici + expectation
 ↓
routing fisico Drive
```

Dopo processamento riuscito il documento va fisicamente nella cartella `Elaborate` del dominio riconosciuto.

Esempi:

```text
Import Documenti
→ riconosce CORRISPETTIVO
→ validazione OK
→ Drive / Corrispettivi / Elaborate
```

```text
Import Documenti
→ riconosce CARTELLA ESATTORIALE
→ validazione OK
→ Drive / CARTELLE ESATTORIALI / Elaborate
```

Il file non deve essere parcheggiato in `Da elaborare` dopo un processamento concluso con successo.

### File caricato direttamente in Drive / Da elaborare

Il watcher deve osservare:

- Drive File ID;
- versione/revision;
- hash;
- MIME;
- cartella dominio;
- stato ultimo processamento;
- parser version.

Flusso:

```text
Drive / <dominio> / Da elaborare / nuovo-file
 ↓
watcher rileva nuovo ID/versione
 ↓
claim idempotente
 ↓
hash + deduplica
 ↓
parser + validazione
 ↓
SUCCESSO → Elaborate
ERRORE TECNICO → Errori
AMBIGUO → resta Da elaborare + stato DA_VERIFICARE
```

Un file ambiguo non deve essere riprocessato in loop. Si riprova solo quando:

- cambia il file/versione;
- cambia il parser/versione;
- viene richiesto manualmente.

### Condizione di spostamento

Lo spostamento fisico a `Elaborate` avviene solo dopo:

1. persistenza della fonte;
2. hash/deduplica;
3. classificazione valida;
4. estrazione minima necessaria;
5. scrittura dei fatti canonici;
6. creazione delle expectation;
7. audit del processamento.

Questo evita di perdere la posizione operativa del file se il processo si interrompe a metà.

---

## 15. Relazioni bidirezionali canoniche

Bidirezionale significa:

- navigazione da entrambi i lati;
- propagazione di stato tramite eventi;
- tracciabilità;
- possibilità di aprire le entità collegate.

Non significa doppia proprietà o doppia scrittura.

Relazioni principali:

- documento ↔ fonti Drive/upload/PEC;
- fattura ↔ soggetto ↔ righe;
- riga fattura ↔ alias fornitore ↔ prodotto canonico;
- fattura ↔ IVA;
- fattura ↔ obbligo ↔ partita aperta;
- obbligo ↔ riconciliazione ↔ movimento finanziario;
- riconciliazione ↔ Prima Nota ↔ contabilità;
- XML RT ↔ giorno fiscale ↔ IVA ↔ ricavo;
- giorno RT ↔ chiusure POS ↔ credito gestore ↔ payout ↔ accredito;
- F24 ↔ righe tributo ↔ versione codice ↔ crediti/compensazioni ↔ quietanza ↔ banca;
- cedolino ↔ dipendente ↔ componenti ↔ netto ↔ acconti/saldo ↔ banca;
- cedolino ↔ expectation F24 ↔ contributi/ritenute;
- atto ADER ↔ snapshot ↔ rateizzazione ↔ PagoPA/RAV ↔ pagamento ↔ nuovo snapshot;
- assegno ↔ carnet ↔ allocazioni ↔ fatture ↔ addebito banca;
- PayPal ↔ fattura/fornitore ↔ commissioni ↔ payout ↔ banca;
- mutuo ↔ rate ↔ capitale/interessi ↔ banca ↔ residuo;
- verbale ↔ veicolo ↔ conducente ↔ pagamento;
- anomalia ↔ entità ↔ regola ↔ decisione operatore.

Esempio corretto:

```text
Fattura → crea obbligo
Movimento banca → soddisfa expectation finanziaria
Riconciliazione → chiude obbligo
Fattura → riflette stato PAGATA
```

Ma:

```text
Banca NON riscrive la fattura
Fattura NON riscrive il movimento banca
```

La relazione di riconciliazione è un record autonomo, versionato e auditabile.

---

## 16. Coerenza e attività da completare

`Home → Attività da completare` e `Controllo → Coerenza e anomalie operative` devono leggere direttamente le expectation aperte.

Devono rendere visibili almeno:

- prove bancarie attese;
- quietanze attese;
- snapshot ADER attesi;
- chiusure POS mancanti;
- payout/accrediti mancanti;
- F24 attesi dalle paghe;
- pagamenti stipendio mancanti;
- scadenze superate;
- parser ambigui;
- documenti in `Da elaborare` non risolti;
- processi apparentemente completi con almeno una expectation aperta.

Questo è il meccanismo che impedisce al sistema di “non aspettarsi niente”.

---

## 17. Modello dati minimo dell'Expectation Engine

Una expectation dovrebbe avere almeno:

```json
{
  "expectationId": "...",
  "processId": "...",
  "entityType": "invoice_supplier",
  "entityId": "...",
  "expectationType": "FINANCIAL_EVIDENCE",
  "status": "ATTESO",
  "required": true,
  "expectedAmount": 1250.00,
  "currency": "EUR",
  "expectedPartyId": "...",
  "dueDate": "2026-09-15",
  "evidenceRefs": [],
  "createdByEventId": "...",
  "satisfiedByEventId": null,
  "ruleVersion": "...",
  "createdAt": "...",
  "updatedAt": "..."
}
```

Il matching con un evento futuro deve essere idempotente e auditabile.

---

## 18. Regole di autonomia

- osservazione, hash, deduplica tecnica e proiezioni deterministiche possono essere automatiche;
- classificazioni ambigue restano `DA_VERIFICARE`;
- riconciliazioni automatiche solo con causa univoca e quadratura esatta;
- stesso importo non basta;
- documenti e prove finanziarie restano fatti distinti;
- azioni distruttive Drive richiedono policy amministrativa, audit e recuperabilità;
- agenti L0/L1 possono analizzare e proporre;
- L2 resta disabilitato;
- L3 richiede conferma umana + riconferma PIN;
- L4 vietato.

---

## 19. Ordine di implementazione raccomandato

1. `Expectation Engine`;
2. intake unico (`Import Documenti`, watcher Drive, PEC/email);
3. obligation/open-item engine;
4. motore centrale di riconciliazione;
5. Prima Nota e proiezioni contabili;
6. Coerenza e chiusura processo;
7. UI ad albero animato e navigazione bidirezionale.

Non costruire nuove pagine isolate prima di avere il contratto eventi/expectation sottostante.

---

## 20. Definition of Done del progetto

Per ogni blocco di sviluppo:

```text
sviluppo
 ↓
test automatici
 ↓
audit
 ↓
commit
 ↓
push
 ↓
merge su main
 ↓
deploy Render
 ↓
smoke test sulla versione pubblicata
 ↓
BLOCCO COMPLETATO
```

Il merge non equivale a deploy riuscito.

La fase deve essere considerata conclusa solo quando:

- il commit previsto è su `main`;
- Render ha pubblicato quel commit/versione;
- health/smoke test passano;
- gli endpoint principali rispondono;
- nessuna migrazione o job risulta fallito;
- il risultato è registrato nell'audit.

Finché il deploy Render non è effettivamente verificabile, il sistema deve riportare `DEPLOY_NON_VERIFICATO` e non dichiarare successo.

---

## 21. Istruzione a Codex

Codex deve trattare questo documento insieme a:

- `docs/anatomia-gestionale/README.md`
- `docs/anatomia-gestionale/TOPOLOGIA_FLUSSI.md`
- `docs/anatomia-gestionale/topologia-flussi.json`
- `docs/anatomia-gestionale/catalogo.json`
- `docs/MOTORE_EVENTI_CONTABILITA.md`
- `docs/REGOLE_DOMINIO.md`

come specifiche complementari.

In caso di conflitto, questa specifica prevale per:

1. nascita anticipata dei rami attesi;
2. regole di chiusura dei processi;
3. routing fisico `Da elaborare → Elaborate/Errori`;
4. convergenza di Import Documenti e Drive watcher nello stesso intake;
5. definition of done merge + deploy Render + smoke test.

Il codice deve implementare il comportamento, non limitarsi a rappresentarlo graficamente.