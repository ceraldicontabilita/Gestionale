# Topologia dei flussi canonici

Questo documento descrive come ingressi, eventi, entità canoniche e pagine si collegano nel gestionale. La definizione verificabile è [`topologia-flussi.json`](topologia-flussi.json); gli ID di entità, relazioni e pagine sono quelli di [`catalogo.json`](catalogo.json).

## Regola fondamentale

Una pagina non possiede una copia dei dati. È una proiezione o materialized view ricostruibile delle entità canoniche di cui mostra lo stato. Il solo proprietario dell'entità può modificarne il fatto autorevole; una pagina di un altro dominio può leggerlo, collegare evidenze o proporre un'azione, senza duplicarlo.

```text
ingresso esterno
    ↓
source_asset immutabile → document + provenienza + hash
    ↓ classificazione/handoff a un solo owner
entità canoniche di dominio
    ↓ eventi immutabili + invalidazione
proiezioni delle pagine
    ↓ controlli read-only
coherence_evaluation → anomaly → correzione del vero owner
```

Correzioni, note di credito, sostituzioni e storni sono eventi compensativi o di supersessione. Non cancellano né sovrascrivono silenziosamente la storia. Le proiezioni invalidate vengono ricostruite in modo idempotente.

Le due viste Home oggi interrogano `/api/dashboard` su richiesta e sono quindi `QUERY_VIEW`, non materialized view alimentate da eventi. `home.quadro_operativo` è una vista read-only presente. `home.attivita_aperte` è parziale: espone soltanto i contatori disponibili; non esistono ancora una coda canonica, l'assegnazione della revisione, comandi o eventi in uscita. Gli eventi elencati come input descrivono il contesto dei dati letti, non un job di refresh della pagina.

## Contratto di un evento

Ogni evento contiene almeno identificativo e tipo, data economica e data di registrazione, `evidenceRefs[]`, entità interessata, chiave di idempotenza, attore o job, correlazione, causa e versione dello schema. `sourceAssetId` compare fra le evidenze quando applicabile, ma non è obbligatorio per eventi interni che derivano da altri fatti canonici. Gli eventi sono immutabili e passano da un outbox transazionale per evitare il caso «dato scritto ma evento perso».

Una rettifica punta esplicitamente all'evento o record che sostituisce o storna. Il ricalcolo non modifica l'originale: emette `projection.invalidation_requested` e ricostruisce le viste derivate.

Il registry `events` nel JSON dichiara ogni evento utilizzato: proprietario, pagine e processor produttori/consumatori, entità, idempotenza, prove richieste, autonomia, retry, dead letter e semantica di rettifica. Un evento non registrato non può entrare nella topologia.

Gli eventi di ingresso sono grezzi e appartengono a Intake: non autorizzano IVA, scadenze o fatti di dominio. Processor espliciti trasformano l'input soltanto dopo i gate e producono eventi validati quali `invoice.supplier_validated`, `invoice.customer_validated`, `f24.model_validated`, `payroll.validated`, `receipt.day_validated` e `collection.act_validated`. `vat.entries_projected` è emesso soltanto da un processor di `CONTABILITA`.

## Ingressi e proprietari

| Ingresso | Evento | Primo proprietario | Entità principali | Deduplicazione |
|---|---|---|---|---|
| Drive | `drive.inventory_observed` | `INTAKE_DOCUMENTALE` | `drive_node`, `source_asset`, `document`, `document_source` | ID Drive/versione osservata e SHA-256 del documento. |
| Upload centralizzato | `upload.asset_received` | `INTAKE_DOCUMENTALE` | `source_asset`, `document`, `document_source`, `extraction` | Identità della fonte/versione e SHA-256. |
| PEC/email | `mail.message_received` | `INTAKE_DOCUMENTALE` | messaggio/allegato come `source_asset`, quindi documento | Casella, message ID, posizione allegato e SHA-256. |
| Fatture XML | `invoice.xml_received` | `INTAKE_DOCUMENTALE`, poi handoff | raw asset, documento, provenienza ed estrazione; i processor validati creano fattura, soggetto, obbligo e IVA | Fonte/versione e SHA-256; chiavi fattura soltanto dopo validazione. |
| Banca/carte | `treasury.statement_received` | `INTAKE_DOCUMENTALE`, poi `TESORERIA` | raw asset, documento, provenienza ed estrazione; movimento e prova soltanto dopo import validato | Fonte/versione e SHA-256; conto e transaction ID dopo validazione. |
| F24/quietanze/dichiarazioni | `fiscal.document_received` | `INTAKE_DOCUMENTALE`, poi `FISCO_F24` | raw asset, documento, provenienza ed estrazione; modello/righe/esiti soltanto dopo validazione | Fonte/versione e SHA-256; protocollo dopo validazione. |
| Cedolini/riepiloghi | `payroll.document_received` | `INTAKE_DOCUMENTALE`, poi `PAGHE` | raw asset, documento, provenienza ed estrazione; cedolino/componenti soltanto dopo validazione | Fonte/versione e SHA-256; dipendente/periodo dopo validazione. |
| Corrispettivi/POS | `receipt.xml_received` | `INTAKE_DOCUMENTALE`, poi `CORRISPETTIVI_POS` | raw asset, documento, provenienza ed estrazione; giorno/chiusure soltanto dopo validazione | Fonte/versione e SHA-256; impresa/data dopo validazione. |
| ADER/PagoPA/verbali | `collection.document_received` | `INTAKE_DOCUMENTALE`, poi handoff | raw asset, documento, provenienza ed estrazione; atto, PagoPA e verbale hanno validatori proprietari separati | Fonte/versione e SHA-256; chiavi di dominio dopo validazione. |

