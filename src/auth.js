import crypto from 'node:crypto';

const SESSION_COOKIE = 'impresa_session';
const CSRF_COOKIE = 'impresa_csrf';
const PUBLIC_API_PATHS = new Set(['/api/health', '/api/auth/status', '/api/auth/pin-login']);
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const readyDatabases = new WeakSet();

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function safeEqualText(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

export function verifyAdminPin(pin, env = process.env) {
  const value = String(pin || '');
  const scrypt = String(env.PIN_SCRYPT_ADMIN || '').trim();
  if (scrypt) {
    const [saltHex, expectedHex] = scrypt.split(':');
    if (!/^[a-f0-9]{32,}$/i.test(saltHex || '') || !/^[a-f0-9]{64,}$/i.test(expectedHex || '')) return null;
    const derived = crypto.scryptSync(value, Buffer.from(saltHex, 'hex'), expectedHex.length / 2).toString('hex');
    return safeEqualText(derived, expectedHex.toLowerCase());
  }

  const compatibleSha256 = String(env.PIN_HASH_ADMIN || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(compatibleSha256)) return null;
  return safeEqualText(sha256(value), compatibleSha256);
}

export function authConfigured(env = process.env) {
  return verifyAdminPin('__configuration_probe__', env) !== null;
}

function normalizeBase32(secret) {
  return String(secret || '').toUpperCase().replace(/[\s-]+/g, '').replace(/=+$/g, '');
}

function decodeBase32(secret) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const normalized = normalizeBase32(secret);
  if (normalized.length < 16 || !/^[A-Z2-7]+$/.test(normalized)) throw new Error('Segreto TOTP non valido');
  let bits = '';
  for (const character of normalized) bits += alphabet.indexOf(character).toString(2).padStart(5, '0');
  const bytes = [];
  for (let index = 0; index + 8 <= bits.length; index += 8) bytes.push(Number.parseInt(bits.slice(index, index + 8), 2));
  return Buffer.from(bytes);
}

export function generateTotp(secret, at = new Date(), { stepSeconds = 30, digits = 6 } = {}) {
  const date = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(date.getTime())) throw new Error('Istante TOTP non valido');
  const counter = Math.floor(date.getTime() / 1000 / stepSeconds);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac('sha1', decodeBase32(secret)).update(counterBuffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff);
  return String(binary % (10 ** digits)).padStart(digits, '0');
}

export function verifyTotp(secret, code, at = new Date(), { window = 1, stepSeconds = 30 } = {}) {
  const value = String(code || '').trim();
  if (!/^\d{6}$/.test(value)) return false;
  const date = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(date.getTime())) return false;
  try {
    for (let offset = -Math.max(0, window); offset <= Math.max(0, window); offset += 1) {
      const candidate = generateTotp(secret, new Date(date.getTime() + offset * stepSeconds * 1000), { stepSeconds, digits: 6 });
      if (safeEqualText(candidate, value)) return true;
    }
  } catch {
    return false;
  }
  return false;
}

export function mfaConfigured(env = process.env) {
  try {
    decodeBase32(env.MFA_TOTP_SECRET);
    return true;
  } catch {
    return false;
  }
}

function configFromEnv(env) {
  const sessionMinutes = Math.max(10, Math.min(24 * 60, Number(env.AUTH_SESSION_MINUTES || 60)));
  const mfaMinutes = Math.max(2, Math.min(60, Number(env.MFA_STEPUP_MINUTES || 10)));
  return {
    configured: authConfigured(env),
    mfaConfigured: mfaConfigured(env),
    mfaSecret: String(env.MFA_TOTP_SECRET || ''),
    sessionMs: sessionMinutes * 60 * 1000,
    mfaStepMs: mfaMinutes * 60 * 1000,
    maxAttempts: Math.max(3, Math.min(20, Number(env.AUTH_MAX_ATTEMPTS || 5))),
    maxMfaAttempts: Math.max(3, Math.min(10, Number(env.MFA_MAX_ATTEMPTS || 5))),
    attemptWindowMs: Math.max(60_000, Number(env.AUTH_ATTEMPT_WINDOW_MINUTES || 5) * 60_000),
    lockMs: Math.max(60_000, Number(env.AUTH_LOCK_MINUTES || 5) * 60_000),
    secureCookie: String(env.COOKIE_SECURE || (env.NODE_ENV === 'production' ? 'true' : 'false')).toLowerCase() !== 'false'
  };
}

