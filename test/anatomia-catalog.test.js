import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  catalogSummary,
  inventoriesDirectory,
  loadCatalog,
  loadExpectationTree,
  loadTopology,
  validateCatalog,
  validateExpectationTree,
  validateInventories,
  validateTopology
} from '../scripts/validate-anatomia.js';

function copy(value) {
  return structuredClone(value);
}

function allPages(catalog) {
  return catalog.sections.flatMap((section) => section.pages);
}

function copyInventoriesToTemporaryDirectory(t) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'anatomia-inventari-'));
  const temporaryInventories = path.join(temporaryRoot, 'inventari');
  fs.cpSync(inventoriesDirectory, temporaryInventories, { recursive: true });
  t.after(() => fs.rmSync(temporaryRoot, { force: true, recursive: true }));
  return temporaryInventories;
}

test('il catalogo anatomico canonico e gli inventari storici sono coerenti', () => {
  const catalog = loadCatalog();
  assert.deepEqual(validateCatalog(catalog), []);
  assert.deepEqual(validateInventories(catalog), []);
  assert.deepEqual(validateTopology(catalog, loadTopology()), []);
  assert.deepEqual(validateExpectationTree(loadExpectationTree()), []);
  const summary = catalogSummary(catalog);
  assert.equal(summary.sections, 6);
  assert.ok(summary.pages >= 50);
  assert.ok(summary.entities >= 40);
  assert.ok(summary.relations >= 30);
  assert.ok(summary.flows >= 6);
});

test('l albero vincola la nascita del ramo all obbligo e non alla prova futura', () => {
  const tree = copy(loadExpectationTree());
  const supplierFlow = new Map(tree.flussi['Fattura fornitore'].map((step) => [step[0], step[1]]));
  assert.equal(supplierFlow.get('Documento originale'), 'SODDISFATTO');
  assert.equal(supplierFlow.get('Pagamento'), 'ATTESO');
  assert.equal(supplierFlow.get('Chiusura debito'), 'ATTESO');
  tree.principio = 'Il pagamento crea il ramo';
  assert.match(validateExpectationTree(tree).join('\n'), /principio obbligo-evidenza/);
});

test('la topologia copre ogni pagina esattamente una volta e registra ogni evento', () => {
  const catalog = loadCatalog();
  const topology = loadTopology();
  const pageIds = allPages(catalog).map((page) => page.id).sort();
  const projectionIds = topology.pageProjections.map((projection) => projection.pageId).sort();
  assert.deepEqual(projectionIds, pageIds);
  assert.equal(new Set(topology.events.map((event) => event.id)).size, topology.events.length);
  assert.ok(topology.events.length >= 40);
  assert.ok(topology.processors.length >= 20);
});

test('separa la competenza della fattura dal regolamento finanziario', () => {
  const topology = loadTopology();
  const flow = topology.canonicalFlows.find((item) => item.id === 'supplier_invoice_drive_to_ledger');
  const competence = flow.steps.find((step) => step.relations?.includes('supplier_invoice_projects_accounting'));
  const evidence = flow.steps.find((step) => step.produces?.includes('financial_evidence'));
  const settlement = flow.steps.find((step) => step.relations?.includes('ledger_projects_accounting'));

  assert.ok(competence.order < evidence.order);
  assert.ok(settlement.order > evidence.order);
  assert.equal(flow.branches.competence.requiresPayment, false);
  assert.equal(flow.branches.settlement.requiresConfirmedFinancialEvidence, true);
  assert.match(competence.action, /senza attendere il pagamento/);
  assert.match(settlement.action, /non ricrea costo o IVA/);
});

test('centralizza le proiezioni contabili e riserva la chiusura a persona con riconferma PIN', () => {
  const topology = loadTopology();
  const accountingEvent = topology.events.find((event) => event.id === 'accounting.entry_projected');
  const periodEvent = topology.events.find((event) => event.id === 'accounting.period_closed');
  const closingPage = topology.pageProjections.find((page) => page.pageId === 'controllo.chiusura_mensile');
  const closingCommand = closingPage.commands.find((command) => command.id === 'controllo.chiusura_mensile.submit');

  assert.deepEqual(accountingEvent.producerPages, []);
  assert.deepEqual(accountingEvent.producerProcessors, ['project_accounting_entries']);
  assert.deepEqual(periodEvent.producerPages, ['controllo.chiusura_mensile']);
  assert.equal(closingCommand.autonomy, 'C');
  assert.match(closingCommand.approval, /HUMAN_APPROVAL_REQUIRED/);
  assert.match(closingCommand.approval, /PIN_CONFIRMATION/);
});

