# Motore centrale eventi, contabilità e proiezioni

Il motore implementa il primo percorso runtime del contratto descritto in
`docs/anatomia-gestionale/topologia-flussi.json`. Non sostituisce i fatti dei
domini: riceve soltanto eventi già validati dal proprietario funzionale.

## Garanzie implementate

- evento, outbox e audit sono registrati nella stessa transazione MongoDB;
- la chiave evento e la chiave di proiezione rendono i retry idempotenti;
- la competenza del documento è indipendente dalla prova di pagamento;
- il regolamento finanziario richiede una prova bancaria, carta o cassa
  esplicitamente riferita;
- le scritture devono quadrare al centesimo e usare una regola contabile
  versionata, approvata con riconferma del PIN e limitata a conti e tipi ammessi;
- la data di registrazione deve appartenere a un periodo contabile aperto;
  apertura, chiusura e riapertura sono versionate, motivate e auditate;
  la chiusura è bloccata finché esistono eventi contabili non elaborati;
- documento, ricezione, competenza, registrazione, IVA, scadenza e valuta
  rimangono date distinte;
- le correzioni usano scritture compensative che invertono esattamente
  l'originale, senza cancellarlo;
- giornale, saldi di mastro e richieste di aggiornamento delle pagine sono
  persistiti atomicamente; i saldi usano centesimi interi;
- un worker con lease, retry esponenziale e dead letter elabora l'outbox;
- un evento completato o in dead letter può essere riaccodato con motivo e
  audit, senza duplicare la scrittura.

L'intake automatico delle fatture usa una sola eccezione tecnica circoscritta:
la regola code-defined `FATTURA_PASSIVA_AUTO_DA_CLASSIFICARE` può essere
provisionata idempotentemente dal sistema soltanto per XML FatturaPA esatti e
soltanto sui conti tecnici `COSTI_DA_CLASSIFICARE`, `IVA_DA_CLASSIFICARE` e
`DEBITI_FORNITORI`. Actor, motivo e audit sono obbligatori. La regola non
classifica definitivamente costo o detraibilità IVA e non può essere modificata
dalla pagina. Creazione o modifica delle normali regole contabili, chiusura e
riapertura dei periodi restano operazioni amministrative protette da PIN. Il
sistema può creare idempotentemente come `OPEN` soltanto un periodo ancora
inesistente necessario alla data di acquisizione, con actor e motivo tecnici;
se il periodo esiste ma non è aperto, l'intake fallisce senza aggirarne lo
stato.

## API amministrative

Le operazioni `POST /api/event-engine/*` sono sensibili e richiedono la
riconferma temporanea del PIN amministratore.

- `POST /api/event-engine/posting-rules`: registra una versione approvata;
- `POST /api/event-engine/accounting-periods`: apre, chiude o riapre un periodo;
- `POST /api/event-engine/events`: pubblica un fatto validato con proiezione;
- `POST /api/event-engine/dispatch`: esegue un ciclo controllato del worker;
- `POST /api/event-engine/projections/dispatch`: elabora le proiezioni di pagina;
- `POST /api/event-engine/projections/rebuild`: ricostruisce idempotentemente le viste contabili;
- `POST /api/event-engine/events/:eventKey/requeue`: riprende un evento;
- `GET /api/event-engine/status`: espone coda e dead letter;
- `GET /api/event-engine/accounting-entries`: consulta il giornale tecnico;
- `GET /api/event-engine/accounting-balances`: consulta i saldi di mastro.

## Perimetro ancora aperto

Il primo produttore reale collegato è quello delle fatture fornitori. Drive,
PEC, upload XML e job di upload multiplo XML/ZIP convergono nello stesso staging
FatturaPA, preservando fonte, versione, originale e SHA-256. I job accettano più
file e ZIP annidati, espongono avanzamento persistito anche durante la
navigazione e applicano limiti contro ZIP bomb e percorsi malevoli. L'intake
richiede una sessione amministrativa autenticata tramite PIN. Quando identità,
chiave naturale, schema e quadratura sono esatti, il processor canonizza
automaticamente la fattura e registra `invoice.supplier_validated` nella stessa
transazione. I casi non esatti restano in revisione senza produrre fatti
contabili.

Il consumer crea competenza, IVA esposta su conto tecnico da classificare,
debito, partita aperta e albero delle attese senza attendere il pagamento. Non
dichiara automaticamente l'IVA detraibile e non inventa il conto costo
definitivo. La pagina Fornitori è una proiezione per identificativo fiscale
esatto e non crea un'anagrafica parallela. Vale la regola: il ramo nasce quando
nasce l'obbligo; l'evidenza futura lo soddisfa, non lo crea.

Il regolamento è un fatto successivo. `POST
/api/supplier-invoices/:invoiceId/reconcile` richiede identità naturale della
fattura, riferimento esplicito del movimento, prova finanziaria reale
compatibile ed esatta allocazione in centesimi. Soltanto allora chiude o riduce
la partita, pubblica `ledger.entry_projected` con
`FINANCIAL_SETTLEMENT` e, dopo il dispatcher, soddisfa l'attesa di Prima Nota
finanziaria. Retry, allocazione, riconciliazione e proiezioni sono idempotenti;
un PDF di disposizione non costituisce prova bancaria.

La pagina Riconciliazione legge le partite fornitore da `GET
/api/riconciliazione/partite-aperte`: mostra importo originario, allocato,
residuo, scadenza e stato senza creare una copia autorevole. La conferma
manuale valorizza automaticamente conto debiti, conto finanziario, regola e
data di registrazione partendo dalla fattura e dal movimento scelti. L'importo
allocato è mostrato prima della conferma; una eventuale eccedenza del movimento
resta disponibile. Non esiste abbinamento automatico basato sul solo importo.

I consumer della `projection_outbox` materializzano giornale/mastro, conti
osservati, saldi di verifica e controlli di coerenza con lease, retry e dead
letter. Questo non rende automaticamente complete le 61 pagine: mancano ancora
il piano dei conti canonico versionato, chiusura/bilancio completi,
supersessione e note di credito delle fatture, proposta multi-candidato e gli
altri produttori reali. Le capacità restano
quindi `PARZIALE` o `ASSENTE` secondo il catalogo canonico.
