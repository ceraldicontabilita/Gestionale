const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const euro = new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR' });
let config = { conti: [], stati: [] };
let appReady = false;
let reconciliationData = null;
let reconciliationSelection = { movementId: null, causeId: null, causeType: 'F24' };
let supplierInvoiceStaging = [];
let supplierDirectoryData = { counts: {}, rows: [] };
let driveDeclarations = [];
let supplierImportPollTimer = null;
let supplierImportRuntime = { jobId: null, active: false, networkPercent: null, displayPercent: 0 };
let bankImportPollTimer = null;
let bankImportRuntime = { jobId: null, active: false, networkPercent: null, displayPercent: 0 };
let pinConfirmationRequest = null;
const SUPPLIER_IMPORT_JOB_KEY = 'impresa_supplier_invoice_import_job';
const BANK_IMPORT_JOB_KEY = 'impresa_bank_movement_import_job';

function currentYear() { return new Date().getFullYear(); }
function years() { const now = currentYear(); return Array.from({ length: 9 }, (_, i) => now - i); }
function fillSelect(select, values) { select.innerHTML = values.map((v) => `<option value="${v}">${String(v).replaceAll('_', ' ')}</option>`).join(''); }
function fmtDate(value) { return value ? new Date(value).toLocaleDateString('it-IT') : '—'; }
function fmtSourceDate(value) { return /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(String(value || '')) ? String(value) : fmtDate(value); }
function badge(status) {
  const label = String(status || 'SCONOSCIUTO');
  const className = label.toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
  return `<span class="badge ${className}">${escapeHtml(label.replaceAll('_', ' '))}</span>`;
}
function escapeHtml(value) { return String(value ?? '').replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c])); }
function cookieValue(name) { return document.cookie.split(';').map((v) => v.trim()).find((v) => v.startsWith(`${name}=`))?.slice(name.length + 1) || ''; }

function ensurePinConfirmationDialog() {
  if ($('#pinConfirmationDialog')) return;
  document.body.insertAdjacentHTML('beforeend', `
    <dialog id="pinConfirmationDialog" class="login-dialog">
      <form id="pinConfirmationForm">
        <div><p class="eyebrow">CONFERMA OPERAZIONE</p><h3>Reinserisci il PIN</h3><p id="pinConfirmationMessage" class="muted">Il PIN protegge modifiche sensibili ed eliminazioni.</p></div>
        <label>PIN<input name="pin" type="password" inputmode="numeric" pattern="[0-9]{4,12}" minlength="4" maxlength="12" autocomplete="current-password" required></label>
        <div class="two-cols"><button class="primary" type="submit">Conferma</button><button id="cancelPinConfirmation" type="button">Annulla</button></div>
        <p id="pinConfirmationError" class="error"></p>
      </form>
    </dialog>`);
}

function showLogin(message = '') {
  $('#loginError').textContent = message;
  $('#logoutButton').classList.add('hidden');
  if ($('#pinConfirmationDialog')?.open) $('#pinConfirmationDialog').close();
  if (!$('#loginDialog').open) $('#loginDialog').showModal();
}

function hideLogin() {
  if ($('#loginDialog').open) $('#loginDialog').close();
  $('#logoutButton').classList.remove('hidden');
}

function requestPinConfirmation(message = 'Reinserisci il PIN per confermare questa operazione.') {
  if (pinConfirmationRequest) return pinConfirmationRequest.promise;
  ensurePinConfirmationDialog();
  $('#pinConfirmationMessage').textContent = message;
  $('#pinConfirmationError').textContent = '';
  if (!$('#pinConfirmationDialog').open) $('#pinConfirmationDialog').showModal();
  $('#pinConfirmationForm [name=pin]').focus();
  let resolveRequest;
  let rejectRequest;
  const promise = new Promise((resolve, reject) => { resolveRequest = resolve; rejectRequest = reject; });
  pinConfirmationRequest = { promise, resolve: resolveRequest, reject: rejectRequest };
  return promise;
}

function hidePinConfirmation() {
  if ($('#pinConfirmationDialog')?.open) $('#pinConfirmationDialog').close();
  $('#pinConfirmationForm')?.reset();
  if ($('#pinConfirmationError')) $('#pinConfirmationError').textContent = '';
}

function cancelPinConfirmation() {
  const pending = pinConfirmationRequest;
  pinConfirmationRequest = null;
  hidePinConfirmation();
  pending?.reject(new Error('Conferma PIN annullata'));
}

async function api(url, options = {}, { allowPinPrompt = true } = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) headers['X-CSRF-Token'] = decodeURIComponent(cookieValue('impresa_csrf'));
  const response = await fetch(url, { credentials: 'same-origin', ...options, method, headers });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401 && url !== '/api/auth/pin-confirm') showLogin('Sessione scaduta. Inserisci nuovamente il PIN.');
  if (response.status === 428 && data.code === 'PIN_CONFIRMATION_REQUIRED' && allowPinPrompt) {
    await requestPinConfirmation(data.error);
    return api(url, options, { allowPinPrompt: false });
  }
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
    [data.riscossioneDaVerificare || 0, 'atti riscossione da verificare'], [data.riscossioneSenzaSnapshot || 0, 'atti senza snapshot ADER'],
    [data.partiteAperte || 0, 'partite aperte fornitori'], [data.partiteScadute || 0, 'partite fornitori scadute']
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
  const year = $('#f24Year').value || currentYear();
  const [rows, receipts, indexed] = await Promise.all([
    api(`/api/f24?anno=${year}`),
    api(`/api/f24-quietanze?anno=${year}`),
    api(`/api/drive-index/f24-documents?year=${year}`).catch(() => ({ models: [], receipts: [] }))
  ]);
  const modelIds = new Set(rows.map((row) => row.documentIndexId || String(row.sourceKey || '').split(':').at(-1)).filter(Boolean));
  const receiptIds = new Set(receipts.map((row) => row.documentIndexId || String(row.sourceKey || '').split(':').at(-1)).filter(Boolean));
  const modelRows = [...rows, ...indexed.models.filter((row) => !modelIds.has(row.documentId)).map((row) => ({
    sourceOnly: true, documentIndexId: row.documentId, dataVersamento: row.date, protocollo: row.protocol,
    file: row.documentName, tipoDocumento: row.documentType, codiciDaVerificare: row.rowCount,
    stato: row.state, saldoModello: row.totals.balance
  }))];
  const receiptRows = [...receipts, ...indexed.receipts.filter((row) => !receiptIds.has(row.documentId)).map((row) => ({
    sourceOnly: true, documentIndexId: row.documentId, dataVersamento: row.date, protocollo: row.protocol,
    percorsoDrive: row.path, stato: row.state, totaliRighe: { saldo: row.totals.balance }
  }))];
  $('#f24Rows').innerHTML = modelRows.length ? modelRows.map((row) => {
    const protocollo = row.protocollo || row.protocolloLettoNelPdf || 'senza protocollo';
    const saldo = row.saldoModello ?? row.saldoOperazione ?? 0;
    const check = row.controlloSaldo ? `${row.controlloSaldo.stato}${row.codiciDaVerificare ? ` · ${row.codiciDaVerificare} da verificare` : ''}` : (row.codiciDaVerificare ? `${row.codiciDaVerificare} righe dall'indice` : 'righe non ancora analizzate');
    const sourceButton = row.documentIndexId ? `<button type="button" class="drive-open" data-document-id="${escapeHtml(row.documentIndexId)}">Apri documento</button>` : '';
    return `<tr><td>${fmtSourceDate(row.dataVersamento)}</td><td><strong>${escapeHtml(protocollo)}</strong><small>${escapeHtml(row.file || '')}</small>${sourceButton}</td><td>${escapeHtml(String(row.tipoDocumento || '').replaceAll('_', ' '))}</td><td>${escapeHtml(check)}</td><td>${badge(row.stato)}</td><td class="num balance">${euro.format(saldo)}</td></tr>`;
  }).join('') : '<tr><td colspan="6" class="muted">Nessun F24 indicizzato per questo anno.</td></tr>';
  $('#f24ReceiptRows').innerHTML = receiptRows.length ? receiptRows.map((row) => `<tr><td>${fmtSourceDate(row.dataVersamento)}</td><td><strong>${escapeHtml(row.protocollo || 'senza protocollo')}</strong></td><td>${row.documentIndexId ? `<button type="button" class="drive-open" data-document-id="${escapeHtml(row.documentIndexId)}">Apri quietanza</button>` : ''}<small>${escapeHtml(row.percorsoDrive || '')}</small></td><td>${badge(row.stato)}</td><td class="num balance">${euro.format(row.totaliRighe?.saldo || 0)}</td></tr>`).join('') : '<tr><td colspan="5" class="muted">Nessuna quietanza indicizzata per questo anno.</td></tr>';
}

