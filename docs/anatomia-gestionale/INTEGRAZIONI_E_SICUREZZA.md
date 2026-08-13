# Valutazione integrazioni esterne

Valutazione aggiornata al 13 agosto 2026. Nessuno dei progetti analizzati è una fonte autorevole per fatti fiscali, pagamenti o scritture contabili.

## Strix

Il progetto corretto è [`usestrix/strix`](https://github.com/usestrix/strix), strumento open source Apache-2.0 per penetration test agentici. La valutazione è stata effettuata sulla release [`v1.5.3`](https://github.com/usestrix/strix/releases/tag/v1.5.3) e sul commit `8ca0c4a9b8b353edd5fa398710c9d313540746d1`.

### Decisione

`PILOTA_ISOLATO`, non dipendenza del gestionale.

Strix può trovare problemi di autenticazione, autorizzazione, IDOR, CSRF, upload, parser XML/PDF, segreti e dipendenze. Non misura la correttezza contabile, la quadratura F24, la qualità OCR o l'identità di una transazione.

Non viene aggiunto ora alla CI ordinaria perché:

- il progetto si dichiara ancora alpha nel proprio `pyproject.toml`;
- avvia strumenti offensivi e container con capacità di rete elevate;
- il sorgente può essere montato nel container;
- richiede un modello AI e può produrre costi e risultati non deterministici;
- un exit code riuscito non prova necessariamente copertura completa;
- la telemetria va disabilitata esplicitamente.

### Piano autorizzabile

1. ambiente staging isolato con MongoDB e documenti sintetici;
2. runner effimero senza credenziali Drive, PEC, banca, Render o produzione;
3. trigger esclusivamente manuale `workflow_dispatch`;
4. permessi GitHub `contents: read`, niente `pull_request_target`;
5. `STRIX_TELEMETRY=0` e provider AI con zero data retention;
6. release, immagine e dipendenze fissate a versione e digest;
7. nessun auto-fix, commit, push o merge;
8. timeout, limiti CPU/RAM/PID e retention breve dei report;
9. controllo del `run.json`, non del solo exit code;
10. almeno tre esecuzioni confrontabili prima di usarlo come controllo PR non bloccante.

Un futuro controllo bloccante potrà riguardare soltanto vulnerabilità critiche o alte confermate da una persona. I dettagli di runtime e telemetria sono documentati nelle fonti ufficiali di [Strix](https://github.com/usestrix/strix/tree/8ca0c4a9b8b353edd5fa398710c9d313540746d1).

## Esito dello screenshot Public APIs/APIlayer

Lo screenshot allegato identifica [`public-apis/public-apis`](https://github.com/public-apis/public-apis). È un catalogo comunitario MIT di servizi pubblici, non una libreria, un provider unico o un dataset certificato.

### Decisione

`NON_INTEGRATO`. Il catalogo non viene copiato nel gestionale e non diventa una sezione applicativa.

La licenza MIT copre il catalogo, non i singoli servizi elencati. I campi Auth, HTTPS e CORS e i controlli sui link non certificano accuratezza, SLA, privacy, titolarità dei dati o adeguatezza fiscale. Anche il marketplace APIlayer include fornitori terzi e i relativi [termini](https://www.ideracorp.com/Legal/APILayer/Marketplace-Terms-of-Use) escludono garanzie generali di accuratezza, affidabilità e disponibilità.

Lo screenshot ha avuto un solo uso: individuare esigenze concrete da verificare successivamente presso le rispettive fonti ufficiali. La valutazione di singole API resta sospesa finché non viene ripresa come attività dedicata; non viene mantenuto un elenco generico di servizi.

### Gate prima di qualunque prova commerciale

- DPA firmato e verifica di subprocessori e trasferimenti extra-UE;
- retention, addestramento sui dati, residenza e cancellazione definiti per contratto;
- SLA e supporto contrattuali, non soli claim commerciali;
- dataset di prova sintetico o anonimizzato;
- adapter provider-neutral e schema interno canonico;
- chiave soltanto nelle variabili protette dell'ambiente;
- timeout, retry limitato, circuit breaker e monitoraggio quota;
- nessun dato personale nei log;
- salvataggio di provider, versione, timestamp, input hash e confidenza;
- golden dataset e accuratezza esatta dei campi critici;
- ogni incertezza in revisione, mai auto-posting contabile.

## Regola generale

Le integrazioni esterne possono fornire un'evidenza o un arricchimento. Non diventano proprietarie di fattura, obbligo, movimento, riconciliazione o scrittura. Se il servizio non risponde o cambia comportamento, il gestionale deve restare utilizzabile in modalità fail-safe e conservare l'ultimo dato con la sua provenienza.
