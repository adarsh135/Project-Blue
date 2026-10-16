import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');

/** Minimal .env loader (no dependency, does not override real env vars). */
function loadDotEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const rawLine of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
loadDotEnv();

export const DATA_DIR = process.env.BLUE_DATA_DIR
  ? path.resolve(process.env.BLUE_DATA_DIR)
  : path.join(ROOT, 'data');

fs.mkdirSync(DATA_DIR, { recursive: true });

/** Stable session secret: env var wins, otherwise persisted random value. */
function sessionSecret() {
  if (process.env.BLUE_SESSION_SECRET) return process.env.BLUE_SESSION_SECRET;
  const file = path.join(DATA_DIR, '.session-secret');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  const secret = crypto.randomBytes(48).toString('base64url');
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

const bool = (v, fallback = false) =>
  v === undefined || v === '' ? fallback : /^(1|true|yes|on)$/i.test(String(v));

export const config = {
  env: process.env.NODE_ENV || 'development',
  host: process.env.HOST || '0.0.0.0',
  port: process.env.PORT !== undefined && process.env.PORT !== '' ? Number(process.env.PORT) : 4000,
  publicUrl: process.env.PUBLIC_URL || '',
  dataDir: DATA_DIR,
  dbFile: process.env.BLUE_DB_FILE || path.join(DATA_DIR, 'blue.db'),
  sessionSecret: sessionSecret(),
  sessionTtlHours: Number(process.env.SESSION_TTL_HOURS || 168),
  // SameSite for the session + CSRF cookies. Empty means "decide per request"
  // (see cookiePolicy in auth.js): `lax` in production, `none` over HTTPS
  // elsewhere, because dev/preview runs are commonly embedded cross-site.
  cookieSameSite: (process.env.BLUE_COOKIE_SAMESITE || '').trim().toLowerCase(),
  // Adds `Partitioned` to the cross-site cookies. On by default: it is what
  // keeps them working in browsers that block third-party cookies outright,
  // and browsers that do not know the attribute ignore it.
  cookiePartitioned: bool(process.env.BLUE_COOKIE_PARTITIONED, true),
  forceLocalEngine: bool(process.env.BLUE_FORCE_LOCAL_ENGINE),
  // Skip every outbound search request (used by tests and air-gapped installs).
  searchOffline: bool(process.env.BLUE_SEARCH_OFFLINE),
  maxToolRounds: Number(process.env.BLUE_MAX_TOOL_ROUNDS || 4),
  providers: {
    openai: {
      id: 'openai',
      label: 'OpenAI-compatible',
      apiKey: process.env.OPENAI_API_KEY || '',
      baseUrl: (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
      // gpt-4o-mini is deprecated; GPT-5.6 Terra is the current balanced
      // tool-calling tier. Any OpenAI-compatible gateway can override this.
      defaultModel: process.env.OPENAI_MODEL || 'gpt-5.6-terra',
    },
    anthropic: {
      id: 'anthropic',
      label: 'Anthropic',
      apiKey: process.env.ANTHROPIC_API_KEY || '',
      baseUrl: 'https://api.anthropic.com/v1',
      // Claude 3.5 Sonnet retired on the Claude API on 2025-10-28.
      defaultModel: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5',
    },
    gemini: {
      id: 'gemini',
      label: 'Google Gemini',
      apiKey: process.env.GEMINI_API_KEY || '',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      // Every Gemini 1.x model (incl. gemini-1.5-flash) returns 404 since
      // 2025-09-29. Gemini 3.8 Flash is the current GA Flash model.
      defaultModel: process.env.GEMINI_MODEL || 'gemini-3.8-flash',
    },
    ollama: {
      id: 'ollama',
      label: 'Ollama (local)',
      apiKey: '',
      baseUrl: (process.env.OLLAMA_BASE_URL || '').replace(/\/$/, ''),
      defaultModel: process.env.OLLAMA_MODEL || 'llama3.1',
    },
  },
  search: {
    tavily: process.env.TAVILY_API_KEY || '',
    brave: process.env.BRAVE_API_KEY || '',
    serper: process.env.SERPER_API_KEY || '',
  },
  // A self-hosted SearXNG instance is a dependable, keyless search backend and
  // the durable answer to DuckDuckGo's per-IP throttling. Accepts either name.
  searxngUrl: (process.env.BLUE_SEARXNG_URL || process.env.SEARXNG_URL || '').replace(/\/$/, ''),
  // Point the keyless DuckDuckGo HTML lanes at a mirror, proxy or local test
  // server instead of duckduckgo.com. Empty (the default) means the real host.
  searchDdgBase: (process.env.BLUE_SEARCH_DDG_BASE || '').replace(/\/$/, ''),
};

/** Providers that are actually usable right now. */
export function availableProviders() {
  const out = [];
  for (const p of Object.values(config.providers)) {
    if (p.id === 'ollama') {
      if (p.baseUrl) out.push({ id: p.id, label: p.label, model: p.defaultModel, kind: 'remote' });
      continue;
    }
    if (p.apiKey) out.push({ id: p.id, label: p.label, model: p.defaultModel, kind: 'remote' });
  }
  if (!config.forceLocalEngine) {
    out.push({ id: 'local', label: 'Blue Local Engine', model: 'blue-local-1', kind: 'local' });
  } else {
    out.unshift({ id: 'local', label: 'Blue Local Engine', model: 'blue-local-1', kind: 'local' });
  }
  return out;
}

export function defaultProviderId() {
  if (!config.forceLocalEngine) {
    const remote = availableProviders().find((p) => p.kind === 'remote');
    if (remote) return remote.id;
  }
  return 'local';
}

config.version = '1.0.0';

/**
 * Model IDs that providers have retired. Anyone carrying an older `.env` keeps
 * sending these and gets an opaque 404/400 from the vendor, so we translate it
 * into an error that says what to do. Keep this list append-only.
 */
export const RETIRED_MODELS = {
  // Gemini 1.0/1.5 shutdown 2025-09-29; 2.0 shutdown 2026-06-01.
  'gemini-1.5-pro': { provider: 'gemini', retired: '2025-09-29', replacement: 'gemini-3.8-flash' },
  'gemini-1.5-flash': { provider: 'gemini', retired: '2025-09-29', replacement: 'gemini-3.8-flash' },
  'gemini-1.5-flash-8b': { provider: 'gemini', retired: '2025-09-29', replacement: 'gemini-3.5-flash-lite' },
  'gemini-2.0-flash': { provider: 'gemini', retired: '2026-06-01', replacement: 'gemini-3.8-flash' },
  'gemini-2.0-flash-001': { provider: 'gemini', retired: '2026-06-01', replacement: 'gemini-3.8-flash' },
  'gemini-2.0-flash-lite': { provider: 'gemini', retired: '2026-06-01', replacement: 'gemini-3.5-flash-lite' },
  'gemini-2.0-flash-lite-001': { provider: 'gemini', retired: '2026-06-01', replacement: 'gemini-3.5-flash-lite' },
  // Claude 3.x generation fully retired between 2025-07 and 2026-04.
  'claude-3-5-sonnet-latest': { provider: 'anthropic', retired: '2025-10-28', replacement: 'claude-sonnet-5' },
  'claude-3-5-sonnet-20240620': { provider: 'anthropic', retired: '2025-10-28', replacement: 'claude-sonnet-5' },
  'claude-3-5-sonnet-20241022': { provider: 'anthropic', retired: '2025-10-28', replacement: 'claude-sonnet-5' },
  'claude-3-5-haiku-latest': { provider: 'anthropic', retired: '2026-02-19', replacement: 'claude-haiku-4-5' },
  'claude-3-5-haiku-20241022': { provider: 'anthropic', retired: '2026-02-19', replacement: 'claude-haiku-4-5' },
  'claude-3-7-sonnet-latest': { provider: 'anthropic', retired: '2026-02-19', replacement: 'claude-sonnet-5' },
  'claude-3-7-sonnet-20250219': { provider: 'anthropic', retired: '2026-02-19', replacement: 'claude-sonnet-5' },
  'claude-3-opus-20240229': { provider: 'anthropic', retired: '2026-01-05', replacement: 'claude-opus-5' },
  'claude-3-haiku-20240307': { provider: 'anthropic', retired: '2026-04-20', replacement: 'claude-haiku-4-5' },
  'claude-sonnet-4-20250514': { provider: 'anthropic', retired: '2026-06-15', replacement: 'claude-sonnet-5' },
  'claude-opus-4-20250514': { provider: 'anthropic', retired: '2026-06-15', replacement: 'claude-opus-5' },
  'claude-opus-4-1-20250805': { provider: 'anthropic', retired: '2026-08-05', replacement: 'claude-opus-4-8' },
  // Deprecated on OpenAI but still served; kept for a heads-up rather than a hard error.
  'gpt-4o-mini': { provider: 'openai', retired: null, deprecated: true, replacement: 'gpt-5.6-terra' },
  'gpt-4o': { provider: 'openai', retired: null, deprecated: true, replacement: 'gpt-5.6-terra' },
};

/**
 * Turn a vendor HTTP failure into something a human can act on. Returns an
 * Error whose message names the model and, when we recognise the ID, the
 * replacement to move to.
 */
export function describeProviderError({ providerId, model, status, body }) {
  const detail = String(body || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  const known = RETIRED_MODELS[String(model || '').trim().toLowerCase()];
  const parts = [`${providerId} request failed (HTTP ${status})`];

  if (status === 404 || (status === 400 && /not found|unsupported|does not exist|invalid model/i.test(detail))) {
    if (known) {
      parts.push(
        known.retired
          ? `model "${model}" was retired by the provider on ${known.retired}. Update your .env to ${known.replacement}.`
          : `model "${model}" is deprecated by the provider. Move to ${known.replacement}.`,
      );
    } else {
      parts.push(`the provider does not recognise model "${model}". Check the model name, or set it explicitly in .env.`);
    }
  } else if (status === 401 || status === 403) {
    parts.push('the API key was rejected. Check the key in .env is current and has access to this model.');
  } else if (status === 429) {
    parts.push('rate limited or out of quota — retry shortly, or switch model in Settings.');
  }

  if (known?.deprecated && status !== 404) {
    parts.push(`note: "${model}" is deprecated; ${known.replacement} is the current equivalent.`);
  }
  if (detail) parts.push(`provider said: ${detail}`);

  const error = new Error(parts.join(' '));
  error.status = status;
  error.retiredModel = Boolean(known?.retired);
  return error;
}

/** Escape hatch used by the UI/status endpoint to flag a stale configured model. */
export function retiredModelWarning(providerId, model) {
  const known = RETIRED_MODELS[String(model || '').trim().toLowerCase()];
  if (!known || known.provider !== providerId) return null;
  return {
    model,
    retired: known.retired || null,
    deprecated: Boolean(known.deprecated),
    replacement: known.replacement,
  };
}

/** Bits of config that are safe to expose to the browser. */
export const PUBLIC_LIMITS = {
  maxToolRounds: config.maxToolRounds,
  sessionTtlHours: config.sessionTtlHours,
  searchProviders: {
    tavily: !!config.search.tavily,
    brave: !!config.search.brave,
    serper: !!config.search.serper,
    searxng: !!config.searxngUrl,
    duckduckgo: true,
  },
};
