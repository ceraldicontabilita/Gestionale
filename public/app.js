const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const euro = new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR' });

let config = { conti: [], stati: [] };

function currentYear() { return new Date().getFullYear(); }
function years() { const now = currentYear(); return Array.from({ length: 9 }, (_, i) => now - i); }
function fillSelect(select, values) { select.innerHTML = values.map((v) => `<option value="${v}">${String(v).replaceAll('_', ' ')}</option>`).join(''); }
function fmtDate(value) { return value ? new Date(value).toLocaleDateString('it-IT') : '—'; }
function badge(status) { return `<span class="badge ${String(status).toLowerCase()}">${String(status).replaceAll('_', ' ')}</span>`; }
function escapeHtml(value) { return String(value ?? '').replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c])); }

async function api(url, options = {}) {
  const response = await fetch(url, { headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Errore ${response.status}`);
  return data;
}

async function loadHealth() {
  try {
    const health = await api('/api/health');
    $('#dbStatus').textContent = health.database === 'connected' ? `MongoDB collegato · v${health.versione || ''}` : 'MongoDB da configurare';
    $('#dbStatus').classList.toggle('ok', health.database === 'connected');
  } catch {
    $('#dbStatus').textContent = 'Backend non raggiungibile';
  }
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
  try {
    const data = await api(`/api/dashboard?anno=${year}`);
    $('#dashboardCards').innerHTML = config.conti.map((conto) => {
      const info = data.saldi[conto] || { saldo: 0 };
      return `<article class="card"><small>${conto.replaceAll('_', ' ')}</small><strong>${euro.format(info.saldo)}</strong>${info.daRiallineare ? '<span class="mini-warning">Riporto da riallineare</span>' : ''}</article>`;
    }).join('');
    $('#todo').innerHTML = [
      [data.daVerificare, 'movimenti da verificare'],
      [data.documentiDaVerificare, 'documenti da verificare'],
      [data.f24DaRiscontrare || 0, 'F24 da riscontrare'],
      [data.codiciTributoDaVerificare || 0, 'codici/causali da classificare']
    ].map(([value, label]) => `<div><strong>${value}</strong><span>${label}</span></div>`).join('');
  } catch (error) {
    $('#dashboardCards').innerHTML = `<p class="error">${escapeHtml(error.message)}</p>`;
  }
}

async function loadLedger() {
  const conto = $('#ledgerAccount').value;
  const anno = $('#ledgerYear').value;
  if (!conto || !anno) return;
  try {
    const data = await api(`/api/prima-nota/${conto}?anno=${anno}`);
    $('#openingWarning').classList.toggle('hidden', !data.riporto.daRiallineare);
    $('#openingWarning').textContent = data.riporto.daRiallineare
      ? `Il riporto salvato è ${euro.format(data.riporto.saldo)}, mentre la chiusura precedente ricalcolata è ${euro.format(data.riporto.saldoAtteso)}. Nessuna correzione automatica è stata eseguita.`
      : '';

    $('#ledgerRows').innerHTML = data.righe.map((row) => {
      const entrata = row.direzione === 'ENTRATA' ? euro.format(row.importo) : '';
      const uscita = row.direzione === 'USCITA' ? euro.format(row.importo) : '';
      const rowClass = row.tipo === 'RIPORTO_APERTURA' ? 'opening-row' : '';
      return `<tr class="${rowClass}"><td>${fmtDate(row.data)}</td><td><strong>${escapeHtml(row.descrizione)}</strong><small>${escapeHtml(row.tipo || '')}</small></td><td>${escapeHtml(row.fonte || (row.tipo === 'RIPORTO_APERTURA' ? 'CHIUSURA PRECEDENTE' : ''))}</td><td>${badge(row.stato)}</td><td class="num positive">${entrata}</td><td class="num negative">${uscita}</td><td class="num balance">${euro.format(row.saldoProgressivo)}</td></tr>`;
    }).join('');
  } catch (error) {
    $('#ledgerRows').innerHTML = `<tr><td colspan="7" class="error">${escapeHtml(error.message)}</td></tr>`;
  }
}

async function loadF24() {
  const anno = $('#f24Year').value || currentYear();
  try {
    const rows = await api(`/api/f24?anno=${anno}`);
    if (!rows.length) {
      $('#f24Rows').innerHTML = '<tr><td colspan="6" class="muted">Nessun F24 importato per questo anno.</td></tr>';
      return;
    }
    $('#f24Rows').innerHTML = rows.map((row) => {
      const protocollo = row.protocollo || row.protocolloLettoNelPdf || 'senza protocollo';
      const saldo = row.saldoModello ?? row.saldoOperazione ?? 0;
      const check = row.controlloSaldo
        ? `${row.controlloSaldo.stato}${row.codiciDaVerificare ? ` · ${row.codiciDaVerificare} da verificare` : ''}`
        : (row.codiciDaVerificare ? `${row.codiciDaVerificare} da verificare` : 'righe non ancora analizzate');
      return `<tr><td>${fmtDate(row.dataVersamento)}</td><td><strong>${escapeHtml(protocollo)}</strong><small>${escapeHtml(row.file || '')}</small></td><td>${escapeHtml(String(row.tipoDocumento || '').replaceAll('_', ' '))}</td><td>${escapeHtml(check)}</td><td>${badge(row.stato)}</td><td class="num balance">${euro.format(saldo)}</td></tr>`;
    }).join('');
  } catch (error) {
    $('#f24Rows').innerHTML = `<tr><td colspan="6" class="error">${escapeHtml(error.message)}</td></tr>`;
  }
}

async function loadTributi() {
  try {
    const rows = await api('/api/tributi');
    if (!rows.length) {
      $('#tributiRows').innerHTML = '<tr><td colspan="6" class="muted">Registro vuoto: nessuna classificazione viene inventata.</td></tr>';
      return;
    }
    $('#tributiRows').innerHTML = rows.slice(0, 200).map((row) => `<tr><td>${escapeHtml(row.namespace)}</td><td><strong>${escapeHtml(row.codice)}</strong></td><td>${escapeHtml(row.descrizione)}</td><td>${escapeHtml(row.natura || '—')}</td><td>${escapeHtml(row.fonte)}</td><td>${fmtDate(row.verificatoIl)}</td></tr>`).join('');
  } catch (error) {
    $('#tributiRows').innerHTML = `<tr><td colspan="6" class="error">${escapeHtml(error.message)}</td></tr>`;
  }
}

async function submitTributo(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const body = Object.fromEntries(form.entries());
  $('#tributoResult').textContent = '';
  try {
    const saved = await api('/api/tributi', { method: 'POST', body: JSON.stringify(body) });
    $('#tributoResult').innerHTML = `<strong>${escapeHtml(saved.codice)}</strong><span>versione registrata con fonte verificabile</span>`;
    event.currentTarget.reset();
    await Promise.all([loadTributi(), loadF24(), loadDashboard()]);
  } catch (error) {
    $('#tributoResult').innerHTML = `<span class="error">${escapeHtml(error.message)}</span>`;
  }
}

async function submitMovement(event) {
  event.preventDefault();
  $('#formError').textContent = '';
  const form = new FormData(event.currentTarget);
  const body = Object.fromEntries(form.entries());
  body.provaReale = form.get('provaReale') === 'on';
  body.importo = Number(body.importo);
  try {
    await api('/api/movimenti', { method: 'POST', body: JSON.stringify(body) });
    $('#movementDialog').close();
    event.currentTarget.reset();
    $('#movementForm [name=data]').valueAsDate = new Date();
    await Promise.all([loadLedger(), loadDashboard()]);
  } catch (error) { $('#formError').textContent = error.message; }
}

async function submitReceipts(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const body = {
    data: form.get('data'),
    totaleXml: Number(form.get('totaleXml')),
    chiusuraOperativa: form.get('chiusuraOperativa') === '' ? null : Number(form.get('chiusuraOperativa')),
    pos: {
      NUMIA: form.get('numia') === '' ? null : Number(form.get('numia')),
      SUMUP: form.get('sumup') === '' ? null : Number(form.get('sumup'))
    },
    originePos: { NUMIA: 'MANUALE', SUMUP: 'MANUALE' }
  };
  try {
    const data = await api('/api/corrispettivi/giornata', { method: 'POST', body: JSON.stringify(body) });
    const contante = data.contanteAtteso === null ? 'non determinabile' : euro.format(data.contanteAtteso);
    const fiscale = data.controlloFiscale.stato === 'ALLINEATO'
      ? 'XML e chiusura operativa allineati'
      : data.controlloFiscale.stato === 'DIFFERENZA'
        ? `Differenza fiscale ${euro.format(data.controlloFiscale.differenza)}`
        : 'Chiusura operativa non disponibile';
    $('#receiptsResult').innerHTML = `<strong>Contante atteso: ${contante}</strong><span>${fiscale}</span>${data.nota ? `<span class="mini-warning">${escapeHtml(data.nota)}</span>` : ''}`;
    await Promise.all([loadLedger(), loadDashboard()]);
  } catch (error) { $('#receiptsResult').innerHTML = `<span class="error">${escapeHtml(error.message)}</span>`; }
}

function setView(name) {
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  if (name === 'prima-nota') loadLedger();
  if (name === 'amministrazione') Promise.all([loadF24(), loadTributi()]);
}

function bindEvents() {
  $$('.nav-item').forEach((button) => button.addEventListener('click', () => setView(button.dataset.view)));
  $('#homeYear').addEventListener('change', loadDashboard);
  $('#ledgerAccount').addEventListener('change', loadLedger);
  $('#ledgerYear').addEventListener('change', loadLedger);
  $('#f24Year').addEventListener('change', loadF24);
  $('#newMovement').addEventListener('click', () => $('#movementDialog').showModal());
  $('#closeDialog').addEventListener('click', () => $('#movementDialog').close());
  $('#movementForm').addEventListener('submit', submitMovement);
  $('#receiptsForm').addEventListener('submit', submitReceipts);
  $('#tributoForm').addEventListener('submit', submitTributo);
}

async function boot() {
  $('#movementForm [name=data]').valueAsDate = new Date();
  $('#receiptsForm [name=data]').valueAsDate = new Date();
  await loadHealth();
  await loadConfig();
  bindEvents();
  await loadDashboard();
}

boot();
