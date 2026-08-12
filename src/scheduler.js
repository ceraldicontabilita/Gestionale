import {
  acquireJobLease,
  finishJobRun,
  getCheckpoint,
  releaseJobLease,
  saveCheckpoint,
  startJobRun
} from './jobs.js';
import { SCHEDULE_POLICY, isDue, policyFor } from './schedule-policy.js';

export function createScheduler({ db, handlers = {}, logger = console, instanceId = `instance-${process.pid}` }) {
  if (!db) throw new Error('Database richiesto per lo scheduler');
  let timer = null;
  let stopped = false;

  async function runJob(jobName, { force = false, now = new Date() } = {}) {
    const handler = handlers[jobName];
    if (typeof handler !== 'function') return { skipped: true, reason: 'HANDLER_NON_CONFIGURATO' };
    const policy = policyFor(jobName);
    if (policy.automaticRemoteFetch === false && !force) return { skipped: true, reason: 'AUTOMAZIONE_REMOTA_DISABILITATA' };

    const checkpoint = await getCheckpoint(db, jobName);
    const lastSuccessfulAt = checkpoint?.value?.lastSuccessfulAt || null;
    if (!force && !isDue(lastSuccessfulAt, now, policy.everyMinutes)) {
      return { skipped: true, reason: 'NON_ANCORA_DOVUTO' };
    }

    const lease = await acquireJobLease(db, jobName, {
      owner: `${instanceId}:${jobName}`,
      now,
      leaseMs: Number(policy.leaseMinutes || 15) * 60 * 1000
    });
    if (!lease) return { skipped: true, reason: 'JOB_GIA_IN_ESECUZIONE' };

    const run = await startJobRun(db, jobName, { instanceId, forced: force }, { now });
    try {
      const result = await handler({
        db,
        jobName,
        checkpoint: checkpoint?.value || null,
        policy,
        now
      });
      const endedAt = new Date();
      await finishJobRun(db, run._id, {
        status: 'SUCCESS',
        counts: result?.counts || {},
        errors: result?.errors || [],
        metadata: { instanceId, ...(result?.metadata || {}) }
      }, { now: endedAt });
      await saveCheckpoint(db, jobName, {
        ...(checkpoint?.value || {}),
        ...(result?.checkpoint || {}),
        lastSuccessfulAt: endedAt
      }, { now: endedAt });
      return { ok: true, runId: run._id, result };
    } catch (error) {
      const endedAt = new Date();
      await finishJobRun(db, run._id, {
        status: 'ERROR',
        counts: { errors: 1 },
        errors: [{ code: error.code || 'JOB_ERROR', message: error.message }],
        metadata: { instanceId }
      }, { now: endedAt });
      logger.error?.(`[scheduler:${jobName}]`, error);
      return { ok: false, runId: run._id, error: error.message };
    } finally {
      await releaseJobLease(db, lease);
    }
  }

  async function tick(now = new Date()) {
    if (stopped) return [];
    const jobs = Object.keys(SCHEDULE_POLICY).filter((job) => typeof handlers[job] === 'function');
    return Promise.all(jobs.map((job) => runJob(job, { now })));
  }

  function start({ tickEveryMs = 60_000, runImmediately = true } = {}) {
    if (timer) return;
    stopped = false;
    if (runImmediately) tick().catch((error) => logger.error?.('[scheduler:tick]', error));
    timer = setInterval(() => {
      tick().catch((error) => logger.error?.('[scheduler:tick]', error));
    }, tickEveryMs);
    timer.unref?.();
  }

  function stop() {
    stopped = true;
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { start, stop, tick, runJob };
}
