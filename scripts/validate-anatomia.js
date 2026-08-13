import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  historicalConnectionsManifestPath,
  loadHistoricalConnections
} from './historical-connections-shards.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const repositoryRoot = path.resolve(__dirname, '..');
export const catalogPath = path.join(repositoryRoot, 'docs/anatomia-gestionale/catalogo.json');
export const inventoriesDirectory = path.join(repositoryRoot, 'docs/anatomia-gestionale/inventari');
export const topologyPath = path.join(repositoryRoot, 'docs/anatomia-gestionale/topologia-flussi.json');

const TOP_LEVEL_SECTIONS = [
  'home',
  'prima_nota',
  'documenti',
  'riconciliazione',
  'amministrazione',
  'controllo'
];

const REQUIRED_STATUSES = [
  'PRESENTE',
  'PARZIALE',
  'ASSENTE',
  'DIVERGENTE',
  'SUPERATO_DA_VERSIONE_PIU_RECENTE',
  'ESCLUSO_DAL_PERIMETRO'
];
const REQUIRED_ROLES = ['ADMIN', 'OPERATORE', 'SOLA_LETTURA'];
const ACCESS_LEVELS = new Set(['AUTHENTICATED', 'ADMIN']);
const IMPLEMENTED_STATES = new Set(['PRESENTE', 'PARZIALE']);
const ADMIN_VIEW_EXCEPTIONS = new Set(['controllo.audit_rollback']);

// Contratto machine-readable: un test è prova di una capability soltanto quando
// il registro nomina sia i file d'implementazione sia comportamenti osservabili
// verificati da quel test. La mera importazione di un file non costituisce copertura.
export const CAPABILITY_TEST_EVIDENCE = Object.freeze({
  'home.quadro_operativo': {
    implementation: ['public/index.html', 'src/core-router.js'],
    tests: [{
      path: 'test/home-dashboard.test.js',
      assertions: ['/api/dashboard', 'payload.saldi', 'dashboardCards', 'payload.saldi[conto]']
    }]
  },
  'home.attivita_aperte': {
    implementation: ['public/app.js', 'src/core-router.js'],
    tests: [{
      path: 'test/home-dashboard.test.js',
      assertions: ['payload.documentiDaVerificare', 'f24DaRiscontrare', 'riscossioneDaVerificare', 'id=["\']todo']
    }]
  },
  'prima_nota.registro_saldi': {
    implementation: ['src/ledger.js', 'src/core-router.js'],
    tests: [{ path: 'test/domain.test.js', assertions: ['saldo progressivo', 'buildLedger', 'saldoProgressivo'] }]
  },
  'prima_nota.cassa': {
    implementation: ['src/domain.js', 'src/ledger.js'],
    tests: [{ path: 'test/domain.test.js', assertions: ['Cassa richiede attestazione', 'ATTESTAZIONE_CASSA', 'canReconcile'] }]
  },
  'prima_nota.provvisoria': {
    implementation: ['src/domain.js', 'src/ledger.js'],
    tests: [{ path: 'test/domain.test.js', assertions: ['Provvisoria non si riconcilia', "conto: 'PROVVISORIA'", 'canReconcile'] }]
  },
  'documenti.indice_drive': {
    implementation: ['src/drive-document-index.js', 'src/drive-index-router.js'],
    tests: [{ path: 'test/drive-document-index.test.js', assertions: ['valida relazioni e identita dell indice', 'parseDriveIndex', 'resolvePath'] }]
  },
  'documenti.albero_drive': {
    implementation: ['src/drive-data-import.js', 'src/drive-data-router.js'],
    tests: [{ path: 'test/drive-data-import.test.js', assertions: ['scansione conserva radice', 'scanDriveTree', 'folderRecords'] }]
  },
  'documenti.f24_quietanze_dichiarazioni': {
    implementation: ['src/f24-import-service.js', 'src/f24-extraction-policy.js', 'src/drive-data-import.js'],
    tests: [{ path: 'test/f24.test.js', assertions: ['estrae le sezioni principali da una quietanza', 'parseQuietanzaText', 'conserva provenienza e confidenza'] }]
  },
  'controllo.anatomia': {
    implementation: ['docs/anatomia-gestionale/catalogo.json', 'scripts/validate-anatomia.js'],
    tests: [{ path: 'test/anatomia-catalog.test.js', assertions: ['catalogo anatomico canonico', 'validateCatalog', 'validateTopology'] }]
  }
});

// Le capability parziali note senza un test end-to-end esatto non possono essere
// promosse a PRESENTE riutilizzando un test adiacente.
const REQUIRED_CAPABILITY_TEST_GAPS = Object.freeze({
  'riconciliazione.f24_banca': 'manca un test della route /api/f24/:id/riconcilia con prova finanziaria, quadratura, idempotenza e allocazione',
  'riconciliazione.riscossione_banca': 'manca un test della route /api/riscossione/atti/:id/collega-movimento con prova finanziaria, quadratura, idempotenza e allocazione',
  'amministrazione.f24_codici': 'manca un test del registro /api/tributi versionato, della riclassificazione e del codice ignoto DA_VERIFICARE'
});

// Capability -> massimo perimetro di scrittura/eventi. Anche un'entità dello
// stesso owner resta vietata se appartiene a un'altra capability.
export const PAGE_COMMAND_SCOPE = Object.freeze({
  'amministrazione.dizionario_prodotti': {
    commands: {
      'amministrazione.dizionario_prodotti.resolve_alias': {
        writeEntities: ['product_dictionary_item', 'supplier_product_alias'],
        emits: ['product.alias_resolved']
      }
    }
  },
  'amministrazione.f24_codici': {
    commands: {
      'amministrazione.f24_codici.publish_tax_code_version': {
        writeEntities: ['tax_code_version'],
        emits: ['f24.tax_code_version_changed']
      }
    }
  }
});

const EXPECTED_INVENTORIES = new Map([
  ['endpoint-runtime.json', { kind: 'runtime_endpoints', count: 1108 }],
  ['collezioni.json', { kind: 'collections', count: 269 }],
  ['modelli-enum.json', { kind: 'models_and_enums', count: 174 }],
  ['job-schedulati.json', { kind: 'scheduled_jobs', count: 34 }],
  ['pagine-storiche.json', { kind: 'historical_pages', count: 62 }],
  ['schede-pagine.json', { kind: 'historical_page_specs', count: 50 }],
  ['popup.json', { kind: 'historical_popups', count: 36 }],
  ['situazione-fiscale.json', { kind: 'outside_catalog_fiscal_page', count: 8 }],
  ['connessioni-storiche/manifest.json', {
    kind: 'historical_connections',
    nodeCount: 3638,
    edgeCount: 8730,
    gapCount: 877,
    special: 'connections'
  }]
]);

function duplicateValues(values) {
  const seen = new Set();
  const duplicates = new Set();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates];
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasExactValues(actual, expected) {
  return Array.isArray(actual) && JSON.stringify(actual) === JSON.stringify(expected);
}

function hasSameValues(actual, expected) {
  if (!Array.isArray(actual) || !Array.isArray(expected)) return false;
  return JSON.stringify([...new Set(actual)].sort()) === JSON.stringify([...new Set(expected)].sort());
}

function nonEmptyStringArray(value) {
  return Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString);
}

function expectedSectionStatus(pages) {
  if (!Array.isArray(pages) || pages.length === 0) return null;
  if (pages.every((page) => page.status === 'PRESENTE')) return 'PRESENTE';
  if (pages.every((page) => page.status === 'ASSENTE')) return 'ASSENTE';
  return 'PARZIALE';
}

function normalizedRepositoryPath(value, root = repositoryRoot) {
  if (!isNonEmptyString(value) || path.isAbsolute(value)) return null;
  const normalized = path.posix.normalize(value.replaceAll('\\', '/'));
  if (normalized !== value || normalized === '..' || normalized.startsWith('../')) return null;
  const resolved = path.resolve(root, normalized);
  if (resolved === root || !resolved.startsWith(`${root}${path.sep}`)) return null;
  return { normalized, resolved };
}

