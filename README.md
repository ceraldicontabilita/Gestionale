# Impresa Semplice

Nuova applicazione amministrativa indipendente per Ceraldi Group.

Il repository `GestionaleCloud` è soltanto una fonte di riferimento per parser, formati documentali e casi operativi. Non è una dipendenza di runtime e non viene modificato da questo progetto.

## Stato

Il ramo di sviluppo verificato è:

`feat/impresa-semplice-clean`

Il progetto è una base di sviluppo protetta e testata, non ancora un ambiente di produzione autorizzato a sostituire tutte le procedure amministrative correnti.

Leggere prima:

- `docs/SPECIFICA_FUNZIONALE.md`
- `docs/AUDIT_2026-08-12.md`
- `docs/REGOLE_DOMINIO.md`

## Componenti disponibili

- frontend HTML/CSS/JavaScript semplice e mobile;
- backend Node.js/Express;
- MongoDB con transazioni;
- Prima Nota con saldi progressivi e riporti annuali;
- Cassa, Banca, Mastercard, Salari, Finanziamenti soci e Provvisoria;
- corrispettivi XML, chiusura serale, Numia e SumUp;
- F24, quietanze, righe tributo e registro versionato;
- atti della riscossione e snapshot ADER;
- archivio originali tramite GridFS e SHA-256;
- acquisizione Google Drive fiscale;
- acquisizione PEC/IMAP, `daticert.xml` e `postacert.eml`;
- scheduler con lease, heartbeat, retry, checkpoint e audit;
- accesso PIN, sessione HttpOnly, CSRF e MFA TOTP per operazioni sensibili.

## Indice documentale Google Drive

Impostando `DRIVE_DOCUMENT_INDEX_ROOT_FOLDER_ID`, la pagina **Documenti** legge il file unico
`INDICI GESTIONALE/INDICE_DOCUMENTALE_DRIVE.xlsx` direttamente da Google Drive. Il backend valida
ID, SHA-256, percorsi e collegamenti F24/dichiarazioni, ma non salva in MongoDB né il foglio né gli
originali. Il link a un documento viene risolto seguendo ogni cartella genitore con corrispondenza
esatta; nomi simili non vengono accettati.

L'accesso può usare OAuth (`GOOGLE_OAUTH_*`) oppure un'identità tecnica in `GOOGLE_DRIVE_SA_JSON`;
in entrambi i casi il gestionale richiede soltanto l'autorizzazione Drive in lettura.

Modello F24, quietanza e movimento bancario restano evidenze distinte: la presenza nell'indice non
dimostra da sola il pagamento.

### Sincronizzazione completa 0.8

La versione 0.8 salva in MongoDB il catalogo e i dati strutturati verificabili, mentre PDF, ZIP e
altri originali restano su Drive. All'avvio la sincronizzazione idempotente cataloga l'intera radice e
importa documenti dell'indice, righe tributo, modelli F24, quietanze, dichiarazioni, fatture XML e
corrispettivi RT. Le sole cartelle producono una classificazione proposta, non un pagamento o una
registrazione contabile. Lo stato dell'ultimo import e disponibile in `/api/drive-data/status`.

## Pagine operative

- **Riconciliazione** mostra soltanto movimenti finanziari non già utilizzati e richiede una scelta
  manuale della causa. L'importo non produce mai un collegamento automatico; F24 e riscossione
  applicano nuovamente le verifiche nel backend e richiedono MFA.
- **Controllo** raccoglie riporti da riallineare, movimenti senza prova, F24 da riscontrare, documenti
  interni da verificare e atti ADER privi di snapshot, senza correggere silenziosamente i dati.
- **Riscossione** conserva separati atto originario, pagamenti collegati e ultimo snapshot ADER.

## Avvio locale

Requisiti:

- Node.js 20;
- MongoDB configurato come replica set per le transazioni;
- variabili d'ambiente definite senza inserirne i valori nel repository.

```bash
npm ci
cp .env.example .env
npm start
```

L'applicazione resta in modalità fail-safe quando il PIN non è configurato: le API protette non vengono aperte per comodità.

## Sicurezza

Preferire `PIN_SCRYPT_ADMIN` rispetto al vecchio hash SHA-256 compatibile.

Le operazioni sensibili richiedono anche `MFA_TOTP_SECRET` in formato Base32. Il PIN apre la sessione; il codice TOTP autorizza temporaneamente riporti, classificazioni tributarie e riconciliazioni.

Nessuna credenziale, URI MongoDB, token Google, password PEC o segreto MFA deve essere committato.

## Verifiche

```bash
npm run check
npm test
npm audit --audit-level=high
```

GitHub Actions usa `npm ci`, avvia MongoDB come replica set ed esegue test unitari, transazionali e HTTP reali.

## Principio fondamentale

Documento, disposizione, quietanza e movimento finanziario sono prove diverse.

Il sistema deve collegarle senza confonderle e deve lasciare ogni caso ambiguo in verifica.