async function loadTributi() {
  const rows = await api('/api/tributi');
  $('#tributiRows').innerHTML = rows.length ? rows.slice(0, 500).map((row) => `<tr><td>${escapeHtml(row.namespace)}</td><td><strong>${escapeHtml(row.codice)}</strong><small>${row.occurrences || 0} righe F24 osservate</small></td><td>${escapeHtml(row.descrizione)}<small>${escapeHtml((row.observedSections || []).join(', '))}</small></td><td>${escapeHtml(row.natura || '—')}</td><td>${escapeHtml(row.fonte)}<small>${badge(row.registryStatus || 'CLASSIFICATO')}</small></td><td>${row.verificatoIl ? fmtDate(row.verificatoIl) : '<span class="mini-warning">Da classificare</span>'}</td></tr>`).join('') : '<tr><td colspan="6" class="muted">Nessun codice osservato negli F24.</td></tr>';
}

function selectedMovement() {
  return reconciliationData?.movimenti.find((row) => String(row._id) === reconciliationSelection.movementId) || null;
}

function availableCauses() {
  if (reconciliationSelection.causeType === 'FATTURA_FORNITORE') return reconciliationData?.openItems?.candidates || [];
  return reconciliationSelection.causeType === 'F24' ? (reconciliationData?.f24 || []) : (reconciliationData?.atti || []);
}

function selectedCause() {
  return availableCauses().find((row) => String(row._id || row.invoiceId) === reconciliationSelection.causeId) || null;
}

function causeIdentity(row) {
  if (reconciliationSelection.causeType === 'FATTURA_FORNITORE') return `${row.invoiceNumber || 'senza numero'} · ${row.supplier?.name || 'fornitore da identificare'}`;
  if (reconciliationSelection.causeType === 'F24') return row.protocollo || row.file || 'F24 senza protocollo';
  return row.numeroAtto || `${String(row.tipo || '').replaceAll('_', ' ')} senza numero`;
}

function causeAmount(row) {
  if (reconciliationSelection.causeType === 'FATTURA_FORNITORE') return Number(row.residualCents || 0) / 100;
  if (reconciliationSelection.causeType === 'F24') return Number(row.importoAtteso || 0);
  return Number(row.importoResiduo ?? row.importoOriginario ?? 0);
}

function renderReconciliationSelection() {
  const movement = selectedMovement(); const cause = selectedCause();
  const supplierAllocation = reconciliationSelection.causeType === 'FATTURA_FORNITORE'
    ? Math.min(Number(movement?.availableAmount || 0), Number(cause?.residualCents || 0) / 100)
    : null;
  const supplierReady = reconciliationSelection.causeType !== 'FATTURA_FORNITORE'
    || Boolean(movement?.movementReference && cause?.invoiceNaturalKey && supplierAllocation > 0);
  $('#confirmReconciliation').disabled = !(movement && cause && movement.provaFinanziaria && supplierReady);
  if (!movement && !cause) { $('#reconciliationSelection').textContent = 'Seleziona un movimento e una causa.'; return; }
  const movementText = movement ? `${fmtDate(movement.data)} · ${movement.conto} · ${euro.format(movement.importo)} · ${movement.descrizione}` : 'movimento non selezionato';
  const causeText = cause ? `${causeIdentity(cause)} · ${euro.format(causeAmount(cause))}` : 'causa non selezionata';
  const allocationText = supplierAllocation > 0 ? `<small>Importo esatto da allocare: ${escapeHtml(euro.format(supplierAllocation))}. L'eventuale eccedenza del movimento resta disponibile.</small>` : '';
  $('#reconciliationSelection').innerHTML = `<strong>${escapeHtml(movementText)}</strong><span>↔</span><strong>${escapeHtml(causeText)}</strong>${allocationText}`;
}

function renderReconciliationCauses() {
  const causes = availableCauses();
  $('#reconciliationCauseRows').innerHTML = causes.length ? causes.map((row) => {
    const id = String(row._id || row.invoiceId); const date = reconciliationSelection.causeType === 'FATTURA_FORNITORE' ? row.dueDate : (reconciliationSelection.causeType === 'F24' ? row.dataVersamento : (row.dataNotifica || row.dataAtto));
    const detail = reconciliationSelection.causeType === 'FATTURA_FORNITORE' ? `${fmtDate(row.documentDate)} · scadenza ${fmtDate(row.dueDate)} · ${row.documentType || 'fattura'}` : (reconciliationSelection.causeType === 'F24' ? `${fmtDate(date)} · ${row.tipoDocumento || 'modello'}` : `${fmtDate(date)} · ${(row.entiCreditori || []).join(', ') || row.tipo}`);
    return `<tr class="selectable-row ${reconciliationSelection.causeId === id ? 'selected' : ''}"><td><input class="reconciliation-cause" type="radio" name="reconciliationCause" value="${escapeHtml(id)}" ${reconciliationSelection.causeId === id ? 'checked' : ''}></td><td><strong>${escapeHtml(causeIdentity(row))}</strong><small>${escapeHtml(detail)}</small></td><td>${badge(row.status || row.stato)}</td><td class="num balance">${euro.format(causeAmount(row))}</td></tr>`;
  }).join('') : '<tr><td colspan="4" class="muted">Nessuna causa aperta per questa selezione.</td></tr>';
  renderReconciliationSelection();
}

async function loadReconciliation() {
  const year = $('#reconciliationYear').value || currentYear();
  $('#reconciliationResult').textContent = 'Caricamento…';
  const [reconciliation, openItems] = await Promise.all([
    api(`/api/riconciliazione?anno=${year}`),
    api(`/api/riconciliazione/partite-aperte?status=${encodeURIComponent($('#openItemStatus').value || 'OPEN')}`)
  ]);
  reconciliationData = { ...reconciliation, openItems };
  reconciliationSelection = { movementId: null, causeId: null, causeType: $('#reconciliationCauseType').value || 'FATTURA_FORNITORE' };
  const summary = reconciliationData.riepilogo;
  $('#reconciliationCards').innerHTML = [[summary.movimentiAperti, 'movimenti disponibili'], [summary.movimentiSenzaProva, 'movimenti senza prova'], [openItems.counts.open + openItems.counts.partial, 'partite fornitori aperte'], [summary.f24Aperti, 'F24 aperti'], [summary.attiAperti, 'atti riscossione aperti'], [summary.collegamentiConfermati, 'collegamenti confermati']].map(([value, label]) => `<article class="card"><small>${label}</small><strong>${value}</strong></article>`).join('');
  $('#openItemMessage').textContent = `${openItems.counts.open + openItems.counts.partial} partite aperte · ${openItems.counts.overdue} scadute · residuo ${euro.format(openItems.counts.residualCents / 100)}`;
  $('#openItemRows').innerHTML = openItems.rows.length ? openItems.rows.map((row) => `<tr><td><strong>${escapeHtml(row.supplier?.name || 'Fornitore da identificare')}</strong><small>${escapeHtml(row.supplier?.vatId || row.supplier?.taxId || '')}</small></td><td><strong>${escapeHtml(row.invoiceNumber || 'senza numero')}</strong><small>${escapeHtml(row.documentType || '')} · ${fmtDate(row.documentDate)}</small></td><td>${row.dueDate ? fmtDate(row.dueDate) : '<span class="mini-warning">Non indicata</span>'}${row.overdue ? '<small class="mini-warning">Scaduta</small>' : ''}</td><td>${badge(row.status)}</td><td class="num">${euro.format(row.originalCents / 100)}</td><td class="num">${euro.format(row.allocatedCents / 100)}</td><td class="num balance">${euro.format(row.residualCents / 100)}</td><td><button type="button" class="supplier-invoice-tree" data-invoice-id="${escapeHtml(row.invoiceId || '')}">Albero</button></td></tr>`).join('') : '<tr><td colspan="8" class="muted">Nessuna partita corrisponde al filtro.</td></tr>';
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
    const endpoint = reconciliationSelection.causeType === 'FATTURA_FORNITORE'
      ? `/api/supplier-invoices/${encodeURIComponent(cause.invoiceId)}/reconcile`
      : reconciliationSelection.causeType === 'F24'
        ? `/api/f24/${encodeURIComponent(cause._id)}/riconcilia`
        : `/api/riscossione/atti/${encodeURIComponent(cause._id)}/collega-movimento`;
    const body = reconciliationSelection.causeType === 'FATTURA_FORNITORE' ? {
      movementId: movement._id,
      movementReference: movement.movementReference,
      invoiceNaturalKey: cause.invoiceNaturalKey,
      allocationAmount: Math.min(Number(movement.availableAmount || 0), Number(cause.residualCents || 0) / 100)
    } : { movimentoId: movement._id };
    await api(endpoint, { method: 'POST', body: JSON.stringify(body) });
    $('#reconciliationResult').textContent = 'Collegamento verificato e registrato.';
    await Promise.all([loadReconciliation(), loadDashboard()]);
  } catch (error) {
    $('#reconciliationResult').textContent = error.message;
  }
}

