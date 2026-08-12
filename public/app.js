const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const euro = new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR' });
let config = { conti: [], stati: [] };
let appReady = false;
let reconciliationData = null;
let reconciliationSelection = { movementId: null, causeId: null, causeType: 'F24' };

function currentYear() { return new Date().getFullYear(); }
function years() { const now = currentYear(); return Array.from({ length: 9 }, (_, i) => now - i); }
function fillSelect(select, values) { select.innerHTML = values.map((v) => `<option value="${v}">${String(v).replaceAll('_', ' ')}</option>`).join(''); }
function fmtDate(value) { return value ? new Date(value).toLocaleDateString('it-IT') : '—'; }
function badge(status) { return `<span class="badge ${String(status).toLowerCase()}">${String(status).replaceAll('_', ' ')}</span>`; }
function escapeHtml(value) { return String(value ?? '').replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c])); }
function cookieValue(name) { return document.cookie.split(';').map((v) => v.trim()).find((v) => v.startsWith(`${name}=`))?.slice(name.length + 1) || ''; }

function ensureMfaDialog() {
  if ($('#mfaDialog')) return;
  document.body.insertAdjacentHTML('beforeend', `
    <dialog id="mfaDialog" class="login-dialog">
      <form id="mfaForm">
        <div><p class="eyebrow">CONFERMA OPERAZIONE</p><h3>Codice MFA</h3><p class="muted">Inserisci il codice a sei cifre dell'autenticatore. La verifica resta valida solo per pochi minuti.</p></div>
        <label>Codice<input name="code" type="text" inputmode="numeric" pattern="[0-9]{6}" minlength="6" maxlength="6" autocomplete="one-time-code" required></label>
        <div class="two-cols"><button class="primary" type="submit">Verifica</button><button id="cancelMfa" type="button">Annulla</button></div>
        <p id="mfaError" class="error"></p>
      </form>
    </dialog>`);
}

function showLogin(message = '') {
  $('#loginError').textContent = message;
  $('#logoutButton').classList.add('hidden');
  if ($('#mfaDialog')?.open) $('#mfaDialog').close();
  if (!$('#loginDialog').open) $('#loginDialog').showModal();
}

function hideLogin() {
  if ($('#loginDialog').open) $('#loginDialog').close();
  $('#logoutButton').classList.remove('hidden');
}

function showMfa(message = 'Conferma MFA richiesta.') {
  ensureMfaDialog();
  $('#mfaError').textContent = message;
  if (!$('#mfaDialog').open) $('#mfaDialog').showModal();
  $('#mfaForm [name=code]').focus();
}

function hideMfa() {
  if ($('#mfaDialog')?.open) $('#mfaDialog').close();
  $('#mfaForm')?.reset();
  if ($('#mfaError')) $('#mfaError').textContent = '';
}

async function api(url, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) headers['X-CSRF-Token'] = decodeURIComponent(cookieValue('impresa_csrf'));
  const response = await fetch(url, { credentials: 'same-origin', ...options, method, headers });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401 && url !== '/api/auth/mfa') showLogin('Sessione scaduta. Inserisci nuovamente il PIN.');
  if (response.status === 428 && data.code === 'MFA_REQUIRED') showMfa(data.error);
  if (response.status === 503 && data.code === 'MFA_NOT_CONFIGURED') showMfa(data.error);
  if (!response.ok) throw new Error(data.error || `Errore ${response.status}`);
  return data;
}

async function loadHealth() {
  try {
    const health = await api('/api/health');
    $('#dbStatus').textContent = health.database === 'connected' ? `MongoDB collegato · v${health.versione || ''}` : 'MongoDB da configurare';
    $('#dbStatus').classList.toggle('ok', health.database === 'connected');
  } catch { $('#dbStatus').textContent = 'Backend non raggiungibile'; }
}

async function checkAuth() {
  const status = await api('/api/auth/status');
  if (!status.configured) { showLogin('Il PIN amministratore non è configurato sul server.'); return false; }
  if (!status.authenticated) { showLogin(); return false; }
  hideLogin();
  return true;
}

async function loadConfig() {
  config = await api('/api/config');
  fillSelect($('#ledgerAccount'), config.conti);
  fillSelect($('#movementForm [name=conto]'), config.conti);
  fillSelect($('#ledgerYear'), years());
  fillSelect($('#homeYear'), years());
  fillSelect($('#f24Year'), years());
  fillSelect($('#reconciliationYear'), years());
  fillSelect($('#controlYear'), years());
}

