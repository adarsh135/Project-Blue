import express from 'express';
import {
  SESSION_COOKIE,
  clearCookieHeader,
  sessionCookieHeaders,
  createApiKey,
  createSession,
  createUser,
  findUserByEmail,
  findUserById,
  hashPassword,
  listApiKeys,
  listSessions,
  newSessionToken,
  parseCookies,
  passwordProblem,
  publicUser,
  rateLimit,
  requireUser,
  revokeAllSessions,
  revokeApiKey,
  revokeSession,
  verifyPassword,
} from '../auth.js';
import { all, audit, getSettings, run, saveSettings } from '../db.js';
import { availableProviders, config, defaultProviderId, PUBLIC_LIMITS } from '../config.js';
import { clientIp, id, normalizeEmail, now } from '../lib/util.js';

export const authRouter = express.Router();

const authLimiter = rateLimit({ windowMs: 10 * 60_000, max: 30, key: 'auth' });
const registerLimiter = rateLimit({ windowMs: 60 * 60_000, max: 10, key: 'register' });

const isSecureRequest = (req) => {
  const proto = req.headers['x-forwarded-proto'];
  if (typeof proto === 'string' && proto.split(',')[0].trim() === 'https') return true;
  return req.secure;
};

async function startSession(req, res, user, event) {
  const { token } = newSessionToken();
  const session = await createSession({
    userId: user.id,
    token,
    userAgent: req.headers['user-agent'] || '',
    ip: clientIp(req),
  });
  res.setHeader('Set-Cookie', sessionCookieHeaders(token, { secure: isSecureRequest(req) }));
  await run('UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?', now(), now(), user.id);
  await audit({
    userId: user.id,
    email: user.email,
    event,
    status: 'ok',
    ip: clientIp(req),
    userAgent: req.headers['user-agent'],
    detail: session.id,
  });
  return session;
}

/* ------------------------------ register -------------------------- */
authRouter.post('/register', registerLimiter, async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const name = String(req.body?.name || '').trim();
    const password = String(req.body?.password || '');

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      return res.status(400).json({ error: 'Enter a valid email address.' });
    }
    const problem = passwordProblem(password);
    if (problem) return res.status(400).json({ error: problem });
    if (await findUserByEmail(email)) {
      await audit({ email, event: 'register', status: 'exists', ip: clientIp(req), userAgent: req.headers['user-agent'] });
      return res.status(409).json({ error: 'An account with that email already exists.' });
    }

    const user = await createUser({ email, name, password });
    const session = await startSession(req, res, user, 'register');
    return res.status(201).json({ user: publicUser(user), sessionId: session.id, settings: await getSettings(user.id) });
  } catch (error) {
    return next(error);
  }
});

/* -------------------------------- login --------------------------- */
authRouter.post('/login', authLimiter, async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password || '');
    const user = await findUserByEmail(email);

    if (!user || !(await verifyPassword(password, user.password_hash))) {
      await audit({
        userId: user?.id || null,
        email,
        event: 'login',
        status: 'failed',
        ip: clientIp(req),
        userAgent: req.headers['user-agent'],
        detail: user ? 'bad password' : 'unknown email',
      });
      // Same response for both cases so the endpoint can't enumerate accounts.
      return res.status(401).json({ error: 'Email or password is incorrect.' });
    }

    if (!user.password_hash.startsWith('scrypt')) {
      await run('UPDATE users SET password_hash = ? WHERE id = ?', await hashPassword(password), user.id);
    }

    const session = await startSession(req, res, user, 'login');
    return res.json({ user: publicUser(user), sessionId: session.id, settings: await getSettings(user.id) });
  } catch (error) {
    return next(error);
  }
});

/* -------------------------------- logout -------------------------- */
authRouter.post('/logout', async (req, res) => {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (token) {
    const sessionId = token.split('.')[0];
    await audit({ userId: req.user?.id || null, event: 'logout', status: 'ok', ip: clientIp(req), detail: sessionId });
    await run('UPDATE sessions SET revoked_at = ? WHERE id = ?', now(), sessionId);
  }
  res.setHeader('Set-Cookie', clearCookieHeader());
  return res.json({ ok: true });
});

/* --------------------------------- me ----------------------------- */
authRouter.get('/me', async (req, res) => {
  if (!req.user) return res.json({ user: null, authenticated: false });
  return res.json({
    user: publicUser(req.user),
    authenticated: true,
    auth: req.auth,
    settings: await getSettings(req.user.id),
  });
});

authRouter.patch('/me', requireUser, async (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (name) await run('UPDATE users SET name = ?, updated_at = ? WHERE id = ?', name.slice(0, 80), now(), req.user.id);
  const email = req.body?.email === undefined ? null : normalizeEmail(req.body.email);
  if (email && email !== req.user.email) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
    if (await findUserByEmail(email)) return res.status(409).json({ error: 'That email is already in use.' });
    await run('UPDATE users SET email = ?, updated_at = ? WHERE id = ?', email, now(), req.user.id);
    await audit({ userId: req.user.id, email, event: 'email_change', status: 'ok', ip: clientIp(req) });
  }
  return res.json({ user: publicUser(await findUserById(req.user.id)) });
});

