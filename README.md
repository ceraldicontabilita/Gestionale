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