function validateCapabilityTestEvidence(page) {
  const errors = [];
  const contract = CAPABILITY_TEST_EVIDENCE[page.id];
  const declaredEvidence = new Set(page.currentEvidence || []);

  if (page.status === 'PRESENTE' && !contract) {
    const knownGap = REQUIRED_CAPABILITY_TEST_GAPS[page.id];
    errors.push(
      `Pagina ${page.id}: stato PRESENTE senza contratto capability→evidence→test; ${knownGap || 'registrare implementazione, test e asserzioni specifiche della capability'}.`
    );
    return errors;
  }
  if (!contract) return errors;

  for (const implementationPath of contract.implementation || []) {
    if (!declaredEvidence.has(implementationPath)) {
      errors.push(`Pagina ${page.id}: currentEvidence non include l'implementazione richiesta ${implementationPath}.`);
    }
  }
  for (const testEvidence of contract.tests || []) {
    if (!declaredEvidence.has(testEvidence.path)) {
      errors.push(`Pagina ${page.id}: currentEvidence non include il test capability-specific ${testEvidence.path}.`);
      continue;
    }
    const safePath = normalizedRepositoryPath(testEvidence.path);
    if (!safePath || !fs.existsSync(safePath.resolved)) continue;
    const source = fs.readFileSync(safePath.resolved, 'utf8');
    const missingAssertions = (testEvidence.assertions || []).filter((marker) => !source.includes(marker));
    if (missingAssertions.length > 0) {
      errors.push(`Pagina ${page.id}: ${testEvidence.path} non prova la capability; marker mancanti: ${missingAssertions.join(', ')}.`);
    }
  }
  return errors;
}

function dependencyCycles(pages, pageIds) {
  const graph = new Map(
    pages.map((page) => [page.id, (page.dependsOn || []).filter((dependency) => pageIds.has(dependency))])
  );
  const state = new Map();
  const stack = [];
  const cycles = new Map();

  const visit = (pageId) => {
    state.set(pageId, 1);
    stack.push(pageId);
    for (const dependency of graph.get(pageId) || []) {
      if (!state.has(dependency)) {
        visit(dependency);
      } else if (state.get(dependency) === 1) {
        const start = stack.lastIndexOf(dependency);
        const cycleNodes = stack.slice(start);
        const rotations = cycleNodes.map((_, index) => [
          ...cycleNodes.slice(index),
          ...cycleNodes.slice(0, index)
        ].join(' -> '));
        const key = rotations.sort()[0];
        cycles.set(key, [...cycleNodes, dependency]);
      }
    }
    stack.pop();
    state.set(pageId, 2);
  };

  for (const pageId of graph.keys()) {
    if (!state.has(pageId)) visit(pageId);
  }
  return [...cycles.values()];
}

function validatePageAccess(page, roles) {
  const errors = [];
  const access = page.access;
  if (!access || typeof access !== 'object' || Array.isArray(access)) {
    return [`Pagina ${page.id}: access obbligatorio e non valido.`];
  }
  if (!ACCESS_LEVELS.has(access.level)) {
    errors.push(`Pagina ${page.id}: livello accesso sconosciuto ${access.level}.`);
  }

  for (const field of ['viewRoles', 'writeRoles', 'mfaActions']) {
    if (!Array.isArray(access[field])) {
      errors.push(`Pagina ${page.id}: access.${field} deve essere un array.`);
      continue;
    }
    for (const duplicate of duplicateValues(access[field])) {
      errors.push(`Pagina ${page.id}: valore duplicato in access.${field}: ${duplicate}.`);
    }
  }

  if (!Array.isArray(access.viewRoles) || access.viewRoles.length === 0) {
    errors.push(`Pagina ${page.id}: access.viewRoles deve contenere almeno un ruolo.`);
  }
  for (const role of [...(access.viewRoles || []), ...(access.writeRoles || [])]) {
    if (!roles.has(role)) errors.push(`Pagina ${page.id}: ruolo accesso sconosciuto ${role}.`);
  }
  for (const action of access.mfaActions || []) {
    if (!isNonEmptyString(action)) errors.push(`Pagina ${page.id}: azione MFA non valida.`);
  }
  for (const role of access.writeRoles || []) {
    if (!(access.viewRoles || []).includes(role)) {
      errors.push(`Pagina ${page.id}: il ruolo ${role} può scrivere ma non visualizzare.`);
    }
    if (role === 'SOLA_LETTURA') {
      errors.push(`Pagina ${page.id}: SOLA_LETTURA non può essere in writeRoles.`);
    }
  }

  if (access.level === 'ADMIN') {
    const documentedAuditException = ADMIN_VIEW_EXCEPTIONS.has(page.id) && /audit/i.test(page.notes || '');
    const allowedViewRoles = documentedAuditException ? new Set(['ADMIN', 'SOLA_LETTURA']) : new Set(['ADMIN']);
    for (const role of access.viewRoles || []) {
      if (!allowedViewRoles.has(role)) {
        errors.push(`Pagina ${page.id}: livello ADMIN non consente viewRoles ${role}.`);
      }
    }
    if ((access.writeRoles || []).some((role) => role !== 'ADMIN')) {
      errors.push(`Pagina ${page.id}: livello ADMIN consente scrittura solo ad ADMIN.`);
    }
  }
  return errors;
}

function validatePageEvidence(page) {
  const errors = [];
  if (!Array.isArray(page.currentEvidence)) {
    return [`Pagina ${page.id}: currentEvidence deve essere un array di path.`];
  }
  if (IMPLEMENTED_STATES.has(page.status) && page.currentEvidence.length === 0) {
    errors.push(`Pagina ${page.id}: stato ${page.status} senza currentEvidence.`);
  }
  if (!IMPLEMENTED_STATES.has(page.status) && page.currentEvidence.length > 0) {
    errors.push(`Pagina ${page.id}: stato ${page.status} non può dichiarare currentEvidence correnti.`);
  }
  for (const duplicate of duplicateValues(page.currentEvidence)) {
    errors.push(`Pagina ${page.id}: currentEvidence duplicata ${duplicate}.`);
  }
  for (const evidence of page.currentEvidence) {
    const safePath = normalizedRepositoryPath(evidence);
    if (!safePath) {
      errors.push(`Pagina ${page.id}: currentEvidence deve essere un path relativo sicuro: ${String(evidence)}.`);
      continue;
    }
    if (!fs.existsSync(safePath.resolved) || !fs.statSync(safePath.resolved).isFile()) {
      errors.push(`Pagina ${page.id}: currentEvidence inesistente ${evidence}.`);
      continue;
    }
    const realPath = fs.realpathSync(safePath.resolved);
    if (!realPath.startsWith(`${repositoryRoot}${path.sep}`)) {
      errors.push(`Pagina ${page.id}: currentEvidence esce dal repository ${evidence}.`);
    }
  }
  errors.push(...validateCapabilityTestEvidence(page));
  return errors;
}

