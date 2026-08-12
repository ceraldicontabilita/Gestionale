import crypto from 'node:crypto';
import {
  acquireJobLease,
  finishJobRun,
  getCheckpoint,
  releaseJobLease,
  renewJobLease,
  saveCheckpoint,
  startJobRun
} from './jobs.js';
import { SCHEDULE_POLICY, isDue, isPolicyDue, policyFor } from './schedule-policy.js';

export function createScheduler({ db, handlers = {}, logger = console, instanceId = `instance-${process.pid}`, timeZone = 'Europe/Rome' }) {
  if (!db) throw new Error('Database richiesto per lo scheduler');
  let timer = null;
  let stopped = false;

  async function runJob(jobName, { force = false, now = new Date() } = {}) {
    const handler = handlers[jobName];
    if (typeof handler !== 'function') return { skipped: true, reason: 'HANDLER_NON_CONFIGURATO' };
    const policy = policyFor(jobName);
    if (policy.automaticRemoteFetch === false && !force) return { skipped: true, reason: 'AUTOMAZIONE_REMOTA_DISABILITATA' };

    const checkpoint = await getCheckpoint(db, jobName);
    const state = checkpoint?.value || {};
    const failedRecently = state.lastStatus === 'ERROR' && state.lastAttemptAt;
    const due = failedRecently
      ? isDue(state.lastAttemptAt, now, Number(policy.retryTechnicalMinutes || policy.everyMinutes || 30))
      : isPolicyDue(state.lastSuccessfulAt || null, now, policy, { timeZone });
    if (!force && !due) return { skipped: true, reason: 'NON_ANCORA_DOVUTO' };

    const leaseMs = Number(policy.leaseMinutes || 15) * 60 * 1000;
    const lease = await acquireJobLease(db, jobName, {
      owner: `${instanceId}:${jobName}:${crypto.randomUUID()}`,
      now,
      leaseMs
    });
    if (!lease) return { skipped: true, reason: 'JOB_GIA_IN_ESECUZIONE' };

    let leaseLost = false;
    const heartbeat = setInterval(() => {
      renewJobLease(db, lease).then((ok) => { if (!ok) leaseLost = true; }).catch(() => { leaseLost = true; });
    }, Math.max(5_000, Math.floor(leaseMs / 3)));
    heartbeat.unref?.();

    const run = await startJobRun(db, jobName, { instanceId, forced: force, timeZone }, { now });
    const attemptAt = new Date();
    try {
      const result = await handler({ db, jobName, checkpoint: state, policy, now });
      if (leaseLost) throw Object.assign(new Error('Lease del job persa durante l’esecuzione'), { code: 'JOB_LEASE_LOST' });
      if (Array.isArray(result?.errors) && result.errors.length > 0) {
        const error = Object.assign(new Error(`Job parziale: ${result.errors.length} errori tecnici`), {
          code: 'PARTIAL_JOB_FAILURE',
          details: result.errors
        });
        throw error;
      }

      const endedAt = new Date();
      await finishJobRun(db, run._id, {
        status: 'SUCCESS',
        counts: result?.counts || {},
        errors: [],
        metadata: { instanceId, timeZone, ...(result?.metadata || {}) }
      }, { now: endedAt });
      await saveCheckpoint(db, jobName, {
        ...state,
        ...(result?.checkpoint || {}),
        lastAttemptAt: attemptAt,
        lastSuccessfulAt: endedAt,
        lastStatus: 'SUCCESS',
        lastError: null
      }, { now: endedAt });
      return { ok: true, runId: run._id, result };
    } catch (error) {
      const endedAt = new Date();
      const errors = error.details || [{ code: error.code || 'JOB_ERROR', message: error.message }];
      await finishJobRun(db, run._id, {
        status: 'ERROR',
        counts: { errors: Math.max(1, errors.length) },
        errors,
        metadata: { instanceId, timeZone }
      }, { now: endedAt });
      await saveCheckpoint(db, jobName, {
        ...state,
        lastAttemptAt: attemptAt,
        lastStatus: 'ERROR',
        lastError: { code: error.code || 'JOB_ERROR', message: error.message, at: endedAt }
      }, { now: endedAt });
      logger.error?.(`[scheduler:${jobName}]`, error);
      return { ok: false, runId: run._id, error: error.message };
    } finally {
      clearInterval(heartbeat);
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
    timer = setInterval(() => tick().catch((error) => logger.error?.('[scheduler:tick]', error)), tickEveryMs);
    timer.unref?.();
  }

  function stop() {
    stopped = true;
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { start, stop, tick, runJob };
}
