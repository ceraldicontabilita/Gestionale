import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { CONTI } from '../src/domain.js';
import { registerCoreRoutes } from '../src/core-router.js';

function createDashboardDb() {
  const riporti = new Map();
  const countCalls = [];
  const movementTotals = new Map(CONTI.map((conto, index) => [conto, (index + 1) * 10]));
  const counts = new Map([
    ['movimenti', 2],
    ['documenti', 3],
    ['f24_operazioni', 4],
    ['f24_righe', 5],
    ['atti_riscossione', 6],
    ['obligations', 9]
  ]);

  function riportoCollection() {
    return {
      createIndex: async () => undefined,
      findOne: async (filter) => {
        if (typeof filter.anno === 'object') return null;
        return riporti.get(`${filter.conto}:${filter.anno}`) || null;
      },
      updateOne: async (filter, update) => {
        const key = `${filter.conto}:${filter.anno}`;
        if (!riporti.has(key)) riporti.set(key, { ...update.$setOnInsert });
        return { acknowledged: true };
      }
    };
  }

  const db = {
    collection(name) {
      if (name === 'riporti') return riportoCollection();
      return {
        createIndex: async () => undefined,
        aggregate: (pipeline) => ({
          toArray: async () => [{
            total: pipeline[0].$match.data?.$gte
              ? movementTotals.get(pipeline[0].$match.conto) || 0
              : 0
          }]
        }),
        countDocuments: async (filter) => {
          countCalls.push({ name, filter });
          if (name === 'atti_riscossione' && filter?.$or) return 7;
          if (name === 'obligations' && !filter?.dueDate) return 8;
          return counts.get(name) || 0;
        }
      };
    }
  };
  return { db, countCalls };
}

test('il quadro operativo espone saldi separati e contatori aperti verificati', async () => {
  const routes = new Map();
  const app = {
    get(path, handler) { routes.set(`GET ${path}`, handler); },
    post() {},
    put() {}
  };
  const { db, countCalls } = createDashboardDb();
  registerCoreRoutes(app, { getDb: () => db });

  let payload;
  const response = {
    status() { return this; },
    json(value) { payload = value; }
  };
  await routes.get('GET /api/dashboard')({ query: { anno: '2026' } }, response);

  assert.equal(payload.anno, 2026);
  assert.deepEqual(Object.keys(payload.saldi), CONTI);
  CONTI.forEach((conto, index) => {
    assert.deepEqual(payload.saldi[conto], {
      saldo: (index + 1) * 10,
      riporto: 0,
      daRiallineare: false
    });
  });
  assert.deepEqual({
    daVerificare: payload.daVerificare,
    documentiDaVerificare: payload.documentiDaVerificare,
    f24DaRiscontrare: payload.f24DaRiscontrare,
    codiciTributoDaVerificare: payload.codiciTributoDaVerificare,
    riscossioneDaVerificare: payload.riscossioneDaVerificare,
    riscossioneSenzaSnapshot: payload.riscossioneSenzaSnapshot,
    partiteAperte: payload.partiteAperte,
    partiteScadute: payload.partiteScadute
  }, {
    daVerificare: 2,
    documentiDaVerificare: 3,
    f24DaRiscontrare: 4,
    codiciTributoDaVerificare: 5,
    riscossioneDaVerificare: 6,
    riscossioneSenzaSnapshot: 7,
    partiteAperte: 8,
    partiteScadute: 9
  });
  assert.deepEqual(countCalls.slice(0, 7), [
    { name: 'movimenti', filter: { stato: 'DA_VERIFICARE' } },
    {
      name: 'documenti',
      filter: {
        stato: 'DA_VERIFICARE',
        recordKind: { $ne: 'DRIVE_SOURCE' },
        sourceActive: { $ne: false }
      }
    },
    {
      name: 'f24_operazioni',
      filter: { stato: { $in: ['IN_ATTESA_RISCONTRO', 'DA_VERIFICARE'] } }
    },
    { name: 'f24_righe', filter: { 'classificazione.stato': 'DA_VERIFICARE' } },
    { name: 'atti_riscossione', filter: { stato: 'DA_VERIFICARE' } },
    {
      name: 'atti_riscossione',
      filter: { $or: [{ ultimoSnapshot: { $exists: false } }, { ultimoSnapshot: null }] }
    },
    { name: 'obligations', filter: { sourceEntityType: 'INVOICE_SUPPLIER', status: { $in: ['OPEN', 'PARTIAL'] } } }
  ]);
  assert.equal(countCalls[7].name, 'obligations');
  assert.equal(countCalls[7].filter.sourceEntityType, 'INVOICE_SUPPLIER');
  assert.deepEqual(countCalls[7].filter.status, { $in: ['OPEN', 'PARTIAL'] });
  assert.ok(countCalls[7].filter.dueDate.$lt instanceof Date);
});

test('la Home rende quadro operativo e attività aperte dalla risposta dashboard', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

  assert.match(html, /id=["']dashboardCards["']/);
  assert.match(html, /id=["']todo["']/);
  assert.match(source, /api\(`\/api\/dashboard\?anno=\$\{year\}`\)/);
  assert.match(source, /data\.saldi\[conto\]/);
  assert.match(source, /data\.documentiDaVerificare/);
  assert.match(source, /data\.f24DaRiscontrare/);
  assert.match(source, /data\.riscossioneDaVerificare/);
  assert.match(source, /data\.partiteAperte/);
  assert.match(source, /data\.partiteScadute/);
});