async function loadDashboard() {
  const year = $('#homeYear').value || currentYear();
  const data = await api(`/api/dashboard?anno=${year}`);
  $('#dashboardCards').innerHTML = config.conti.map((conto) => {
    const info = data.saldi[conto] || { saldo: 0 };
    return `<article class="card"><small>${conto.replaceAll('_', ' ')}</small><strong>${euro.format(info.saldo)}</strong>${info.daRiallineare ? '<span class="mini-warning">Riporto da riallineare</span>' : ''}</article>`;
  }).join('');
  $('#todo').innerHTML = [
    [data.daVerificare, 'movimenti da verificare'], [data.documentiDaVerificare, 'documenti da verificare'],
    [data.f24DaRiscontrare || 0, 'F24 da riscontrare'], [data.codiciTributoDaVerificare || 0, 'codici/causali da classificare'],
    [data.riscossioneDaVerificare || 0, 'atti riscossione da verificare'], [data.riscossioneSenzaSnapshot || 0, 'atti senza snapshot ADER']
  ].map(([value, label]) => `<div><strong>${value}</strong><span>${label}</span></div>`).join('');
}

async function loadLedger() {
  const conto = $('#ledgerAccount').value; const anno = $('#ledgerYear').value;
  if (!conto || !anno) return;
  const data = await api(`/api/prima-nota/${conto}?anno=${anno}`);
  $('#openingWarning').classList.toggle('hidden', !data.riporto.daRiallineare);
  $('#openingWarning').textContent = data.riporto.daRiallineare ? `Il riporto salvato è ${euro.format(data.riporto.saldo)}, mentre la chiusura precedente ricalcolata è ${euro.format(data.riporto.saldoAtteso)}. Nessuna correzione automatica è stata eseguita.` : '';
  $('#ledgerRows').innerHTML = data.righe.map((row) => {
    const entrata = row.direzione === 'ENTRATA' ? euro.format(row.importo) : '';
    const uscita = row.direzione === 'USCITA' ? euro.format(row.importo) : '';
    return `<tr class="${row.tipo === 'RIPORTO_APERTURA' ? 'opening-row' : ''}"><td>${fmtDate(row.data)}</td><td><strong>${escapeHtml(row.descrizione)}</strong><small>${escapeHtml(row.tipo || '')}</small></td><td>${escapeHtml(row.fonte || (row.tipo === 'RIPORTO_APERTURA' ? 'CHIUSURA PRECEDENTE' : ''))}</td><td>${badge(row.stato)}</td><td class="num positive">${entrata}</td><td class="num negative">${uscita}</td><td class="num balance">${euro.format(row.saldoProgressivo)}</td></tr>`;
  }).join('');
}

async function loadF24() {
  const rows = await api(`/api/f24?anno=${$('#f24Year').value || currentYear()}`);
  $('#f24Rows').innerHTML = rows.length ? rows.map((row) => {
    const protocollo = row.protocollo || row.protocolloLettoNelPdf || 'senza protocollo';
    const saldo = row.saldoModello ?? row.saldoOperazione ?? 0;
    const check = row.controlloSaldo ? `${row.controlloSaldo.stato}${row.codiciDaVerificare ? ` · ${row.codiciDaVerificare} da verificare` : ''}` : (row.codiciDaVerificare ? `${row.codiciDaVerificare} da verificare` : 'righe non ancora analizzate');
    return `<tr><td>${fmtDate(row.dataVersamento)}</td><td><strong>${escapeHtml(protocollo)}</strong><small>${escapeHtml(row.file || '')}</small></td><td>${escapeHtml(String(row.tipoDocumento || '').replaceAll('_', ' '))}</td><td>${escapeHtml(check)}</td><td>${badge(row.stato)}</td><td class="num balance">${euro.format(saldo)}</td></tr>`;
  }).join('') : '<tr><td colspan="6" class="muted">Nessun F24 importato per questo anno.</td></tr>';
}

