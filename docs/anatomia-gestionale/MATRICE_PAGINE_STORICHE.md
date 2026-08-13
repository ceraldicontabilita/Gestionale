# Matrice delle pagine dello snapshot storico

Questa matrice cattura integralmente le 62 pagine censite nello snapshot del 13 agosto 2026 e le assegna alla nuova anatomia. Non è una lista di schermate da ricopiare: è il registro che impedisce di dimenticare una capacità o di ricrearla due volte.

Stato dell'audit storico: `V` verificata, `R` in revisione, `U` non verificata. La colonna Decisione indica cosa fare nella nuova applicazione.

## Accesso, Home e ingresso dati

| # | Pagina/route storica | Audit | Destinazione canonica | Decisione |
|---:|---|:---:|---|---|
| 1 | Login `/login` | U | `amministrazione.utenti_sicurezza` | Ridisegnare su identità, ruoli, sessione e MFA nuovi. |
| 2 | Gestione riservata `/gestione-riservata` | U | Nessuna | Non trasferire movimenti extracontabili o volumi non documentati. |
| 3 | Dashboard `/` | U | `home.quadro_operativo` | Consolidare KPI soltanto da entità canoniche. |
| 4 | Inserimento rapido `/rapido` | U | `documenti.acquisizione_inbox` | Unificare con intake e Provvisoria; niente writer diretto parallelo. |
| 29 | Learning Machine `/learning-machine` | U | `home.assistente_memoria` | Ridisegnare come proposta versionata, mai riscrittura silenziosa. |
| 48 | Agenti AI `/agenti` | U | `amministrazione.configurazione_agenti` | Reintrodurre dopo il consolidamento dei domini. |
| 50 | Impostazioni AI `/impostazioni-ai` | U | `amministrazione.configurazione_agenti` | Unificare provider, limiti e approvazioni. |
| 59 | Mappa gestionale `/mappa-gestionale` | U | `controllo.anatomia` | Superata dal catalogo machine-readable validato in CI. |

## Fatture, fornitori e corrispettivi

| # | Pagina/route storica | Audit | Destinazione canonica | Decisione |
|---:|---|:---:|---|---|
| 5 | Archivio fatture `/fatture` | U | `documenti.fatture_fornitori` | Ricostruire sul solo ciclo passivo canonico. |
| 6 | Corrispettivi `/fatture/corrispettivi` | U | `documenti.corrispettivi_xml` | Mantenere XML RT separato da POS e banca. |
| 7 | Fornitori `/fornitori` | U | `amministrazione.fornitori_soggetti` | Chiave legale stabile e merge conflitti esplicito. |
| 61 | Verifica fatture estere `/fatture-estere-verifica` | U | `documenti.fatture_fornitori` | Sottocoda di verifica, non secondo store fatture. |

## Prima Nota e personale contabile

| # | Pagina/route storica | Audit | Destinazione canonica | Decisione |
|---:|---|:---:|---|---|
| 8 | Prima Nota `/prima-nota` | R | `prima_nota.registro_saldi` | Conservare i conti nuovi e le prove esplicite. |
| 9 | Pulizia Prima Nota `/prima-nota/pulizia` | U | `controllo.anomalie` | Solo anteprima, approvazione, audit e operazioni reversibili. |
| 10 | Cedolini e salari `/salari` | U | `documenti.cedolini_paghe` | Identità dipendente, periodo, dovuto, acconti e saldo. |

I cinque tab storici Cassa, Banca, SumUp, Soci e Provvisori confluiscono rispettivamente in `prima_nota.cassa`, `prima_nota.banca`, `prima_nota.carte_circuiti`, `prima_nota.finanziamenti_soci` e `prima_nota.provvisoria`.

## Veicoli, noleggio e verbali

| # | Pagina/route storica | Audit | Destinazione canonica | Decisione |
|---:|---|:---:|---|---|
| 11 | Flotta noleggio `/noleggio` | U | `amministrazione.cespiti_veicoli` | Dominio secondario dopo contabilità e fatture. |
| 12 | Verbali noleggio `/noleggio/verbali` | R | `riconciliazione.verbali_audit` | Un solo schema verbale e collegamento temporale al veicolo. |
| 13 | Costi noleggio `/noleggio/costi` | R | `amministrazione.cespiti_veicoli` | Derivare da fatture e movimenti, non da totali autonomi. |
| 14 | Dettaglio verbale `/verbali-noleggio/:identificativo` | V | `riconciliazione.verbali_audit` | Conservare come dettaglio della stessa entità. |

