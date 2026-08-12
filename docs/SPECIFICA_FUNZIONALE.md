# Impresa Semplice — Specifica funzionale unica

Versione iniziale consolidata: 12/08/2026.

Questa specifica sostituisce la copia meccanica delle logiche del gestionale legacy. `GestionaleCloud` resta una fonte di riferimento per parser, formati e casi reali, ma il nuovo progetto deve conservare solo regole coerenti, verificabili e comprensibili.

## 1. Principio generale

Impresa Semplice non deve indovinare la contabilità. Deve raccogliere prove, collegarle e distinguere sempre:

1. cosa sappiamo;
2. cosa è documentato;
3. cosa è solo proposto;
4. cosa è realmente riconciliato;
5. cosa manca o è ambiguo.

Regole madri:

- documento ≠ pagamento;
- disposizione di pagamento ≠ pagamento eseguito;
- movimento bancario/carta reale = prova finanziaria;
- la Cassa può essere attestata manualmente;
- importo uguale ≠ stessa operazione;
- un automatismo può confermare solo una relazione univoca;
- un caso ambiguo resta `DA_VERIFICARE`;
- ogni numero deve poter tornare alla propria fonte;
- le relazioni sono bidirezionali, ma la fonte autorevole di ogni fatto è una sola.

## 2. Struttura dell'applicazione

Le sezioni principali sono:

1. Home;
2. Prima Nota;
3. Documenti;
4. Riconciliazione;
5. Amministrazione;
6. Controllo.

Le specializzazioni (F24, cedolini, assegni, corrispettivi, riscossione, fornitori ecc.) devono vivere come schede o filtri interni, non come applicazioni indipendenti.

## 3. Prima Nota

Registri iniziali:

- CASSA
- BANCA
- MASTERCARD
- SALARI
- FINANZIAMENTI_SOCI
- PROVVISORIA

Ogni riga deve avere almeno:

- data;
- conto;
- entrata/uscita;
- importo positivo;
- descrizione;
- tipo;
- fonte;
- stato;
- documento o relazione collegata;
- evidenze;
- saldo progressivo.

### 3.1 Saldo progressivo

Per ogni riga:

`saldo precedente + entrate - uscite = saldo progressivo`

L'ordinamento deve essere deterministico: data e, a parità di data, sequenza/istante di creazione.

### 3.2 Riporto anni precedenti

Ogni Prima Nota deve iniziare con una riga sintetica:

`01/01/AAAA — Riporto saldo anni precedenti`

Il riporto:

- deriva dal saldo finale dell'anno precedente;
- non è ricavo né costo;
- esiste una sola volta per conto e anno;
- può essere consolidato;
- se il passato cambia dopo il consolidamento, il sistema segnala `da riallineare` invece di correggerlo silenziosamente.

### 3.3 Cassa

È l'unico conto che può essere confermato tramite attestazione manuale dell'operatore.

### 3.4 Banca e Mastercard

La riconciliazione finale richiede una prova finanziaria reale. PDF bonifico, ordine di pagamento o documento predisposto non equivalgono a un addebito.

Mastercard resta distinta dalla banca. Un addebito banca per saldo carta non deve duplicare i singoli acquisti carta.

### 3.5 Salari

Il cedolino stabilisce il dovuto. Acconti e saldi sono ammessi. Stato finale `RICONCILIATO` solo quando le evidenze reali coprono il dovuto. Identità del dipendente prima dell'importo.

### 3.6 Finanziamenti soci

Separati da ricavi e costi ordinari. Ogni apporto, finanziamento, restituzione o rimborso conserva socio, direzione e fonte.

### 3.7 Provvisoria

Zona obbligatoria per elementi ambigui, incompleti, senza prova sufficiente o con più destinazioni plausibili.

## 4. Corrispettivi, Cassa e POS

Le fonti sono separate:

1. XML RT = fonte fiscale;
2. chiusura operativa serale = controllo operativo;
3. chiusure POS reali = prova dei terminali;
4. accrediti finanziari = prova dell'arrivo del denaro.

### 4.1 XML RT

L'XML genera una sola entrata Cassa:

`CASSA + totale corrispettivo giornaliero`

L'eventuale quota elettronica dichiarata nell'XML non sostituisce i terminali POS reali.

### 4.2 Chiusure POS

Per ogni gestore si registra separatamente il dato reale, inizialmente almeno:

- NUMIA;
- SUMUP.

`0` è un dato valido: significa nessun incasso sul terminale.
`null/assente` significa dato non disponibile.

Una chiusura POS genera:

- uscita dalla Cassa per il valore transitato sul terminale;
- credito verso il relativo gestore.

Non genera nuovo ricavo.

### 4.3 Contante atteso