async function loadTributi() {
  const rows = await api('/api/tributi');
  $('#tributiRows').innerHTML = rows.length ? rows.slice(0, 200).map((row) => `<tr><td>${escapeHtml(row.namespace)}</td><td><strong>${escapeHtml(row.codice)}</strong></td><td>${escapeHtml(row.descrizione)}</td><td>${escapeHtml(row.natura || '—')}</td><td>${escapeHtml(row.fonte)}</td><td>${fmtDate(row.verificatoIl)}</td></tr>`).join('') : '<tr><td colspan="6" class="muted">Registro vuoto.</td></tr>';
}

function selectedMovement() {
  return reconciliationData?.movimenti.find((row) => String(row._id) === reconciliationSelection.movementId) || null;
}

function availableCauses() {
  return reconciliationSelection.causeType === 'F24' ? (reconciliationData?.f24 || []) : (reconciliationData?.atti || []);
}

function selectedCause() {
  return availableCauses().find((row) => String(row._id) === reconciliationSelection.causeId) || null;
}

function causeIdentity(row) {
  if (reconciliationSelection.causeType === 'F24') return row.protocollo || row.file || 'F24 senza protocollo';
  return row.numeroAtto || `${String(row.tipo || '').replaceAll('_', ' ')} senza numero`;
}

function causeAmount(row) {
  if (reconciliationSelection.causeType === 'F24') return Number(row.importoAtteso || 0);
  return Number(row.importoResiduo ?? row.importoOriginario ?? 0);
}

function renderReconciliationSelection() {
  const movement = selectedMovement(); const cause = selectedCause();
  $('#confirmReconciliation').disabled = !(movement && cause && movement.provaFinanziaria);
  if (!movement && !cause) { $('#reconciliationSelection').textContent = 'Seleziona un movimento e una causa.'; return; }
  const movementText = movement ? `${fmtDate(movement.data)} · ${movement.conto} · ${euro.format(movement.importo)} · ${movement.descrizione}` : 'movimento non selezionato';
  const causeText = cause ? `${causeIdentity(cause)} · ${euro.format(causeAmount(cause))}` : 'causa non selezionata';
  $('#reconciliationSelection').innerHTML = `<strong>${escapeHtml(movementText)}</strong><span>↔</span><strong>${escapeHtml(causeText)}</strong>`;
}

function renderReconciliationCauses() {
  const causes = availableCauses();
  $('#reconciliationCauseRows').innerHTML = causes.length ? causes.map((row) => {
    const id = String(row._id); const date = reconciliationSelection.causeType === 'F24' ? row.dataVersamento : (row.dataNotifica || row.dataAtto);
    const detail = reconciliationSelection.causeType === 'F24' ? `${fmtDate(date)} · ${row.tipoDocumento || 'modello'}` : `${fmtDate(date)} · ${(row.entiCreditori || []).join(', ') || row.tipo}`;
    return `<tr class="selectable-row ${reconciliationSelection.causeId === id ? 'selected' : ''}"><td><input class="reconciliation-cause" type="radio" name="reconciliationCause" value="${escapeHtml(id)}" ${reconciliationSelection.causeId === id ? 'checked' : ''}></td><td><strong>${escapeHtml(causeIdentity(row))}</strong><small>${escapeHtml(detail)}</small></td><td>${badge(row.stato)}</td><td class="num balance">${euro.format(causeAmount(row))}</td></tr>`;
  }).join('') : '<tr><td colspan="4" class="muted">Nessuna causa aperta per questa selezione.</td></tr>';
  renderReconciliationSelection();
}