L'osservazione e l'hashing possono essere automatici. Classificazioni, identità o collegamenti ambigui restano in revisione. Ogni mutazione Drive richiede anteprima, `ADMIN`, MFA, audit e recuperabilità.

La tabella descrive l'handoff funzionale; nel contratto eventi il raw asset resta di `INTAKE_DOCUMENTALE`. Il processor del dominio indicato valida e soltanto allora scrive le proprie entità.

## Processor e comandi

I processor descrivono gli aggiornamenti automatici fra domini senza attribuirli alle pagine. Ciascuno consuma eventi registrati, legge le entità necessarie e scrive soltanto entità che appartengono al suo `owner`. Gate, quadrature, idempotenza, approvazione, retry e invalidazione sono parte del contratto. `autonomy` è esplicita: `A` per osservazione, proposta, calcolo o Coerenza; `B` per aggiornamento deterministico con chiavi esatte, audit e compensazione; `C` quando la conferma umana è sempre obbligatoria.

Le pagine inviano `commands`; non scrivono direttamente nelle materialized view. Ogni comando dichiara proprietario destinatario, entità scrivibili, prove richieste, livello di autonomia A/B/C, approvazione, audit, evento emesso, chiave idempotente ed errore. Per esempio, una pagina contestuale F24 può inoltrare una riconciliazione a `RICONCILIAZIONE`, ma non scriverla come `FISCO_F24`. Le pagine di riconciliazione espongono tre comandi distinti: `propose` crea solo una proposta, `confirm` richiede evidenza esatta e produce allocazioni, `supersede` richiede conferma umana e avvia il percorso compensativo.

Il perimetro di lettura di una pagina non diventa automaticamente il suo perimetro di scrittura. Due confini sono espliciti:

| Pagina | Contesto leggibile | Uniche entità scrivibili | Unico evento di comando |
|---|---|---|---|
| `amministrazione.dizionario_prodotti` | riga fattura, candidato, alias e prodotto canonico | `product_dictionary_item`, `supplier_product_alias` | `product.alias_resolved` |
| `amministrazione.f24_codici` | modello, righe, quietanza e registro codici | `tax_code_version` | `f24.tax_code_version_changed` |

Il primo comando non può modificare `invoice_supplier_line` né emettere `invoice.supplier_validated`; il secondo non può modificare o rivalidare `f24_model`, `f24_line` o `f24_receipt`. Entrambi richiedono una conferma umana e conservano le versioni precedenti.

I processor `project_open_item`, `dispatch_projection_invalidation` e `reopen_obligation_after_allocation_invalidation` restano di autonomia `B`, perché persistono rispettivamente una partita aperta, un audit/outbox di invalidazione e una nuova versione dell'obbligo. L'approvazione è coerente con `B`: aggiornamento deterministico, append-only o versionato, audit obbligatorio e arresto fail-closed quando manca una versione autorevole, una quadratura esatta o il manifesto completo delle proiezioni.

`documenti.corrispettivi_xml` valida il giorno nel dominio `CORRISPETTIVI_POS`; non emette direttamente `ledger.entry_projected`. La proiezione definitiva in Prima Nota appartiene al processor `PRIMA_NOTA` e richiede l'evidenza prevista.

