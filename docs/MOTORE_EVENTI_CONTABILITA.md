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
  versionata, approvata con MFA e limitata a conti e tipi ammessi;
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

## API amministrative

Le operazioni `POST /api/event-engine/*` sono sensibili e richiedono MFA quando
l'autenticazione è configurata.

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
PEC e `POST /api/supplier-invoices/intake` convergono nello stesso staging
FatturaPA, preservando fonte, versione, originale e SHA-256. La successiva
`POST /api/supplier-invoices/validate` richiede una decisione esplicita
sull'IVA detraibile e registra fattura canonica ed evento
`invoice.supplier_validated` nella stessa transazione. Il consumer crea
competenza, componente IVA, debito, partita aperta e l'albero delle attese
senza attendere il pagamento. Vale la regola: il ramo nasce quando nasce
l'obbligo; l'evidenza futura lo soddisfa, non lo crea.

Il regolamento è un fatto successivo. `POST
/api/supplier-invoices/:invoiceId/reconcile` richiede identità naturale della
fattura, riferimento esplicito del movimento, prova finanziaria reale
compatibile ed esatta allocazione in centesimi. Soltanto allora chiude o riduce
la partita, pubblica `ledger.entry_projected` con
`FINANCIAL_SETTLEMENT` e, dopo il dispatcher, soddisfa l'attesa di Prima Nota
finanziaria. Retry, allocazione, riconciliazione e proiezioni sono idempotenti;
un PDF di disposizione non costituisce prova bancaria.

I consumer della `projection_outbox` materializzano giornale/mastro, conti
osservati, saldi di verifica e controlli di coerenza con lease, retry e dead
letter. Questo non rende automaticamente complete le 61 pagine: mancano ancora
il piano dei conti canonico versionato, chiusura/bilancio completi,
supersessione e note di credito delle fatture, proposta multi-candidato e gli
altri produttori reali. Le capacità restano
quindi `PARZIALE` o `ASSENTE` secondo il catalogo canonico.