async function loadRiscossione() {
  const [rows, sources, packageSources] = await Promise.all([
    api('/api/riscossione/atti'),
    api('/api/drive-data/domains/riscossione/files?limit=500').catch(() => ({ total: 0, rows: [] })),
    api('/api/drive-data/source-packages/records?packageKind=ESTRAZIONE_5_MITTENTI&recordType=ALLEGATO_EMAIL&category=agenzia_riscossione&limit=500').catch(() => ({ total: 0, rows: [] }))
  ]);
  $('#riscossioneRows').innerHTML = rows.length ? rows.map((row) => {
    const snapshot = row.ultimoSnapshot || null; const dateParts = [row.dataAtto ? `Atto ${fmtDate(row.dataAtto)}` : null, row.dataNotifica ? `Notifica ${fmtDate(row.dataNotifica)}` : null, row.scadenza ? `Scade ${fmtDate(row.scadenza)}` : null].filter(Boolean);
    return `<tr><td><strong>${escapeHtml(row.numeroAtto || 'senza numero')}</strong><small>${escapeHtml(String(row.tipo || '').replaceAll('_', ' '))}</small></td><td>${dateParts.join('<br>') || '—'}</td><td>${escapeHtml((row.entiCreditori || []).join(', ') || '—')}</td><td>${badge(row.stato)}</td><td class="num">${row.importoOriginario == null ? '—' : euro.format(row.importoOriginario)}</td><td class="num balance">${snapshot?.importoResiduo == null ? '—' : euro.format(snapshot.importoResiduo)}</td><td>${snapshot ? `${fmtDate(snapshot.acquisitoIl)}<small>${escapeHtml(snapshot.statoAder || '')}</small>` : '<span class="mini-warning">Manca snapshot</span>'}</td></tr>`;
  }).join('') : '<tr><td colspan="7" class="muted">Nessun atto registrato.</td></tr>';
  const sourceRows = [
    ...sources.rows.map((row) => ({ name: row.nome, year: row.anno, type: row.tipoProposto, status: 'OSSERVATO_SU_DRIVE', location: row.percorso, url: row.webViewLink })),
    ...packageSources.rows.map((row) => ({ name: row.fileName, year: row.year, type: row.recordType, status: row.status || 'INDICIZZATO_DA_EMAIL', location: `${row.drivePackageName} · ${row.sourceEntry} riga ${row.sourceRow}`, url: row.sourceUrl || row.drivePackageWebViewLink }))
  ];
  $('#riscossioneSourceMessage').textContent = `${sourceRows.length} documenti ADER/cartelle osservati da Drive e dagli indici ZIP; la classificazione canonica resta separata.`;
  $('#riscossioneSourceRows').innerHTML = sourceRows.length ? sourceRows.map((row) => `<tr><td><strong>${escapeHtml(row.name)}</strong><small>${escapeHtml(row.type || '')}</small></td><td>${escapeHtml(row.year || '—')}</td><td>${badge(row.status)}</td><td><small>${escapeHtml(row.location || '')}</small></td><td><button type="button" class="drive-open-url" data-url="${escapeHtml(row.url || '')}">Apri fonte</button></td></tr>`).join('') : '<tr><td colspan="5" class="muted">Nessun documento ADER o cartella trovato nelle fonti indicizzate.</td></tr>';
}