async function loadReconciliation() {
  const year = $('#reconciliationYear').value || currentYear();
  $('#reconciliationResult').textContent = 'Caricamento…';
  reconciliationData = await api(`/api/riconciliazione?anno=${year}`);
  reconciliationSelection = { movementId: null, causeId: null, causeType: $('#reconciliationCauseType').value || 'F24' };
  const summary = reconciliationData.riepilogo;
  $('#reconciliationCards').innerHTML = [[summary.movimentiAperti, 'movimenti disponibili'], [summary.movimentiSenzaProva, 'movimenti senza prova'], [summary.f24Aperti, 'F24 aperti'], [summary.attiAperti, 'atti riscossione aperti'], [summary.collegamentiConfermati, 'collegamenti confermati']].map(([value, label]) => `<article class="card"><small>${label}</small><strong>${value}</strong></article>`).join('');
  $('#reconciliationMovementRows').innerHTML = reconciliationData.movimenti.length ? reconciliationData.movimenti.map((row) => {
    const id = String(row._id); const disabled = !row.provaFinanziaria;
    return `<tr class="selectable-row ${disabled ? 'disabled-row' : ''}"><td><input class="reconciliation-movement" type="radio" name="reconciliationMovement" value="${escapeHtml(id)}" ${disabled ? 'disabled' : ''}></td><td><strong>${fmtDate(row.data)} · ${escapeHtml(row.descrizione)}</strong><small>${escapeHtml(row.fonte || 'fonte non indicata')}</small></td><td>${escapeHtml(row.conto)}</td><td class="num balance">${euro.format(row.importo)}</td><td>${row.provaFinanziaria ? badge('DOCUMENTATO') : '<span class="badge da_verificare">Manca prova</span>'}</td></tr>`;
  }).join('') : '<tr><td colspan="5" class="muted">Nessun movimento finanziario disponibile.</td></tr>';
  renderReconciliationCauses();
  $('#reconciliationResult').textContent = '';
}

async function confirmReconciliation() {
  const movement = selectedMovement(); const cause = selectedCause();
  if (!movement || !cause || !movement.provaFinanziaria) return;
  $('#reconciliationResult').textContent = 'Verifica del collegamento…';
  try {
    const endpoint = reconciliationSelection.causeType === 'F24'
      ? `/api/f24/${encodeURIComponent(cause._id)}/riconcilia`
      : `/api/riscossione/atti/${encodeURIComponent(cause._id)}/collega-movimento`;
    await api(endpoint, { method: 'POST', body: JSON.stringify({ movimentoId: movement._id }) });
    $('#reconciliationResult').textContent = 'Collegamento verificato e registrato.';
    await Promise.all([loadReconciliation(), loadDashboard()]);
  } catch (error) {
    $('#reconciliationResult').textContent = error.message.includes('MFA') ? 'Conferma il codice MFA, poi premi nuovamente Conferma collegamento.' : error.message;
  }
}

async function loadRiscossione() {
  const rows = await api('/api/riscossione/atti');
  $('#riscossioneRows').innerHTML = rows.length ? rows.map((row) => {
    const snapshot = row.ultimoSnapshot || null; const dateParts = [row.dataAtto ? `Atto ${fmtDate(row.dataAtto)}` : null, row.dataNotifica ? `Notifica ${fmtDate(row.dataNotifica)}` : null, row.scadenza ? `Scade ${fmtDate(row.scadenza)}` : null].filter(Boolean);
    return `<tr><td><strong>${escapeHtml(row.numeroAtto || 'senza numero')}</strong><small>${escapeHtml(String(row.tipo || '').replaceAll('_', ' '))}</small></td><td>${dateParts.join('<br>') || '—'}</td><td>${escapeHtml((row.entiCreditori || []).join(', ') || '—')}</td><td>${badge(row.stato)}</td><td class="num">${row.importoOriginario == null ? '—' : euro.format(row.importoOriginario)}</td><td class="num balance">${snapshot?.importoResiduo == null ? '—' : euro.format(snapshot.importoResiduo)}</td><td>${snapshot ? `${fmtDate(snapshot.acquisitoIl)}<small>${escapeHtml(snapshot.statoAder || '')}</small>` : '<span class="mini-warning">Manca snapshot</span>'}</td></tr>`;
  }).join('') : '<tr><td colspan="7" class="muted">Nessun atto registrato.</td></tr>';
}

async function submitRiscossione(event) {
  event.preventDefault(); const formElement = event.currentTarget; const body = Object.fromEntries(new FormData(formElement).entries());
  for (const key of ['numeroAtto', 'dataAtto', 'dataNotifica', 'scadenza', 'importoOriginario', 'enteCreditore', 'fonteRiferimento']) if (body[key] === '') delete body[key];
  if (body.importoOriginario !== undefined) body.importoOriginario = Number(body.importoOriginario);
  try { const saved = await api('/api/riscossione/atti', { method: 'POST', body: JSON.stringify(body) }); $('#riscossioneResult').innerHTML = `<strong>${escapeHtml(saved.numeroAtto || saved.tipo)}</strong><span>Atto registrato; lo snapshot ADER resta separato.</span>`; formElement.reset(); await Promise.all([loadRiscossione(), loadDashboard()]); } catch (error) { $('#riscossioneResult').innerHTML = `<span class="error">${escapeHtml(error.message)}</span>`; }
}

