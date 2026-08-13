import assert from 'node:assert/strict';
import test from 'node:test';

import { registerEventEngineRoutes } from '../src/event-engine-router.js';

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

test('l endpoint amministrativo non può pubblicare eventi validati al posto del dominio', async () => {
  const routes = new Map();
  const app = {
    post(path, handler) { routes.set(`POST ${path}`, handler); },
    get(path, handler) { routes.set(`GET ${path}`, handler); }
  };
  registerEventEngineRoutes(app, { getClient: () => ({}), getDb: () => ({}) });
  const res = response();
  await routes.get('POST /api/event-engine/events')({ body: { type: 'invoice.supplier_validated' }, auth: {} }, res);
  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.body, { error: 'DOMAIN_VALIDATOR_REQUIRED' });
});