async function loadArchives() {
  const currentDomain = $('#archiveDomain').value;
  const currentYearValue = $('#archiveYear').value;
  const summary = await api('/api/drive-data/domains');
  if ($('#archiveDomain').options.length <= 1) {
    $('#archiveDomain').innerHTML = '<option value="">Tutte le categorie</option>' + summary.domains.map((row) => `<option value="${escapeHtml(row.key)}">${escapeHtml(row.label)}</option>`).join('');
  }
  const availableYears = [...new Set(summary.topFolders.flatMap((row) => row.years || []).filter((value) => Number(value)).map(Number))].sort((left, right) => right - left);
  if ($('#archiveYear').options.length <= 1) $('#archiveYear').innerHTML = '<option value="">Tutti gli anni</option>' + availableYears.map((year) => `<option value="${year}">${year}</option>`).join('');
  if (currentDomain) $('#archiveDomain').value = currentDomain;
  if (currentYearValue) $('#archiveYear').value = currentYearValue;
  $('#archiveDomainCards').innerHTML = summary.domains.map((row) => `<article class="card"><small>${escapeHtml(row.label)}</small><strong>${row.count}</strong></article>`).join('');
  const params = new URLSearchParams({ limit: '500' });
  if ($('#archiveDomain').value) params.set('domain', $('#archiveDomain').value);
  if ($('#archiveYear').value) params.set('year', $('#archiveYear').value);
  if ($('#archiveQuery').value.trim()) params.set('q', $('#archiveQuery').value.trim());
  const packageParams = new URLSearchParams({ limit: '500' });
  if ($('#sourcePackageKind').value) packageParams.set('packageKind', $('#sourcePackageKind').value);
  if ($('#sourcePackageRecordType').value) packageParams.set('recordType', $('#sourcePackageRecordType').value);
  const [documents, verbali, packageVerbali, packageSummary, packageRecords] = await Promise.all([
    api(`/api/drive-data/files?${params}`),
    api('/api/drive-data/domains/verbali/files?limit=500'),
    api('/api/drive-data/source-packages/records?packageKind=ESTRAZIONE_5_MITTENTI&recordType=ALLEGATO_EMAIL&category=notifica_polizia_locale&limit=500').catch(() => ({ rows: [] })),
    api('/api/drive-data/source-packages/summary').catch(() => ({ total: 0, rows: [] })),
    api(`/api/drive-data/source-packages/records?${packageParams}`).catch(() => ({ total: 0, rows: [] }))
  ]);
  $('#archiveMessage').textContent = `${documents.total} documenti trovati · ${documents.rows.length} visualizzati · originali conservati su Drive`;
  $('#archiveRows').innerHTML = documents.rows.length ? documents.rows.map((row) => `<tr><td><strong>${escapeHtml(row.nome)}</strong><small>${escapeHtml(row.percorso || '')}</small></td><td>${escapeHtml(row.topFolder || '—')}</td><td>${escapeHtml(String(row.tipoProposto || 'DOCUMENTO_DRIVE').replaceAll('_', ' '))}</td><td>${escapeHtml(row.anno || '—')}</td><td><button type="button" class="drive-open-url" data-url="${escapeHtml(row.webViewLink || '')}">Apri su Drive</button></td></tr>`).join('') : '<tr><td colspan="5" class="muted">Nessun documento corrisponde ai filtri.</td></tr>';
  const verbaliRows = [
    ...verbali.rows.map((row) => ({ name: row.nome, type: row.tipoProposto, year: row.anno, location: row.percorso, url: row.webViewLink })),
    ...packageVerbali.rows.map((row) => ({ name: row.fileName, type: row.status || row.recordType, year: row.year, location: `${row.drivePackageName} · ${row.sourceEntry} riga ${row.sourceRow}`, url: row.sourceUrl || row.drivePackageWebViewLink }))
  ];
  $('#archiveVerbaliRows').innerHTML = verbaliRows.length ? verbaliRows.map((row) => `<tr><td><strong>${escapeHtml(row.name)}</strong><small>${escapeHtml(row.type || '')}</small></td><td>${escapeHtml(row.year || '—')}</td><td><small>${escapeHtml(row.location || '')}</small></td><td><button type="button" class="drive-open-url" data-url="${escapeHtml(row.url || '')}">Apri fonte</button></td></tr>`).join('') : '<tr><td colspan="4" class="muted">Nessun verbale trovato nelle fonti indicizzate.</td></tr>';
  $('#sourcePackageMessage').textContent = packageSummary.total
    ? `${packageRecords.total} righe visualizzabili su ${packageSummary.total} righe indicizzate dagli ZIP; i campi originali sono conservati integralmente.`
    : 'Gli ZIP non sono ancora stati indicizzati dal processo Drive oppure non sono presenti nella radice configurata.';
  $('#sourcePackageRows').innerHTML = packageRecords.rows.length ? packageRecords.rows.map((row) => {
    const sourceButton = row.sourceUrl
      ? `<button type="button" class="drive-open-url" data-url="${escapeHtml(row.sourceUrl)}">Apri fonte</button>`
      : `<button type="button" class="drive-open-url" data-url="${escapeHtml(row.drivePackageWebViewLink || '')}">Apri pacchetto</button>`;
    return `<tr><td><strong>${escapeHtml(String(row.recordType || '').replaceAll('_', ' '))}</strong><small>${escapeHtml(row.packageKind)}</small></td><td>${escapeHtml(row.category || '—')}</td><td>${escapeHtml(row.date || row.year || '—')}</td><td><strong>${escapeHtml(row.fileName || row.subject || 'Riga indice')}</strong><small>${escapeHtml(row.relativePath || '')}</small></td><td>${sourceButton}<small>${escapeHtml(row.sourceEntry)} · riga ${row.sourceRow} · ${(row.packageSources || []).length || 1} provenienze</small></td><td><details><summary>Mostra</summary><pre class="source-fields">${escapeHtml(JSON.stringify(row.fields, null, 2))}</pre></details></td></tr>`;
  }).join('') : '<tr><td colspan="6" class="muted">Nessuna riga indice corrisponde ai filtri.</td></tr>';
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
    api(`/api/dashboard?anno=${year}`), api(`/api/riconciliazione?anno=${year}`), api('/api/documenti?stato=DA_VERIFICARE'), api('/api/riscossione/controlli'), api('/api/drive-data/summary')
  ]);
  const summary = reconciliation.riepilogo;
  $('#controlCards').innerHTML = [[dashboard.daVerificare, 'movimenti da verificare'], [summary.movimentiSenzaProva, 'senza prova finanziaria'], [dashboard.f24DaRiscontrare, 'F24 da riscontrare'], [dashboard.documentiDaVerificare, 'documenti interni da verificare'], [riscossione.senzaSnapshot, 'atti senza snapshot'], [drive.counts.driveFiles, 'file indicizzati Drive']].map(([value, label]) => `<article class="card"><small>${label}</small><strong>${value}</strong></article>`).join('');
  const issues = [];
  for (const [account, value] of Object.entries(dashboard.saldi || {})) if (value.daRiallineare) issues.push(issue('ALTA', `Riporto ${account} da riallineare`, `Saldo salvato ${euro.format(value.riporto)}; nessuna correzione automatica eseguita.`));
  for (const row of reconciliation.movimenti.filter((item) => !item.provaFinanziaria).slice(0, 20)) issues.push(issue('ALTA', `Movimento senza prova: ${row.descrizione}`, `${fmtDate(row.data)} · ${row.conto} · ${euro.format(row.importo)}`));
  if (dashboard.f24DaRiscontrare) issues.push(issue('MEDIA', 'F24 in attesa di riscontro finanziario', `${dashboard.f24DaRiscontrare} operazioni richiedono verifica; modello e quietanza non provano da soli l'addebito.`));
  if (riscossione.scadutiAperti) issues.push(issue('ALTA', 'Atti scaduti ancora aperti', `${riscossione.scadutiAperti} atti richiedono controllo amministrativo.`));
  if (riscossione.senzaSnapshot) issues.push(issue('MEDIA', 'Situazione ADER non aggiornata', `${riscossione.senzaSnapshot} atti non hanno uno snapshot ufficiale.`));
  if (dashboard.documentiDaVerificare) issues.push(issue('MEDIA', 'Documenti interni da verificare', `${dashboard.documentiDaVerificare} documenti non possono ancora guidare registrazioni contabili.`));
  if (!issues.length) issues.push(issue('OK', 'Nessuna anomalia aperta per i controlli disponibili', "L'indice Drive resta consultabile; continuare con i controlli periodici."));
  $('#controlIssues').innerHTML = issues.join('');
  $('#controlMovementRows').innerHTML = reconciliation.movimenti.length ? reconciliation.movimenti.slice(0, 100).map((row) => `<tr><td>${fmtDate(row.data)}</td><td>${escapeHtml(row.conto)}</td><td><strong>${escapeHtml(row.descrizione)}</strong><small>${escapeHtml(row.fonte || '')}</small></td><td>${badge(row.stato)}</td><td>${row.provaFinanziaria ? badge('DOCUMENTATO') : '<span class="badge da_verificare">Manca prova</span>'}</td><td class="num balance">${euro.format(row.importo)}</td></tr>`).join('') : '<tr><td colspan="6" class="muted">Nessun movimento aperto.</td></tr>';
  $('#controlDocumentRows').innerHTML = documents.length ? documents.slice(0, 100).map((row) => `<tr><td><strong>${escapeHtml(row.nomeOriginale || 'documento')}</strong><small>${escapeHtml(row.protocollo || row.sha256 || '')}</small></td><td>${escapeHtml(row.tipo || '—')}</td><td>${badge(row.stato)}</td><td>${fmtDate(row.aggiornatoIl)}</td></tr>`).join('') : '<tr><td colspan="4" class="muted">Nessun documento interno in attesa.</td></tr>';
}

async function openDriveDocument(id) {
  const document = await api(`/api/drive-index/documents/${encodeURIComponent(id)}`);
  openExternalUrl(document.drive.webViewLink);
}

function openExternalUrl(value) {
  const target = new URL(String(value || ''));
  if (target.protocol !== 'https:') throw new Error('Collegamento esterno non sicuro');
  window.open(target.href, '_blank', 'noopener,noreferrer');
}

function invoiceDateValue(value) { return value ? new Date(value).toISOString().slice(0, 10) : ''; }

function storeBankImportJob(jobId) {
  try {
    if (jobId) localStorage.setItem(BANK_IMPORT_JOB_KEY, jobId);
    else localStorage.removeItem(BANK_IMPORT_JOB_KEY);
  } catch {}
}

function savedBankImportJob() {
  try { return localStorage.getItem(BANK_IMPORT_JOB_KEY); } catch { return null; }
}

function renderBankImport(job, { networkPercent = null, networkFile = null } = {}) {
  const monitor = $('#bankImportMonitor');
  if (!monitor || !job) return;
  monitor.classList.remove('hidden');
  const terminal = ['COMPLETED', 'COMPLETED_WITH_ERRORS'].includes(job.status);
  const percent = terminal ? 100 : Math.max(Number(job.progressPercent || 0), Number(networkPercent || 0), Number(bankImportRuntime.displayPercent || 0));
  bankImportRuntime.displayPercent = percent;
  $('#bankImportProgress').value = percent;
  $('#bankImportProgress').textContent = `${percent}%`;
  $('#bankImportPercent').textContent = `${percent}%`;
  const totals = job.totals || {};
  $('#bankImportSummary').textContent = `${totals.completedFiles || 0}/${totals.totalFiles || 0} file · ${totals.inserted || 0} movimenti nuovi · ${totals.duplicates || 0} già presenti · ${totals.conflicts || 0} da controllare`;
  const activeFile = job.files?.find((file) => !['COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED'].includes(file.status));
  $('#bankImportCurrent').textContent = terminal
    ? (job.status === 'COMPLETED' ? 'Importazione completata: i movimenti sono disponibili in Banca e Riconciliazione.' : 'Importazione conclusa con elementi da controllare.')
    : networkFile ? `Caricamento ${networkFile}. Puoi cambiare pagina nel gestionale.` : activeFile?.name || 'Elaborazione in corso. Puoi cambiare pagina nel gestionale.';
  const button = $('#bankMovementIntakeForm button[type=submit]');
  if (button) button.disabled = !terminal && bankImportRuntime.active;
  $('#bankImportOpenLedger')?.classList.toggle('hidden', !terminal);
}