function issue(level, title, detail) {
  return `<article class="issue ${level.toLowerCase()}"><span class="issue-level">${escapeHtml(level)}</span><div><strong>${escapeHtml(title)}</strong><p>${escapeHtml(detail)}</p></div></article>`;
}

async function loadControls() {
  const year = $('#controlYear').value || currentYear();
  const [dashboard, reconciliation, documents, riscossione, drive] = await Promise.all([
    api(`/api/dashboard?anno=${year}`), api(`/api/riconciliazione?anno=${year}`), api('/api/documenti?stato=DA_VERIFICARE'), api('/api/riscossione/controlli'), api('/api/drive-index/overview')
  ]);
  const summary = reconciliation.riepilogo;
  $('#controlCards').innerHTML = [[dashboard.daVerificare, 'movimenti da verificare'], [summary.movimentiSenzaProva, 'senza prova finanziaria'], [dashboard.f24DaRiscontrare, 'F24 da riscontrare'], [documents.length, 'documenti interni da verificare'], [riscossione.senzaSnapshot, 'atti senza snapshot'], [drive.counts.documents, 'documenti indicizzati Drive']].map(([value, label]) => `<article class="card"><small>${label}</small><strong>${value}</strong></article>`).join('');
  const issues = [];
  for (const [account, value] of Object.entries(dashboard.saldi || {})) if (value.daRiallineare) issues.push(issue('ALTA', `Riporto ${account} da riallineare`, `Saldo salvato ${euro.format(value.riporto)}; nessuna correzione automatica eseguita.`));
  for (const row of reconciliation.movimenti.filter((item) => !item.provaFinanziaria).slice(0, 20)) issues.push(issue('ALTA', `Movimento senza prova: ${row.descrizione}`, `${fmtDate(row.data)} · ${row.conto} · ${euro.format(row.importo)}`));
  if (dashboard.f24DaRiscontrare) issues.push(issue('MEDIA', 'F24 in attesa di riscontro finanziario', `${dashboard.f24DaRiscontrare} operazioni richiedono verifica; modello e quietanza non provano da soli l'addebito.`));
  if (riscossione.scadutiAperti) issues.push(issue('ALTA', 'Atti scaduti ancora aperti', `${riscossione.scadutiAperti} atti richiedono controllo amministrativo.`));
  if (riscossione.senzaSnapshot) issues.push(issue('MEDIA', 'Situazione ADER non aggiornata', `${riscossione.senzaSnapshot} atti non hanno uno snapshot ufficiale.`));
  if (documents.length) issues.push(issue('MEDIA', 'Documenti interni da verificare', `${documents.length} documenti non possono ancora guidare registrazioni contabili.`));
  if (!issues.length) issues.push(issue('OK', 'Nessuna anomalia aperta per i controlli disponibili', "L'indice Drive resta consultabile; continuare con i controlli periodici."));
  $('#controlIssues').innerHTML = issues.join('');
  $('#controlMovementRows').innerHTML = reconciliation.movimenti.length ? reconciliation.movimenti.slice(0, 100).map((row) => `<tr><td>${fmtDate(row.data)}</td><td>${escapeHtml(row.conto)}</td><td><strong>${escapeHtml(row.descrizione)}</strong><small>${escapeHtml(row.fonte || '')}</small></td><td>${badge(row.stato)}</td><td>${row.provaFinanziaria ? badge('DOCUMENTATO') : '<span class="badge da_verificare">Manca prova</span>'}</td><td class="num balance">${euro.format(row.importo)}</td></tr>`).join('') : '<tr><td colspan="6" class="muted">Nessun movimento aperto.</td></tr>';
  $('#controlDocumentRows').innerHTML = documents.length ? documents.slice(0, 100).map((row) => `<tr><td><strong>${escapeHtml(row.nomeOriginale || 'documento')}</strong><small>${escapeHtml(row.protocollo || row.sha256 || '')}</small></td><td>${escapeHtml(row.tipo || '—')}</td><td>${badge(row.stato)}</td><td>${fmtDate(row.aggiornatoIl)}</td></tr>`).join('') : '<tr><td colspan="4" class="muted">Nessun documento interno in attesa.</td></tr>';
}