Analogamente, `treasury.statement_received` non è ancora un movimento economico. Il processor `import_financial_movements` verifica conto, transaction ID o fingerprint deterministico, valuta, data contabile, data valuta, segno/importo e collegamento all'originale. Solo dopo questi gate `TESORERIA` scrive `financial_movement` e `financial_evidence` ed emette `financial.movement_observed`; le pagine economiche consumano quest'ultimo, mai l'evento raw.

## Esempio completo: fattura passiva

### 1. Acquisizione unica

Una fattura arrivata da Drive, upload o PEC produce un `source_asset` immutabile. Intake calcola l'hash e crea o riusa un solo `document`; `document_source` conserva tutte le provenienze. Lo stesso contenuto ricevuto due volte non crea due fatture, ma mantiene entrambe le evidenze di origine.

Relazioni: `document_has_sources`, `source_preserves_asset`, `document_has_extractions`.

### 2. Fattura, fornitore e righe

`FATTURE_FORNITORI` convalida identità legale, chiave documento e quadratura dei totali. Crea o aggiorna un solo `invoice_supplier`, le sue `invoice_supplier_line` e il ruolo `supplier` collegato a `party`.

Relazioni: `supplier_invoice_document`, `supplier_invoice_party`, `supplier_is_party`, `supplier_invoice_has_lines`.

Una nota di credito non cancella la fattura. `supplier_invoice_adjusts_invoice` indica la fattura rettificata e innesca l'invalidazione delle proiezioni a valle.

### 3. IVA

`CONTABILITA` deriva `vat_entry` dalla fattura con `supplier_invoice_generates_vat_entries`. La creazione è automatica solo quando imponibile, aliquote, componenti e centesimi quadrano; altrimenti resta una revisione IVA. L'IVA è una proiezione fiscale del documento, non una seconda fattura.

### 4. Dizionario prodotti acquistati

Le righe alimentano un candidato composto da descrizione, codice del fornitore, eventuale EAN/GTIN e confezione. `supplier_line_uses_product_alias` collega la riga all'alias del fornitore. `product_alias_resolves_dictionary_item` può risolvere il prodotto canonico soltanto con EAN verificato oppure mapping già confermato dall'operatore. La riga fattura resta provenienza in sola lettura: il mapping versiona esclusivamente alias e prodotto canonico e non rivalida la fattura.

Nome simile, prezzo o descrizione generica non bastano. I candidati ambigui restano separati. Il dizionario serve agli acquisti e ai controlli economici futuri: non introduce giacenze, lotti, ricette o produzione. La comparazione prezzi rimane una capacità `ASSENTE`, senza API o automatismo scelto.

### 5. Debito e partita aperta

La fattura crea `obligation` e la relativa `open_item` tramite `invoice_creates_obligation` e `obligation_has_open_item`. Una rettifica modifica il dovuto mediante evento compensativo, non cancellando il debito precedente.

### 6. Prova finanziaria separata

L'import banca/carta crea `financial_movement`. Estratto, ricevuta e disposizione restano `financial_evidence` distinte e collegate con `movement_has_evidence` e `financial_evidence_preserves_asset`.

Il metodo di pagamento scritto nell'XML non prova l'avvenuto pagamento. Importo uguale o causale simile non identificano da soli la stessa operazione.

### 7. Riconciliazione con gating

`RICONCILIAZIONE` propone un collegamento fra movimento e obbligo. La conferma automatica richiede chiavi compatibili, causa univoca e quadratura esatta dei centesimi. Più candidati, pagamento parziale non allocato o sola coincidenza dell'importo producono `DA_VERIFICARE`.

Relazioni: `reconciliation_uses_movement`, `reconciliation_has_allocations`, `allocation_closes_obligation`.

Una correzione crea una nuova `reconciliation` collegata da `reconciliation_supersedes_reconciliation`; la versione confermata precedente resta nell'audit.

### 8. Prima Nota e contabilità

Solo una riconciliazione confermata, idempotente e sostenuta dalla prova finanziaria può generare la scrittura finanziaria definitiva con `reconciliation_projects_ledger`. Prima di quel momento può esistere soltanto una proposta/provvisoria esplicita.

La contabilità proietta poi `accounting_entry` bilanciata sul `chart_account` approvato. Uno storno usa `ledger_entry_reverses_entry`: non elimina la scrittura originaria.

L'attestazione di cassa è una `financial_evidence` esplicita: registra autore, istante, importo, causale e audit. Il metodo abituale del fornitore, il termine indicato in fattura o una ricorrenza storica non dimostrano mai che il pagamento sia avvenuto.

## Altri flussi canonici