/* ------------------------------ password -------------------------- */
authRouter.post('/password', requireUser, authLimiter, async (req, res, next) => {
  try {
    const current = String(req.body?.current_password || '');
    const next_ = String(req.body?.new_password || '');
    const user = await findUserById(req.user.id);
    if (!(await verifyPassword(current, user.password_hash))) {
      await audit({ userId: user.id, email: user.email, event: 'password_change', status: 'denied', ip: clientIp(req) });
      return res.status(403).json({ error: 'Current password is incorrect.' });
    }
    const problem = passwordProblem(next_);
    if (problem) return res.status(400).json({ error: problem });

    await run('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', await hashPassword(next_), now(), user.id);
    await revokeAllSessions(user.id, req.auth?.sessionId || null);
    await audit({ userId: user.id, email: user.email, event: 'password_change', status: 'ok', ip: clientIp(req) });
    return res.json({ ok: true, message: 'Password updated. All other sessions were signed out.' });
  } catch (error) {
    return next(error);
  }
});

/* ------------------------- sessions (devices) --------------------- */
authRouter.get('/sessions', requireUser, async (req, res) => {
  const currentId = req.auth?.kind === 'session' ? req.auth.sessionId : null;
  res.json({
    sessions: (await listSessions(req.user.id)).map((s) => ({
      ...s,
      current: s.id === currentId,
      active: !s.revoked_at && new Date(s.expires_at).getTime() > Date.now(),
    })),
  });
});

authRouter.delete('/sessions/:id', requireUser, async (req, res) => {
  await revokeSession(req.user.id, req.params.id);
  await audit({ userId: req.user.id, event: 'session_revoke', status: 'ok', ip: clientIp(req), detail: req.params.id });
  res.json({ ok: true });
});

authRouter.delete('/sessions', requireUser, async (req, res) => {
  await revokeAllSessions(req.user.id, req.auth?.kind === 'session' ? req.auth.sessionId : null);
  await audit({ userId: req.user.id, event: 'session_revoke_all', status: 'ok', ip: clientIp(req) });
  res.json({ ok: true });
});

/* ------------------------------ api keys -------------------------- */
authRouter.get('/keys', requireUser, async (req, res) => {
  res.json({
    keys: (await listApiKeys(req.user.id)).map((k) => ({
      ...k,
      scopes: JSON.parse(k.scopes || '[]'),
      active: !k.revoked_at,
    })),
  });
});

authRouter.post('/keys', requireUser, async (req, res) => {
  const label = String(req.body?.label || 'API key').slice(0, 60);
  const scopes = Array.isArray(req.body?.scopes) && req.body.scopes.length ? req.body.scopes.slice(0, 8) : ['chat'];
  const key = await createApiKey(req.user.id, label, scopes);
  await audit({ userId: req.user.id, event: 'api_key_create', status: 'ok', ip: clientIp(req), detail: key.id });
  res.status(201).json({
    key: { id: key.id, label: key.label, prefix: key.prefix },
    // Shown exactly once — only the hash is stored.
    plaintext: key.plaintext,
    usage: 'curl -H "Authorization: Bearer <key>" https://your-host/api/chat',
  });
});

authRouter.delete('/keys/:id', requireUser, async (req, res) => {
  await revokeApiKey(req.user.id, req.params.id);
  await audit({ userId: req.user.id, event: 'api_key_revoke', status: 'ok', ip: clientIp(req), detail: req.params.id });
  res.json({ ok: true });
});

/* --------------------------- auth activity ------------------------ */
authRouter.get('/events', requireUser, async (req, res) => {
  const rows = await all(
    `SELECT event, status, ip, user_agent, detail, created_at FROM auth_events
     WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`,
    req.user.id,
  );
  res.json({ events: rows });
});

/* ----------------------------- engines ---------------------------- */
authRouter.get('/providers', (req, res) => {
  res.json({
    providers: availableProviders(),
    default: defaultProviderId(),
    localEngine: { model: 'blue-local-1', alwaysAvailable: true },
    limits: PUBLIC_LIMITS,
    version: config.version,
  });
});

/* --------------------------- account delete ----------------------- */
authRouter.delete('/account', requireUser, async (req, res, next) => {
  try {
    const password = String(req.body?.password || '');
    const user = await findUserById(req.user.id);
    if (!(await verifyPassword(password, user.password_hash))) {
      await audit({ userId: user.id, event: 'account_delete', status: 'denied', ip: clientIp(req) });
      return res.status(403).json({ error: 'Password confirmation failed.' });
    }
    await audit({ userId: null, email: user.email, event: 'account_delete', status: 'ok', ip: clientIp(req) });
    await run('DELETE FROM users WHERE id = ?', user.id); // cascades to all user data
    res.setHeader('Set-Cookie', clearCookieHeader());
    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

/* ------------------------------ settings -------------------------- */
authRouter.put('/settings', requireUser, async (req, res) => {
  const patch = req.body || {};
  if (patch.provider && !availableProviders().some((p) => p.id === patch.provider)) {
    return res.status(400).json({ error: `Provider "${patch.provider}" is not configured on this server.` });
  }
  const saved = await saveSettings(req.user.id, patch);
  res.json({ settings: saved });
});

export default authRouter;