async function openDriveDocument(id) {
  const document = await api(`/api/drive-index/documents/${encodeURIComponent(id)}`);
  window.open(document.drive.webViewLink, '_blank', 'noopener,noreferrer');
}

async function loadDriveIndex(force = false) {
  $('#driveIndexMessage').textContent = 'Lettura indice in corso…';
  const [overview, imported] = await Promise.all([
    api(`/api/drive-index/overview${force ? '?refresh=true' : ''}`),
    api('/api/drive-data/summary').catch(() => null)
  ]);
  const counts = overview.counts; const dbCounts = imported?.counts || {};
  $('#driveIndexCards').innerHTML = [
    [dbCounts.driveFiles ?? counts.documents, 'file Drive catalogati'], [dbCounts.documents ?? 0, 'documenti nel gestionale'], [dbCounts.f24Rows ?? counts.f24Rows, 'righe F24'], [dbCounts.f24 ?? 0, 'modelli F24'], [dbCounts.quietanze ?? 0, 'quietanze F24'], [dbCounts.declarations ?? counts.declarations, 'dichiarazioni'], [dbCounts.invoices ?? 0, 'fatture XML'], [dbCounts.corrispettivi ?? 0, 'corrispettivi RT']
  ].map(([value, label]) => `<article class="card"><small>${label}</small><strong>${value}</strong></article>`).join('');
  const lastRun = imported?.lastRun;
  $('#driveImportStatus').textContent = lastRun?.stato === 'IN_CORSO' ? 'Importazione in corso…' : lastRun?.stato ? `${lastRun.stato.replaceAll('_', ' ')} · ${fmtDate(lastRun.completatoIl || lastRun.iniziatoIl)}` : 'In attesa del primo import';
  $('#driveDataRows').innerHTML = imported?.byDomain?.length ? imported.byDomain.map((row) => `<tr><td>${escapeHtml(row._id || '(radice)')}</td><td class="num"><strong>${row.count}</strong></td></tr>`).join('') : '<tr><td colspan="2" class="muted">La sincronizzazione del catalogo è in corso.</td></tr>';
  $('#driveIndexMessage').textContent = `Indice letto ${fmtDate(overview.loadedAt)} · originali conservati esclusivamente su Drive`;
  const declarations = await api('/api/drive-index/declarations');
  $('#driveDeclarationRows').innerHTML = declarations.map((row) => `<tr><td>${escapeHtml(row.year)}</td><td>${escapeHtml(row.type)}</td><td>${escapeHtml(row.protocol || '—')}</td><td><button type="button" class="drive-open" data-document-id="${escapeHtml(row.documentId)}">Apri su Drive</button><small>${escapeHtml(row.archivePath)}</small></td></tr>`).join('');
  await loadDriveDocuments();
}

async function loadDriveDocuments() {
  const params = new URLSearchParams({ limit: '200' });
  const query = $('#driveDocumentQuery').value.trim();
  const year = $('#driveDocumentYear').value;
  if (query) params.set('q', query);
  if (year) params.set('year', year);
  const full = await api(`/api/drive-data/files?${params}`).catch(() => null);
  const data = full?.rows?.length || full?.total ? full : await api(`/api/drive-index/documents?${params}`);
  $('#driveIndexMessage').textContent = `${data.total} documenti trovati · visualizzati ${data.rows.length}`;
  $('#driveDocumentRows').innerHTML = data.rows.length ? data.rows.map((row) => {
    const fullRow = Boolean(row.driveFileId); const name = row.nome || row.name; const path = row.percorso || row.path; const domain = row.topFolder || row.domain; const type = row.tipoProposto || row.category || row.extension; const yearValue = row.anno || row.year || '—';
    const button = fullRow ? `<button type="button" class="drive-open-url" data-url="${escapeHtml(row.webViewLink || '')}">Apri su Drive</button>` : `<button type="button" class="drive-open" data-document-id="${escapeHtml(row.id)}">Apri su Drive</button>`;
    return `<tr><td><strong>${escapeHtml(name)}</strong><small>${escapeHtml(type)}</small></td><td>${escapeHtml(domain)}</td><td>${escapeHtml(yearValue)}</td><td>${badge(fullRow ? 'INDICIZZATO' : row.status)}</td><td>${button}<small>${escapeHtml(path)}</small></td></tr>`;
  }).join('') : '<tr><td colspan="5" class="muted">Nessun documento trovato.</td></tr>';
}