function cookie(name, value, { maxAge, httpOnly, secure }) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'SameSite=Strict'];
  if (httpOnly) parts.push('HttpOnly');
  if (secure) parts.push('Secure');
  if (maxAge !== undefined) parts.push(`Max-Age=${Math.max(0, Math.floor(maxAge / 1000))}`);
  return parts.join('; ');
}

function appendSessionCookies(res, token, csrf, cfg) {
  res.append('Set-Cookie', cookie(SESSION_COOKIE, token, { maxAge: cfg.sessionMs, httpOnly: true, secure: cfg.secureCookie }));
  res.append('Set-Cookie', cookie(CSRF_COOKIE, csrf, { maxAge: cfg.sessionMs, httpOnly: false, secure: cfg.secureCookie }));
}

function clearSessionCookies(res, cfg) {
  res.append('Set-Cookie', cookie(SESSION_COOKIE, '', { maxAge: 0, httpOnly: true, secure: cfg.secureCookie }));
  res.append('Set-Cookie', cookie(CSRF_COOKIE, '', { maxAge: 0, httpOnly: false, secure: cfg.secureCookie }));
}

function requestIpKey(req) {
  return sha256(req.ip || req.socket?.remoteAddress || 'unknown');
}

function userAgentHash(req) {
  return sha256(req.get('user-agent') || 'unknown');
}

async function ensureIndexes(db) {
  if (readyDatabases.has(db)) return;
  await Promise.all([
    db.collection('auth_sessions').createIndex({ tokenHash: 1 }, { unique: true }),
    db.collection('auth_sessions').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    db.collection('auth_attempts').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    db.collection('audit_log').createIndex({ creatoIl: -1 })
  ]);
  readyDatabases.add(db);
}

async function attemptState(db, ipKey) {
  return db.collection('auth_attempts').findOne({ _id: ipKey });
}

async function registerFailure(db, ipKey, cfg, now) {
  const current = await attemptState(db, ipKey);
  const activeWindow = current?.windowStart && new Date(current.windowStart).getTime() > now.getTime() - cfg.attemptWindowMs;
  const failures = activeWindow ? Number(current.failures || 0) + 1 : 1;
  const lockedUntil = failures >= cfg.maxAttempts ? new Date(now.getTime() + cfg.lockMs) : null;
  await db.collection('auth_attempts').updateOne(
    { _id: ipKey },
    {
      $set: {
        failures,
        windowStart: activeWindow ? current.windowStart : now,
        lockedUntil,
        lastAttemptAt: now,
        expiresAt: new Date(now.getTime() + Math.max(cfg.attemptWindowMs, cfg.lockMs) * 2)
      }
    },
    { upsert: true }
  );
  return { failures, lockedUntil };
}

function bearerToken(req) {
  const header = req.get('authorization') || '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : null;
}

async function resolveSession(db, req, cfg, { touch = false } = {}) {
  const cookies = parseCookies(req.get('cookie'));
  const bearer = bearerToken(req);
  const rawToken = bearer || cookies[SESSION_COOKIE];
  if (!rawToken || !/^[A-Za-z0-9_-]{40,200}$/.test(rawToken)) return null;
  const now = new Date();
  const session = await db.collection('auth_sessions').findOne({
    tokenHash: sha256(rawToken),
    revokedAt: null,
    expiresAt: { $gt: now }
  });
  if (!session || (session.userAgentHash && !safeEqualText(session.userAgentHash, userAgentHash(req)))) return null;

  if (touch && now.getTime() - new Date(session.lastSeenAt || session.createdAt).getTime() > 5 * 60_000) {
    const expiresAt = new Date(now.getTime() + cfg.sessionMs);
    await db.collection('auth_sessions').updateOne(
      { _id: session._id, expiresAt: { $gt: now }, revokedAt: null },
      { $set: { lastSeenAt: now, expiresAt } }
    );
    session.lastSeenAt = now;
    session.expiresAt = expiresAt;
  }

  return { session, rawToken, source: bearer ? 'BEARER' : 'COOKIE', cookies };
}

function csrfValid(req, auth) {
  if (SAFE_METHODS.has(req.method) || auth.source === 'BEARER') return true;
  const cookieValue = auth.cookies[CSRF_COOKIE];
  const headerValue = req.get('x-csrf-token');
  if (!cookieValue || !headerValue || !safeEqualText(cookieValue, headerValue)) return false;
  if (!safeEqualText(sha256(headerValue), auth.session.csrfHash)) return false;
  const origin = req.get('origin');
  if (!origin) return true;
  try {
    return new URL(origin).host === req.get('host');
  } catch {
    return false;
  }
}

