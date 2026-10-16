import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { config } from './config.js';
import { all, audit, one, run } from './db.js';
import { clientIp, id, normalizeEmail, now, timingSafeEqual } from './lib/util.js';

const scrypt = promisify(crypto.scrypt);

const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 64 };
export const SESSION_COOKIE = 'blue_session';

/* ------------------------------------------------------------------ */
/* passwords                                                           */
/* ------------------------------------------------------------------ */

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = await scrypt(String(password), salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: 128 * SCRYPT.N * SCRYPT.r * 2,
  });
  return [
    'scrypt',
    SCRYPT.N,
    SCRYPT.r,
    SCRYPT.p,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

export async function verifyPassword(password, stored) {
  try {
    const [scheme, N, r, p, saltB64, hashB64] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const derived = await scrypt(String(password), salt, expected.length, {
      N: Number(N),
      r: Number(r),
      p: Number(p),
      maxmem: 128 * Number(N) * Number(r) * 2,
    });
    return crypto.timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

export function passwordProblem(password) {
  const pw = String(password || '');
  if (pw.length < 8) return 'Password must be at least 8 characters.';
  if (pw.length > 200) return 'Password is too long (200 characters max).';
  if (!/[A-Za-z]/.test(pw) || !/[0-9!@#$%^&*_\-+=?.,:;(){}[\]/\\|<>~`"']/.test(pw)) {
    return 'Password must contain at least one letter and one number or symbol.';
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* tokens & sessions                                                   */
/* ------------------------------------------------------------------ */

const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

export function newSessionToken() {
  const sessionId = id('sess');
  const secret = crypto.randomBytes(32).toString('base64url');
  return { sessionId, token: `${sessionId}.${secret}` };
}

export function createSession({ userId, token, userAgent = '', ip = '' }) {
  const ts = now();
  const expires = new Date(Date.now() + config.sessionTtlHours * 3600 * 1000).toISOString();
  const sessionId = token.split('.')[0];
  run(
    `INSERT INTO sessions (id, user_id, token_hash, user_agent, ip, created_at, last_seen_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    sessionId,
    userId,
    sha256(token),
    String(userAgent).slice(0, 250),
    ip,
    ts,
    ts,
    expires,
  );
  return one('SELECT * FROM sessions WHERE id = ?', sessionId);
}

export function findSessionByToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const hash = sha256(token);
  const row = one('SELECT * FROM sessions WHERE token_hash = ?', hash);
  if (!row) return null;
  if (row.revoked_at) return { ...row, reason: 'revoked' };
  if (new Date(row.expires_at).getTime() < Date.now()) {
    run('UPDATE sessions SET revoked_at = ? WHERE id = ?', now(), row.id);
    return { ...row, reason: 'expired' };
  }
  // Guard against a forged session id + hash collision attempt.
  if (!timingSafeEqual(row.token_hash, hash)) return null;
  return row;
}

export function touchSession(sessionId) {
  run('UPDATE sessions SET last_seen_at = ? WHERE id = ?', now(), sessionId);
}

export function listSessions(userId) {
  return all(
    `SELECT id, user_agent, ip, created_at, last_seen_at, expires_at, revoked_at
     FROM sessions WHERE user_id = ? ORDER BY last_seen_at DESC LIMIT 100`,
    userId,
  );
}

export function revokeSession(userId, sessionId) {
  run('UPDATE sessions SET revoked_at = ? WHERE id = ? AND user_id = ?', now(), sessionId, userId);
}

export function revokeAllSessions(userId, exceptId = null) {
  if (exceptId) {
    run('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND id != ? AND revoked_at IS NULL', now(), userId, exceptId);
  } else {
    run('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', now(), userId);
  }
}

export function pruneExpiredSessions() {
  run(
    `UPDATE sessions SET revoked_at = ? WHERE revoked_at IS NULL AND expires_at < ?`,
    now(),
    now(),
  );
}

/* ------------------------------------------------------------------ */
/* API keys (machine credentials)                                      */
/* ------------------------------------------------------------------ */

export function createApiKey(userId, label = 'API key', scopes = ['chat']) {
  const prefix = crypto.randomBytes(4).toString('hex');
  const secret = crypto.randomBytes(24).toString('base64url');
  const plaintext = `blue_sk_${prefix}_${secret}`;
  const keyId = id('key');
  run(
    `INSERT INTO credentials (id, user_id, kind, label, prefix, secret_hash, scopes, created_at)
     VALUES (?, ?, 'api_key', ?, ?, ?, ?, ?)`,
    keyId,
    userId,
    String(label).slice(0, 80) || 'API key',
    prefix,
    sha256(secret),
    JSON.stringify(scopes),
    now(),
  );
  return { id: keyId, plaintext, prefix, label };
}

export function listApiKeys(userId) {
  return all(
    `SELECT id, label, prefix, scopes, last_used_at, expires_at, revoked_at, created_at
     FROM credentials WHERE user_id = ? AND kind = 'api_key' ORDER BY created_at DESC`,
    userId,
  );
}

export function revokeApiKey(userId, keyId) {
  run(`UPDATE credentials SET revoked_at = ? WHERE id = ? AND user_id = ? AND kind = 'api_key'`, now(), keyId, userId);
  return one('SELECT * FROM credentials WHERE id = ? AND user_id = ?', keyId, userId);
}

export function userFromApiKey(bearer) {
  const m = /^blue_sk_([0-9a-f]{8})_([A-Za-z0-9_-]+)$/.exec(String(bearer || '').trim());
  if (!m) return null;
  const [, prefix, secret] = m;
  const row = one(`SELECT * FROM credentials WHERE kind = 'api_key' AND prefix = ?`, prefix);
  if (!row || row.revoked_at) return null;
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) return null;
  if (!timingSafeEqual(row.secret_hash, sha256(secret))) return null;
  run('UPDATE credentials SET last_used_at = ? WHERE id = ?', now(), row.id);
  const user = one('SELECT * FROM users WHERE id = ?', row.user_id);
  if (!user) return null;
  return { user, credential: row };
}

/* ------------------------------------------------------------------ */
/* request middlewares                                                 */
/* ------------------------------------------------------------------ */

export function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

/**
 * Does this request arrive over HTTPS? Behind a reverse proxy that is what
 * `x-forwarded-proto` says; otherwise Express knows from the socket.
 */
export function isSecureRequest(req) {
  const proto = req?.headers?.['x-forwarded-proto'];
  if (typeof proto === 'string' && proto.split(',')[0].trim() === 'https') return true;
  return Boolean(req?.secure);
}

/**
 * The cookie attributes that depend on how the request arrived.
 *
 * One builder for every cookie writer, deliberately. The session cookie, the
 * CSRF cookie and both clearing cookies have to agree on `Secure`/`SameSite`,
 * and spelling them out separately is exactly how the CSRF cookie once ended
 * up without `Secure` while the session cookie had it.
 */
function cookieAttrs({ sameSite = 'Lax', secure = false, partitioned = false, maxAgeSeconds } = {}) {
  const attrs = ['Path=/', `SameSite=${sameSite}`];
  if (maxAgeSeconds !== undefined) attrs.push(`Max-Age=${maxAgeSeconds}`);
  if (secure) attrs.push('Secure');
  if (partitioned) attrs.push('Partitioned');
  return attrs.join('; ');
}

/**
 * How the session and CSRF cookies should be marked for this request.
 *
 * `SameSite=Lax` is the stronger default and what production uses: the app is
 * served same-origin behind Caddy, so nothing legitimate is ever cross-site.
 *
 * It breaks wherever the app is embedded cross-site, though — a preview iframe
 * on another origin — because a Lax cookie is simply *not sent* on those
 * requests. The login POST returns 200, the cookie is stored, and then every
 * following fetch arrives unauthenticated: the app looks like it logs you in
 * and then shows nothing at all. Embedded contexts therefore need
 * `SameSite=None; Secure`, plus `Partitioned` (CHIPS) so the cookies keep
 * working in browsers that block third-party cookies outright.
 *
 * `None` is only valid next to `Secure`, so the implicit rule also downgrades
 * to Lax over plain HTTP rather than handing the browser a cookie it rejects —
 * that keeps local development on a LAN address working. An explicit
 * `BLUE_COOKIE_SAMESITE=none` is honoured as written, since asking for it means
 * the deployment really is cross-site and really is on HTTPS.
 */
export function cookiePolicy(req) {
  const secure = isSecureRequest(req);

  if (config.cookieSameSite) {
    const sameSite = config.cookieSameSite;
    const needsSecure = sameSite === 'none';
    return {
      secure: secure || needsSecure,
      sameSite: sameSite === 'none' ? 'None' : sameSite === 'strict' ? 'Strict' : 'Lax',
      partitioned: needsSecure && config.cookiePartitioned,
    };
  }

  // Implicit: cross-site embedding is the norm off production, HTTPS is what
  // makes `None` legal at all.
  const crossSite = secure && config.env !== 'production';
  return { secure, sameSite: crossSite ? 'None' : 'Lax', partitioned: crossSite && config.cookiePartitioned };
}

export function cookieHeader(
  token,
  { maxAgeSeconds = config.sessionTtlHours * 3600, sameSite, secure = false, partitioned = false } = {},
) {
  const attrs = cookieAttrs({ sameSite, secure, partitioned, maxAgeSeconds });
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; ${attrs}`;
}

/**
 * The CSRF cookie stays readable by JS (that is the point of double-submit) but
 * still needs `Secure` on HTTPS: without it the token can be read off a
 * plaintext request to the same host, which is exactly what a network attacker
 * would need to forge a state-changing call.
 */
export const clearCookieHeader = ({ sameSite, secure = false, partitioned = false } = {}) => {
  const tail = cookieAttrs({ sameSite, secure, partitioned, maxAgeSeconds: 0 });
  return [`${SESSION_COOKIE}=; HttpOnly; ${tail}`, `${CSRF_COOKIE}=; ${tail}`];
};

export const CSRF_COOKIE = 'blue_csrf';

/**
 * Session cookies: an HttpOnly session token plus a readable CSRF token.
 * The browser mirrors the CSRF token into an `x-blue-csrf` header, which a
 * cross-site attacker cannot read or set (it would need CORS permission).
 */
export function sessionCookieHeaders(
  token,
  { maxAgeSeconds = config.sessionTtlHours * 3600, sameSite, secure = false, partitioned = false } = {},
) {
  const csrf = crypto.randomBytes(18).toString('base64url');
  return [
    cookieHeader(token, { maxAgeSeconds, sameSite, secure, partitioned }),
    `${CSRF_COOKIE}=${csrf}; ${cookieAttrs({ sameSite, secure, partitioned, maxAgeSeconds })}`,
  ];
}

/** Resolve req.user from a session cookie or an API-key bearer token. */
export function attachUser(req, res, next) {
  req.user = null;
  req.auth = null;
  const authz = req.headers.authorization || '';
  if (/^Bearer\s+/i.test(authz)) {
    const bearer = authz.replace(/^Bearer\s+/i, '');
    const found = userFromApiKey(bearer);
    if (found) {
      req.user = found.user;
      req.auth = { kind: 'api_key', credentialId: found.credential.id, label: found.credential.label };
      return next();
    }
  }
  const cookies = parseCookies(req);
  const token = cookies[SESSION_COOKIE];
  if (token) {
    const session = findSessionByToken(token);
    if (session && !session.reason) {
      const user = one('SELECT * FROM users WHERE id = ?', session.user_id);
      if (user) {
        req.user = user;
        req.auth = { kind: 'session', sessionId: session.id, token };
        touchSession(session.id);
        return next();
      }
    }
  }
  return next();
}

export function requireUser(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Not authenticated', code: 'unauthenticated' });
  }
  return next();
}

/**
 * CSRF defence for cookie-authenticated writes. Two independent passes:
 *   1. double-submit: `x-blue-csrf` header must equal the readable CSRF cookie;
 *   2. or a same-origin Origin/Referer header.
 * API-key (Bearer) clients are exempt — no ambient cookie authority.
 */
export function requireSameOrigin(req, res, next) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  if (!req.user) return next(); // login/register: nothing to forge yet
  if (req.auth?.kind === 'api_key') return next();

  const cookies = parseCookies(req);
  const header = req.headers['x-blue-csrf'] || req.headers['x-csrf-token'];
  if (cookies[CSRF_COOKIE] && header && timingSafeEqual(cookies[CSRF_COOKIE], header)) {
    return next();
  }

  const origin = req.headers.origin || req.headers.referer;
  if (origin) {
    try {
      const host = new URL(origin).host;
      const expected = req.headers['x-forwarded-host'] || req.headers.host;
      if (host === expected) return next();
      if (config.publicUrl && new URL(config.publicUrl).host === host) return next();
    } catch {
      /* fall through to rejection */
    }
  }

  return res.status(403).json({
    error: 'Blocked a cross-site request. Send the x-blue-csrf header (browser) or use an API key.',
    code: 'csrf',
  });
}

/* ------------------------------------------------------------------ */
/* rate limiting (in-memory sliding window)                            */
/* ------------------------------------------------------------------ */

const buckets = new Map();

export function rateLimit({ windowMs = 60_000, max = 20, key = 'default' } = {}) {
  return (req, res, next) => {
    const bucketKey = `${key}:${clientIp(req)}`;
    const nowMs = Date.now();
    const hits = (buckets.get(bucketKey) || []).filter((t) => nowMs - t < windowMs);
    if (hits.length >= max) {
      const retryAfter = Math.ceil((windowMs - (nowMs - hits[0])) / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      audit({
        event: 'rate_limit',
        status: 'blocked',
        ip: clientIp(req),
        userAgent: req.headers['user-agent'],
        detail: `${req.method} ${req.path}`,
      });
      return res.status(429).json({ error: 'Too many requests, slow down.', retryAfter });
    }
    hits.push(nowMs);
    buckets.set(bucketKey, hits);
    if (buckets.size > 5000) {
      for (const [k, v] of buckets) if (!v.some((t) => nowMs - t < windowMs)) buckets.delete(k);
    }
    return next();
  };
}

/* ------------------------------------------------------------------ */
/* users                                                               */
/* ------------------------------------------------------------------ */

export const findUserByEmail = (email) => one('SELECT * FROM users WHERE email = ?', normalizeEmail(email));
export const findUserById = (userId) => one('SELECT * FROM users WHERE id = ?', userId);

export async function createUser({ email, name, password }) {
  const normalized = normalizeEmail(email);
  const ts = now();
  const userId = id('user');
  run(
    `INSERT INTO users (id, email, name, password_hash, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    userId,
    normalized,
    String(name || normalized.split('@')[0]).slice(0, 80),
    await hashPassword(password),
    ts,
    ts,
  );
  return one('SELECT * FROM users WHERE id = ?', userId);
}

export const publicUser = (user) =>
  user && {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    created_at: user.created_at,
    last_login_at: user.last_login_at,
  };
