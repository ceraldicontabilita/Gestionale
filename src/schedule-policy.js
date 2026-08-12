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

function localParts(value, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(new Date(value));
  const read = (type) => parts.find((part) => part.type === type)?.value;
  return {
    dateKey: `${read('year')}-${read('month')}-${read('day')}`,
    hour: Number(read('hour'))
  };
}

export function isPolicyDue(lastRunAt, now, policy, { timeZone = 'Europe/Rome' } = {}) {
  const current = now instanceof Date ? now : new Date(now || Date.now());
  if (policy?.localHour !== undefined && policy?.localHour !== null) {
    const currentLocal = localParts(current, timeZone);
    if (currentLocal.hour < Number(policy.localHour)) return false;
    if (!lastRunAt) return true;
    const lastLocal = localParts(lastRunAt, timeZone);
    return lastLocal.dateKey !== currentLocal.dateKey;
  }
  return isDue(lastRunAt, current, policy?.everyMinutes);
}

export function overlapStart(lastSuccessfulAt, jobName) {
  if (!lastSuccessfulAt) return null;
  const policy = policyFor(jobName);
  const overlapMinutes = Number(policy.overlapMinutes || 0);
  const last = new Date(lastSuccessfulAt);
  if (Number.isNaN(last.getTime())) return null;
  return new Date(last.getTime() - overlapMinutes * 60 * 1000);
}