async function submitLogin(event) {
  event.preventDefault();
  const formElement = event.currentTarget;
  const pin = new FormData(formElement).get('pin');
  $('#loginError').textContent = '';
  try {
    await api('/api/auth/pin-login', { method: 'POST', body: JSON.stringify({ pin }) });
    formElement.reset(); hideLogin(); await initializeApplication();
  } catch (error) { $('#loginError').textContent = error.message; }
}

async function submitMfa(event) {
  event.preventDefault();
  const code = new FormData(event.currentTarget).get('code');
  $('#mfaError').textContent = '';
  try {
    await api('/api/auth/mfa', { method: 'POST', body: JSON.stringify({ code }) });
    hideMfa();
  } catch (error) { $('#mfaError').textContent = error.message; }
}

async function logout() {
  try { await api('/api/auth/logout', { method: 'POST', body: '{}' }); } catch {}
  appReady = false; hideMfa(); showLogin('Sessione terminata.');
}

async function submitMovement(event) {
  event.preventDefault(); const formElement = event.currentTarget; const form = new FormData(formElement); const body = Object.fromEntries(form.entries()); body.importo = Number(body.importo);
  try { await api('/api/movimenti', { method: 'POST', body: JSON.stringify(body) }); $('#movementDialog').close(); formElement.reset(); $('#movementForm [name=data]').valueAsDate = new Date(); await Promise.all([loadLedger(), loadDashboard()]); } catch (error) { $('#formError').textContent = error.message; }
}

async function submitReceipts(event) {
  event.preventDefault(); const form = new FormData(event.currentTarget);
  const body = { data: form.get('data'), totaleXml: Number(form.get('totaleXml')), chiusuraOperativa: form.get('chiusuraOperativa') === '' ? null : Number(form.get('chiusuraOperativa')), pos: { NUMIA: form.get('numia') === '' ? null : Number(form.get('numia')), SUMUP: form.get('sumup') === '' ? null : Number(form.get('sumup')) }, originePos: { NUMIA: 'MANUALE', SUMUP: 'MANUALE' } };
  try { const data = await api('/api/corrispettivi/giornata', { method: 'POST', body: JSON.stringify(body) }); const contante = data.contanteAtteso === null ? 'non determinabile' : euro.format(data.contanteAtteso); const fiscale = data.controlloFiscale.stato === 'ALLINEATO' ? 'XML e chiusura operativa allineati' : data.controlloFiscale.stato === 'DIFFERENZA' ? `Differenza fiscale ${euro.format(data.controlloFiscale.differenza)}` : 'Chiusura operativa non disponibile'; $('#receiptsResult').innerHTML = `<strong>Contante atteso: ${contante}</strong><span>${fiscale}</span>${data.nota ? `<span class="mini-warning">${escapeHtml(data.nota)}</span>` : ''}`; await Promise.all([loadLedger(), loadDashboard()]); } catch (error) { $('#receiptsResult').innerHTML = `<span class="error">${escapeHtml(error.message)}</span>`; }
}

async function submitTributo(event) {
  event.preventDefault(); const formElement = event.currentTarget; const body = Object.fromEntries(new FormData(formElement).entries());
  try { const saved = await api('/api/tributi', { method: 'POST', body: JSON.stringify(body) }); $('#tributoResult').innerHTML = `<strong>${escapeHtml(saved.codice)}</strong><span>versione registrata</span>`; formElement.reset(); await Promise.all([loadTributi(), loadF24(), loadDashboard()]); } catch (error) { $('#tributoResult').innerHTML = `<span class="error">${escapeHtml(error.message)}</span>`; }
}