test('rifiuta la regressione che subordina la competenza al pagamento', () => {
  const catalog = loadCatalog();
  const topology = copy(loadTopology());
  const flow = topology.canonicalFlows.find((item) => item.id === 'supplier_invoice_drive_to_ledger');
  const competence = flow.steps.find((step) => step.relations?.includes('supplier_invoice_projects_accounting'));
  const evidence = flow.steps.find((step) => step.produces?.includes('financial_evidence'));
  competence.order = evidence.order + 1;

  assert.match(
    validateTopology(catalog, topology).join('\n'),
    /la competenza deve precedere ed essere indipendente dalla prova finanziaria/
  );
});

test('le viste Home sono query on-demand e mai copie autorevoli', () => {
  const catalog = loadCatalog();
  const topology = loadTopology();
  for (const pageId of ['home.quadro_operativo', 'home.attivita_aperte']) {
    const projection = topology.pageProjections.find((item) => item.pageId === pageId);
    assert.equal(projection.projection.kind, 'QUERY_VIEW');
    assert.equal(projection.projection.refresh, 'ON_DEMAND_QUERY');
    assert.equal(projection.projection.queryEndpoint, '/api/dashboard');
    assert.equal(projection.projection.ownsCanonicalData, false);
  }
});

test('rifiuta una QUERY_VIEW senza endpoint o con refresh materializzato', () => {
  const catalog = loadCatalog();
  const topology = copy(loadTopology());
  const projection = topology.pageProjections.find((item) => item.pageId === 'home.quadro_operativo');
  projection.projection.refresh = 'EVENT_DRIVEN_INVALIDATION_AND_IDEMPOTENT_REBUILD';
  delete projection.projection.queryEndpoint;
  assert.match(
    validateTopology(catalog, topology).join('\n'),
    /QUERY_VIEW richiede ON_DEMAND_QUERY e queryEndpoint/
  );
});

test('rifiuta una pagina non coperta e un evento usato ma non registrato', () => {
  const catalog = loadCatalog();
  const topology = copy(loadTopology());
  topology.pageProjections.shift();
  topology.pageProjections[0].inputEvents.push('evento.non_registrato');
  const errors = validateTopology(catalog, topology).join('\n');
  assert.match(errors, /pagina catalogo non coperta/);
  assert.match(errors, /inputEvent sconosciuto evento\.non_registrato/);
  assert.match(errors, /evento usato ma non registrato evento\.non_registrato/);
});

test('rifiuta evento orfano o duplicato nel registry', () => {
  const catalog = loadCatalog();
  const topology = copy(loadTopology());
  const orphan = copy(topology.events[0]);
  orphan.id = 'evento.orfano';
  orphan.type = orphan.id;
  orphan.producerPages = [];
  orphan.producerProcessors = [];
  orphan.consumerPages = [];
  orphan.consumerProcessors = [];
  topology.events.push(orphan, copy(orphan));
  const errors = validateTopology(catalog, topology).join('\n');
  assert.match(errors, /evento duplicato evento\.orfano/);
  assert.match(errors, /evento registrato ma mai usato/);
});

test('rifiuta processor e comando che scrivono entità di un altro owner', () => {
  const catalog = loadCatalog();
  const topology = copy(loadTopology());
  const processor = topology.processors[0];
  processor.writeEntities = ['user_identity'];
  processor.autonomy = 'AUTONOMIA_IGNOTA';
  processor.retry = '';
  const projection = topology.pageProjections.find((item) => item.commands.length > 0);
  const command = projection.commands[0];
  command.writeEntities = ['user_identity'];
  command.autonomy = 'AUTONOMIA_IGNOTA';
  const errors = validateTopology(catalog, topology).join('\n');
  assert.match(errors, /user_identity è autorevole per SICUREZZA/);
  assert.match(errors, /gates\/autonomy\/idempotency\/approval\/failure\/retry/);
  assert.match(errors, /evidence\/autonomy\/approval\/audit\/idempotency\/failure/);
});

