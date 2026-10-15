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

const env = process.env.NODE_ENV || 'development';
const isVercel = Boolean(process.env.VERCEL);
const databaseUrl =
  process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.POSTGRES_URL_NON_POOLING || '';
const bool = (v, fallback = false) =>
  v === undefined || v === '' ? fallback : /^(1|true|yes|on)$/i.test(String(v));

if (env === 'production' && isVercel && !databaseUrl) {
  throw new Error('Vercel production requires DATABASE_URL (or POSTGRES_URL) for durable user data.');
}
if (env === 'production' && isVercel && !process.env.BLUE_SESSION_SECRET) {
  throw new Error('Vercel production requires a stable BLUE_SESSION_SECRET environment variable.');
}
if (env === 'production' && isVercel && String(process.env.BLUE_SESSION_SECRET || '').length < 32) {
  throw new Error('BLUE_SESSION_SECRET must be at least 32 characters in production.');
}

export const DATA_DIR = process.env.BLUE_DATA_DIR
  ? path.resolve(process.env.BLUE_DATA_DIR)
  : isVercel
    ? '/tmp/project-blue'
    : path.join(ROOT, 'data');

// SQLite is a convenient durable-enough local/single-server default. It is
// deliberately not used on Vercel: function filesystems are ephemeral.
if (!databaseUrl) fs.mkdirSync(DATA_DIR, { recursive: true });

/** Stable session secret: env var wins, otherwise persisted for local installs. */
function sessionSecret() {
  if (process.env.BLUE_SESSION_SECRET) return process.env.BLUE_SESSION_SECRET;
  if (isVercel && env === 'production') {
    throw new Error('Set BLUE_SESSION_SECRET in the Vercel project environment.');
  }
  const file = path.join(DATA_DIR, '.session-secret');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  const secret = crypto.randomBytes(48).toString('base64url');
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

export const config = {
  env,
  isVercel,
  host: process.env.HOST || '0.0.0.0',
  port: process.env.PORT !== undefined && process.env.PORT !== '' ? Number(process.env.PORT) : 4000,
  publicUrl: process.env.PUBLIC_URL || '',
  dataDir: DATA_DIR,
  databaseUrl,
  databaseKind: databaseUrl ? 'postgres' : 'sqlite',
  dbFile: process.env.BLUE_DB_FILE || path.join(DATA_DIR, 'blue.db'),
  sessionSecret: sessionSecret(),
  sessionTtlHours: Number(process.env.SESSION_TTL_HOURS || 168),
  forceLocalEngine: bool(process.env.BLUE_FORCE_LOCAL_ENGINE),
  // Skip every outbound search request (used by tests and air-gapped installs).
  searchOffline: bool(process.env.BLUE_SEARCH_OFFLINE),
  maxToolRounds: Number(process.env.BLUE_MAX_TOOL_ROUNDS || 4),
  maxHistoryMessages: Math.min(Math.max(Number(process.env.BLUE_MAX_HISTORY_MESSAGES || 160), 20), 500),
  maxContextChars: Math.min(Math.max(Number(process.env.BLUE_MAX_CONTEXT_CHARS || 240000), 20000), 1000000),
  maxRequestBytes: 4 * 1024 * 1024,
  maxAttachmentBytes: 2 * 1024 * 1024,
  providers: {
    openai: {
      id: 'openai',
      label: 'OpenAI-compatible',
      apiKey: process.env.OPENAI_API_KEY || '',
      baseUrl: (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
      defaultModel: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    },
    anthropic: {
      id: 'anthropic',
      label: 'Anthropic',
      apiKey: process.env.ANTHROPIC_API_KEY || '',
      baseUrl: 'https://api.anthropic.com/v1',
      defaultModel: process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-latest',
    },
    gemini: {
      id: 'gemini',
      label: 'Google Gemini',
      apiKey: process.env.GEMINI_API_KEY || '',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      defaultModel: process.env.GEMINI_MODEL || 'gemini-1.5-flash',
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

config.version = '1.1.0';

/** Bits of config that are safe to expose to the browser. */
export const PUBLIC_LIMITS = {
  maxToolRounds: config.maxToolRounds,
  maxHistoryMessages: config.maxHistoryMessages,
  maxAttachmentBytes: config.maxAttachmentBytes,
  sessionTtlHours: config.sessionTtlHours,
  database: config.databaseKind,
  searchProviders: {
    tavily: !!config.search.tavily,
    brave: !!config.search.brave,
    serper: !!config.search.serper,
    duckduckgo: true,
  },
};
