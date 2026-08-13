# Manutenzione documentale Google Drive

## Stato operativo

La fase attuale è esclusivamente di inventario e pianificazione. Il gestionale legge Google Drive, persiste file e cartelle in MongoDB e produce proposte verificabili. Non rinomina, sposta, cestina o elimina elementi su Drive.

Il client Google usa lo scope `drive.readonly` ed espone soltanto elenco e download. I report di manutenzione sono endpoint `GET` autenticati e non ricevono il client Drive.

## Inventario dell'albero

Una scansione completa persiste:

- file in `drive_files` con `driveFileId`, checksum, dimensione, genitore, `pathSegments`, percorso visuale e `scanId`;
- cartelle in `drive_folders`, inclusa la radice e le cartelle vuote, con `driveFolderId`, `parentId`, `pathSegments` e `scanId`;
- esito e conteggi in `drive_import_runs`.

`pathSegments` è la rappresentazione autorevole. La stringa percorso resta disponibile per ricerca e visualizzazione, ma non basta a ricostruire l'albero quando un nome Drive contiene `/`.

I record non osservati vengono disattivati in MongoDB soltanto dopo una scansione senza errori. Questo non modifica gli originali su Drive.

La prima esecuzione successiva a questa migrazione si arresta se trova un inventario, collegamento o documento
Drive preesistente senza `rootFolderId`. Dopo aver verificato che `DRIVE_DOCUMENT_INDEX_ROOT_FOLDER_ID` identifica la radice corretta,
impostare temporaneamente in Render `DRIVE_DATA_ROOT_ADOPTION_CONFIRM` allo stesso identico ID. Una volta
completata con successo l'adozione, la variabile di conferma può essere rimossa. Il cambio successivo della
radice è bloccato e richiede una migrazione esplicita.

Ogni import acquisisce inoltre un lock Mongo per la radice (`DRIVE_IMPORT_LEASE_MS`, 30 minuti per default),
lo rinnova durante il lavoro e verifica di esserne ancora titolare prima di disattivare record o completare il
run. Due istanze Render non possono quindi finalizzare scansioni concorrenti sullo stesso inventario.

## Attendibilità della deduplicazione

| Evidenza | Classificazione | Conseguenza |
|---|---|---|
| SHA-256 valido uguale e nessuna dimensione dichiarata discordante | `EXACT_DUPLICATE` | gruppo certo da sottoporre a revisione |
| MD5 valido uguale e stessa dimensione | `DA_VERIFICARE` | candidato forte, mai promosso automaticamente |
| stesso nome e stessa dimensione senza hash | `DA_VERIFICARE` | indizio informativo |
| hash o dimensioni incompatibili | `HASH_CONFLICT` | blocco e verifica obbligatoria |

La copia canonica viene proposta con una regola deterministica per rendere il report ripetibile. La proposta non autorizza cancellazioni e non modifica lo stato dei file.

## API di sola lettura

- `GET /api/drive-data/duplicates`: gruppi di duplicati, candidati e conflitti;
- `GET /api/drive-data/folder-plan`: proposta di tassonomia per tutte le cartelle inventariate, comprese quelle vuote.

Ogni risposta contiene:

- versione dello schema e data di generazione;
- `scanId`, conteggi e digest SHA-256 dell'inventario;
- stato di completezza e motivi di blocco;
- salvaguardie che dichiarano assenza di mutazioni e azioni automatiche;
- proposte `KEEP`, `MOVE_RENAME` o `REVIEW`.

`MOVE_RENAME` è il nome di una proposta nel report, non un comando eseguibile. Le risposte hanno `actionable: false` e richiedono sempre revisione umana.

## Condizioni di blocco

Il report non produce proposte se:

- manca un'esecuzione completa;
- l'ultimo inventario contiene errori;
- file o cartelle attivi appartengono a scansioni diverse;
- la radice dell'inventario non coincide con quella canonica registrata;
- i conteggi MongoDB non coincidono con quelli registrati nel run;
- l'inventario supera il limite configurato;
- l'albero delle cartelle non è ancora disponibile.

## Tassonomia proposta

La tassonomia raggruppa le cartelle in aree numerate: sistema, vendite, fatture, personale, banca, fisco, riscossione, veicoli e finanziamenti. I percorsi usati direttamente dagli importatori sono protetti e rimangono `REVIEW` finché il codice non supporta contemporaneamente posizione attuale e destinazione proposta.

Le cartelle non riconosciute restano `TAXONOMY_UNMAPPED`; non vengono riclassificate per somiglianza del nome.

## Fasi successive

1. Eseguire e validare una scansione reale completa.
2. Esaminare duplicati, conflitti e collisioni di destinazione.
3. Approvare un manifest immutabile con digest dell'inventario sorgente.
4. Introdurre, in un intervento separato, quarantena e spostamenti reversibili con MFA, audit e controllo di concorrenza.
5. Considerare una rimozione soltanto per duplicati confermati dopo quarantena, nuova verifica del contenuto e approvazione esplicita.

Nessuna fase autorizza cancellazioni automatiche.
