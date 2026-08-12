export const SCHEDULE_POLICY = Object.freeze({
  EMAIL_PEC_SCAN: {
    everyMinutes: 30,
    overlapMinutes: 72 * 60,
    leaseMinutes: 20,
    retryTechnicalMinutes: 30
  },
  DRIVE_FISCALE_SCAN: {
    everyMinutes: 60,
    overlapMinutes: 72 * 60,
    leaseMinutes: 30,
    retryTechnicalMinutes: 60
  },
  DOCUMENTI_RIPROCESSA: {
    everyMinutes: 120,
    overlapMinutes: 0,
    leaseMinutes: 45,
    retryTechnicalMinutes: 120
  },
  SCADENZE_FISCALI: {
    everyMinutes: 24 * 60,
    overlapMinutes: 0,
    leaseMinutes: 30,
    localHour: 3
  },
  CODICI_TRIBUTO_REFRESH: {
    everyMinutes: 24 * 60,
    overlapMinutes: 0,
    leaseMinutes: 30,
    localHour: 4
  },
  ADER_SNAPSHOT_IMPORT: {
    automaticRemoteFetch: false,
    reason: 'Lo snapshot viene acquisito da una fonte supportata o da un documento importato; non si automatizza uno scraping fragile dell’area riservata.'
  }
});

export function policyFor(jobName) {
  const name = String(jobName || '').toUpperCase();
  const policy = SCHEDULE_POLICY[name];
  if (!policy) throw new Error('Policy scheduler non definita');
  return policy;
}

export function isDue(lastRunAt, now, everyMinutes) {
  if (!lastRunAt) return true;
  const last = new Date(lastRunAt);
  const current = now instanceof Date ? now : new Date(now || Date.now());
  if (Number.isNaN(last.getTime()) || Number.isNaN(current.getTime())) return true;
  return current.getTime() - last.getTime() >= Number(everyMinutes) * 60 * 1000;
}

export function overlapStart(lastSuccessfulAt, jobName) {
  if (!lastSuccessfulAt) return null;
  const policy = policyFor(jobName);
  const overlapMinutes = Number(policy.overlapMinutes || 0);
  const last = new Date(lastSuccessfulAt);
  if (Number.isNaN(last.getTime())) return null;
  return new Date(last.getTime() - overlapMinutes * 60 * 1000);
}