function setView(name) { $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`)); $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === name)); if (name === 'prima-nota') loadLedger().catch((e) => showLogin(e.message)); if (name === 'documenti') loadDriveIndex().catch((e) => { $('#driveIndexMessage').textContent = e.message; }); if (name === 'riconciliazione') loadReconciliation().catch((e) => { $('#reconciliationResult').textContent = e.message; }); if (name === 'amministrazione') Promise.all([loadF24(), loadTributi(), loadRiscossione()]).catch((e) => showLogin(e.message)); if (name === 'controllo') loadControls().catch((e) => { $('#controlIssues').innerHTML = issue('ALTA', 'Controllo non disponibile', e.message); }); }

function bindEvents() {
  $$('.nav-item').forEach((button) => button.addEventListener('click', () => setView(button.dataset.view)));
  $('#homeYear').addEventListener('change', () => loadDashboard().catch((e) => showLogin(e.message)));
  $('#ledgerAccount').addEventListener('change', () => loadLedger().catch((e) => showLogin(e.message)));
  $('#ledgerYear').addEventListener('change', () => loadLedger().catch((e) => showLogin(e.message)));
  $('#f24Year').addEventListener('change', () => loadF24().catch((e) => showLogin(e.message)));
  $('#reconciliationYear').addEventListener('change', () => loadReconciliation().catch((e) => { $('#reconciliationResult').textContent = e.message; }));
  $('#reloadReconciliation').addEventListener('click', () => loadReconciliation().catch((e) => { $('#reconciliationResult').textContent = e.message; }));
  $('#reconciliationCauseType').addEventListener('change', (event) => { reconciliationSelection.causeType = event.target.value; reconciliationSelection.causeId = null; renderReconciliationCauses(); });
  $('#reconciliationMovementRows').addEventListener('change', (event) => { if (event.target.matches('.reconciliation-movement')) { reconciliationSelection.movementId = event.target.value; renderReconciliationSelection(); } });
  $('#reconciliationCauseRows').addEventListener('change', (event) => { if (event.target.matches('.reconciliation-cause')) { reconciliationSelection.causeId = event.target.value; renderReconciliationCauses(); } });
  $('#confirmReconciliation').addEventListener('click', confirmReconciliation);
  $('#controlYear').addEventListener('change', () => loadControls().catch((e) => { $('#controlIssues').innerHTML = issue('ALTA', 'Controllo non disponibile', e.message); }));
  $('#reloadControls').addEventListener('click', () => loadControls().catch((e) => { $('#controlIssues').innerHTML = issue('ALTA', 'Controllo non disponibile', e.message); }));
  $('#refreshDriveIndex').addEventListener('click', () => loadDriveIndex(true).catch((e) => { $('#driveIndexMessage').textContent = e.message; }));
  $('#searchDriveDocuments').addEventListener('click', () => loadDriveDocuments().catch((e) => { $('#driveIndexMessage').textContent = e.message; }));
  $('#driveDocumentQuery').addEventListener('keydown', (event) => { if (event.key === 'Enter') loadDriveDocuments().catch((e) => { $('#driveIndexMessage').textContent = e.message; }); });
  document.addEventListener('click', (event) => { const button = event.target.closest('.drive-open'); if (button) openDriveDocument(button.dataset.documentId).catch((e) => { $('#driveIndexMessage').textContent = e.message; }); });
  document.addEventListener('click', (event) => { const button = event.target.closest('.drive-open-url'); if (button?.dataset.url) window.open(button.dataset.url, '_blank', 'noopener,noreferrer'); });
  $('#newMovement').addEventListener('click', () => $('#movementDialog').showModal()); $('#closeDialog').addEventListener('click', () => $('#movementDialog').close());
  $('#movementForm').addEventListener('submit', submitMovement); $('#receiptsForm').addEventListener('submit', submitReceipts); $('#tributoForm').addEventListener('submit', submitTributo); $('#riscossioneForm').addEventListener('submit', submitRiscossione);
  $('#loginForm').addEventListener('submit', submitLogin); $('#mfaForm').addEventListener('submit', submitMfa); $('#cancelMfa').addEventListener('click', hideMfa); $('#logoutButton').addEventListener('click', logout);
}

async function initializeApplication() {
  if (appReady) { await loadDashboard(); return; }
  await loadConfig(); appReady = true; await loadDashboard();
}

async function boot() {
  ensureMfaDialog(); $('#movementForm [name=data]').valueAsDate = new Date(); $('#receiptsForm [name=data]').valueAsDate = new Date(); fillSelect($('#driveDocumentYear'), ['', ...years()]); $('#driveDocumentYear option:first-child').textContent = 'Tutti gli anni'; bindEvents(); await loadHealth();
  try { if (await checkAuth()) await initializeApplication(); } catch (error) { showLogin(error.message); }
}

boot();
