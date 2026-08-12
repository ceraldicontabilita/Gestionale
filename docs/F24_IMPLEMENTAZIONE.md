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