test('la allowlist blocca il dizionario prodotti dal riscrivere righe fattura', () => {
  const catalog = loadCatalog();
  const topology = copy(loadTopology());
  const projection = topology.pageProjections.find(
    (item) => item.pageId === 'amministrazione.dizionario_prodotti'
  );
  const command = projection.commands[0];
  command.writeEntities.push('invoice_supplier_line');
  command.emits.push('invoice.supplier_validated');
  projection.outputEvents.push('invoice.supplier_validated');
  const errors = validateTopology(catalog, topology).join('\n');
  assert.match(errors, /dizionario_prodotti\.resolve_alias: writeEntities fuori perimetro/);
  assert.match(errors, /dizionario_prodotti\.resolve_alias: eventi emessi fuori perimetro/);
});

test('la allowlist blocca il registro codici dal validare modelli e quietanze F24', () => {
  const catalog = loadCatalog();
  const topology = copy(loadTopology());
  const projection = topology.pageProjections.find(
    (item) => item.pageId === 'amministrazione.f24_codici'
  );
  const command = projection.commands[0];
  command.writeEntities.push('f24_model', 'f24_receipt');
  command.emits.push('f24.model_validated');
  projection.outputEvents.push('f24.model_validated');
  const errors = validateTopology(catalog, topology).join('\n');
  assert.match(errors, /f24_codici\.publish_tax_code_version: writeEntities fuori perimetro/);
  assert.match(errors, /f24_codici\.publish_tax_code_version: eventi emessi fuori perimetro/);
});

test('rifiuta un comando non registrato nella allowlist della capability', () => {
  const catalog = loadCatalog();
  const topology = copy(loadTopology());
  const projection = topology.pageProjections.find(
    (item) => item.pageId === 'amministrazione.dizionario_prodotti'
  );
  const command = copy(projection.commands[0]);
  command.id = 'amministrazione.dizionario_prodotti.revalidate_invoice';
  projection.commands = [command];
  const errors = validateTopology(catalog, topology).join('\n');
  assert.match(errors, /comando .*revalidate_invoice fuori dalla allowlist/);
  assert.match(errors, /comando allowlist mancante .*resolve_alias/);
});