async function pollBankImportJob(jobId) {
  const job = await api(`/api/bank-movements/import-jobs/${encodeURIComponent(jobId)}`);
  renderBankImport(job, { networkPercent: bankImportRuntime.networkPercent });
  if (['COMPLETED', 'COMPLETED_WITH_ERRORS'].includes(job.status)) {
    bankImportRuntime = { jobId: null, active: false, networkPercent: null, displayPercent: 100 };
    storeBankImportJob(null);
    if (bankImportPollTimer) clearInterval(bankImportPollTimer);
    bankImportPollTimer = null;
    const button = $('#bankMovementIntakeForm button[type=submit]');
    if (button) button.disabled = false;
    await Promise.all([loadLedger(), loadDashboard(), loadReconciliation()]).catch(() => {});
  }
  return job;
}

function startBankImportPolling(jobId) {
  if (bankImportPollTimer) clearInterval(bankImportPollTimer);
  bankImportPollTimer = setInterval(() => pollBankImportJob(jobId).catch(() => {}), 800);
  pollBankImportJob(jobId).catch(() => {});
}

function uploadBankImportFile(jobId, index, file, totalFiles) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/bank-movements/import-jobs/${encodeURIComponent(jobId)}/files/${index}`);
    xhr.responseType = 'json';
    xhr.withCredentials = true;
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('X-CSRF-Token', decodeURIComponent(cookieValue('impresa_csrf')));
    xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name));
    xhr.upload.addEventListener('progress', (event) => {
      if (!event.lengthComputable) return;
      bankImportRuntime.networkPercent = Math.round(((index + 0.2 * event.loaded / event.total) / totalFiles) * 100);
      bankImportRuntime.displayPercent = Math.max(bankImportRuntime.displayPercent || 0, bankImportRuntime.networkPercent);
      renderBankImport({ status: 'PROCESSING', progressPercent: bankImportRuntime.displayPercent, totals: { totalFiles, completedFiles: index }, files: [{ name: file.name, status: 'PROCESSING' }] }, { networkPercent: bankImportRuntime.networkPercent, networkFile: file.name });
    });
    xhr.upload.addEventListener('load', () => { bankImportRuntime.networkPercent = null; });
    xhr.addEventListener('load', () => {
      const data = xhr.response || {};
      if (xhr.status === 401) showLogin('Sessione scaduta. Inserisci nuovamente il PIN.');
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error(data.error || `Errore ${xhr.status} durante ${file.name}`));
    });
    xhr.addEventListener('error', () => reject(new Error(`Connessione interrotta durante ${file.name}`)));
    xhr.send(file);
  });
}

async function submitBankMovementIntake(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const files = [...(form.elements.bankFiles.files || [])];
  if (!files.length || bankImportRuntime.active) return;
  const unsupported = files.find((file) => !/\.csv$/i.test(file.name));
  if (unsupported) return void ($('#bankMovementImportResult').innerHTML = `<span class="error">Formato non supportato: ${escapeHtml(unsupported.name)}</span>`);
  try {
    const job = await api('/api/bank-movements/import-jobs', { method: 'POST', body: JSON.stringify({ files: files.map((file) => ({ name: file.name, size: file.size, type: file.type, lastModified: file.lastModified })) }) });
    bankImportRuntime = { jobId: job.jobId, active: true, networkPercent: 0, displayPercent: 0 };
    storeBankImportJob(job.jobId);
    renderBankImport(job);
    startBankImportPolling(job.jobId);
    form.reset();
    const errors = [];
    for (let index = 0; index < files.length; index += 1) {
      try { await uploadBankImportFile(job.jobId, index, files[index], files.length); }
      catch (error) { errors.push(error.message); }
      await pollBankImportJob(job.jobId).catch(() => {});
    }
    const finalJob = await pollBankImportJob(job.jobId);
    $('#bankMovementImportResult').innerHTML = errors.length ? `<span class="error">${escapeHtml(errors.join(' · '))}</span>` : `${finalJob.totals.inserted || 0} movimenti nuovi, ${finalJob.totals.duplicates || 0} già presenti, ${finalJob.totals.conflicts || 0} da controllare.`;
  } catch (error) { $('#bankMovementImportResult').innerHTML = `<span class="error">${escapeHtml(error.message)}</span>`; }
}

function storeSupplierImportJob(jobId) {
  try {
    if (jobId) localStorage.setItem(SUPPLIER_IMPORT_JOB_KEY, jobId);
    else localStorage.removeItem(SUPPLIER_IMPORT_JOB_KEY);
  } catch {}
}

function savedSupplierImportJob() {
  try { return localStorage.getItem(SUPPLIER_IMPORT_JOB_KEY); } catch { return null; }
}

function renderSupplierImport(job, { networkPercent = null, networkFile = null } = {}) {
  const monitor = $('#supplierImportMonitor');
  if (!monitor || !job) return;
  monitor.classList.remove('hidden');
  const terminal = ['COMPLETED', 'COMPLETED_WITH_ERRORS'].includes(job.status);
  const percent = terminal ? 100 : Math.max(Number(job.progressPercent || 0), Number(networkPercent || 0), Number(supplierImportRuntime.displayPercent || 0));
  supplierImportRuntime.displayPercent = percent;
  $('#supplierImportProgress').value = percent;
  $('#supplierImportProgress').textContent = `${percent}%`;
  $('#supplierImportPercent').textContent = `${percent}%`;
  const totals = job.totals || {};
  $('#supplierImportSummary').textContent = `${totals.completedFiles || 0}/${totals.totalFiles || 0} file · ${totals.canonicalInvoices || 0} fatture registrate · ${totals.duplicateInvoices || 0} duplicate · ${(totals.reviewInvoices || 0) + (totals.rejectedXml || 0)} da controllare`;
  const activeFile = job.files?.find((file) => !['COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED'].includes(file.status));
  $('#supplierImportCurrent').textContent = terminal
    ? (job.status === 'COMPLETED' ? 'Importazione completata: fatture disponibili in Fornitori.' : 'Importazione completata con elementi da controllare.')
    : networkFile
      ? `Caricamento ${networkFile}. Puoi cambiare pagina nel gestionale.`
      : activeFile?.currentEntry || activeFile?.name || 'Elaborazione in corso. Puoi cambiare pagina nel gestionale.';
  const button = $('#supplierInvoiceIntakeForm button[type=submit]');
  if (button) button.disabled = !terminal && supplierImportRuntime.active;
  $('#supplierImportOpenInvoices')?.classList.toggle('hidden', !terminal);
}

async function pollSupplierImportJob(jobId) {
  const job = await api(`/api/supplier-invoices/import-jobs/${encodeURIComponent(jobId)}`);
  renderSupplierImport(job, { networkPercent: supplierImportRuntime.networkPercent });
  if (['COMPLETED', 'COMPLETED_WITH_ERRORS'].includes(job.status)) {
    supplierImportRuntime = { jobId: null, active: false, networkPercent: null, displayPercent: 100 };
    storeSupplierImportJob(null);
    if (supplierImportPollTimer) clearInterval(supplierImportPollTimer);
    supplierImportPollTimer = null;
    const button = $('#supplierInvoiceIntakeForm button[type=submit]');
    if (button) button.disabled = false;
    try {
      await Promise.all([loadSupplierInvoices(), loadSupplierDirectory()]);
    } catch (error) {
      $('#supplierInvoiceResult').innerHTML = `<span class="error">${escapeHtml(error.message)}</span>`;
    }
  }
  return job;
}

function startSupplierImportPolling(jobId) {
  if (supplierImportPollTimer) clearInterval(supplierImportPollTimer);
  supplierImportPollTimer = setInterval(() => pollSupplierImportJob(jobId).catch(() => {}), 800);
  pollSupplierImportJob(jobId).catch(() => {});
}

function uploadSupplierImportFile(jobId, index, file, totalFiles) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/supplier-invoices/import-jobs/${encodeURIComponent(jobId)}/files/${index}`);
    xhr.responseType = 'json';
    xhr.withCredentials = true;
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('X-CSRF-Token', decodeURIComponent(cookieValue('impresa_csrf')));
    xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name));
    xhr.upload.addEventListener('progress', (event) => {
      if (!event.lengthComputable) return;
      supplierImportRuntime.networkPercent = Math.round(((index + 0.2 * event.loaded / event.total) / totalFiles) * 100);
      supplierImportRuntime.displayPercent = Math.max(supplierImportRuntime.displayPercent || 0, supplierImportRuntime.networkPercent);
      $('#supplierImportProgress').value = supplierImportRuntime.networkPercent;
      $('#supplierImportProgress').textContent = `${supplierImportRuntime.networkPercent}%`;
      $('#supplierImportPercent').textContent = `${supplierImportRuntime.networkPercent}%`;
      $('#supplierImportCurrent').textContent = `Caricamento ${file.name}. Puoi cambiare pagina nel gestionale.`;
    });
    xhr.upload.addEventListener('load', () => { supplierImportRuntime.networkPercent = null; });
    xhr.addEventListener('load', () => {
      const data = xhr.response || {};
      if (xhr.status === 401) showLogin('Sessione scaduta. Inserisci nuovamente il PIN.');
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error(data.error || `Errore ${xhr.status} durante ${file.name}`));
    });
    xhr.addEventListener('error', () => reject(new Error(`Connessione interrotta durante ${file.name}`)));
    xhr.addEventListener('abort', () => reject(new Error(`Caricamento annullato: ${file.name}`)));
    xhr.send(file);
  });
}

