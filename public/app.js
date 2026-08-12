const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const euro = new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR' });
let config = { conti: [], stati: [] };
let appReady = false;

function currentYear() { return new Date().getFullYear(); }
function years() { const now = currentYear(); return Array.from({ length: 9 }, (_, i) => now - i); }
function fillSelect(select, values) { select.innerHTML = values.map((v) => `<option value="${v}">${String(v).replaceAll('_', ' ')}</option>`).join(''); }
function fmtDate(value) { return value ? new Date(value).toLocaleDateString('it-IT') : '—'; }
function badge(status) { return `<span class="badge ${String(status).toLowerCase()}">${String(status).replaceAll('_', ' ')}</span>`; }
function escapeHtml(value) { return String(value ?? '').replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c])); }
function cookieValue(name) { return document.cookie.split(';').map((v) => v.trim()).find((v) => v.startsWith(`${name}=`))?.slice(name.length + 1) || ''; }

function showLogin(message = '') {
  $('#loginError').textContent = message;
  $('#logoutButton').classList.add('hidden');
  if (!$('#loginDialog').open) $('#loginDialog').showModal();
}

function hideLogin() {
  if ($('#loginDialog').open) $('#loginDialog').close();
  $('#logoutButton').classList.remove('hidden');
}

async function api(url, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) headers['X-CSRF-Token'] = decodeURIComponent(cookieValue('impresa_csrf'));
  const response = await fetch(url, { credentials: 'same-origin', ...options, method, headers });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) showLogin('Sessione scaduta. Inserisci nuovamente il PIN.');
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

async function submitLogin(event) {
  event.preventDefault();
  const pin = new FormData(event.currentTarget).get('pin');
  $('#loginError').textContent = '';
  try {
    await api('/api/auth/pin-login', { method: 'POST', body: JSON.stringify({ pin }) });
    event.currentTarget.reset(); hideLogin(); await initializeApplication();
  } catch (error) { $('#loginError').textContent = error.message; }
}

async function logout() {
  try { await api('/api/auth/logout', { method: 'POST', body: '{}' }); } catch {}
  appReady = false; showLogin('Sessione terminata.');
}

async function submitMovement(event) {
  event.preventDefault(); const form = new FormData(event.currentTarget); const body = Object.fromEntries(form.entries()); body.importo = Number(body.importo);
  try { await api('/api/movimenti', { method: 'POST', body: JSON.stringify(body) }); $('#movementDialog').close(); event.currentTarget.reset(); $('#movementForm [name=data]').valueAsDate = new Date(); await Promise.all([loadLedger(), loadDashboard()]); } catch (error) { $('#formError').textContent = error.message; }
}

async function submitReceipts(event) {
  event.preventDefault(); const form = new FormData(event.currentTarget);
  const body = { data: form.get('data'), totaleXml: Number(form.get('totaleXml')), chiusuraOperativa: form.get('chiusuraOperativa') === '' ? null : Number(form.get('chiusuraOperativa')), pos: { NUMIA: form.get('numia') === '' ? null : Number(form.get('numia')), SUMUP: form.get('sumup') === '' ? null : Number(form.get('sumup')) }, originePos: { NUMIA: 'MANUALE', SUMUP: 'MANUALE' } };
  try { const data = await api('/api/corrispettivi/giornata', { method: 'POST', body: JSON.stringify(body) }); const contante = data.contanteAtteso === null ? 'non determinabile' : euro.format(data.contanteAtteso); const fiscale = data.controlloFiscale.stato === 'ALLINEATO' ? 'XML e chiusura operativa allineati' : data.controlloFiscale.stato === 'DIFFERENZA' ? `Differenza fiscale ${euro.format(data.controlloFiscale.differenza)}` : 'Chiusura operativa non disponibile'; $('#receiptsResult').innerHTML = `<strong>Contante atteso: ${contante}</strong><span>${fiscale}</span>${data.nota ? `<span class="mini-warning">${escapeHtml(data.nota)}</span>` : ''}`; await Promise.all([loadLedger(), loadDashboard()]); } catch (error) { $('#receiptsResult').innerHTML = `<span class="error">${escapeHtml(error.message)}</span>`; }
}

async function submitTributo(event) {
  event.preventDefault(); const body = Object.fromEntries(new FormData(event.currentTarget).entries());
  try { const saved = await api('/api/tributi', { method: 'POST', body: JSON.stringify(body) }); $('#tributoResult').innerHTML = `<strong>${escapeHtml(saved.codice)}</strong><span>versione registrata</span>`; event.currentTarget.reset(); await Promise.all([loadTributi(), loadF24(), loadDashboard()]); } catch (error) { $('#tributoResult').innerHTML = `<span class="error">${escapeHtml(error.message)}</span>`; }
}

function setView(name) { $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`)); $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === name)); if (name === 'prima-nota') loadLedger().catch((e) => showLogin(e.message)); if (name === 'amministrazione') Promise.all([loadF24(), loadTributi()]).catch((e) => showLogin(e.message)); }

function bindEvents() {
  $$('.nav-item').forEach((button) => button.addEventListener('click', () => setView(button.dataset.view)));
  $('#homeYear').addEventListener('change', () => loadDashboard().catch((e) => showLogin(e.message)));
  $('#ledgerAccount').addEventListener('change', () => loadLedger().catch((e) => showLogin(e.message)));
  $('#ledgerYear').addEventListener('change', () => loadLedger().catch((e) => showLogin(e.message)));
  $('#f24Year').addEventListener('change', () => loadF24().catch((e) => showLogin(e.message)));
  $('#newMovement').addEventListener('click', () => $('#movementDialog').showModal()); $('#closeDialog').addEventListener('click', () => $('#movementDialog').close());
  $('#movementForm').addEventListener('submit', submitMovement); $('#receiptsForm').addEventListener('submit', submitReceipts); $('#tributoForm').addEventListener('submit', submitTributo);
  $('#loginForm').addEventListener('submit', submitLogin); $('#logoutButton').addEventListener('click', logout);
}

async function initializeApplication() {
  if (appReady) { await loadDashboard(); return; }
  await loadConfig(); appReady = true; await loadDashboard();
}

async function boot() {
  $('#movementForm [name=data]').valueAsDate = new Date(); $('#receiptsForm [name=data]').valueAsDate = new Date(); bindEvents(); await loadHealth();
  try { if (await checkAuth()) await initializeApplication(); } catch (error) { showLogin(error.message); }
}

boot();
