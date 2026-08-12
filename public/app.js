const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const euro = new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR' });

let config = { conti: [], stati: [] };

function currentYear() { return new Date().getFullYear(); }
function years() { const now = currentYear(); return Array.from({ length: 9 }, (_, i) => now - i); }
function fillSelect(select, values) { select.innerHTML = values.map((v) => `<option value="${v}">${String(v).replaceAll('_', ' ')}</option>`).join(''); }
function fmtDate(value) { return new Date(value).toLocaleDateString('it-IT'); }
function badge(status) { return `<span class="badge ${String(status).toLowerCase()}">${String(status).replaceAll('_', ' ')}</span>`; }

async function api(url, options = {}) {
  const response = await fetch(url, { headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Errore ${response.status}`);
  return data;
}

async function loadHealth() {
  try {
    const health = await api('/api/health');
    $('#dbStatus').textContent = health.database === 'connected' ? 'MongoDB collegato' : 'MongoDB da configurare';
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
}

async function loadDashboard() {
  const year = $('#homeYear').value || currentYear();
  try {
    const data = await api(`/api/dashboard?anno=${year}`);
    $('#dashboardCards').innerHTML = config.conti.map((conto) => {
      const info = data.saldi[conto] || { saldo: 0 };
      return `<article class="card"><small>${conto.replaceAll('_', ' ')}</small><strong>${euro.format(info.saldo)}</strong>${info.daRiallineare ? '<span class="mini-warning">Riporto da riallineare</span>' : ''}</article>`;
    }).join('');
    $('#todo').innerHTML = `<div><strong>${data.daVerificare}</strong><span>movimenti da verificare</span></div><div><strong>${data.documentiDaVerificare}</strong><span>documenti da verificare</span></div>`;
  } catch (error) {
    $('#dashboardCards').innerHTML = `<p class="error">${error.message}</p>`;
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
      return `<tr class="${rowClass}"><td>${fmtDate(row.data)}</td><td><strong>${row.descrizione}</strong><small>${row.tipo || ''}</small></td><td>${row.fonte || (row.tipo === 'RIPORTO_APERTURA' ? 'CHIUSURA PRECEDENTE' : '')}</td><td>${badge(row.stato)}</td><td class="num positive">${entrata}</td><td class="num negative">${uscita}</td><td class="num balance">${euro.format(row.saldoProgressivo)}</td></tr>`;
    }).join('');
  } catch (error) {
    $('#ledgerRows').innerHTML = `<tr><td colspan="7" class="error">${error.message}</td></tr>`;
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
    $('#receiptsResult').innerHTML = `<strong>Contante atteso: ${contante}</strong><span>${fiscale}</span>${data.nota ? `<span class="mini-warning">${data.nota}</span>` : ''}`;
    await Promise.all([loadLedger(), loadDashboard()]);
  } catch (error) { $('#receiptsResult').innerHTML = `<span class="error">${error.message}</span>`; }
}

function setView(name) {
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  if (name === 'prima-nota') loadLedger();
}

function bindEvents() {
  $$('.nav-item').forEach((button) => button.addEventListener('click', () => setView(button.dataset.view)));
  $('#homeYear').addEventListener('change', loadDashboard);
  $('#ledgerAccount').addEventListener('change', loadLedger);
  $('#ledgerYear').addEventListener('change', loadLedger);
  $('#newMovement').addEventListener('click', () => $('#movementDialog').showModal());
  $('#closeDialog').addEventListener('click', () => $('#movementDialog').close());
  $('#movementForm').addEventListener('submit', submitMovement);
  $('#receiptsForm').addEventListener('submit', submitReceipts);
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