async function loadSupplierInvoices() {
  const [staging, canonical] = await Promise.all([
    api('/api/supplier-invoices/staging?limit=200'),
    api('/api/supplier-invoices?limit=200')
  ]);
  supplierInvoiceStaging = staging;
  $('#supplierNavBadge').textContent = String(staging.length || canonical.length);
  $('#supplierNavBadge').classList.toggle('hidden', staging.length + canonical.length === 0);
  $('#supplierInvoiceCounts').textContent = `${staging.length} in elaborazione o da controllare · ${canonical.length} fatture canoniche`;
  $('#supplierInvoiceStagingRows').innerHTML = staging.length ? staging.map((row) => `<tr>
    <td><strong>${escapeHtml(row.numero || 'Senza numero')}</strong><small>${escapeHtml(row.tipoDocumento || '')} · ${escapeHtml(row.sourceType || 'DRIVE')}</small></td>
    <td>${escapeHtml(row.fornitore?.denominazione || 'Da verificare')}<small>${escapeHtml(row.fornitore?.partitaIva || row.fornitore?.codiceFiscale || '')}</small></td>
    <td>${fmtDate(row.data)}</td><td class="num">${euro.format(Number(row.totaleDocumento || 0))}</td>
    <td>${badge(row.quadraturaEstrazione?.status || 'REVIEW')}</td>
    <td>${badge(row.stato || 'IN_ELABORAZIONE')}</td>
  </tr>`).join('') : '<tr><td colspan="6" class="muted">Nessuna fattura in attesa: gli XML esatti sono stati registrati automaticamente.</td></tr>';
  $('#supplierInvoiceCanonicalRows').innerHTML = canonical.length ? canonical.map((row) => `<tr>
    <td><strong>${escapeHtml(row.number)}</strong><small>${fmtDate(row.dates?.documentDate)}</small></td>
    <td>${escapeHtml(row.supplier?.name || '')}<small>${escapeHtml(row.naturalKey)}</small></td>
    <td>${badge(row.validation?.status || 'VALIDATED')}<small>${row.amounts?.pendingVatCents ? 'IVA e costo su conti da classificare' : 'Classificazione completa'}</small></td>
    <td class="num">${euro.format(Number(row.openItem?.residualCents || 0) / 100)}</td>
    <td>${badge(row.expectationProcess?.status || 'APERTO')}<small>${row.expectationProcess?.openRequiredExpectations ?? '—'} attese aperte</small></td>
    <td><button type="button" class="supplier-invoice-tree" data-invoice-id="${escapeHtml(row.invoiceId)}">Albero</button></td>
  </tr>`).join('') : '<tr><td colspan="6" class="muted">Nessuna fattura canonica validata.</td></tr>';
}

async function submitSupplierInvoiceIntake(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const files = [...(form.elements.invoiceFiles.files || [])];
  if (!files.length || supplierImportRuntime.active) return;
  const unsupported = files.find((file) => !/\.(xml|zip)$/i.test(file.name));
  if (unsupported) {
    $('#supplierInvoiceResult').innerHTML = `<span class="error">Formato non supportato: ${escapeHtml(unsupported.name)}</span>`;
    return;
  }
  $('#supplierInvoiceResult').textContent = `Preparazione di ${files.length} file…`;
  try {
    const job = await api('/api/supplier-invoices/import-jobs', {
      method: 'POST',
      body: JSON.stringify({ files: files.map((file) => ({ name: file.name, size: file.size, type: file.type, lastModified: file.lastModified })) })
    });
    supplierImportRuntime = { jobId: job.jobId, active: true, networkPercent: 0, displayPercent: 0 };
    storeSupplierImportJob(job.jobId);
    renderSupplierImport(job);
    startSupplierImportPolling(job.jobId);
    form.reset();
    const errors = [];
    for (let index = 0; index < files.length; index += 1) {
      try {
        await uploadSupplierImportFile(job.jobId, index, files[index], files.length);
      } catch (error) {
        errors.push(error.message);
      }
      await pollSupplierImportJob(job.jobId).catch(() => {});
    }
    const finalJob = await pollSupplierImportJob(job.jobId);
    $('#supplierInvoiceResult').innerHTML = errors.length
      ? `<span class="error">${escapeHtml(errors.join(' · '))}</span>`
      : `${finalJob.totals.canonicalInvoices || 0} fatture registrate automaticamente, ${finalJob.totals.duplicateInvoices} duplicate esatte, ${(finalJob.totals.reviewInvoices || 0) + finalJob.totals.rejectedXml} da controllare.`;
  } catch (error) { $('#supplierInvoiceResult').innerHTML = `<span class="error">${escapeHtml(error.message)}</span>`; }
}

function renderSupplierDirectory() {
  const query = $('#supplierDirectoryQuery').value.trim().toLowerCase();
  const status = $('#supplierDirectoryStatus').value;
  const rows = supplierDirectoryData.rows.filter((row) => (!status || row.status === status)
    && (!query || `${row.name} ${row.vatId || ''} ${row.taxId || ''} ${row.invoices.map((invoice) => invoice.number).join(' ')}`.toLowerCase().includes(query)));
  const counts = supplierDirectoryData.counts || {};
  $('#supplierDirectoryCards').innerHTML = [
    [counts.suppliers || 0, 'fornitori osservati'],
    [counts.pendingInvoices || 0, 'fatture da elaborare'],
    [counts.canonicalInvoices || 0, 'fatture canoniche'],
    [euro.format(Number(counts.residualCents || 0) / 100), 'debito residuo documentale']
  ].map(([value, label]) => `<article class="card"><small>${label}</small><strong>${value}</strong></article>`).join('');
  $('#supplierDirectoryMessage').textContent = `${rows.length} fornitori visualizzati · raggruppamento soltanto per identificativo fiscale esatto`;
  $('#supplierDirectoryRows').innerHTML = rows.length ? rows.map((row) => `<article class="supplier-card">
    <header><div><h4>${escapeHtml(row.name)}</h4><small>${escapeHtml(row.vatId || row.taxId || 'Identificativo da verificare')}</small></div>${badge(row.status)}</header>
    <div class="supplier-metrics"><span><strong>${row.pendingInvoices}</strong> da elaborare</span><span><strong>${row.canonicalInvoices}</strong> canoniche</span><span><strong>${euro.format(Number(row.residualCents || 0) / 100)}</strong> residuo</span></div>
    <details ${row.pendingInvoices ? 'open' : ''}><summary>${row.invoices.length} fatture</summary><div class="table-wrap compact-table"><table><thead><tr><th>Documento</th><th>Data</th><th class="num">Totale</th><th>Stato</th><th>Dettaglio</th></tr></thead><tbody>${row.invoices.map((invoice) => `<tr><td><strong>${escapeHtml(invoice.number)}</strong><small>${escapeHtml(invoice.documentType || '')}</small></td><td>${fmtDate(invoice.documentDate)}</td><td class="num">${euro.format(Number(invoice.totalCents || 0) / 100)}</td><td>${badge(invoice.stage)}</td><td>${invoice.invoiceId ? `<button type="button" class="supplier-invoice-tree supplier-directory-tree" data-invoice-id="${escapeHtml(invoice.invoiceId)}">Albero</button>` : '<span class="muted">Elaborazione automatica</span>'}</td></tr>`).join('')}</tbody></table></div></details>
  </article>`).join('') : '<div class="muted">Nessun fornitore corrisponde ai filtri.</div>';
}