test('rifiuta output di pagina non emessi dai comandi e scritture della Coerenza', () => {
  const catalog = loadCatalog();
  const topology = copy(loadTopology());
  const readOnlyProjection = topology.pageProjections.find((item) => item.commands.length === 0);
  readOnlyProjection.outputEvents = [topology.events[0].id];
  const coherenceProjection = topology.pageProjections.find(
    (item) => item.pageId === topology.coherenceEngine.pageId
  );
  coherenceProjection.commands = [copy(topology.pageProjections.find((item) => item.commands.length > 0).commands[0])];
  coherenceProjection.commands[0].id = 'coerenza.scrittura_vietata';
  coherenceProjection.commands[0].commandOwner = 'CONTROLLO';
  coherenceProjection.commands[0].writeEntities = ['invoice_supplier'];
  coherenceProjection.outputEvents = [...coherenceProjection.commands[0].emits];
  const errors = validateTopology(catalog, topology).join('\n');
  assert.match(errors, /pagina read-only senza comandi non può emettere eventi/);
  assert.match(errors, /Coerenza non può scrivere l'entità autorevole invoice_supplier/);
  assert.match(errors, /la pagina Coerenza deve essere read-only/);
});

test('rifiuta un raw entry event che bypassa il validatore di dominio', () => {
  const catalog = loadCatalog();
  const topology = copy(loadTopology());
  const entryPoint = topology.entryPoints.find((item) => item.owner === 'INTAKE_DOCUMENTALE');
  const event = topology.events.find((item) => item.id === entryPoint.event);
  entryPoint.canonicalOutputs.push('vat_entry');
  event.canonicalEntities.push('vat_entry');
  const errors = validateTopology(catalog, topology).join('\n');
  assert.match(errors, /raw input non può produrre vat_entry, autorevole per CONTABILITA/);
  assert.match(errors, /vat_entry è autorevole per CONTABILITA/);
});

test('rifiuta pagine duplicate e dipendenze inesistenti', () => {
  const catalog = copy(loadCatalog());
  const page = catalog.sections[0].pages[0];
  catalog.sections[1].pages[0].id = page.id;
  catalog.sections[1].pages[0].dependsOn = ['pagina.inesistente'];
  const errors = validateCatalog(catalog).join('\n');
  assert.match(errors, /Pagina duplicata/);
  assert.match(errors, /dipendenza sconosciuta/);
});

test('rifiuta cicli transitivi fra dipendenze di pagina', () => {
  const catalog = copy(loadCatalog());
  const [first, second, third] = allPages(catalog);
  first.dependsOn = [second.id];
  second.dependsOn = [third.id];
  third.dependsOn = [first.id];
  assert.match(validateCatalog(catalog).join('\n'), /Dipendenza circolare transitiva/);
});

test('rifiuta flow ID e decision ID duplicati', () => {
  const catalog = copy(loadCatalog());
  catalog.flows.push(copy(catalog.flows[0]));
  catalog.externalDecisions.push(copy(catalog.externalDecisions[0]));
  const errors = validateCatalog(catalog).join('\n');
  assert.match(errors, /Flusso duplicato/);
  assert.match(errors, /Decisione integrazione duplicata/);
});

test('rifiuta accessi mancanti, ruoli ignoti e scrittura di SOLA_LETTURA', () => {
  const catalog = copy(loadCatalog());
  const pages = allPages(catalog);
  delete pages[0].access;
  pages[1].access.viewRoles = ['ADMIN', 'RUOLO_IGNOTO'];
  pages[2].access.viewRoles = ['ADMIN', 'SOLA_LETTURA'];
  pages[2].access.writeRoles = ['SOLA_LETTURA'];
  const errors = validateCatalog(catalog).join('\n');
  assert.match(errors, /access obbligatorio/);
  assert.match(errors, /ruolo accesso sconosciuto RUOLO_IGNOTO/);
  assert.match(errors, /SOLA_LETTURA non può essere in writeRoles/);
});

test('rifiuta un accesso ADMIN esposto a un ruolo operativo', () => {
  const catalog = copy(loadCatalog());
  const page = allPages(catalog).find((candidate) => candidate.access.level === 'ADMIN');
  page.access.viewRoles = ['ADMIN', 'OPERATORE'];
  assert.match(validateCatalog(catalog).join('\n'), /livello ADMIN non consente viewRoles OPERATORE/);
});

test('rifiuta evidenze non strutturate, insicure, inesistenti o prive di test', () => {
  const unsafeCatalog = copy(loadCatalog());
  const unsafePage = allPages(unsafeCatalog).find((page) => page.status === 'PRESENTE');
  unsafePage.currentEvidence = ['../fuori-repository.js', { path: 'src/domain.js' }];
  const unsafeErrors = validateCatalog(unsafeCatalog).join('\n');
  assert.match(unsafeErrors, /path relativo sicuro/);

  const missingCatalog = copy(loadCatalog());
  const missingPage = allPages(missingCatalog).find((page) => page.status === 'PRESENTE');
  missingPage.currentEvidence = ['src/file-che-non-esiste.js'];
  assert.match(validateCatalog(missingCatalog).join('\n'), /currentEvidence inesistente/);

  const untestedCatalog = copy(loadCatalog());
  const untestedPage = allPages(untestedCatalog).find((page) => page.status === 'PRESENTE');
  untestedPage.currentEvidence = ['README.md'];
  assert.match(validateCatalog(untestedCatalog).join('\n'), /currentEvidence non include l'implementazione richiesta/);
  assert.match(validateCatalog(untestedCatalog).join('\n'), /currentEvidence non include il test capability-specific/);
});

test('non accetta un test adiacente come prova del quadro operativo', () => {
  const catalog = copy(loadCatalog());
  const page = allPages(catalog).find((candidate) => candidate.id === 'home.quadro_operativo');
  page.currentEvidence = page.currentEvidence.map((evidence) =>
    evidence === 'test/home-dashboard.test.js' ? 'test/auth.test.js' : evidence
  );
  const errors = validateCatalog(catalog).join('\n');
  assert.match(errors, /home\.quadro_operativo/);
  assert.match(errors, /non include il test capability-specific test\/home-dashboard\.test\.js/);
});

test('un marker nominale non sostituisce il contratto capability-test registrato', () => {
  const catalog = copy(loadCatalog());
  const page = allPages(catalog).find((candidate) => candidate.id === 'home.quadro_operativo');
  page.currentEvidence = ['public/index.html', 'src/core-router.js', 'test/frontend-events.test.js'];
  assert.match(
    validateCatalog(catalog).join('\n'),
    /non include il test capability-specific test\/home-dashboard\.test\.js/
  );
});

test('segnala i test capability-specific mancanti prima di promuovere capacità parziali', () => {
  const expectedGaps = new Map([
    ['riconciliazione.f24_banca', /manca un test della route \/api\/f24\/:id\/riconcilia/],
    ['riconciliazione.riscossione_banca', /manca un test della route \/api\/riscossione\/atti\/:id\/collega-movimento/],
    ['amministrazione.f24_codici', /manca un test del registro \/api\/tributi versionato/]
  ]);
  for (const [pageId, expectedError] of expectedGaps) {
    const catalog = copy(loadCatalog());
    allPages(catalog).find((page) => page.id === pageId).status = 'PRESENTE';
    const errors = validateCatalog(catalog).join('\n');
    assert.match(errors, expectedError, pageId);
  }
});

test('rifiuta una capacità dichiarata presente senza evidenze', () => {
  const catalog = copy(loadCatalog());
  const page = allPages(catalog).find((candidate) => candidate.status === 'PRESENTE');
  page.currentEvidence = [];
  assert.match(validateCatalog(catalog).join('\n'), /senza currentEvidence/);
});

test('rifiuta evidenze correnti su una capacità non implementata', () => {
  const catalog = copy(loadCatalog());
  const page = allPages(catalog).find((candidate) => candidate.status === 'ASSENTE');
  page.currentEvidence = ['README.md'];
  assert.match(validateCatalog(catalog).join('\n'), /ASSENTE non può dichiarare currentEvidence correnti/);
});

test('rifiuta lo stato di sezione incoerente con gli stati delle pagine', () => {
  const catalog = copy(loadCatalog());
  catalog.sections[0].status = 'PRESENTE';
  assert.match(validateCatalog(catalog).join('\n'), /stato PRESENTE incoerente, atteso PARZIALE/);
});

test('rifiuta entità e autorità di relazione sconosciute', () => {
  const catalog = copy(loadCatalog());
  catalog.relations[0].to = 'entita_inesistente';
  catalog.relations[0].authority = 'autorita_inesistente';
  const errors = validateCatalog(catalog).join('\n');
  assert.match(errors, /entità to sconosciuta/);
  assert.match(errors, /authority sconosciuta/);
});

test('rifiuta inventari incompleti e mapping storico non 1:1', (t) => {
  const catalog = loadCatalog();
  const directory = copyInventoriesToTemporaryDirectory(t);
  const pagesPath = path.join(directory, 'pagine-storiche.json');
  const historicalPages = JSON.parse(fs.readFileSync(pagesPath, 'utf8'));
  historicalPages.records[0].legacyId = historicalPages.records[1].legacyId;
  historicalPages.records[0].canonicalDestination = [historicalPages.records[1].canonicalDestination];
  historicalPages.summary.recordCount -= 1;
  fs.writeFileSync(pagesPath, `${JSON.stringify(historicalPages, null, 2)}\n`);
  fs.rmSync(path.join(directory, 'endpoint-runtime.json'));

  const errors = validateInventories(catalog, directory).join('\n');
  assert.match(errors, /Inventario obbligatorio mancante: endpoint-runtime\.json/);
  assert.match(errors, /summary\.recordCount non coincide/);
  assert.match(errors, /canonicalDestination deve essere una stringa o null/);
  assert.match(errors, /legacyId deve coprire esattamente 1\.\.62/);
});

test('rifiuta uno shard delle connessioni storiche alterato', (t) => {
  const catalog = loadCatalog();
  const directory = copyInventoriesToTemporaryDirectory(t);
  const manifestPath = path.join(directory, 'connessioni-storiche', 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const shardPath = path.join(directory, 'connessioni-storiche', manifest.shards[0].path);
  const shard = fs.readFileSync(shardPath, 'utf8');
  const replacement = shard[0] === '{' ? '[' : '{';
  fs.writeFileSync(shardPath, `${replacement}${shard.slice(1)}`);

  assert.match(
    validateInventories(catalog, directory).join('\n'),
    /Connessioni storiche: shard .* hash SHA-256 atteso/
  );
});

test('registra la comparazione prezzi come capacità sospesa e ancora assente', () => {
  const catalog = loadCatalog();
  const page = allPages(catalog).find((item) => item.id === 'controllo.comparazione_prezzi_acquisto');
  assert.equal(page?.status, 'ASSENTE');
  assert.deepEqual(page?.entities, ['invoice_supplier_line']);
  assert.equal(catalog.flows.some((flow) => /price|prezz/i.test(flow.id)), false);
  assert.equal(
    catalog.externalDecisions.some((decision) => /agrifood|bmti/i.test(decision.id)),
    false
  );
});
