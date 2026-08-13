# Inventari dello snapshot storico

Questi file JSON chiudono l'ispezione dello snapshot storico: descrivono ciò che esisteva, la destinazione nell'anatomia nuova e la decisione di porting. Non sono specifiche da copiare automaticamente e non sono dipendenze runtime.

Gli inventari sono artefatti autosufficienti e immutabili dello snapshot. Lo script temporaneo usato per estrarli non viene conservato perché dipendeva da un percorso locale non disponibile in CI; l'integrità e i collegamenti degli artefatti vengono invece verificati da `npm run validate:anatomia`.

Regole di lettura:

- `canonicalDestination` indica la pagina o l'entità proprietaria nel catalogo corrente; `null` significa esclusione intenzionale.
- `decision` distingue consolidamento, ridisegno, sola lettura, esclusione e verifica necessaria.
- `sourcePath` e `symbol`/`route` mantengono la provenienza verificabile senza richiedere una nuova consultazione dello snapshot.
- `acceptanceTests` sono condizioni minime per dichiarare trasferita una capacità; una route o una classe da sola non basta.
- i conteggi descrivono lo snapshot del 13 agosto 2026 e non lo stato di implementazione corrente.

Inventari:

- `endpoint-runtime.json`: tutti i 1108 endpoint montati e i 113 prefissi.
- `collezioni.json`: registro `COLL_*`, alias e collezioni letterali effettivamente referenziate.
- `modelli-enum.json`: modelli Pydantic ed enum Python del runtime.
- `job-schedulati.json`: tutti i job APScheduler registrati.
- `pagine-storiche.json`: mapping uno-a-uno delle 62 pagine del vecchio `page_catalog.json`.
- `schede-pagine.json`: indice delle schede operative approfondite disponibili.
- `popup.json`: indice di modali, drawer, pannelli e conferme censiti.
- `situazione-fiscale.json`: pagina amministrativa e sette tab montati ma assenti dal vecchio catalogo.
- `connessioni-storiche/manifest.json`: manifest del grafo machine-readable di consumer UI, endpoint, handler, dipendenze, modelli, job e accessi alle collezioni. I 3.638 nodi, 8.730 archi e 877 gap sono distribuiti in 14 shard JSONL piccoli e revisionabili; ogni nodo è mappato alla destinazione canonica e ogni relazione non determinabile resta un gap esplicito.

## Integrità del grafo partizionato

Il monolite non è tracciato nel repository: il manifest conserva hash e dimensione dell'artefatto originale, hash logico del grafo, algoritmo di partizione, conteggi e SHA-256 di ogni shard. La partizione usa i primi quattro byte di `SHA-256(id)` in ordine big-endian, modulo il numero di shard del dataset; dentro ogni shard gli ID sono ordinati byte per byte.

La verifica non consulta sorgenti esterne e controlla manifest, file attesi, hash, dimensioni, bucket, ordine, ID univoci, riferimenti, riepiloghi e digest logico:

```bash
node scripts/historical-connections-shards.js verify
```

Per una diagnosi locale si può ricostruire byte per byte il monolite originario in un file non esistente:

```bash
node scripts/historical-connections-shards.js assemble --output /tmp/connessioni-storiche.json
```

La modalità `split` è una migrazione esplicita, non un passaggio ordinario. Richiede `--input` e scrive prima in una directory temporanea; con `--replace` sostituisce soltanto una directory composta da file del formato atteso ed elimina il monolite sorgente solo dopo round-trip e verifica completi.
