import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { attachUser, pruneExpiredSessions, requireSameOrigin } from './auth.js';
import { apiRouter } from './routes/api.routes.js';
import { authRouter } from './routes/auth.routes.js';
import { availableProviders, config, defaultProviderId, retiredModelWarning, ROOT } from './config.js';
import { searchHealth } from './agent/tools.js';
import { log } from './lib/util.js';

// Everything is served from this origin: inline styles/scripts only from self,
// outbound API calls are made by the server, not the browser.
const CSP = [
  "default-src 'self'",
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "connect-src 'self'",
  "form-action 'self'",
  "base-uri 'none'",
  "object-src 'none'",
].join('; ');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);

app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Content-Security-Policy', CSP);
  // Framing: production installs are locked to same-origin. In development the
  // header is omitted so the app can be embedded by a preview proxy / editor
  // panel without being blocked.
  if (config.env === 'production') {
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  }
  next();
});

const started = Date.now();
app.use((req, res, next) => {
  res.on('finish', () => {
    if (req.path.startsWith('/assets/') || req.path === '/favicon.ico') return;
    log('http', `${req.method} ${req.path} → ${res.statusCode}`);
  });
  next();
});

app.use(attachUser);

// ---- browser auth API -------------------------------------------------
app.use('/api/auth', requireSameOrigin, authRouter);

app.get('/api/status', (req, res) => {
  const providers = availableProviders();
  // Flag any configured model the vendor has since retired, so a stale .env
  // explains itself instead of surfacing as a mystery 404 mid-conversation.
  const staleModels = providers
    .filter((p) => p.kind === 'remote')
    .map((p) => retiredModelWarning(p.id, p.model))
    .filter(Boolean);

  res.json({
    ok: true,
    version: config.version,
    uptime_ms: Date.now() - started,
    providers,
    default_provider: defaultProviderId(),
    search_configured: Object.entries(config.search).filter(([, v]) => v).map(([k]) => k),
    search: searchHealth(),
    stale_models: staleModels,
  });
});

// ---- product API (auth required inside the router) --------------------
app.use('/api', apiRouter);

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
    return res.status(404).sendFile(path.join(publicDir, '404.html'), (err) => {
      if (err) res.sendStatus(404);
    });
  }
  return next();
});

// eslint-disable-next-line no-unused-vars
app.use((error, req, res, next) => {
  log('error', error?.stack || error?.message || String(error));
  if (res.headersSent) return res.end();
  return res.status(500).json({ error: 'Something went wrong on the server.', detail: config.env === 'development' ? error?.message : undefined });
});

pruneExpiredSessions();
setInterval(pruneExpiredSessions, 60 * 60 * 1000).unref();

const server = app.listen(config.port, config.host, () => {
  const providers = availableProviders();
  log('blue', `Project Blue v${config.version} listening on http://${config.host}:${config.port}`);
  log('blue', `engine: ${defaultProviderId()}  |  configured providers: ${providers.map((p) => p.id).join(', ')}`);
  log('blue', `web search: ${Object.entries(config.search).filter(([, v]) => v).map(([k]) => k).join(', ') || 'duckduckgo (keyless)'}`);
  log('blue', `data dir: ${config.dataDir}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    log('blue', `${signal} received, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}

export { app, server };
