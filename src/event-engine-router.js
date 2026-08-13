import {
  changeAccountingPeriod,
  dispatchPendingEvents,
  ensureEventEngineIndexes,
  publishDomainEvent,
  registerPostingRule,
  requeueOutboxEvent
} from './event-engine.js';

function context(getClient, getDb, res) {
  const client = getClient?.();
  const db = getDb?.();
  if (!client || !db) {
    res.status(503).json({ error: 'MongoDB transazionale non configurato' });
    return null;
  }
  return { client, db };
}

function limit(value, fallback = 100) {
  const parsed = Number(value || fallback);
  return Math.max(1, Math.min(500, Number.isInteger(parsed) ? parsed : fallback));
}

export function registerEventEngineRoutes(app, { getClient, getDb }) {
  app.post('/api/event-engine/accounting-periods', async (req, res) => {
    try {
      const current = context(getClient, getDb, res); if (!current) return;
      const output = await changeAccountingPeriod(current, req.body, {
        actor: String(req.auth?.sessionId || 'SYSTEM')
      });
      res.status(output.version === 1 ? 201 : 200).json({ ok: true, ...output });
    } catch (error) {
      const status = /ALREADY_EXISTS|NOT_OPEN|NOT_CLOSED/.test(error.message) ? 409 : /NOT_FOUND/.test(error.message) ? 404 : 400;
      res.status(status).json({ error: error.message });
    }
  });

  app.post('/api/event-engine/posting-rules', async (req, res) => {
    try {
      const current = context(getClient, getDb, res); if (!current) return;
      const actor = String(req.auth?.sessionId || 'SYSTEM');
      const output = await registerPostingRule(current, req.body, { actor });
      res.status(output.duplicate ? 200 : 201).json({
        ok: true,
        duplicate: output.duplicate,
        ruleId: output.rule.ruleId,
        version: output.rule.version,
        status: output.rule.status
      });
    } catch (error) {
      res.status(/CONFLICT/.test(error.message) ? 409 : 400).json({ error: error.message });
    }
  });

  app.post('/api/event-engine/events', async (req, res) => {
    try {
      const current = context(getClient, getDb, res); if (!current) return;
      const output = await publishDomainEvent(current, {
        ...req.body,
        provenance: { ...req.body?.provenance, actor: String(req.auth?.sessionId || 'SYSTEM') }
      });
      res.status(output.duplicate ? 200 : 202).json({
        ok: true,
        duplicate: output.duplicate,
        eventKey: output.event.eventKey,
        status: output.event.status
      });
    } catch (error) {
      const conflict = /CONFLICT/.test(error.message);
      res.status(conflict ? 409 : 400).json({ error: error.message });
    }
  });

  app.post('/api/event-engine/dispatch', async (req, res) => {
    try {
      const current = context(getClient, getDb, res); if (!current) return;
      const results = await dispatchPendingEvents(current, { limit: limit(req.body?.limit, 50) });
      res.json({ ok: true, processed: results.length, results });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/event-engine/events/:eventKey/requeue', async (req, res) => {
    try {
      const current = context(getClient, getDb, res); if (!current) return;
      const output = await requeueOutboxEvent(current, req.params.eventKey, {
        actor: String(req.auth?.sessionId || 'SYSTEM'),
        reason: req.body?.reason
      });
      res.json({ ok: true, ...output });
    } catch (error) {
      const status = /NOT_FOUND/.test(error.message) ? 404 : /NOT_REQUEUEABLE/.test(error.message) ? 409 : 400;
      res.status(status).json({ error: error.message });
    }
  });

  app.get('/api/event-engine/status', async (req, res) => {
    try {
      const db = getDb?.();
      if (!db) return res.status(503).json({ error: 'MongoDB non configurato' });
      await ensureEventEngineIndexes(db);
      const [outbox, events, entries, deadLetters] = await Promise.all([
        db.collection('event_outbox').aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]).toArray(),
        db.collection('domain_events').countDocuments(),
        db.collection('accounting_entries').countDocuments(),
        db.collection('event_outbox').find({ status: 'DEAD_LETTER' }).sort({ updatedAt: -1 }).limit(20).toArray()
      ]);
      res.set('Cache-Control', 'no-store');
      res.json({
        mode: 'AUDITABLE_EVENT_ENGINE',
        events,
        accountingEntries: entries,
        outbox: Object.fromEntries(outbox.map((row) => [row._id, row.count])),
        deadLetters
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/event-engine/accounting-entries', async (req, res) => {
    try {
      const db = getDb?.();
      if (!db) return res.status(503).json({ error: 'MongoDB non configurato' });
      const filter = {};
      if (req.query.entryKind) filter.entryKind = String(req.query.entryKind).trim().toUpperCase();
      if (req.query.sourceId) filter['source.id'] = String(req.query.sourceId).trim();
      const rows = await db.collection('accounting_entries').find(filter)
        .sort({ 'dates.registrationDate': -1, createdAt: -1 }).limit(limit(req.query.limit)).toArray();
      res.set('Cache-Control', 'no-store');
      res.json(rows);
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.get('/api/event-engine/accounting-balances', async (req, res) => {
    try {
      const db = getDb?.();
      if (!db) return res.status(503).json({ error: 'MongoDB non configurato' });
      const filter = {};
      if (req.query.year) {
        const year = Number(req.query.year);
        if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new Error('Anno non valido');
        filter.year = year;
      }
      if (req.query.accountCode) filter.accountCode = String(req.query.accountCode).trim().toUpperCase();
      const rows = await db.collection('accounting_balances').find(filter)
        .sort({ year: -1, accountCode: 1 }).limit(limit(req.query.limit, 500)).toArray();
      res.set('Cache-Control', 'no-store');
      res.json(rows.map((row) => ({
        ...row,
        debit: Number(row.debitCents || 0) / 100,
        credit: Number(row.creditCents || 0) / 100,
        balance: Number(row.balanceCents || 0) / 100
      })));
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });
}
