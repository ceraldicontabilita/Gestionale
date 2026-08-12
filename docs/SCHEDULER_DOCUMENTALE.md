# Scheduler documentale

## Obiettivo

Gli automatismi non devono creare buchi, doppioni o processi sovrapposti. Ogni job usa MongoDB per lease, checkpoint e audit.

## Frequenze iniziali

- PEC/email documentali: ogni 30 minuti;
- Drive fiscale: ogni 60 minuti;
- riprocessamento errori tecnici: ogni 120 minuti;
- controllo scadenze fiscali: giornaliero;
- aggiornamento/controllo registro codici tributo: giornaliero;
- snapshot ADER: nessuno scraping remoto fragile; acquisizione tramite fonte supportata o documento importato.

## Regole

1. La scansione usa identificativi stabili della fonte, non lo stato letto/non letto.
2. Il checkpoint avanza solo dopo un'esecuzione riuscita.
3. Email e Drive ripartono da una finestra sovrapposta di 72 ore rispetto all'ultimo successo.
4. SHA-256 e chiavi stabili impediscono la creazione di documenti duplicati.
5. La lease Mongo impedisce che due istanze eseguano lo stesso job contemporaneamente.
6. Un errore tecnico viene registrato e può essere ritentato; un dubbio fiscale resta `DA_VERIFICARE` e non viene ritentato finché "indovina".
7. Ogni run registra elementi analizzati, nuovi, duplicati, da verificare ed errori.
8. Le credenziali delle sorgenti non vengono salvate nei documenti o nei log applicativi.

## Motore

`src/jobs.js` gestisce lease, checkpoint, audit e fonti stabili.

`src/schedule-policy.js` contiene le frequenze.

`src/scheduler.js` esegue gli handler registrati e aggiorna il checkpoint solo dopo il successo.

Gli adapter concreti per PEC/email e Drive saranno separati dal motore. In questo modo cambiare provider non cambia le regole di deduplica e sicurezza.