- F24: modello, righe, crediti compensati, quietanza e movimento bancario restano fatti diversi. La quietanza documenta l'esito telematico; la banca prova il pagamento. Il registro codici è un fatto distinto: `f24.tax_code_version_changed` versiona solo `tax_code_version` e invalida le viste interessate, senza creare, modificare o rivalidare modello, righe o quietanza. Se il saldo netto è esattamente zero non si attende alcun movimento: i debiti sono estinti da `f24_credit_offsets_debit`, mentre l'effetto fiscale/contabile resta distinto dal ledger finanziario. `f24_line_creates_obligation` riguarda soltanto l'eventuale debito residuo.
- Paghe: cedolino, `payroll_component`, netto dovuto, acconti/saldo N:M, attese F24 e prove bancarie/cassa restano separati. Una sostituzione ricalcola componenti, TFR e attese F24, supera le allocazioni interessate e invalida le viste senza eliminare pagamenti storici.
- Corrispettivi/POS: totale fiscale, IVA, chiusura terminale, credito verso gestore, payout e accredito bancario non vengono fusi. Un dato manuale è `receipt_day_provisional`; l'XML ufficiale lo supera e ricostruisce IVA/ledger con un solo writer fiscale.
- Riscossione: gli snapshot sono osservazioni point-in-time e una comunicazione di definizione non è pagamento. Un piano può comprendere più atti: `collection_plan_act_allocation` spiega le quote, ma una sola allocazione monetaria chiude la rata. Ricevuta PagoPA, prova e movimento bancario restano evidenze distinte fino a riconciliazione e Prima Nota.
- Verbali: pagamento dell'azienda e recupero dal dipendente sono eventi separati. Il conducente si risolve solo dall'unica `vehicle_assignment` valida alla data; il recupero richiede autorizzazione e prova paghe. I legami a contratto di noleggio e fattura fornitore impediscono di contabilizzare due volte lo stesso costo.

## Storno end-to-end

Il percorso generico di rettifica è atomico per eventi e ripetibile:

1. una nuova `reconciliation` supera quella errata tramite `reconciliation_supersedes_reconciliation`;
2. le allocazioni interessate diventano inattive con audit, senza delete;
3. `open_item` e residuo dell'`obligation` si riaprono o ricalcolano;
4. `ledger_entry_reverses_entry` crea lo storno compensativo;
5. l'outbox emette invalidazione e ricostruisce in modo idempotente contabilità e viste pagato/non pagato.

Se un passaggio fallisce, il retry riparte dal checkpoint con le stesse chiavi idempotenti; il caso va in dead letter e apre un'anomalia, senza lasciare una correzione silenziosamente parziale.

## Coerenza e anomalie

`controllo.anomalie` è la pagina read-only del motore trasversale. Non ha comandi né eventi in uscita. Il processor background `evaluate_coherence` esegue regole versionate e produce `coherence_evaluation`; un esito fallito può aprire o aggiornare `anomaly` e viene registrato nell'audit.

Controlla:

- completezza dei campi e delle evidenze richieste;
- unicità delle chiavi naturali e assenza di duplicati economici;
- integrità referenziale delle relazioni;
- quadrature di totali, componenti, allocazioni e centesimi;
- compatibilità temporale fra competenza, documento, valuta e periodo;
- provenienza fino all'originale immutabile;
- freschezza di snapshot, import e proiezioni.

Il motore non corregge fatture, movimenti, obblighi, riconciliazioni o scritture. Il proprietario del fatto risolve o sostituisce il record; il motore rivaluta gli stessi input e chiude o supera l'anomalia con traccia di audit.

## Pagine come proiezioni

`pageProjections` nel JSON copre tutte le 61 pagine del catalogo. Ogni voce dichiara:

- eventi ed entità in ingresso;
- read model/materialized view e dipendenze;
- azioni consentite;
- eventi in uscita;
- comandi inoltrati al proprietario autorevole;
- failure state, regola di errore e approval policy.

`projection.ownsCanonicalData` è sempre `false`: persino una pagina collocata nel dominio proprietario invia comandi all'owner, non conserva una copia privata. `implementationStatus: ASSENTE` descrive la topologia obiettivo, non una funzione già operativa.

Le pagine di sola lettura non emettono comandi mutativi. Le altre possono proporre o confermare soltanto nei limiti di ruolo, MFA, chiavi esatte e quadratura indicati dal catalogo. Un fallimento mantiene l'ultimo fatto verificato, apre o aggiorna un'anomalia e vieta sovrascritture silenziose.
