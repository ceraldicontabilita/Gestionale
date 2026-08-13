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
- `POST /api/event-engine/events/:eventKey/requeue`: riprende un evento;
- `GET /api/event-engine/status`: espone coda e dead letter;
- `GET /api/event-engine/accounting-entries`: consulta il giornale tecnico;
- `GET /api/event-engine/accounting-balances`: consulta i saldi di mastro.

## Perimetro ancora aperto

Il motore non rende automaticamente complete le 61 pagine. I produttori reali
di fatture, corrispettivi, paghe e F24 devono ancora pubblicare gli eventi dopo
le rispettive validazioni e quadrature. Anche i consumer della
`projection_outbox` e la schermata finale di libro giornale/mastro restano da
implementare. Finché tali collegamenti non hanno test end-to-end, la capacità
rimane `PARZIALE` nel catalogo canonico.
