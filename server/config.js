import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { installPublicTransport, visitorKey } from './lib/byok.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');
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
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
loadDotEnv();
const env = process.env.NODE_ENV || 'development';
const isVercel = Boolean(process.env.VERCEL);
const bool = (v, fallback = false) => v === undefined || v === '' ? fallback : /^(1|true|yes|on)$/i.test(String(v));
const publicByok = bool(process.env.BLUE_PUBLIC_BYOK, isVercel);
const databaseUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.POSTGRES_URL_NON_POOLING || '';
if (env === 'production' && isVercel && !databaseUrl) throw new Error('Vercel production requires DATABASE_URL (or POSTGRES_URL) for durable user data.');
if (env === 'production' && isVercel && String(process.env.BLUE_SESSION_SECRET || '').length < 32) throw new Error('BLUE_SESSION_SECRET must be at least 32 characters in production.');
export const DATA_DIR = process.env.BLUE_DATA_DIR ? path.resolve(process.env.BLUE_DATA_DIR) : isVercel ? '/tmp/project-blue' : path.join(ROOT, 'data');
if (!databaseUrl) fs.mkdirSync(DATA_DIR, { recursive: true });
function sessionSecret() {
  if (process.env.BLUE_SESSION_SECRET) return process.env.BLUE_SESSION_SECRET;
  const file = path.join(DATA_DIR, '.session-secret');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  const secret = crypto.randomBytes(48).toString('base64url');
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}
function remoteProvider(id, label, baseUrl, defaultModel, environmentKey) {
  return { id, label, baseUrl, defaultModel, get apiKey() { return publicByok ? visitorKey() : environmentKey; } };
}
export const config = {
  env, isVercel, publicByok,
  host: process.env.HOST || '0.0.0.0',
  port: process.env.PORT !== undefined && process.env.PORT !== '' ? Number(process.env.PORT) : 4000,
  publicUrl: process.env.PUBLIC_URL || '',
  dataDir: DATA_DIR, databaseUrl, databaseKind: databaseUrl ? 'postgres' : 'sqlite',
  dbFile: process.env.BLUE_DB_FILE || path.join(DATA_DIR, 'blue.db'),
  sessionSecret: sessionSecret(),
  sessionTtlHours: Number(process.env.SESSION_TTL_HOURS || 168),
  forceLocalEngine: bool(process.env.BLUE_FORCE_LOCAL_ENGINE),
  searchOffline: publicByok || bool(process.env.BLUE_SEARCH_OFFLINE),
  maxToolRounds: Number(process.env.BLUE_MAX_TOOL_ROUNDS || 4),
  maxHistoryMessages: Math.min(Math.max(Number(process.env.BLUE_MAX_HISTORY_MESSAGES || 160), 20), 500),
  maxContextChars: Math.min(Math.max(Number(process.env.BLUE_MAX_CONTEXT_CHARS || 240000), 20000), 1000000),
  maxRequestBytes: 4 * 1024 * 1024,
  maxAttachmentBytes: 2 * 1024 * 1024,
  providers: {
    openai: remoteProvider('openai', publicByok ? 'OpenAI (your key)' : 'OpenAI-compatible', publicByok ? 'https://api.openai.com/v1' : (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''), process.env.OPENAI_MODEL || 'gpt-4o-mini', publicByok ? '' : process.env.OPENAI_API_KEY || ''),
    anthropic: remoteProvider('anthropic', 'Anthropic', 'https://api.anthropic.com/v1', process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-latest', publicByok ? '' : process.env.ANTHROPIC_API_KEY || ''),
    gemini: remoteProvider('gemini', 'Google Gemini', 'https://generativelanguage.googleapis.com/v1beta', process.env.GEMINI_MODEL || 'gemini-1.5-flash', publicByok ? '' : process.env.GEMINI_API_KEY || ''),
    ollama: { id: 'ollama', label: 'Ollama (local)', apiKey: '', baseUrl: publicByok ? '' : (process.env.OLLAMA_BASE_URL || '').replace(/\/$/, ''), defaultModel: process.env.OLLAMA_MODEL || 'llama3.1' },
  },
  search: {
    tavily: publicByok ? '' : process.env.TAVILY_API_KEY || '',
    brave: publicByok ? '' : process.env.BRAVE_API_KEY || '',
    serper: publicByok ? '' : process.env.SERPER_API_KEY || '',
  },
  version: '1.2.0',
};
if (publicByok) installPublicTransport();
export function availableProviders() {
  const out = [];
  for (const p of Object.values(config.providers)) {
    if (p.id === 'ollama') {
      if (p.baseUrl) out.push({ id: p.id, label: p.label, model: p.defaultModel, kind: 'remote' });
    } else if (publicByok || p.apiKey) {
      out.push({ id: p.id, label: p.label, model: p.defaultModel, kind: 'remote', requires_visitor_key: publicByok });
    }
  }
  const local = { id: 'local', label: 'Blue Local Engine', model: 'blue-local-1', kind: 'local' };
  if (config.forceLocalEngine || publicByok) out.unshift(local); else out.push(local);
  return out;
}
export function defaultProviderId() {
  if (!config.forceLocalEngine && !publicByok) {
    const remote = availableProviders().find(p => p.kind === 'remote');
    if (remote) return remote.id;
  }
  return 'local';
}
export const PUBLIC_LIMITS = {
  maxToolRounds: config.maxToolRounds,
  maxHistoryMessages: config.maxHistoryMessages,
  maxAttachmentBytes: config.maxAttachmentBytes,
  sessionTtlHours: config.sessionTtlHours,
  database: config.databaseKind,
  publicByok,
  searchProviders: { tavily: !!config.search.tavily, brave: !!config.search.brave, serper: !!config.search.serper, duckduckgo: !config.searchOffline },
};