Il contante atteso si calcola solo se esiste la chiusura operativa e sono presenti tutte le chiusure POS reali necessarie:

`chiusura operativa - POS reali = contante atteso`

Se manca un terminale, non si stima il valore usando l'XML.

### 4.4 Controllo fiscale

`chiusura operativa ↔ XML RT`

Una differenza genera un'anomalia. Il sistema non corregge automaticamente nessuna delle due fonti.

### 4.5 Accrediti Numia e SumUp

NUMIA:
- vendita POS → credito Numia;
- accredito BPM → chiusura credito Numia.

SUMUP:
- vendita POS → credito SumUp;
- payout Mastercard SumUp → chiusura credito SumUp;
- commissioni, rimborsi o chargeback restano componenti esplicite.

## 5. Documenti

Un unico motore documentale:

`ACQUISISCI → ARCHIVIA ORIGINALE → DEDUPLICA → RICONOSCI → ESTRAI → VALIDA → COLLEGA → SEGNALA`

Ogni documento conserva:

- nome originale;
- tipo;
- hash SHA-256;
- fonte o fonti;
- protocollo/identificativo quando disponibile;
- anno/periodo;
- dati estratti;
- stato di verifica;
- collegamenti.

Lo stesso hash proveniente da email, Drive e upload manuale è un solo documento con più fonti.

## 6. Collegamenti bidirezionali

I collegamenti devono essere navigabili in entrambe le direzioni:

- fattura ↔ fornitore ↔ pagamento ↔ movimento bancario;
- corrispettivo ↔ POS ↔ credito gestore ↔ accredito;
- F24 ↔ tributi ↔ quietanza ↔ movimento bancario ↔ dichiarazione;
- cedolino ↔ dipendente ↔ acconto/saldo ↔ banca;
- cartella ADER ↔ ente ↔ rateizzazione ↔ pagamenti ↔ situazione debitoria.

Il collegamento non duplica i dati. La relazione è separata e ogni fatto mantiene una sola fonte autorevole.

## 7. F24

Il modello F24, la quietanza e l'addebito finanziario sono prove diverse.

Il parser deve estrarre le singole righe:

- codice tributo;
- sezione;
- anno/periodo;
- codice ente/sede se presente;
- debito;
- credito.

Il saldo F24 non è automaticamente un costo.

### 7.1 Codici tributo

Un registro unico e versionato deve conservare:

`codice → descrizione ufficiale → sezione → natura → classificazione gestionale → fonte → validità → ultima verifica`

Codice sconosciuto:
- viene salvato;
- non viene inventata una classificazione;
- stato `DA_VERIFICARE`.

## 8. Riscossione / ADER

Dominio distinto dagli F24 con tipi quali:

- cartella di pagamento;
- intimazione/avviso;
- avviso di accertamento esecutivo;
- avviso di addebito INPS;
- rateizzazione;
- comunicazione somme dovute;
- pagoPA;
- quietanza;
- situazione debitoria/snapshot ADER.

Atto originale e situazione debitoria aggiornata non devono essere sovrascritti uno sull'altra.

Gli snapshot ADER sono versionati per data.

## 9. Email, PEC, Drive e scheduler

Le fonti documentali possono essere email, PEC, Drive, upload manuale e portali fiscali.

Lo scheduler deve:

- lavorare per UID/Message-ID e non per “non letto”;
- usare SHA-256;
- essere idempotente;
- mantenere checkpoint con finestra di sovrapposizione;
- non sovrapporre due esecuzioni dello stesso job;
- archiviare prima di classificare;
- ritentare errori tecnici, non dubbi fiscali;
- produrre audit di ogni esecuzione.

Frequenze iniziali:

- email/PEC: ogni 30 minuti;
- Drive fiscale: ogni ora;
- retry tecnici: ogni 2 ore;
- scadenze fiscali: una volta al giorno e a ogni nuovo documento;
- aggiornamento dizionario tributi: giornaliero o al primo codice sconosciuto.

## 10. Drive fiscale storico

La raccolta fiscale 2020–2026 con indici CSV, protocolli e manifest SHA-256 è una fonte di riferimento per:

- test dei parser;
- deduplicazione;
- regressione automatica;
- ricostruzione storica;
- collegamento tra dichiarazioni, F24, quietanze e banca.

I PDF non devono essere duplicati inutilmente in MongoDB: MongoDB conserva metadati, dati estratti, relazioni, stato e riferimenti alla fonte.

## 11. Sicurezza degli automatismi

- Nessuna azione finanziaria silenziosa.
- Ambiguo = `DA_VERIFICARE`.
- Le modifiche sensibili future richiedono MFA.
- Ogni modifica deve essere auditabile.
- Nessun parser può dichiarare un pagamento in assenza della prova prevista dal dominio.
