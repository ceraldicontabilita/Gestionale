# Regole di dominio iniziali

## Principio probatorio

Una proposta, un documento o una disposizione non equivalgono a un pagamento reale. Per i conti finanziari la riconciliazione richiede una fonte reale compatibile.

## Cassa

La Cassa è l'unico conto che può essere attestato manualmente dall'operatore. Deve mantenere saldo progressivo e riferimenti agli eventuali documenti collegati.

## Banca

Un pagamento bancario è riconciliato soltanto contro un movimento bancario reale. Un bonifico predisposto o un PDF costituisce documentazione, non prova dell'addebito.

L'import di un estratto crea il fatto `financial_movement` e la relativa prova
reale, non una scrittura contabile né un pagamento già allocato. Per gli export
CSV Bank BPM “Elenco Entrate/Uscite” la chiave canonica è
`accountId + sourceTransactionId`; quando manca un riferimento provider stabile,
il sistema usa il fingerprint deterministico di tutti i campi della riga e la
sua occorrenza. Data e importo da soli non sono mai una chiave. Estratti
sovrapposti aggiungono provenienza (SHA-256, originale e numero riga) allo stesso
fatto; un conflitto di fingerprint resta da controllare.

Schemi POS, CSV generici e formati non riconosciuti sono rifiutati: non vengono
interpretati per somiglianza. Un movimento osservato può soddisfare un'attesa
finanziaria soltanto attraverso una riconciliazione autonoma, idempotente e
auditabile con causa identificata e centesimi esatti.

## Mastercard

È un conto distinto dalla banca. Le operazioni carta devono essere confrontate con la relativa fonte/estratto e non confuse automaticamente con il successivo addebito del saldo carta sul conto corrente.

## Salari e cedolini

Il cedolino definisce il dovuto. Bonifici e altri documenti possono documentare il pagamento, ma lo stato finale richiede evidenza reale. Sono ammessi acconti e saldi, con stato parziale finché il totale reale non raggiunge il dovuto.

## Finanziamenti soci

Movimenti separati dai normali ricavi/costi. Ogni versamento o restituzione mantiene causale, socio e fonte probatoria.

## Provvisoria

Destinazione obbligatoria per movimenti ambigui, incompleti, senza prova sufficiente o con più associazioni plausibili. Nessun automatismo deve trasformarli in riconciliati.

## Fatture fornitori

Un XML FatturaPA può diventare automaticamente fattura canonica soltanto quando
schema, identità del fornitore, chiave naturale e quadratura in centesimi sono
esatti. La canonizzazione crea subito competenza, debito, partita aperta e ramo
delle attese; non attende e non presume il pagamento.

L'IVA esposta non equivale a IVA detraibile. Finché manca una classificazione
fiscale esplicita, costo e IVA sono registrati su conti tecnici da classificare,
distinti dal debito fornitore. I casi non esatti restano in revisione e non
generano scritture. Metodo di pagamento, scadenza o importo presenti nell'XML non
provano banca, carta o cassa.

Il fornitore è raggruppato soltanto per identificativo fiscale esatto. Nome
simile o importo uguale non autorizzano fusione di anagrafiche, deduplicazione o
riconciliazione.

La partita aperta fornitore deriva dall'obbligo della fattura canonica. La UI
può compilare automaticamente i campi contabili tecnici del regolamento, ma la
conferma richiede sempre la chiave naturale della fattura, un riferimento
presente nel movimento, una prova finanziaria reale compatibile e un importo in
centesimi non superiore sia al residuo sia alla disponibilità del movimento.
L'eccedenza non viene assorbita né collegata implicitamente ad altre cause.

## SumUp

Incasso POS, payout SumUp e accredito bancario sono eventi distinti. La chiusura POS non prova l'accredito sul conto corrente. Commissioni e differenze devono restare esplicite.

## F24

Il modello F24 è il documento del debito/pagamento predisposto. Lo stato pagato richiede il riscontro della relativa evidenza finanziaria.

## Assegni

Emissione/consegna dell'assegno e addebito bancario sono eventi distinti. La registrazione dell'assegno non genera automaticamente una riconciliazione bancaria.

## Motore documentale

Ogni documento entra da un unico flusso: acquisizione, identificazione tipo, estrazione dati, controllo duplicati, proposta collegamenti, verifica e archiviazione. Le classificazioni incerte restano da verificare.