function sensitiveOperation(req) {
  if (SAFE_METHODS.has(req.method)) return false;
  const path = req.originalUrl.split('?')[0];
  return Boolean(
    req.body?.forza === true
    || req.query?.forza === 'true'
    || (req.method === 'PUT' && /^\/api\/riporti\//.test(path))
    || (req.method === 'POST' && path === '/api/tributi')
    || (req.method === 'POST' && path === '/api/drive-data/import')
    || (req.method === 'POST' && path.startsWith('/api/event-engine/'))
    || (req.method === 'POST' && path.startsWith('/api/supplier-invoices/'))
    || /\/riconcilia$/.test(path)
    || /\/collega-movimento$/.test(path)
    || /\/snapshot$/.test(path)
  );
}

function mfaVerified(session, cfg, now = new Date()) {
  if (!session?.mfaVerifiedAt) return false;
  return now.getTime() - new Date(session.mfaVerifiedAt).getTime() <= cfg.mfaStepMs;
}

function logAudit(db, entry) {
  db.collection('audit_log').insertOne({ ...entry, creatoIl: new Date() }).catch(() => {});
}

export function registerAuthentication(app, { getDb, env = process.env }) {
  const cfg = configFromEnv(env);

  app.get('/api/auth/status', async (req, res) => {
    const db = getDb();
    if (!db) return res.status(503).json({ error: 'MongoDB non configurato', configured: cfg.configured, authenticated: false, mfaConfigured: cfg.mfaConfigured });
    await ensureIndexes(db);
    const auth = cfg.configured ? await resolveSession(db, req, cfg, { touch: true }) : null;
    const verified = Boolean(auth && mfaVerified(auth.session, cfg));
    res.json({
      configured: cfg.configured,
      authenticated: Boolean(auth),
      role: auth?.session?.role || null,
      mfaConfigured: cfg.mfaConfigured,
      mfaVerified: verified,
      mfaVerifiedUntil: verified ? new Date(new Date(auth.session.mfaVerifiedAt).getTime() + cfg.mfaStepMs) : null
    });
  });

  app.post('/api/auth/pin-login', async (req, res) => {
    const db = getDb();
    if (!db) return res.status(503).json({ error: 'MongoDB non configurato' });
    await ensureIndexes(db);
    if (!cfg.configured) return res.status(503).json({ error: 'Accesso PIN non configurato' });
    const now = new Date();
    const ipKey = requestIpKey(req);
    const current = await attemptState(db, ipKey);
    if (current?.lockedUntil && new Date(current.lockedUntil) > now) {
      const seconds = Math.ceil((new Date(current.lockedUntil).getTime() - now.getTime()) / 1000);
      return res.status(429).json({ error: `Troppi tentativi. Riprova tra ${seconds} secondi` });
    }

    const pin = String(req.body?.pin || '').trim();
    if (!/^\d{4,12}$/.test(pin) || verifyAdminPin(pin, env) !== true) {
      const failure = await registerFailure(db, ipKey, cfg, now);
      logAudit(db, { tipo: 'LOGIN_FALLITO', ipKey, dettaglio: 'PIN non valido' });
      if (failure.lockedUntil) return res.status(429).json({ error: 'Troppi tentativi. Accesso temporaneamente bloccato' });
      return res.status(401).json({ error: 'PIN non valido' });
    }

    await db.collection('auth_attempts').deleteOne({ _id: ipKey });
    const token = crypto.randomBytes(48).toString('base64url');
    const csrf = crypto.randomBytes(32).toString('base64url');
    const expiresAt = new Date(now.getTime() + cfg.sessionMs);
    const session = {
      tokenHash: sha256(token),
      csrfHash: sha256(csrf),
      role: 'ADMIN',
      ipKey,
      userAgentHash: userAgentHash(req),
      createdAt: now,
      lastSeenAt: now,
      expiresAt,
      revokedAt: null,
      mfaVerifiedAt: null,
      mfaFailures: 0
    };
    const result = await db.collection('auth_sessions').insertOne(session);
    appendSessionCookies(res, token, csrf, cfg);
    logAudit(db, { tipo: 'LOGIN_OK', sessionId: result.insertedId, ipKey });
    res.json({ ok: true, authenticated: true, role: 'ADMIN', expiresAt, mfaConfigured: cfg.mfaConfigured });
  });

  app.post('/api/auth/mfa', async (req, res) => {
    const db = getDb();
    if (!db) return res.status(503).json({ error: 'MongoDB non configurato' });
    await ensureIndexes(db);
    if (!cfg.mfaConfigured) return res.status(503).json({ error: 'MFA TOTP non configurato', code: 'MFA_NOT_CONFIGURED' });
    const auth = await resolveSession(db, req, cfg, { touch: true });
    if (!auth) return res.status(401).json({ error: 'Autenticazione richiesta' });
    if (!csrfValid(req, auth)) return res.status(403).json({ error: 'Verifica CSRF non valida' });
    const now = new Date();
    if (!verifyTotp(cfg.mfaSecret, req.body?.code, now)) {
      const failures = Number(auth.session.mfaFailures || 0) + 1;
      const revoke = failures >= cfg.maxMfaAttempts;
      await db.collection('auth_sessions').updateOne(
        { _id: auth.session._id },
        { $set: { mfaFailures: failures, ...(revoke ? { revokedAt: now } : {}) } }
      );
      logAudit(db, { tipo: 'MFA_FALLITO', sessionId: auth.session._id, ipKey: auth.session.ipKey, failures });
      if (revoke) {
        clearSessionCookies(res, cfg);
        return res.status(401).json({ error: 'Troppi codici MFA errati. Sessione revocata' });
      }
      return res.status(401).json({ error: 'Codice MFA non valido' });
    }
    await db.collection('auth_sessions').updateOne(
      { _id: auth.session._id, revokedAt: null },
      { $set: { mfaVerifiedAt: now, mfaFailures: 0 } }
    );
    logAudit(db, { tipo: 'MFA_OK', sessionId: auth.session._id, ipKey: auth.session.ipKey });
    res.json({ ok: true, mfaVerifiedUntil: new Date(now.getTime() + cfg.mfaStepMs) });
  });

  app.post('/api/auth/logout', async (req, res) => {
    const db = getDb();
    if (db) {
      await ensureIndexes(db);
      const auth = await resolveSession(db, req, cfg);
      if (auth) {
        if (!csrfValid(req, auth)) return res.status(403).json({ error: 'Verifica CSRF non valida' });
        await db.collection('auth_sessions').updateOne({ _id: auth.session._id }, { $set: { revokedAt: new Date() } });
        logAudit(db, { tipo: 'LOGOUT', sessionId: auth.session._id, ipKey: auth.session.ipKey });
      }
    }
    clearSessionCookies(res, cfg);
    res.json({ ok: true });
  });

  app.use('/api', async (req, res, next) => {
    try {
      if (PUBLIC_API_PATHS.has(req.path.startsWith('/api/') ? req.path : `/api${req.path}`)) return next();
      const db = getDb();
      if (!db) return res.status(503).json({ error: 'MongoDB non configurato' });
      await ensureIndexes(db);
      if (!cfg.configured) return res.status(503).json({ error: 'Accesso PIN non configurato: API bloccate in modalità fail-safe' });
      const auth = await resolveSession(db, req, cfg, { touch: true });
      if (!auth) return res.status(401).json({ error: 'Autenticazione richiesta' });
      if (!csrfValid(req, auth)) return res.status(403).json({ error: 'Verifica CSRF non valida' });
      if (sensitiveOperation(req)) {
        if (!cfg.mfaConfigured) return res.status(503).json({ error: 'MFA TOTP non configurato: operazione sensibile bloccata', code: 'MFA_NOT_CONFIGURED' });
        if (!mfaVerified(auth.session, cfg)) return res.status(428).json({ error: 'Conferma MFA richiesta', code: 'MFA_REQUIRED' });
      }
      req.auth = { sessionId: auth.session._id, role: auth.session.role, mfaVerifiedAt: auth.session.mfaVerifiedAt };
      if (!SAFE_METHODS.has(req.method)) {
        res.on('finish', () => logAudit(db, {
          tipo: 'SCRITTURA_API',
          sessionId: auth.session._id,
          ipKey: auth.session.ipKey,
          metodo: req.method,
          percorso: req.originalUrl.split('?')[0],
          esitoHttp: res.statusCode,
          mfa: sensitiveOperation(req)
        }));
      }
      next();
    } catch {
      res.status(500).json({ error: 'Verifica sessione non disponibile' });
    }
  });
}