## Contabilità e fiscalità

| # | Pagina/route storica | Audit | Destinazione canonica | Decisione |
|---:|---|:---:|---|---|
| 15 | Piano dei Conti `/contabilita` | V | `controllo.piano_conti` | Definire un solo piano versionato. |
| 16 | Bilancio `/contabilita/bilancio` | R | `controllo.bilancio` | Una sola pipeline alimentata dal giornale. |
| 17 | Verifica Bilancio `/contabilita/verifica` | R | `controllo.bilancio` | Vista di controllo della stessa pipeline. |
| 18 | Libro Giornale `/contabilita/giornale` | R | `prima_nota.libro_giornale_mastro` | Scritture bilanciate e collegamenti alle evidenze. |
| 19 | Controllo mensile `/contabilita/controllo` | R | `controllo.chiusura_mensile` | Checklist e chiusura periodo approvata. |
| 20 | Calendario fiscale `/contabilita/calendario` | R | `home.scadenze_priorita` | Derivare da obblighi e regole versionate. |
| 21 | Cespiti `/contabilita/cespiti` | R | `amministrazione.cespiti_veicoli` | Dopo piano dei conti e ciclo passivo. |
| 22 | Finanziaria `/contabilita/finanziaria` | V | `amministrazione.finanziamenti_mutui` | Consolidare finanziamenti, rate e prove. |
| 23 | Chiusura esercizio `/contabilita/chiusura` | V | `controllo.chiusura_mensile` | Estendere il modello periodo a chiusura annuale. |
| 24 | Budget `/contabilita/budget` | U | `controllo.budget_previsioni` | Versioni previsionali separate dai consuntivi. |
| 25 | Mutui `/contabilita/mutui` | U | `amministrazione.finanziamenti_mutui` | Un solo piano rate con capitale e interessi. |
| 26 | Contabilità avanzata `/contabilita/avanzata` | U | `controllo.bilancio` | Assorbire solo funzioni non duplicate e provate. |
| 27 | Utile obiettivo `/contabilita/utile` | U | `controllo.budget_previsioni` | Scenario, non fatto contabile. |
| 28 | Previsioni acquisti `/contabilita/previsioni-acquisti` | U | `controllo.budget_previsioni` | Usare storico fatture e ipotesi dichiarate. |
| 30 | Scadenze `/scadenze` | U | `home.scadenze_priorita` | Un solo registro di obblighi e partite aperte. |
| 31 | Ritenute `/ritenute` | U | `amministrazione.iva_fiscalita` | Dominio fiscale versionato e riconciliabile. |
| 60 | Gestione IVA `/iva` | U | `controllo.iva` | Liquidazioni versionate e anti-doppia detrazione. |
| 62 | Dati ISA `/contabilita/dati-isa` | R | `amministrazione.iva_fiscalita` | Output fiscale derivato, mai store concorrente. |

La pagina amministrativa `situazione-fiscale`, montata ma assente dal vecchio catalogo, confluisce in `controllo.affidabilita_fiscale`.

## Riconciliazione e tesoreria