async function loadSupplierDirectory() {
  supplierDirectoryData = await api('/api/supplier-invoices/suppliers/directory');
  renderSupplierDirectory();
}

function renderDeclarationGroups() {
  const category = $('#driveDeclarationCategory').value;
  const year = $('#driveDeclarationYear').value;
  const rows = driveDeclarations.filter((row) => (!category || row.category === category) && (!year || row.year === year));
  const grouped = new Map();
  for (const row of rows) {
    if (!grouped.has(row.category)) grouped.set(row.category, []);
    grouped.get(row.category).push(row);
  }
  $('#driveDeclarationGroups').innerHTML = rows.length ? [...grouped.entries()].map(([group, declarations]) => `<details class="document-group" ${category ? 'open' : ''}><summary><strong>${escapeHtml(group)}</strong><span>${declarations.length} documenti</span></summary><div class="table-wrap compact-table"><table><thead><tr><th>Modello</th><th>Anno dichiarazione</th><th>Periodo d'imposta</th><th>Protocollo / invio</th><th>Documento</th></tr></thead><tbody>${declarations.map((row) => `<tr><td><strong>${escapeHtml(row.model)}</strong><small>Fonte: ${escapeHtml(row.sourceType || 'indice')}</small></td><td>${escapeHtml(row.year || '—')}</td><td>${escapeHtml(row.taxYear || '—')}</td><td>${escapeHtml(row.protocol || row.submissionReference || '—')}</td><td>${row.documentId ? `<button type="button" class="drive-open" data-document-id="${escapeHtml(row.documentId)}">Apri su Drive</button>` : `<button type="button" class="drive-open-url" data-url="${escapeHtml(row.drivePackageWebViewLink || '')}">Apri pacchetto</button>`}<small>${escapeHtml(row.documentName || row.archivePath)}</small></td></tr>`).join('')}</tbody></table></div></details>`).join('') : '<div class="muted">Nessuna dichiarazione corrisponde ai filtri.</div>';
}

function renderResignations(data) {
  $('#driveResignationRows').innerHTML = data.rows.length ? data.rows.map((row) => `<tr><td><strong>${escapeHtml(row.employeeName || 'Dipendente da identificare')}</strong><small>${escapeHtml(row.employeeTaxIdMasked || '')}</small></td><td>${escapeHtml(row.effectiveDate || '—')}<small>Trasmissione ${escapeHtml(row.transmissionDate || row.documentDate || '—')}</small></td><td>${escapeHtml(row.communicationType || 'Dimissioni telematiche')}<small>${badge(row.status)}</small></td><td><button type="button" class="drive-open" data-document-id="${escapeHtml(row.documentId)}">Apri PDF</button><small>${escapeHtml(row.documentName)}</small></td><td>${row.technicalSourceDocumentId ? `<button type="button" class="drive-open secondary" data-document-id="${escapeHtml(row.technicalSourceDocumentId)}">Apri prova PEC</button>` : '<span class="muted">Non collegata</span>'}</td></tr>`).join('') : '<tr><td colspan="5" class="muted">Nessuna dimissione PDF indicizzata.</td></tr>';
}

async function showSupplierInvoiceTree(invoiceId) {
  const data = await api(`/api/supplier-invoices/${encodeURIComponent(invoiceId)}/tree`);
  const process = data.processes[0];
  $('#supplierInvoiceTree').innerHTML = `<div class="expectation-tree-head"><strong>${escapeHtml(data.invoice.number)} · ${escapeHtml(data.invoice.supplier?.name || '')}</strong>${badge(process?.status || 'APERTO')}</div>
    <div class="expectation-grid">${data.expectations.map((row) => `<article><span>${escapeHtml(row.expectationType.replaceAll('_', ' '))}</span>${badge(row.status)}${row.dueDate ? `<small>Scadenza ${fmtDate(row.dueDate)}</small>` : ''}</article>`).join('')}</div>`;
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
  const [declarations, resignations, packageDeclarations] = await Promise.all([
    api('/api/drive-index/declarations'),
    api('/api/drive-index/resignations').catch(() => ({ total: 0, rows: [] })),
    api('/api/drive-data/source-packages/records?recordType=DICHIARAZIONE_FISCALE&limit=1000').catch(() => ({ rows: [] }))
  ]);
  const declarationKeys = new Set(declarations.map((row) => `${row.model}|${row.year}|${row.taxYear || ''}|${row.protocol || row.submissionReference || row.documentName}`));
  driveDeclarations = [...declarations];
  for (const row of packageDeclarations.rows) {
    if (!row.declaration) continue;
    const mapped = {
      ...row.declaration,
      sourceType: `ZIP ${row.packageKind}`,
      documentName: row.fileName,
      archivePath: row.relativePath,
      drivePackageWebViewLink: row.drivePackageWebViewLink,
      documentId: null
    };
    const key = `${mapped.model}|${mapped.year}|${mapped.taxYear || ''}|${mapped.protocol || mapped.documentName}`;
    if (!declarationKeys.has(key)) { declarationKeys.add(key); driveDeclarations.push(mapped); }
  }
  fillSelect($('#driveDeclarationCategory'), ['', ...new Set(driveDeclarations.map((row) => row.category))]);
  $('#driveDeclarationCategory option:first-child').textContent = 'Tutte le categorie';
  fillSelect($('#driveDeclarationYear'), ['', ...new Set(driveDeclarations.map((row) => row.year).filter(Boolean).sort().reverse())]);
  $('#driveDeclarationYear option:first-child').textContent = 'Tutti gli anni';
  renderDeclarationGroups();
  renderResignations(resignations);
  await loadDriveDocuments();
  await loadSupplierInvoices();
}

