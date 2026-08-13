# Modulo F24 — implementazione

## Stato

Il modulo F24 è separato dal motore generale della Prima Nota e applica queste regole:

- modello F24, quietanza e movimento finanziario sono entità distinte;
- una quietanza non prova automaticamente l'addebito bancario;
- il saldo del modello non è automaticamente un costo;
- le righe sono interpretate in base alla sezione;
- ERARIO, REGIONI e IMU/tributi locali usano codici tributo;
- INPS usa codice sede, causale contributo, matricola/codice INPS e periodo;
- codici e causali sconosciuti restano `DA_VERIFICARE`;
- il registro di classificazione è versionato e richiede una fonte.

## Dataset fiscale Drive

Il materiale fiscale 2020-2026 presente su Google Drive è una fonte privata di riferimento e test. Non deve essere copiato nel repository pubblico.

L'import usa gli indici e i manifest del dataset come ground truth per:

- data versamento;
- protocollo telematico;
- saldo operazione/modello;
- tipo documento;
- nome file;
- SHA-256;
- URL/provenienza tecnica dal Cassetto Fiscale.

I documenti reali restano nella loro fonte documentale. MongoDB conserva metadati, dati estratti, hash, stato e relazioni.

## Privacy

Fixture e test pubblicati nel repository devono usare esclusivamente dati sintetici/anonymizzati. Nomi, codici fiscali, importi e identificativi provenienti dai documenti reali non devono essere commitati nel repository.

## API iniziali

- `GET /api/f24`
- `GET /api/f24/:id`
- `POST /api/f24/importa-indice`
- `POST /api/f24/analizza-quietanza`
- `PUT /api/f24/:id/righe`
- `POST /api/f24/:id/riconcilia`
- `GET /api/tributi`
- `POST /api/tributi`

## Collegamenti

Le relazioni sono bidirezionali:

`F24 ↔ DOCUMENTO ↔ QUIETANZA ↔ MOVIMENTO FINANZIARIO`

La relazione non trasferisce l'autorità della fonte: modificare un F24 non modifica il movimento bancario e viceversa.


## Contratto di affidabilità del dato

Ogni campo estratto conserva valore normalizzato, testo originale, file sorgente, indice modello, pagina, coordinate, metodo di estrazione, confidenza, stato, alternative, warning e controlli che lo hanno verificato.

Stati campo: `ESTRATTO`, `VALIDATO`, `QUADRATO`, `CONFERMATO`, `CONTESTATO`, `NON_DETERMINABILE`.

Il sistema espone separatamente:

1. affidabilità dell'estrazione;
2. coerenza contabile e matematica;
3. forza della prova di pagamento.

Un modello letto perfettamente può avere prova di pagamento assente.

## Quadrature e modelli multipli

Le quadrature sono esatte al centesimo e vengono eseguite per sezione e per singolo modello. Debiti meno crediti deve coincidere con il saldo dichiarato. Un PDF con più modelli mantiene unità autonome tramite `modelIndex`; non è consentito fondere righe o saldi. Una differenza genera `CONTESTATO` e blocca la riconciliazione automatica.

## Estrazione indipendente

Quando disponibili, testo nativo e OCR della pagina renderizzata devono essere confrontati sui campi essenziali. Una discordanza su contribuente, codice fiscale, date, codici, periodi, debiti, crediti o saldo invia il modello a verifica. Un dato non leggibile produce `null`/`NON_DETERMINABILE`, mai un valore inventato.

## Evidenze e riconciliazione

La catena probatoria mantiene oggetti distinti:

- modello F24: obbligo/delega dichiarata;
- ricevuta: trasmissione o acquisizione;
- quietanza/esito positivo: accettazione per gli identificativi riportati;
- movimento bancario: addebito finanziario;
- quietanza e movimento coerenti: riconciliazione completa dopo deduplicazione.

Il solo modello produce sempre `MODELLO_F24_TROVATO`, `paymentEvidence=false` e `autoReconcile=false`. La sola uguaglianza dell'importo non è sufficiente. Più candidati, differenze d'importo o prove discordanti restano `DA_VERIFICARE`. Un saldo zero vieta sempre la creazione di un'uscita bancaria.

## Deduplicazione e audit

La pipeline deve usare hash binario, hash del testo normalizzato e impronta contabile. Ogni elaborazione conserva versione del parser, OCR e dizionari, data, valori precedenti e successivi, autore e motivazione. Un nuovo parser produce un confronto e non sovrascrive silenziosamente dati confermati o riconciliati.

## Regola invariabile

```text
F24 letto correttamente != F24 pagato
F24 quietanzato != movimento bancario riconciliato
Riconciliazione completa = modello + prova valida + riscontro finanziario coerente
```


## Politica di estrazione per documenti ufficiali digitali

I documenti trattati sono PDF ufficiali prodotti da Agenzia delle Entrate, INPS e altri enti. Non è previsto il riconoscimento di manoscritti. Il testo nativo incorporato nel PDF è la fonte primaria perché, quando presente, è più affidabile di una rilettura ottica.

Ordine obbligatorio:

1. testo nativo del PDF;
2. struttura, pagina e coordinate;
3. validazione formale dei campi;
4. quadrature matematiche;
5. OCR mirato soltanto per verifica o recupero;
6. controllo umano in caso di conflitto.

La funzione `evaluateF24ExtractionPolicy` applica queste modalità:

- `NATIVE_ONLY`: testo sufficiente, campi essenziali presenti e quadrature confermate; nessun OCR;
- `NATIVE_PLUS_TARGETED_OCR`: testo presente ma campo essenziale mancante, marcatore assente o quadratura fallita; OCR limitato alle zone interessate;
- `OCR_FULL`: testo nativo assente o insufficiente; OCR dell'intero documento, senza conferma automatica dei valori recuperati;
- `MANUAL_REVIEW`: testo presente ma affidabilità non dimostrabile.

Campi essenziali minimi: codice fiscale del contribuente, data modello quando presente, righe tributo/contributive, totale debiti, totale crediti e saldo finale.

### Divieti

- L'OCR non può sovrascrivere il testo nativo.
- Una confidenza OCR elevata non supera una quadratura fallita.
- Un valore presente soltanto nell'OCR richiede verifica.
- Una discordanza testo/OCR produce `CONTESTATO` e valore accettato `null`.
- L'OCR non determina mai pagamento, riconciliazione o prima nota.
- Timestamp del file, nome file e metadati di consultazione non sostituiscono date fiscali mancanti.

### Confronto dei campi

`compareNativeAndOcrField` usa confronto esatto dopo normalizzazione specifica:

- codice fiscale e codici: spazi rimossi e maiuscole;
- date: formato canonico senza confondere periodo e data modello;
- importi: due decimali e separatori italiani/OCR normalizzati;
- testo: normalizzazione Unicode e spazi, conservando sempre il valore originale.

Esiti: `MATCH`, `NATIVE_ONLY`, `CONFLICT`, `OCR_RECOVERY_REQUIRES_REVIEW`, `NOT_DETERMINABLE`.

### Piano OCR mirato

`buildTargetedOcrPlan` genera soltanto le zone da rileggere. Se fallisce la quadratura, limita la rilettura a colonne importi, totali di sezione e saldo finale. Se manca un campo, tenta soltanto la sua area. Le immagini temporanee non diventano fonte contabile e possono essere eliminate dopo l'elaborazione; originale, testo, coordinate, versione del motore e risultati devono restare nell'audit.
