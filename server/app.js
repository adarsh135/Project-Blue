import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { attachUser, requireSameOrigin } from './auth.js';
import { apiRouter } from './routes/api.routes.js';
import { authRouter } from './routes/auth.routes.js';
import { availableProviders, config, defaultProviderId, ROOT } from './config.js';
import { log } from './lib/util.js';

const CSP = [
  "default-src 'self'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "connect-src 'self'",
  "form-action 'self'",
  "base-uri 'none'",
  "object-src 'none'",
].join('; ');

export const app = express();
app.disable('x-powered-by');
app.set('trust proxy', config.env === 'production' ? 1 : true);

app.use(express.json({ limit: config.maxRequestBytes, strict: true }));
app.use((req, res, next) => {
  const requestId = String(req.headers['x-request-id'] || crypto.randomUUID()).slice(0, 100);
  req.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(self), geolocation=()');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  if (config.env === 'production') {
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }
  next();
});

app.use((req, res, next) => {
  res.on('finish', () => {
    if (req.path.startsWith('/assets/') || req.path === '/favicon.ico') return;
    log('http', `${req.requestId} ${req.method} ${req.path} → ${res.statusCode}`);
  });
  next();
});

// ---- browser auth API -------------------------------------------------
// Resolve sessions only for API routes; static assets must not incur database
// reads on every JS/CSS request on the Vercel function.
app.use('/api/auth', attachUser, requireSameOrigin, authRouter);

app.get('/api/status', (req, res) => {
  res.json({
    ok: true,
    version: config.version,
    providers: availableProviders(),
    default_provider: defaultProviderId(),
    database: config.databaseKind,
    search_configured: Object.entries(config.search).filter(([, value]) => value).map(([key]) => key),
  });
});

// ---- product API (auth required inside the router) --------------------
app.use('/api', attachUser, apiRouter);

// ---- static single-page-ish app --------------------------------------
const publicDir = path.join(ROOT, 'public');
app.use(
  express.static(publicDir, {
    extensions: ['html'],
    setHeaders(res, filePath) {
      if (/\.(css|js|woff2?)$/.test(filePath)) res.setHeader('Cache-Control', 'public, max-age=300');
      else res.setHeader('Cache-Control', 'no-cache');
    },
  }),
);

app.get('/', (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: `No such endpoint: ${req.path}` });
  if (req.method === 'GET' && fs.existsSync(path.join(publicDir, 'index.html'))) {
    return res.status(404).sendFile(path.join(publicDir, '404.html'), (error) => {
      if (error) res.sendStatus(404);
    });
  }
  return next();
});

// Express 5 forwards rejected promises here. Avoid leaking provider, SQL,
// stack-trace or credential details from production responses.
app.use((error, req, res, next) => {
  const status = Number(error?.status || error?.statusCode) || 500;
  log('error', `${req.requestId || 'unknown'} ${error?.stack || error?.message || String(error)}`);
  if (res.headersSent) return res.end();
  if (error?.type === 'entity.too.large' || status === 413) {
    return res.status(413).json({ error: 'Request is too large. Reduce the message or attachment size.' });
  }
  if (error instanceof SyntaxError && status === 400) {
    return res.status(400).json({ error: 'Request body must be valid JSON.' });
  }
  return res.status(status >= 400 && status < 500 ? status : 500).json({
    error: status >= 500 ? 'Something went wrong on the server.' : error?.message || 'Request failed.',
    request_id: req.requestId,
    detail: config.env === 'development' ? error?.message : undefined,
  });
});

export default app;