export function loadCatalog(filePath = catalogPath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

export function loadTopology(filePath = topologyPath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

export function validateCatalog(catalog) {
  const errors = [];
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) {
    return ['Il catalogo deve essere un oggetto JSON.'];
  }

  if (!isNonEmptyString(catalog.schemaVersion)) errors.push('schemaVersion mancante.');
  if (!isNonEmptyString(catalog.baselineCommit)) errors.push('baselineCommit mancante.');

  const statuses = new Set(catalog.statusValues || []);
  for (const required of REQUIRED_STATUSES) {
    if (!statuses.has(required)) errors.push(`Stato obbligatorio assente: ${required}.`);
  }
  if (!hasExactValues(catalog.roleValues, REQUIRED_ROLES)) {
    errors.push(`roleValues deve essere, in ordine: ${REQUIRED_ROLES.join(', ')}.`);
  }
  const roles = new Set(catalog.roleValues || []);
  if (
    catalog.statusAggregation?.scope !== 'section' ||
    catalog.statusAggregation?.evidenceScope !== 'page' ||
    !isNonEmptyString(catalog.statusAggregation?.rule) ||
    !isNonEmptyString(catalog.statusAggregation?.evidenceRule)
  ) {
    errors.push('statusAggregation deve documentare scope di sezione ed evidenze di pagina.');
  }

  const owners = new Set((catalog.owners || []).map((owner) => owner.id));
  for (const duplicate of duplicateValues((catalog.owners || []).map((owner) => owner.id))) {
    errors.push(`Proprietario duplicato: ${duplicate}.`);
  }
  for (const owner of catalog.owners || []) {
    if (!isNonEmptyString(owner.id) || !isNonEmptyString(owner.authority)) {
      errors.push('Ogni proprietario deve avere id e authority.');
    }
  }

  const sections = catalog.sections || [];
  const sectionIds = sections.map((section) => section.id);
  if (!hasExactValues(sectionIds, TOP_LEVEL_SECTIONS)) {
    errors.push(`Le sezioni principali devono essere, in ordine: ${TOP_LEVEL_SECTIONS.join(', ')}.`);
  }

  const entities = catalog.entities || [];
  const entityIds = new Set(entities.map((entity) => entity.id));
  for (const duplicate of duplicateValues(entities.map((entity) => entity.id))) {
    errors.push(`Entità duplicata: ${duplicate}.`);
  }
  for (const entity of entities) {
    if (!owners.has(entity.owner)) errors.push(`Entità ${entity.id}: proprietario sconosciuto ${entity.owner}.`);
    if (!isNonEmptyString(entity.naturalKey)) errors.push(`Entità ${entity.id}: naturalKey mancante.`);
    if (!isNonEmptyString(entity.authority)) errors.push(`Entità ${entity.id}: authority mancante.`);
  }

  const pages = sections.flatMap((section) => section.pages || []);
  const pageIds = new Set(pages.map((page) => page.id));
  for (const duplicate of duplicateValues(pages.map((page) => page.id))) {
    errors.push(`Pagina duplicata: ${duplicate}.`);
  }
  for (const duplicate of duplicateValues(pages.map((page) => page.route))) {
    errors.push(`Route pagina duplicata: ${duplicate}.`);
  }

  for (const section of sections) {
    if (!owners.has(section.owner)) errors.push(`Sezione ${section.id}: proprietario sconosciuto ${section.owner}.`);
    if (!statuses.has(section.status)) errors.push(`Sezione ${section.id}: stato sconosciuto ${section.status}.`);
    if (!isNonEmptyString(section.route) || !section.route.startsWith('/')) {
      errors.push(`Sezione ${section.id}: route non valida.`);
    }
    const expectedStatus = expectedSectionStatus(section.pages);
    if (!expectedStatus) {
      errors.push(`Sezione ${section.id}: deve contenere almeno una pagina.`);
    } else if (section.status !== expectedStatus) {
      errors.push(`Sezione ${section.id}: stato ${section.status} incoerente, atteso ${expectedStatus}.`);
    }
  }

  for (const page of pages) {
    if (!isNonEmptyString(page.id) || !isNonEmptyString(page.label)) errors.push('Ogni pagina deve avere id e label.');
    if (!isNonEmptyString(page.route) || !page.route.startsWith('/')) errors.push(`Pagina ${page.id}: route non valida.`);
    if (!owners.has(page.owner)) errors.push(`Pagina ${page.id}: proprietario sconosciuto ${page.owner}.`);
    if (!statuses.has(page.status)) errors.push(`Pagina ${page.id}: stato sconosciuto ${page.status}.`);
    if (!Array.isArray(page.entities) || page.entities.length === 0) errors.push(`Pagina ${page.id}: entities mancanti.`);
    for (const entityId of page.entities || []) {
      if (!entityIds.has(entityId)) errors.push(`Pagina ${page.id}: entità sconosciuta ${entityId}.`);
    }
    for (const dependency of page.dependsOn || []) {
      if (!pageIds.has(dependency)) errors.push(`Pagina ${page.id}: dipendenza sconosciuta ${dependency}.`);
      if (dependency === page.id) errors.push(`Pagina ${page.id}: dipendenza circolare diretta.`);
    }
    errors.push(...validatePageAccess(page, roles));
    errors.push(...validatePageEvidence(page));
    if (!isNonEmptyString(page.notes)) errors.push(`Pagina ${page.id}: notes mancanti.`);
  }
  for (const cycle of dependencyCycles(pages, pageIds)) {
    if (cycle.length > 2) errors.push(`Dipendenza circolare transitiva: ${cycle.join(' -> ')}.`);
  }

  for (const relation of catalog.relations || []) {
    if (!entityIds.has(relation.from)) errors.push(`Relazione ${relation.id}: entità from sconosciuta ${relation.from}.`);
    if (!entityIds.has(relation.to)) errors.push(`Relazione ${relation.id}: entità to sconosciuta ${relation.to}.`);
    if (!entityIds.has(relation.authority)) errors.push(`Relazione ${relation.id}: authority sconosciuta ${relation.authority}.`);
    if (!isNonEmptyString(relation.cardinality)) errors.push(`Relazione ${relation.id}: cardinalità mancante.`);
    if (!isNonEmptyString(relation.autoLink)) errors.push(`Relazione ${relation.id}: regola autoLink mancante.`);
  }
  for (const duplicate of duplicateValues((catalog.relations || []).map((relation) => relation.id))) {
    errors.push(`Relazione duplicata: ${duplicate}.`);
  }

  for (const duplicate of duplicateValues((catalog.flows || []).map((flow) => flow.id))) {
    errors.push(`Flusso duplicato: ${duplicate}.`);
  }
  for (const flow of catalog.flows || []) {
    if (!isNonEmptyString(flow.id) || !isNonEmptyString(flow.label)) errors.push('Ogni flusso deve avere id e label.');
    if (!Array.isArray(flow.steps) || flow.steps.length < 2) errors.push(`Flusso ${flow.id}: servono almeno due passaggi.`);
    for (const step of flow.steps || []) {
      if (!owners.has(step.owner)) errors.push(`Flusso ${flow.id}: proprietario sconosciuto ${step.owner}.`);
      if (!isNonEmptyString(step.action)) errors.push(`Flusso ${flow.id}: action mancante.`);
      if (!Array.isArray(step.outputs) || step.outputs.length === 0) errors.push(`Flusso ${flow.id}: outputs mancanti.`);
      for (const output of step.outputs || []) {
        if (!entityIds.has(output)) errors.push(`Flusso ${flow.id}: output sconosciuto ${output}.`);
      }
    }
  }

  for (const exclusion of catalog.exclusions || []) {
    if (exclusion.status !== 'ESCLUSO_DAL_PERIMETRO') errors.push(`Esclusione ${exclusion.id}: stato non valido.`);
    if (!isNonEmptyString(exclusion.reason)) errors.push(`Esclusione ${exclusion.id}: motivazione mancante.`);
  }

  for (const decision of catalog.externalDecisions || []) {
    if (decision.runtimeDependency !== false) {
      errors.push(`Integrazione ${decision.id}: una dipendenza runtime richiede una decisione e una modifica dedicate.`);
    }
    if (!isNonEmptyString(decision.decision) || !isNonEmptyString(decision.reason)) {
      errors.push(`Integrazione ${decision.id}: decisione o motivazione mancante.`);
    }
  }
  for (const duplicate of duplicateValues((catalog.externalDecisions || []).map((decision) => decision.id))) {
    errors.push(`Decisione integrazione duplicata: ${duplicate}.`);
  }

  return errors;
}

function validateReferenceArray(errors, context, values, knownValues, valueLabel) {
  if (!Array.isArray(values)) {
    errors.push(`${context}: ${valueLabel} deve essere un array.`);
    return;
  }
  for (const duplicate of duplicateValues(values)) {
    errors.push(`${context}: ${valueLabel} duplicato ${duplicate}.`);
  }
  for (const value of values) {
    if (!knownValues.has(value)) errors.push(`${context}: ${valueLabel} sconosciuto ${value}.`);
  }
}

export function validateTopology(catalog, topology) {
  const errors = [];
  if (!topology || typeof topology !== 'object' || Array.isArray(topology)) {
    return ['Topologia: deve essere un oggetto JSON strutturato.'];
  }

  const owners = new Set((catalog.owners || []).map((owner) => owner.id));
  const entities = catalog.entities || [];
  const entityIds = new Set(entities.map((entity) => entity.id));
  const entityOwners = new Map(entities.map((entity) => [entity.id, entity.owner]));
  const relationIds = new Set((catalog.relations || []).map((relation) => relation.id));
  const pages = (catalog.sections || []).flatMap((section) => section.pages || []);
  const pagesById = new Map(pages.map((page) => [page.id, page]));
  const pageIds = new Set(pagesById.keys());

  if (!isNonEmptyString(topology.schemaVersion)) errors.push('Topologia: schemaVersion mancante.');
  if (topology.catalogSchemaVersion !== catalog.schemaVersion) {
    errors.push('Topologia: catalogSchemaVersion non coincide con il catalogo.');
  }
  if (topology.catalogBaselineCommit !== catalog.baselineCommit) {
    errors.push('Topologia: catalogBaselineCommit non coincide con il catalogo.');
  }
  if (
    topology.eventContract?.immutable !== true ||
    topology.eventContract?.outboxRequired !== true ||
    !Array.isArray(topology.eventContract?.requiredFields) ||
    !topology.eventContract.requiredFields.includes('evidenceRefs') ||
    topology.eventContract.requiredFields.includes('sourceAssetId')
  ) {
    errors.push('Topologia: eventContract deve richiedere evidenceRefs, non sourceAssetId universale, immutabilità e outbox.');
  }

  const events = topology.events;
  if (!Array.isArray(events) || events.length === 0) {
    return [...errors, 'Topologia: registry events obbligatorio e non vuoto.'];
  }
  const eventIds = new Set(events.map((event) => event.id));
  for (const duplicate of duplicateValues(events.map((event) => event.id))) {
    errors.push(`Topologia: evento duplicato ${duplicate}.`);
  }

  const processors = topology.processors;
  if (!Array.isArray(processors) || processors.length === 0) {
    errors.push('Topologia: registry processors obbligatorio e non vuoto.');
  }
  const processorIds = new Set((processors || []).map((processor) => processor.id));
  for (const duplicate of duplicateValues((processors || []).map((processor) => processor.id))) {
    errors.push(`Topologia: processor duplicato ${duplicate}.`);
  }

  const projections = topology.pageProjections;
  if (!Array.isArray(projections)) {
    return [...errors, 'Topologia: pageProjections deve essere un array.'];
  }
  const projectionPageIds = projections.map((projection) => projection.pageId);
  for (const duplicate of duplicateValues(projectionPageIds)) {
    errors.push(`Topologia: proiezione pagina duplicata ${duplicate}.`);
  }
  const missingPages = [...pageIds].filter((pageId) => !projectionPageIds.includes(pageId));
  const unknownPages = projectionPageIds.filter((pageId) => !pageIds.has(pageId));
  for (const pageId of missingPages) errors.push(`Topologia: pagina catalogo non coperta ${pageId}.`);
  for (const pageId of unknownPages) errors.push(`Topologia: proiezione riferisce pagina sconosciuta ${pageId}.`);
  if (projections.length !== pages.length) {
    errors.push(`Topologia: attese esattamente ${pages.length} proiezioni, trovate ${projections.length}.`);
  }

  const commandIds = [];
  for (const projection of projections) {
    const context = `Topologia pagina ${projection.pageId}`;
    const catalogPage = pagesById.get(projection.pageId);
    if (!catalogPage) continue;
    if (projection.owner !== catalogPage.owner) errors.push(`${context}: owner diverso dal catalogo.`);
    if (projection.implementationStatus !== catalogPage.status) errors.push(`${context}: stato diverso dal catalogo.`);
    validateReferenceArray(errors, context, projection.inputEvents, eventIds, 'inputEvent');
    validateReferenceArray(errors, context, projection.outputEvents, eventIds, 'outputEvent');
    validateReferenceArray(errors, context, projection.inputEntities, entityIds, 'inputEntity');
    const projectionKind = projection.projection?.kind;
    if (!new Set(['MATERIALIZED_VIEW', 'QUERY_VIEW']).has(projectionKind)) {
      errors.push(`${context}: projection.kind deve essere MATERIALIZED_VIEW o QUERY_VIEW.`);
    }
    if (projection.projection?.ownsCanonicalData !== false || !isNonEmptyString(projection.projection?.refresh)) {
      errors.push(`${context}: projection deve essere non autorevole e con refresh esplicito.`);
    }
    if (
      projectionKind === 'MATERIALIZED_VIEW' &&
      projection.projection.refresh !== 'EVENT_DRIVEN_INVALIDATION_AND_IDEMPOTENT_REBUILD'
    ) {
      errors.push(`${context}: MATERIALIZED_VIEW richiede refresh event-driven e rebuild idempotente.`);
    }
    if (
      projectionKind === 'QUERY_VIEW' &&
      (projection.projection.refresh !== 'ON_DEMAND_QUERY' || !isNonEmptyString(projection.projection.queryEndpoint))
    ) {
      errors.push(`${context}: QUERY_VIEW richiede ON_DEMAND_QUERY e queryEndpoint.`);
    }
    validateReferenceArray(errors, context, projection.projection?.sourceEntities, entityIds, 'sourceEntity');
    validateReferenceArray(errors, context, projection.projection?.sourcePageDependencies, pageIds, 'sourcePageDependency');
    if (!hasSameValues(projection.inputEntities, projection.projection?.sourceEntities)) {
      errors.push(`${context}: inputEntities e projection.sourceEntities devono coincidere.`);
    }
    if (!hasSameValues(catalogPage.dependsOn || [], projection.projection?.sourcePageDependencies || [])) {
      errors.push(`${context}: sourcePageDependencies diverse da dependsOn del catalogo.`);
    }
    if (
      !nonEmptyStringArray(projection.allowedActions) ||
      !isNonEmptyString(projection.failureState) ||
      !isNonEmptyString(projection.failurePolicy) ||
      !isNonEmptyString(projection.approvalPolicy) ||
      projection.statusDoesNotImplyOwnership !== true
    ) {
      errors.push(`${context}: azioni/policy/failure o separazione ownership incompleti.`);
    }
    if (!Array.isArray(projection.commands)) {
      errors.push(`${context}: commands deve essere un array, anche se vuoto.`);
      continue;
    }

    const emittedByCommands = [];
    for (const command of projection.commands) {
      commandIds.push(command.id);
      const commandContext = `${context}/comando ${command.id}`;
      if (!isNonEmptyString(command.id)) errors.push(`${context}: comando senza id.`);
      if (!owners.has(command.commandOwner)) errors.push(`${commandContext}: owner sconosciuto ${command.commandOwner}.`);
      validateReferenceArray(errors, commandContext, command.writeEntities, entityIds, 'writeEntity');
      for (const entityId of command.writeEntities || []) {
        if (entityOwners.get(entityId) !== command.commandOwner) {
          errors.push(`${commandContext}: ${entityId} è autorevole per ${entityOwners.get(entityId)}, non ${command.commandOwner}.`);
        }
      }
      validateReferenceArray(errors, commandContext, command.emits, eventIds, 'evento emesso');
      emittedByCommands.push(...(command.emits || []));
      if (
        !nonEmptyStringArray(command.requiredEvidence) ||
        !new Set(['A', 'B', 'C']).has(command.autonomy) ||
        !isNonEmptyString(command.approval) ||
        !isNonEmptyString(command.audit) ||
        !isNonEmptyString(command.idempotencyKey) ||
        !isNonEmptyString(command.failure)
      ) {
        errors.push(`${commandContext}: evidence/autonomy/approval/audit/idempotency/failure incompleti.`);
      }
    }
    const commandScope = PAGE_COMMAND_SCOPE[projection.pageId];
    if (commandScope) {
      const allowedCommandIds = new Set(Object.keys(commandScope.commands));
      for (const command of projection.commands) {
        const allowed = commandScope.commands[command.id];
        if (!allowed) {
          errors.push(`${context}: comando ${command.id} fuori dalla allowlist della capability.`);
          continue;
        }
        if (!hasSameValues(command.writeEntities, allowed.writeEntities)) {
          errors.push(`${context}/comando ${command.id}: writeEntities fuori perimetro; consentite ${allowed.writeEntities.join(', ')}.`);
        }
        if (!hasSameValues(command.emits, allowed.emits)) {
          errors.push(`${context}/comando ${command.id}: eventi emessi fuori perimetro; consentiti ${allowed.emits.join(', ')}.`);
        }
      }
      for (const requiredCommandId of allowedCommandIds) {
        if (!projection.commands.some((command) => command.id === requiredCommandId)) {
          errors.push(`${context}: comando allowlist mancante ${requiredCommandId}.`);
        }
      }
    }
    if (!hasSameValues(projection.outputEvents, emittedByCommands)) {
      errors.push(`${context}: outputEvents deve coincidere con l'unione degli eventi emessi dai comandi.`);
    }
    if (projection.commands.length === 0 && projection.outputEvents.length !== 0) {
      errors.push(`${context}: pagina read-only senza comandi non può emettere eventi.`);
    }
    if (projection.pageId === topology.coherenceEngine?.pageId) {
      for (const command of projection.commands) {
        for (const entityId of command.writeEntities || []) {
          if (entityOwners.get(entityId) !== 'CONTROLLO') {
            errors.push(`${context}: Coerenza non può scrivere l'entità autorevole ${entityId}.`);
          }
        }
      }
    }
  }
  for (const duplicate of duplicateValues(commandIds)) errors.push(`Topologia: command ID duplicato ${duplicate}.`);

  for (const processor of processors || []) {
    const context = `Topologia processor ${processor.id}`;
    if (!owners.has(processor.owner)) errors.push(`${context}: owner sconosciuto ${processor.owner}.`);
    validateReferenceArray(errors, context, processor.consumesEvents, eventIds, 'evento consumato');
    validateReferenceArray(errors, context, processor.emits, eventIds, 'evento emesso');
    validateReferenceArray(errors, context, processor.readEntities, entityIds, 'readEntity');
    validateReferenceArray(errors, context, processor.writeEntities, entityIds, 'writeEntity');
    for (const entityId of processor.writeEntities || []) {
      if (entityOwners.get(entityId) !== processor.owner) {
        errors.push(`${context}: ${entityId} è autorevole per ${entityOwners.get(entityId)}, non ${processor.owner}.`);
      }
    }
    if (
      !nonEmptyStringArray(processor.gates) ||
      !new Set(['A', 'B', 'C']).has(processor.autonomy) ||
      !isNonEmptyString(processor.idempotencyKey) ||
      !isNonEmptyString(processor.approval) ||
      !isNonEmptyString(processor.failure) ||
      !isNonEmptyString(processor.retry) ||
      !isNonEmptyString(processor.correctionAndInvalidation)
    ) {
      errors.push(`${context}: gates/autonomy/idempotency/approval/failure/retry/correction incompleti.`);
    }
  }

  const entryEvents = new Set();
  for (const entryPoint of topology.entryPoints || []) {
    const context = `Topologia entry point ${entryPoint.id}`;
    if (!isNonEmptyString(entryPoint.id)) errors.push('Topologia: entry point senza id.');
    if (!eventIds.has(entryPoint.event)) errors.push(`${context}: evento sconosciuto ${entryPoint.event}.`);
    entryEvents.add(entryPoint.event);
    if (!owners.has(entryPoint.owner)) errors.push(`${context}: owner sconosciuto ${entryPoint.owner}.`);
    validateReferenceArray(errors, context, entryPoint.canonicalOutputs, entityIds, 'canonicalOutput');
    for (const entityId of entryPoint.canonicalOutputs || []) {
      if (entityOwners.get(entityId) !== entryPoint.owner) {
        errors.push(`${context}: raw input non può produrre ${entityId}, autorevole per ${entityOwners.get(entityId)}.`);
      }
    }
    for (const handoffOwner of entryPoint.handoffOwner || []) {
      if (!owners.has(handoffOwner)) errors.push(`${context}: handoff owner sconosciuto ${handoffOwner}.`);
    }
    const entryEvent = events.find((event) => event.id === entryPoint.event);
    if (entryEvent && !hasSameValues(entryPoint.canonicalOutputs, entryEvent.canonicalEntities)) {
      errors.push(`${context}: canonicalOutputs non coincide con le entità dell'evento raw.`);
    }
    if (!isNonEmptyString(entryPoint.dedupKey) || !isNonEmptyString(entryPoint.approval)) {
      errors.push(`${context}: dedupKey o approval mancanti.`);
    }
  }
  for (const duplicate of duplicateValues((topology.entryPoints || []).map((entryPoint) => entryPoint.id))) {
    errors.push(`Topologia: entry point duplicato ${duplicate}.`);
  }
  for (const duplicate of duplicateValues((topology.entryPoints || []).map((entryPoint) => entryPoint.event))) {
    errors.push(`Topologia: evento raw duplicato fra entry point ${duplicate}.`);
  }

  const producerPagesByEvent = new Map([...eventIds].map((eventId) => [eventId, []]));
  const consumerPagesByEvent = new Map([...eventIds].map((eventId) => [eventId, []]));
  for (const projection of projections) {
    for (const eventId of projection.outputEvents || []) producerPagesByEvent.get(eventId)?.push(projection.pageId);
    for (const eventId of projection.inputEvents || []) consumerPagesByEvent.get(eventId)?.push(projection.pageId);
  }
  const producerProcessorsByEvent = new Map([...eventIds].map((eventId) => [eventId, []]));
  const consumerProcessorsByEvent = new Map([...eventIds].map((eventId) => [eventId, []]));
  for (const processor of processors || []) {
    for (const eventId of processor.emits || []) producerProcessorsByEvent.get(eventId)?.push(processor.id);
    for (const eventId of processor.consumesEvents || []) consumerProcessorsByEvent.get(eventId)?.push(processor.id);
  }

  const usedEvents = new Set(entryEvents);
  for (const flow of topology.canonicalFlows || []) for (const eventId of flow.triggerEvents || []) usedEvents.add(eventId);
  for (const processor of processors || []) {
    for (const eventId of [...(processor.consumesEvents || []), ...(processor.emits || [])]) usedEvents.add(eventId);
  }
  for (const projection of projections) {
    for (const eventId of [...(projection.inputEvents || []), ...(projection.outputEvents || [])]) usedEvents.add(eventId);
  }

  for (const event of events) {
    const context = `Topologia evento ${event.id}`;
    if (!isNonEmptyString(event.id) || event.type !== event.id || !owners.has(event.owner)) {
      errors.push(`${context}: id/type/owner non validi.`);
    }
    for (const field of ['producerPages', 'consumerPages']) {
      validateReferenceArray(errors, context, event[field], pageIds, field);
    }
    for (const field of ['producerProcessors', 'consumerProcessors']) {
      validateReferenceArray(errors, context, event[field], processorIds, field);
    }
    validateReferenceArray(errors, context, event.canonicalEntities, entityIds, 'canonicalEntity');
    for (const entityId of event.canonicalEntities || []) {
      if (entityOwners.get(entityId) !== event.owner) {
        errors.push(`${context}: ${entityId} è autorevole per ${entityOwners.get(entityId)}, non ${event.owner}.`);
      }
      if (/approval|review/i.test(event.id) && entityId === 'user_identity') {
        errors.push(`${context}: approval/review non può produrre user_identity.`);
      }
    }
    if (
      !isNonEmptyString(event.idempotencyKey) ||
      !nonEmptyStringArray(event.provenanceAndEvidence) ||
      !isNonEmptyString(event.automationAndApproval) ||
      !isNonEmptyString(event.failure?.state) ||
      !isNonEmptyString(event.failure?.retry) ||
      !isNonEmptyString(event.failure?.deadLetter) ||
      !isNonEmptyString(event.correctionAndInvalidation)
    ) {
      errors.push(`${context}: idempotenza/provenienza/approval/failure/correction incompleti.`);
    }
    if (!hasSameValues(event.producerPages, producerPagesByEvent.get(event.id))) {
      errors.push(`${context}: producerPages non coincide con i comandi/proiezioni.`);
    }
    if (!hasSameValues(event.consumerPages, consumerPagesByEvent.get(event.id))) {
      errors.push(`${context}: consumerPages non coincide con le proiezioni.`);
    }
    if (!hasSameValues(event.producerProcessors, producerProcessorsByEvent.get(event.id))) {
      errors.push(`${context}: producerProcessors non coincide con i processor.`);
    }
    if (!hasSameValues(event.consumerProcessors, consumerProcessorsByEvent.get(event.id))) {
      errors.push(`${context}: consumerProcessors non coincide con i processor.`);
    }
    const hasProducer =
      entryEvents.has(event.id) ||
      event.producerPages.length > 0 ||
      event.producerProcessors.length > 0 ||
      event.automationAndApproval === 'HUMAN_DECISION' ||
      event.automationAndApproval === 'AUTOMATIC_PROPOSAL_ALLOWED';
    if (!hasProducer) errors.push(`${context}: evento orfano senza produttore dichiarato.`);
    if (!usedEvents.has(event.id)) errors.push(`${context}: evento registrato ma mai usato.`);
  }
  for (const eventId of usedEvents) {
    if (!eventIds.has(eventId)) errors.push(`Topologia: evento usato ma non registrato ${eventId}.`);
  }

  for (const flow of topology.canonicalFlows || []) {
    const context = `Topologia flusso ${flow.id}`;
    if (!isNonEmptyString(flow.id) || !isNonEmptyString(flow.label) || !new Set(['DETAILED_FLOW', 'FLOW_SUMMARY']).has(flow.kind)) {
      errors.push(`${context}: id, label o kind non validi.`);
    }
    validateReferenceArray(errors, context, flow.triggerEvents, eventIds, 'triggerEvent');
    if (!isNonEmptyString(flow.failure) || !flow.corrections) errors.push(`${context}: failure/corrections mancanti.`);
    for (const owner of flow.owners || []) if (!owners.has(owner)) errors.push(`${context}: owner sconosciuto ${owner}.`);
    for (const entityId of flow.entities || []) if (!entityIds.has(entityId)) errors.push(`${context}: entità sconosciuta ${entityId}.`);
    for (const relationId of flow.relations || []) if (!relationIds.has(relationId)) errors.push(`${context}: relazione sconosciuta ${relationId}.`);
    for (const step of flow.steps || []) {
      if (!owners.has(step.owner)) errors.push(`${context}: step owner sconosciuto ${step.owner}.`);
      for (const entityId of step.produces || []) if (!entityIds.has(entityId)) errors.push(`${context}: step produce entità sconosciuta ${entityId}.`);
      for (const relationId of step.relations || []) if (!relationIds.has(relationId)) errors.push(`${context}: step relazione sconosciuta ${relationId}.`);
      if (!isNonEmptyString(step.action) || !isNonEmptyString(step.auto) || !isNonEmptyString(step.failure)) {
        errors.push(`${context}: step privo di action/auto/failure.`);
      }
    }
  }
  for (const duplicate of duplicateValues((topology.canonicalFlows || []).map((flow) => flow.id))) {
    errors.push(`Topologia: canonical flow duplicato ${duplicate}.`);
  }

  const accountingEvent = events.find((event) => event.id === 'accounting.entry_projected');
  const accountingProcessor = processors.find((processor) => processor.id === 'project_accounting_entries');
  if (
    !accountingEvent ||
    accountingEvent.producerPages.length !== 0 ||
    !hasExactValues(accountingEvent.producerProcessors, ['project_accounting_entries']) ||
    !accountingProcessor ||
    !accountingProcessor.gates.includes('document entry does not require payment evidence') ||
    !accountingProcessor.gates.includes('settlement entry requires confirmed financial evidence or explicit audited cash attestation')
  ) {
    errors.push('Topologia contabile: competenza documento e regolamento finanziario devono essere proiettati dal processor canonico come scritture distinte.');
  }

  const supplierInvoiceFlow = topology.canonicalFlows.find((flow) => flow.id === 'supplier_invoice_drive_to_ledger');
  const competenceStep = supplierInvoiceFlow?.steps?.find((step) => step.relations?.includes('supplier_invoice_projects_accounting'));
  const financialEvidenceStep = supplierInvoiceFlow?.steps?.find((step) => step.produces?.includes('financial_evidence'));
  const settlementStep = supplierInvoiceFlow?.steps?.find((step) => step.relations?.includes('ledger_projects_accounting'));
  if (
    !competenceStep ||
    !financialEvidenceStep ||
    !settlementStep ||
    competenceStep.order >= financialEvidenceStep.order ||
    settlementStep.order <= financialEvidenceStep.order ||
    supplierInvoiceFlow?.branches?.competence?.requiresPayment !== false ||
    supplierInvoiceFlow?.branches?.settlement?.requiresConfirmedFinancialEvidence !== true
  ) {
    errors.push('Topologia fattura passiva: la competenza deve precedere ed essere indipendente dalla prova finanziaria; il regolamento deve seguirla.');
  }

  const periodClosedEvent = events.find((event) => event.id === 'accounting.period_closed');
  const closingPage = projections.find((projection) => projection.pageId === 'controllo.chiusura_mensile');
  const closingCommand = closingPage?.commands?.find((command) => command.id === 'controllo.chiusura_mensile.submit');
  if (
    !periodClosedEvent ||
    !hasExactValues(periodClosedEvent.producerPages, ['controllo.chiusura_mensile']) ||
    closingCommand?.autonomy !== 'C' ||
    !/HUMAN_APPROVAL_REQUIRED/.test(closingCommand?.approval || '') ||
    !/MFA/.test(closingCommand?.approval || '')
  ) {
    errors.push('Topologia chiusura: soltanto la chiusura mensile approvata da una persona con MFA può chiudere il periodo.');
  }

  const approvalEvent = events.find((event) => event.id === 'approval.recorded');
  if (!approvalEvent || approvalEvent.producerPages.length === 0) {
    errors.push('Topologia approvazioni: approval.recorded deve avere un produttore auditabile esplicito.');
  }

  const coherence = topology.coherenceEngine;
  const allowedCoherenceWrites = new Set(['coherence_evaluation', 'anomaly', 'audit_event']);
  if (
    coherence?.mode !== 'READ_ONLY_CROSS_DOMAIN_RULE_ENGINE' ||
    coherence?.owner !== 'CONTROLLO' ||
    !isNonEmptyString(coherence?.anomalyKey) ||
    !isNonEmptyString(coherence?.resolution)
  ) {
    errors.push('Topologia: coherenceEngine deve essere read-only, CONTROLLO e auditabile.');
  }
  validateReferenceArray(errors, 'Topologia coherenceEngine', coherence?.reads, entityIds, 'readEntity');
  validateReferenceArray(errors, 'Topologia coherenceEngine', coherence?.writes, entityIds, 'writeEntity');
  for (const entityId of coherence?.writes || []) {
    if (!allowedCoherenceWrites.has(entityId) || entityOwners.get(entityId) !== 'CONTROLLO') {
      errors.push(`Topologia coherenceEngine: scrittura autorevole vietata ${entityId}.`);
    }
  }
  if (!nonEmptyStringArray(coherence?.forbidden) || !coherence.forbidden.includes('REWRITE_CANONICAL_DOMAIN_FACT')) {
    errors.push('Topologia coherenceEngine: divieto di riscrittura canonica mancante.');
  }
  const coherencePage = projections.find((projection) => projection.pageId === coherence?.pageId);
  if (!coherencePage || coherencePage.commands.length !== 0 || coherencePage.outputEvents.length !== 0) {
    errors.push('Topologia coherenceEngine: la pagina Coerenza deve essere read-only e senza eventi in uscita.');
  }

  return errors;
}

function validateInventoryDocument(fileName, document, specification, catalog, directory) {
  const errors = [];
  const prefix = `Inventario ${fileName}`;
  const owners = new Set((catalog.owners || []).map((owner) => owner.id));
  const pageIds = new Set((catalog.sections || []).flatMap((section) => section.pages || []).map((page) => page.id));

  if (!document || typeof document !== 'object' || Array.isArray(document)) return [`${prefix}: JSON non strutturato.`];
  if (!isNonEmptyString(document.schemaVersion)) errors.push(`${prefix}: schemaVersion mancante.`);
  if (document.kind !== specification.kind) errors.push(`${prefix}: kind ${document.kind} inatteso.`);
  if (document.sourceSnapshot?.runtimeDependency !== false) {
    errors.push(`${prefix}: sourceSnapshot deve essere storico e read-only.`);
  }
  if (document.sourceSnapshot?.commit !== catalog.sourceSnapshot?.commit) {
    errors.push(`${prefix}: commit storico diverso dal catalogo canonico.`);
  }
  if (specification.special === 'connections') {
    return [...errors, ...validateConnectionsInventory(document, specification, catalog, directory)];
  }
  if (!Array.isArray(document.records)) return [...errors, `${prefix}: records deve essere un array.`];
  if (document.records.length !== specification.count) {
    errors.push(`${prefix}: attesi ${specification.count} record, trovati ${document.records.length}.`);
  }
  if (document.summary?.recordCount !== document.records.length) {
    errors.push(`${prefix}: summary.recordCount non coincide con records.length.`);
  }

  for (const duplicate of duplicateValues(document.records.map((record) => record.id))) {
    errors.push(`${prefix}: record id duplicato ${duplicate}.`);
  }
  for (const record of document.records) {
    const recordName = `${prefix}/${record.id}`;
    if (!isNonEmptyString(record.id)) errors.push(`${prefix}: record senza id.`);
    if (!normalizedRepositoryPath(record.sourcePath)) errors.push(`${recordName}: sourcePath non sicuro o mancante.`);
    if (!isNonEmptyString(record.symbol)) errors.push(`${recordName}: symbol mancante.`);
    if (!owners.has(record.owner)) errors.push(`${recordName}: owner sconosciuto ${record.owner}.`);
    if (!isNonEmptyString(record.domain)) errors.push(`${recordName}: domain mancante.`);
    if (!isNonEmptyString(record.decision)) errors.push(`${recordName}: decision mancante.`);
    if (!isNonEmptyString(record.notes)) errors.push(`${recordName}: notes mancanti.`);
    if (!Array.isArray(record.acceptanceTests) || record.acceptanceTests.length === 0 || record.acceptanceTests.some((item) => !isNonEmptyString(item))) {
      errors.push(`${recordName}: acceptanceTests mancanti o non validi.`);
    }

    if (!Object.hasOwn(record, 'canonicalDestination')) {
      errors.push(`${recordName}: mapping canonico 1:1 mancante.`);
    } else if (record.canonicalDestination === null) {
      if (!record.decision?.startsWith('ESCLUDERE')) {
        errors.push(`${recordName}: destinazione nulla senza decisione ESCLUDERE esplicita.`);
      }
    } else if (!isNonEmptyString(record.canonicalDestination)) {
      errors.push(`${recordName}: canonicalDestination deve essere una stringa o null.`);
    } else if (!pageIds.has(record.canonicalDestination)) {
      errors.push(`${recordName}: destinazione canonica sconosciuta ${record.canonicalDestination}.`);
    }
  }

  if (fileName === 'pagine-storiche.json') {
    const expectedLegacyIds = Array.from({ length: 62 }, (_, index) => index + 1);
    const legacyIds = document.records.map((record) => record.legacyId).sort((left, right) => left - right);
    if (!hasExactValues(legacyIds, expectedLegacyIds)) {
      errors.push(`${prefix}: legacyId deve coprire esattamente 1..62 una sola volta.`);
    }
    for (const duplicate of duplicateValues(document.records.map((record) => record.route))) {
      errors.push(`${prefix}: route storica duplicata ${duplicate}.`);
    }
    for (const record of document.records) {
      if (
        !isNonEmptyString(record.label) ||
        !isNonEmptyString(record.route) ||
        !isNonEmptyString(record.component) ||
        !isNonEmptyString(record.entry) ||
        !isNonEmptyString(record.access) ||
        !isNonEmptyString(record.auditStatus)
      ) {
        errors.push(`${prefix}/${record.id}: scheda storica incompleta.`);
      }
    }
  }

  if (fileName === 'situazione-fiscale.json') {
    const pages = document.records.filter((record) => record.recordType === 'page');
    const tabs = document.records.filter((record) => record.recordType === 'tab');
    if (pages.length !== 1 || tabs.length !== 7) {
      errors.push(`${prefix}: attesi una pagina e sette tab.`);
    }
    if (document.records.some((record) => record.outsideCatalog !== true)) {
      errors.push(`${prefix}: tutti i record devono avere outsideCatalog=true.`);
    }
  }
  return errors;
}

function validateConnectionsInventory(document, specification, catalog, directory) {
  const errors = [];
  const prefix = 'Inventario connessioni-storiche.json';
  const pageIds = new Set((catalog.sections || []).flatMap((section) => section.pages || []).map((page) => page.id));
  const inventoryRecords = new Map();
  for (const [fileName, inventorySpecification] of EXPECTED_INVENTORIES) {
    if (inventorySpecification.special) continue;
    const filePath = path.join(directory, fileName);
    if (!fs.existsSync(filePath)) continue;
    const inventory = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    inventoryRecords.set(fileName, new Set((inventory.records || []).map((record) => record.id)));
  }

  if (!Array.isArray(document.nodes) || !Array.isArray(document.edges) || !Array.isArray(document.gaps)) {
    return [`${prefix}: nodes, edges e gaps devono essere array.`];
  }
  for (const [label, actual, expected] of [
    ['nodi', document.nodes.length, specification.nodeCount],
    ['archi', document.edges.length, specification.edgeCount],
    ['gap', document.gaps.length, specification.gapCount]
  ]) {
    if (actual !== expected) errors.push(`${prefix}: attesi ${expected} ${label}, trovati ${actual}.`);
  }
  if (
    document.summary?.nodeCount !== document.nodes.length ||
    document.summary?.edgeCount !== document.edges.length ||
    document.summary?.gapCount !== document.gaps.length
  ) {
    errors.push(`${prefix}: conteggi summary non coincidono con nodi/archi/gap.`);
  }

  const nodeIds = new Set(document.nodes.map((node) => node.id));
  for (const duplicate of duplicateValues(document.nodes.map((node) => node.id))) {
    errors.push(`${prefix}: nodo duplicato ${duplicate}.`);
  }
  const referencedInventoryRecords = new Set();
  for (const node of document.nodes) {
    const context = `${prefix}/nodo ${node.id}`;
    if (!isNonEmptyString(node.id) || !isNonEmptyString(node.nodeType)) errors.push(`${context}: id o nodeType mancante.`);
    if (!normalizedRepositoryPath(node.sourcePath)) errors.push(`${context}: sourcePath non sicuro o mancante.`);
    if (!isNonEmptyString(node.symbol) || !isNonEmptyString(node.decision) || !isNonEmptyString(node.notes)) {
      errors.push(`${context}: symbol/decision/notes mancanti.`);
    }
    if (node.inventory === null) {
      if (node.recordId !== null) errors.push(`${context}: recordId richiede inventory.`);
    } else if (!inventoryRecords.has(node.inventory)) {
      errors.push(`${context}: inventory sconosciuto ${node.inventory}.`);
    } else if (!inventoryRecords.get(node.inventory).has(node.recordId)) {
      errors.push(`${context}: recordId sconosciuto ${node.recordId} in ${node.inventory}.`);
    } else {
      referencedInventoryRecords.add(`${node.inventory}:${node.recordId}`);
    }
    if (
      node.canonicalDestination !== null &&
      node.canonicalDestination !== 'ESCLUSO_DAL_PERIMETRO' &&
      !pageIds.has(node.canonicalDestination)
    ) {
      errors.push(`${context}: destinazione canonica sconosciuta ${node.canonicalDestination}.`);
    }
    if (node.canonicalDestination === null && !node.decision?.startsWith('ESCLUDERE')) {
      errors.push(`${context}: destinazione nulla senza esclusione esplicita.`);
    }
  }
  const expectedInventoryRecordCount = [...inventoryRecords.values()].reduce((total, records) => total + records.size, 0);
  if (
    referencedInventoryRecords.size !== expectedInventoryRecordCount ||
    document.summary?.inventoryRecordCount !== expectedInventoryRecordCount ||
    document.summary?.inventoryRecordsMappedToCanonical !== expectedInventoryRecordCount
  ) {
    errors.push(`${prefix}: ogni record degli inventari deve avere esattamente un nodo e mapping canonico.`);
  }

  for (const duplicate of duplicateValues(document.edges.map((edge) => edge.id))) {
    errors.push(`${prefix}: arco duplicato ${duplicate}.`);
  }
  const mappingSources = new Map();
  for (const edge of document.edges) {
    const context = `${prefix}/arco ${edge.id}`;
    if (!isNonEmptyString(edge.id) || !isNonEmptyString(edge.type) || edge.direction !== 'OUTBOUND') {
      errors.push(`${context}: id/type/direction non validi.`);
    }
    if (!nodeIds.has(edge.from)) errors.push(`${context}: nodo from sconosciuto ${edge.from}.`);
    if (!nodeIds.has(edge.to)) errors.push(`${context}: nodo to sconosciuto ${edge.to}.`);
    if (!new Set(['VERIFIED', 'INFERRED']).has(edge.confidence)) errors.push(`${context}: confidence non valida ${edge.confidence}.`);
    if (!isNonEmptyString(edge.notes) || !Array.isArray(edge.evidence) || edge.evidence.length === 0) {
      errors.push(`${context}: notes/evidence mancanti.`);
    }
    for (const evidence of edge.evidence || []) {
      if (!normalizedRepositoryPath(evidence.sourcePath) || (evidence.line !== undefined && (!Number.isInteger(evidence.line) || evidence.line < 1))) {
        errors.push(`${context}: evidence non strutturata o non sicura.`);
      }
    }
    if (edge.type === 'MAPS_TO_CANONICAL') {
      mappingSources.set(edge.from, (mappingSources.get(edge.from) || 0) + 1);
      if (!edge.to.startsWith('canonical:')) errors.push(`${context}: mapping canonico deve puntare a un nodo canonical:*.`);
    }
  }
  for (const node of document.nodes.filter((item) => item.nodeType !== 'CANONICAL_DESTINATION')) {
    if (mappingSources.get(node.id) !== 1) {
      errors.push(`${prefix}/nodo ${node.id}: deve avere esattamente un MAPS_TO_CANONICAL.`);
    }
  }
  const nonCanonicalNodeCount = document.nodes.filter((node) => node.nodeType !== 'CANONICAL_DESTINATION').length;
  if (mappingSources.size !== nonCanonicalNodeCount || document.summary?.edgesByType?.MAPS_TO_CANONICAL !== nonCanonicalNodeCount) {
    errors.push(`${prefix}: il conteggio MAPS_TO_CANONICAL deve coincidere con tutti i nodi non canonici.`);
  }
  const endpointNodeIds = new Set(document.nodes.filter((node) => node.nodeType === 'ENDPOINT').map((node) => node.id));
  const endpointHandlerCounts = new Map();
  for (const edge of document.edges.filter((item) => item.type === 'HANDLED_BY_ROUTER')) {
    endpointHandlerCounts.set(edge.from, (endpointHandlerCounts.get(edge.from) || 0) + 1);
  }
  for (const endpointNodeId of endpointNodeIds) {
    if (endpointHandlerCounts.get(endpointNodeId) !== 1) {
      errors.push(`${prefix}/nodo ${endpointNodeId}: ogni endpoint deve avere esattamente un HANDLED_BY_ROUTER.`);
    }
  }
  if (endpointHandlerCounts.size !== endpointNodeIds.size || document.summary?.edgesByType?.HANDLED_BY_ROUTER !== endpointNodeIds.size) {
    errors.push(`${prefix}: HANDLED_BY_ROUTER deve coprire esattamente tutti gli endpoint.`);
  }

  for (const duplicate of duplicateValues(document.gaps.map((gap) => gap.id))) {
    errors.push(`${prefix}: gap duplicato ${duplicate}.`);
  }
  for (const gap of document.gaps) {
    const context = `${prefix}/gap ${gap.id}`;
    if (!isNonEmptyString(gap.id) || !nodeIds.has(gap.nodeId) || !isNonEmptyString(gap.reason) || !isNonEmptyString(gap.expectedEdgeType) || !isNonEmptyString(gap.notes)) {
      errors.push(`${context}: riferimento/reason/expectedEdgeType/notes non validi.`);
    }
    if (!gap.evidence || !normalizedRepositoryPath(gap.evidence.sourcePath)) {
      errors.push(`${context}: evidence non strutturata o non sicura.`);
    }
  }
  return errors;
}

export function validateInventories(catalog, directory = inventoriesDirectory) {
  if (!fs.existsSync(directory)) return [];
  const errors = [];
  for (const [fileName, specification] of EXPECTED_INVENTORIES) {
    const filePath = path.join(directory, fileName);
    if (!fs.existsSync(filePath)) {
      errors.push(`Inventario obbligatorio mancante: ${fileName}.`);
      continue;
    }
    let document;
    try {
      document = specification.special === 'connections'
        ? loadHistoricalConnections({
            manifestPath: directory === inventoriesDirectory ? historicalConnectionsManifestPath : filePath
          })
        : JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
      errors.push(`Inventario ${fileName}: non valido (${error.message}).`);
      continue;
    }
    errors.push(...validateInventoryDocument(fileName, document, specification, catalog, directory));
  }
  return errors;
}

export function catalogSummary(catalog) {
  const pages = (catalog.sections || []).flatMap((section) => section.pages || []);
  return {
    sections: (catalog.sections || []).length,
    pages: pages.length,
    entities: (catalog.entities || []).length,
    relations: (catalog.relations || []).length,
    flows: (catalog.flows || []).length,
    byStatus: Object.fromEntries(
      [...new Set(catalog.statusValues || [])].map((status) => [status, pages.filter((page) => page.status === status).length])
    )
  };
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const catalog = loadCatalog();
  const errors = [...validateCatalog(catalog), ...validateInventories(catalog)];
  let topology;
  try {
    topology = loadTopology();
  } catch (error) {
    errors.push(`Topologia obbligatoria non leggibile: ${error.message}.`);
  }
  if (topology) errors.push(...validateTopology(catalog, topology));
  if (errors.length) {
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify({ ok: true, ...catalogSummary(catalog) }, null, 2));
  }
}