| # | Pagina/route storica | Audit | Destinazione canonica | Decisione |
|---:|---|:---:|---|---|
| 32 | Dashboard riconciliazione `/riconciliazione` | U | `riconciliazione.coda_generale` | Una sola coda multi-dominio. |
| 33 | Banca `/riconciliazione/banca` | U | `riconciliazione.coda_generale` | Alimentata dal solo importatore estratti canonico. |
| 34 | F24 `/riconciliazione/f24` | U | `riconciliazione.f24_banca` | Superata dalla riconciliazione nuova con MFA e prove. |
| 35 | Stipendi `/riconciliazione/stipendi` | U | `riconciliazione.salari` | Acconti e saldo con identità dipendente. |
| 36 | Documenti `/riconciliazione/documenti` | U | `riconciliazione.coda_generale` | La causa deve essere un'entità, non un file generico. |
| 37 | Archivio bonifici `/riconciliazione/archivio-bonifici` | U | `documenti.estratti_banca_carte` | Disposizione distinta dall'addebito reale. |
| 38 | Assegni `/riconciliazione/assegni` | R | `riconciliazione.assegni` | Solo modello N:M a quote. |
| 39 | PayPal `/riconciliazione/paypal` | R | `riconciliazione.paypal_pagopa` | Una sola pipeline e un solo mapping provider. |
| 40 | Coerenza POS `/riconciliazione/coerenza-pos` | U | `riconciliazione.carte_pos` | XML, POS, credito, payout e accredito distinti. |
| 44 | Movimenti banca `/riconciliazione/movimenti-banca` | U | `documenti.estratti_banca_carte` | Indice delle prove finanziarie, non seconda riconciliazione. |
| 52 | PagoPA `/riconciliazione/pagopa` | U | `riconciliazione.paypal_pagopa` | IUV e ricevuta distinti dal movimento bancario. |

Lo snapshot presentava due livelli di tab per la riconciliazione: otto voci nell'hub e sette tab nel componente interno. La nuova applicazione ne mantiene uno solo, definito dal catalogo.

## Documenti, strumenti e integrazioni

| # | Pagina/route storica | Audit | Destinazione canonica | Decisione |
|---:|---|:---:|---|---|
| 41 | Import documenti `/documenti/import` | U | `documenti.acquisizione_inbox` | Porta unica per upload, email, PEC e Drive. |
| 42 | Archivio documenti `/documenti/archivio` | U | `documenti.archivio` | Documento unico con più fonti. |
| 43 | Verifica coerenza `/strumenti` | U | `controllo.anomalie` | Controlli deterministici e casi espliciti. |
| 45 | Commercialista `/strumenti/commercialista` | U | `amministrazione.commercialista` | Pacchetti solo da dati verificati. |
| 46 | Pianificazione `/strumenti/pianificazione` | U | `controllo.budget_previsioni` | Separare ipotesi e consuntivi. |
| 47 | Visure `/strumenti/visure` | U | `amministrazione.integrazioni_scheduler` | Adapter di arricchimento, non fonte contabile. |
| 49 | Impostazioni email F24 `/impostazioni-f24-email` | U | `amministrazione.integrazioni_scheduler` | Configurazione di un solo intake. |
| 51 | Integrazione OpenAPI `/integrazioni` | U | `amministrazione.integrazioni_scheduler` | Candidati esterni sempre provider-neutral. |
| 53 | Mittenti attendibili `/integrazioni/mittenti-email` | V | `amministrazione.integrazioni_scheduler` | Conservare whitelist esatta e audit. |

## Amministrazione e diagnostica

| # | Pagina/route storica | Audit | Destinazione canonica | Decisione |
|---:|---|:---:|---|---|
| 54 | Admin sistema `/admin` | U | `amministrazione.integrazioni_scheduler` | Dividere configurazione, sicurezza e audit per proprietario. |
| 55 | Admin MFA `/admin/mfa` | U | `amministrazione.utenti_sicurezza` | Superata dallo step-up MFA nuovo. |
| 56 | Elaborazioni `/admin/elaborazioni` | R | `amministrazione.integrazioni_scheduler` | Un solo registro job con lease e checkpoint. |
| 57 | Elaborazioni legacy `/admin/batch-processor` | R | `controllo.audit_rollback` | Non ricreare; migrare azioni utili una alla volta. |
| 58 | Utenti `/utenti` | U | `amministrazione.utenti_sicurezza` | Ruoli admin, operatore e sola lettura. |

## Esito della cattura

- Tutte le 62 pagine catalogate hanno una destinazione o una decisione esplicita.
- La pagina storica non determina lo schema dati: lo determina il proprietario funzionale nel `catalogo.json`.
- Una destinazione comune significa consolidamento, non perdita di funzione.
- Nessuna route storica è una dipendenza runtime.
- Le parti non verificate restano requisiti da convalidare, non funzionalità da dichiarare già complete.