async function loadDriveDocuments() {
  const params = new URLSearchParams({ limit: '200' });
  const query = $('#driveDocumentQuery').value.trim();
  const year = $('#driveDocumentYear').value;
  if (query) params.set('q', query);
  if (year) params.set('year', year);
  params.set('includeTechnical', $('#includeTechnicalDocuments').checked ? 'true' : 'false');
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

async function submitPinConfirmation(event) {
  event.preventDefault();
  const pin = new FormData(event.currentTarget).get('pin');
  $('#pinConfirmationError').textContent = '';
  try {
    await api('/api/auth/pin-confirm', { method: 'POST', body: JSON.stringify({ pin }) }, { allowPinPrompt: false });
    const pending = pinConfirmationRequest;
    pinConfirmationRequest = null;
    hidePinConfirmation();
    pending?.resolve();
  } catch (error) { $('#pinConfirmationError').textContent = error.message; }
}

async function logout() {
  try { await api('/api/auth/logout', { method: 'POST', body: '{}' }); } catch {}
  appReady = false; cancelPinConfirmation(); showLogin('Sessione terminata.');
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

function setView(name) { $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`)); $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === name)); if (name === 'prima-nota') loadLedger().catch((e) => showLogin(e.message)); if (name === 'documenti') loadDriveIndex().catch((e) => { $('#driveIndexMessage').textContent = e.message; }); if (name === 'archivi') loadArchives().catch((e) => { $('#archiveMessage').textContent = e.message; }); if (name === 'fornitori') loadSupplierDirectory().catch((e) => { $('#supplierDirectoryMessage').textContent = e.message; }); if (name === 'riconciliazione') loadReconciliation().catch((e) => { $('#reconciliationResult').textContent = e.message; }); if (name === 'amministrazione') Promise.all([loadF24(), loadTributi(), loadRiscossione()]).catch((e) => showLogin(e.message)); if (name === 'controllo') loadControls().catch((e) => { $('#controlIssues').innerHTML = issue('ALTA', 'Controllo non disponibile', e.message); }); }

function bindEvents() {
  $$('.nav-item').forEach((button) => button.addEventListener('click', () => setView(button.dataset.view)));
  $('#homeYear').addEventListener('change', () => loadDashboard().catch((e) => showLogin(e.message)));
  $('#ledgerAccount').addEventListener('change', () => loadLedger().catch((e) => showLogin(e.message)));
  $('#ledgerYear').addEventListener('change', () => loadLedger().catch((e) => showLogin(e.message)));
  $('#f24Year').addEventListener('change', () => loadF24().catch((e) => showLogin(e.message)));
  $('#reconciliationYear').addEventListener('change', () => loadReconciliation().catch((e) => { $('#reconciliationResult').textContent = e.message; }));
  $('#reloadReconciliation').addEventListener('click', () => loadReconciliation().catch((e) => { $('#reconciliationResult').textContent = e.message; }));
  $('#reloadOpenItems').addEventListener('click', () => loadReconciliation().catch((e) => { $('#reconciliationResult').textContent = e.message; }));
  $('#openItemStatus').addEventListener('change', () => loadReconciliation().catch((e) => { $('#reconciliationResult').textContent = e.message; }));
  $('#reconciliationCauseType').addEventListener('change', (event) => { reconciliationSelection.causeType = event.target.value; reconciliationSelection.causeId = null; renderReconciliationCauses(); });
  $('#reconciliationMovementRows').addEventListener('change', (event) => { if (event.target.matches('.reconciliation-movement')) { reconciliationSelection.movementId = event.target.value; renderReconciliationSelection(); } });
  $('#reconciliationCauseRows').addEventListener('change', (event) => { if (event.target.matches('.reconciliation-cause')) { reconciliationSelection.causeId = event.target.value; renderReconciliationCauses(); } });
  $('#confirmReconciliation').addEventListener('click', confirmReconciliation);
  $('#controlYear').addEventListener('change', () => loadControls().catch((e) => { $('#controlIssues').innerHTML = issue('ALTA', 'Controllo non disponibile', e.message); }));
  $('#reloadControls').addEventListener('click', () => loadControls().catch((e) => { $('#controlIssues').innerHTML = issue('ALTA', 'Controllo non disponibile', e.message); }));
  $('#refreshDriveIndex').addEventListener('click', () => loadDriveIndex(true).catch((e) => { $('#driveIndexMessage').textContent = e.message; }));
  $('#reloadArchives').addEventListener('click', () => loadArchives().catch((e) => { $('#archiveMessage').textContent = e.message; }));
  $('#searchArchives').addEventListener('click', () => loadArchives().catch((e) => { $('#archiveMessage').textContent = e.message; }));
  $('#archiveDomain').addEventListener('change', () => loadArchives().catch((e) => { $('#archiveMessage').textContent = e.message; }));
  $('#archiveYear').addEventListener('change', () => loadArchives().catch((e) => { $('#archiveMessage').textContent = e.message; }));
  $('#sourcePackageKind').addEventListener('change', () => loadArchives().catch((e) => { $('#sourcePackageMessage').textContent = e.message; }));
  $('#sourcePackageRecordType').addEventListener('change', () => loadArchives().catch((e) => { $('#sourcePackageMessage').textContent = e.message; }));
  $('#archiveQuery').addEventListener('keydown', (event) => { if (event.key === 'Enter') loadArchives().catch((e) => { $('#archiveMessage').textContent = e.message; }); });
  $('#reloadSupplierInvoices').addEventListener('click', () => loadSupplierInvoices().catch((e) => { $('#supplierInvoiceResult').textContent = e.message; }));
  $('#supplierInvoiceIntakeForm').addEventListener('submit', submitSupplierInvoiceIntake);
  $('#bankMovementIntakeForm').addEventListener('submit', submitBankMovementIntake);
  $('#bankImportOpenLedger').addEventListener('click', () => { $('#ledgerAccount').value = 'BANCA'; setView('prima-nota'); loadLedger().catch((e) => showLogin(e.message)); });
  $('#reloadSupplierDirectory').addEventListener('click', () => loadSupplierDirectory().catch((e) => { $('#supplierDirectoryMessage').textContent = e.message; }));
  $('#supplierDirectoryQuery').addEventListener('input', renderSupplierDirectory);
  $('#supplierDirectoryStatus').addEventListener('change', renderSupplierDirectory);
  $('#supplierImportOpenInvoices').addEventListener('click', () => { setView('fornitori'); });
  $('#driveDeclarationCategory').addEventListener('change', renderDeclarationGroups);
  $('#driveDeclarationYear').addEventListener('change', renderDeclarationGroups);
  $('#includeTechnicalDocuments').addEventListener('change', () => loadDriveDocuments().catch((e) => { $('#driveIndexMessage').textContent = e.message; }));
  $('#searchDriveDocuments').addEventListener('click', () => loadDriveDocuments().catch((e) => { $('#driveIndexMessage').textContent = e.message; }));
  $('#driveDocumentQuery').addEventListener('keydown', (event) => { if (event.key === 'Enter') loadDriveDocuments().catch((e) => { $('#driveIndexMessage').textContent = e.message; }); });
  document.addEventListener('click', (event) => { const button = event.target.closest('.drive-open'); if (button) openDriveDocument(button.dataset.documentId).catch((e) => { $('#driveIndexMessage').textContent = e.message; }); });
  document.addEventListener('click', (event) => {
    const button = event.target.closest('.drive-open-url');
    if (!button?.dataset.url) return;
    try { openExternalUrl(button.dataset.url); }
    catch (error) { $('#driveIndexMessage').textContent = error.message; }
  });
  document.addEventListener('click', (event) => { const button = event.target.closest('.supplier-invoice-tree'); if (button) showSupplierInvoiceTree(button.dataset.invoiceId).then(() => { if (button.classList.contains('supplier-directory-tree')) { setView('documenti'); $('#supplierInvoiceTree').scrollIntoView({ behavior: 'smooth', block: 'center' }); } }).catch((e) => { $('#supplierInvoiceTree').textContent = e.message; }); });
  $('#newMovement').addEventListener('click', () => $('#movementDialog').showModal()); $('#closeDialog').addEventListener('click', () => $('#movementDialog').close());
  $('#movementForm').addEventListener('submit', submitMovement); $('#receiptsForm').addEventListener('submit', submitReceipts); $('#tributoForm').addEventListener('submit', submitTributo); $('#riscossioneForm').addEventListener('submit', submitRiscossione);
  $('#loginForm').addEventListener('submit', submitLogin); $('#pinConfirmationForm').addEventListener('submit', submitPinConfirmation); $('#cancelPinConfirmation').addEventListener('click', cancelPinConfirmation); $('#logoutButton').addEventListener('click', logout);
}

async function initializeApplication() {
  if (appReady) { await loadDashboard(); return; }
  await loadConfig(); appReady = true; await loadDashboard();
}

async function boot() {
  ensurePinConfirmationDialog(); $('#movementForm [name=data]').valueAsDate = new Date(); $('#receiptsForm [name=data]').valueAsDate = new Date(); fillSelect($('#driveDocumentYear'), ['', ...years()]); $('#driveDocumentYear option:first-child').textContent = 'Tutti gli anni'; bindEvents(); await loadHealth();
  try {
    if (await checkAuth()) {
      await initializeApplication();
      const jobId = savedSupplierImportJob();
      if (jobId) {
        supplierImportRuntime = { jobId, active: true, networkPercent: null, displayPercent: 0 };
        startSupplierImportPolling(jobId);
      }
      const bankJobId = savedBankImportJob();
      if (bankJobId) {
        bankImportRuntime = { jobId: bankJobId, active: true, networkPercent: null, displayPercent: 0 };
        startBankImportPolling(bankJobId);
      }
    }
  } catch (error) { showLogin(error.message); }
}

boot();
