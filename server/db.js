import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { now, id } from './lib/util.js';

const schema = `
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS workspace_items (
 id TEXT PRIMARY KEY,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 kind TEXT NOT NULL,
 content TEXT NOT NULL,
 updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS credentials (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,
  label        TEXT NOT NULL,
  prefix       TEXT,
  secret_hash  TEXT NOT NULL,
  scopes       TEXT NOT NULL DEFAULT 'chat',
  last_used_at TEXT,
  expires_at   TEXT,
  revoked_at   TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_credentials_user ON credentials(user_id);

CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,
  user_agent   TEXT,
  ip           TEXT,
  created_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  revoked_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token_hash);

CREATE TABLE IF NOT EXISTS chat_sessions (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title         TEXT NOT NULL DEFAULT 'New chat',
  provider      TEXT NOT NULL DEFAULT 'local',
  model         TEXT NOT NULL DEFAULT 'blue-local-1',
  temperature   REAL NOT NULL DEFAULT 0.7,
  system_prompt TEXT,
  pinned        INTEGER NOT NULL DEFAULT 0,
  archived      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_user ON chat_sessions(user_id, archived);

CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  chat_session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role            TEXT NOT NULL,
  name            TEXT,
  tool_call_id    TEXT,
  content         TEXT NOT NULL DEFAULT '',
  tool_calls      TEXT,
  attachments     TEXT,
  provider        TEXT,
  model           TEXT,
  tokens_in       INTEGER NOT NULL DEFAULT 0,
  tokens_out      INTEGER NOT NULL DEFAULT 0,
  latency_ms      INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(chat_session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS searches (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chat_session_id TEXT,
  query           TEXT NOT NULL,
  provider        TEXT NOT NULL DEFAULT 'duckduckgo',
  result_count    INTEGER NOT NULL DEFAULT 0,
  results         TEXT,
  source          TEXT NOT NULL DEFAULT 'agent',
  pinned          INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_searches_user ON searches(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS memories (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,
  source     TEXT NOT NULL DEFAULT 'agent',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(user_id, key)
);

CREATE TABLE IF NOT EXISTS settings (
  user_id       TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  provider      TEXT NOT NULL DEFAULT 'local',
  model         TEXT NOT NULL DEFAULT 'blue-local-1',
  mode          TEXT NOT NULL DEFAULT 'auto',
  temperature   REAL NOT NULL DEFAULT 0.7,
  system_prompt TEXT,
  tools_enabled TEXT NOT NULL DEFAULT '["web_search","deep_research","fetch_page","calculator","data_analysis","clock","memory","session_search","search_history"]',
  theme         TEXT NOT NULL DEFAULT 'blue',
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_events (
  id         TEXT PRIMARY KEY,
  user_id    TEXT,
  email      TEXT,
  event      TEXT NOT NULL,
  status     TEXT NOT NULL,
  ip         TEXT,
  user_agent TEXT,
  detail     TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_events_user ON auth_events(user_id, created_at DESC);

-- Atomic shared rate limits work across serverless instances.
CREATE TABLE IF NOT EXISTS rate_limits (
  bucket_key  TEXT NOT NULL,
  window_start BIGINT NOT NULL,
  hits        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket_key, window_start)
);
`;

export const databaseKind = config.databaseKind;
export let db = null;
let postgres = null;

function statementsFromSchema() {
  return schema
    .replace(/^\s*--.*$/gm, '')
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean);
}

function migrateSqlite() {
  const ensureColumn = (table, column, definition) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    if (cols.length && !cols.some((col) => col.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  };
  ensureColumn('messages', 'name', 'TEXT');
  ensureColumn('messages', 'tool_call_id', 'TEXT');
  ensureColumn('messages', 'attachments', 'TEXT');
  ensureColumn('messages', 'latency_ms', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('searches', 'pinned', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('chat_sessions', 'pinned', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('settings', 'mode', "TEXT NOT NULL DEFAULT 'auto'");
}

async function initialize() {
  if (config.databaseUrl) {
    const { neon } = await import('@neondatabase/serverless');
    postgres = neon(config.databaseUrl, { fetchOptions: { cache: 'no-store' } });
    for (const statement of statementsFromSchema()) await postgres.query(statement, []);
    await postgres.query('ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachments TEXT', []);
    await postgres.query("ALTER TABLE settings ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'auto'", []);
    return;
  }

  fs.mkdirSync(path.dirname(config.dbFile), { recursive: true });
  db = new DatabaseSync(config.dbFile);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(schema);
  migrateSqlite();
}

// The SQLite schema initializes synchronously for local installs. Postgres DDL
// is lazy and awaited by every query so cold-start requests never race it.
export const ready = initialize();

function postgresSql(sql) {
  let index = 0;
  return String(sql).replace(/\?/g, () => `$${++index}`);
}

async function query(sql, params = []) {
  await ready;
  if (db) return db.prepare(sql).all(...params);
  return postgres.query(postgresSql(sql), params);
}

export async function one(sql, ...params) {
  await ready;
  if (db) return db.prepare(sql).get(...params) ?? null;
  const rows = await postgres.query(postgresSql(sql), params);
  return rows[0] ?? null;
}

export async function all(sql, ...params) {
  return query(sql, params);
}

export async function run(sql, ...params) {
  await ready;
  if (db) return db.prepare(sql).run(...params);
  return postgres.query(postgresSql(sql), params);
}

export const DEFAULT_SETTINGS = {
  provider: 'local',
  model: 'blue-local-1',
  mode: 'auto',
  temperature: 0.7,
  system_prompt: null,
  tools_enabled: [
    'github_repository',
    'web_search',
    'deep_research',
    'fetch_page',
    'calculator',
    'data_analysis',
    'clock',
    'memory',
    'session_search',
    'search_history',
  ],
  theme: 'blue',
};

/* ------------------------------------------------------------------ */
/* event log and shared rate limits                                    */
/* ------------------------------------------------------------------ */

export async function audit({ userId = null, email = null, event, status = 'ok', ip = '', userAgent = '', detail = '' }) {
  await run(
    `INSERT INTO auth_events (id, user_id, email, event, status, ip, user_agent, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id('evt'),
    userId,
    email,
    event,
    status,
    ip,
    String(userAgent || '').slice(0, 250),
    detail,
    now(),
  );
}

let rateLimitOperations = 0;

export async function consumeRateLimit(bucketKey, windowMs) {
  const windowStart = Math.floor(Date.now() / windowMs) * windowMs;
  const row = await one(
    `INSERT INTO rate_limits (bucket_key, window_start, hits) VALUES (?, ?, 1)
     ON CONFLICT (bucket_key, window_start) DO UPDATE SET hits = rate_limits.hits + 1
     RETURNING hits`,
    bucketKey,
    windowStart,
  );
  rateLimitOperations += 1;
  if (rateLimitOperations % 100 === 0) {
    await run('DELETE FROM rate_limits WHERE window_start < ?', Date.now() - 24 * 60 * 60 * 1000);
  }
  return { hits: Number(row?.hits || 0), windowStart };
}

/* ------------------------------------------------------------------ */
/* settings                                                            */
/* ------------------------------------------------------------------ */

const safeArray = (json, fallback) => {
  try {
    const parsed = typeof json === 'string' ? JSON.parse(json) : json;
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
};

export async function getSettings(userId) {
  const row = await one('SELECT * FROM settings WHERE user_id = ?', userId);
  if (!row) return { ...DEFAULT_SETTINGS, tools_enabled: [...DEFAULT_SETTINGS.tools_enabled], user_id: userId };
  return {
    user_id: userId,
    provider: row.provider,
    model: row.model,
    mode: row.mode || 'auto',
    temperature: row.temperature,
    system_prompt: row.system_prompt,
    tools_enabled: safeArray(row.tools_enabled, DEFAULT_SETTINGS.tools_enabled),
    theme: row.theme,
    updated_at: row.updated_at,
  };
}

export async function saveSettings(userId, patch = {}) {
  const current = await getSettings(userId);
  const next = {
    provider: patch.provider ?? current.provider,
    model: patch.model ?? current.model,
    mode: ['auto', 'reasoning', 'research', 'coding', 'planning', 'writing'].includes(patch.mode)
      ? patch.mode
      : current.mode,
    temperature: patch.temperature ?? current.temperature,
    system_prompt: patch.system_prompt === undefined ? current.system_prompt : patch.system_prompt,
    tools_enabled: Array.isArray(patch.tools_enabled) ? patch.tools_enabled : current.tools_enabled,
    theme: patch.theme ?? current.theme,
  };
  await run(
    `INSERT INTO settings (user_id, provider, model, mode, temperature, system_prompt, tools_enabled, theme, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       provider = excluded.provider,
       model = excluded.model,
       mode = excluded.mode,
       temperature = excluded.temperature,
       system_prompt = excluded.system_prompt,
       tools_enabled = excluded.tools_enabled,
       theme = excluded.theme,
       updated_at = excluded.updated_at`,
    userId,
    next.provider,
    next.model,
    next.mode,
    next.temperature,
    next.system_prompt,
    JSON.stringify(next.tools_enabled),
    next.theme,
    now(),
  );
  return getSettings(userId);
}

/* ------------------------------------------------------------------ */
/* searches (recent searches feature)                                  */
/* ------------------------------------------------------------------ */

export async function recordSearch({
  userId,
  chatSessionId = null,
  query,
  provider = 'duckduckgo',
  results = [],
  source = 'agent',
}) {
  const clean = String(query || '').trim();
  if (!clean) return null;
  const rowId = id('srch');
  await run(
    `INSERT INTO searches (id, user_id, chat_session_id, query, provider, result_count, results, source, pinned, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    rowId,
    userId,
    chatSessionId,
    clean,
    provider,
    Array.isArray(results) ? results.length : 0,
    JSON.stringify(Array.isArray(results) ? results.slice(0, 25) : []),
    source,
    now(),
  );
  return rowId;
}

export async function recentSearches(userId, { limit = 40, q = '', pinnedOnly = false } = {}) {
  const params = [userId];
  let sql = 'SELECT * FROM searches WHERE user_id = ?';
  if (pinnedOnly) sql += ' AND pinned = 1';
  if (q) {
    sql += ' AND query LIKE ?';
    params.push(`%${q}%`);
  }
  sql += ' ORDER BY pinned DESC, created_at DESC LIMIT ?';
  params.push(Math.min(Number(limit) || 40, 200));
  return (await all(sql, ...params)).map((row) => ({
    id: row.id,
    query: row.query,
    provider: row.provider,
    result_count: row.result_count,
    results: safeArray(row.results, []),
    source: row.source,
    pinned: !!row.pinned,
    chat_session_id: row.chat_session_id,
    created_at: row.created_at,
  }));
}

export async function deleteSearch(userId, searchId) {
  await run('DELETE FROM searches WHERE id = ? AND user_id = ?', searchId, userId);
}

export async function clearSearches(userId) {
  await run('DELETE FROM searches WHERE user_id = ? AND pinned = 0', userId);
}

export async function toggleSearchPin(userId, searchId) {
  const row = await one(
    `UPDATE searches SET pinned = CASE WHEN pinned = 1 THEN 0 ELSE 1 END
     WHERE id = ? AND user_id = ? RETURNING pinned`,
    searchId,
    userId,
  );
  return row ? !!row.pinned : null;
}

/* ------------------------------------------------------------------ */
/* memories                                                            */
/* ------------------------------------------------------------------ */

export async function rememberMemory(userId, key, value, source = 'agent') {
  const k = String(key || '').trim().slice(0, 120);
  if (!k) return null;
  const row = await one(
    `INSERT INTO memories (id, user_id, key, value, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id, key) DO UPDATE SET
       value = excluded.value, source = excluded.source, updated_at = excluded.updated_at
     RETURNING id`,
    id('mem'),
    userId,
    k,
    String(value).slice(0, 2000),
    source,
    now(),
    now(),
  );
  return row?.id ?? null;
}

export async function listMemories(userId) {
  return all('SELECT * FROM memories WHERE user_id = ? ORDER BY updated_at DESC', userId);
}

export async function forgetMemory(userId, keyOrId) {
  await run('DELETE FROM memories WHERE user_id = ? AND (id = ? OR key = ?)', userId, keyOrId, keyOrId);
}

/* ------------------------------------------------------------------ */
/* chat sessions                                                       */
/* ------------------------------------------------------------------ */

export async function createChatSession(userId, { title = 'New chat', provider = 'local', model = 'blue-local-1', temperature = 0.7, system_prompt = null } = {}) {
  const sid = id('chat');
  const ts = now();
  await run(
    `INSERT INTO chat_sessions (id, user_id, title, provider, model, temperature, system_prompt, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    sid,
    userId,
    title,
    provider,
    model,
    temperature,
    system_prompt,
    ts,
    ts,
  );
  return one('SELECT * FROM chat_sessions WHERE id = ?', sid);
}

export async function listChatSessions(userId, { includeArchived = false, q = '' } = {}) {
  const params = [userId];
  let sql = `
    SELECT s.*, (SELECT COUNT(*) FROM messages m WHERE m.chat_session_id = s.id) AS message_count
    FROM chat_sessions s
    WHERE s.user_id = ?`;
  if (!includeArchived) sql += ' AND s.archived = 0';
  if (q) {
    sql += ' AND s.title LIKE ?';
    params.push(`%${q}%`);
  }
  sql += ' ORDER BY s.pinned DESC, s.updated_at DESC LIMIT 200';
  return all(sql, ...params);
}

export async function getChatSession(userId, sessionId) {
  return one('SELECT * FROM chat_sessions WHERE id = ? AND user_id = ?', sessionId, userId);
}

export async function touchChatSession(sessionId, { title, provider, model } = {}) {
  const current = await one('SELECT * FROM chat_sessions WHERE id = ?', sessionId);
  if (!current) return null;
  await run(
    'UPDATE chat_sessions SET title = ?, provider = ?, model = ?, updated_at = ? WHERE id = ?',
    title ?? current.title,
    provider ?? current.provider,
    model ?? current.model,
    now(),
    sessionId,
  );
  return one('SELECT * FROM chat_sessions WHERE id = ?', sessionId);
}

export async function addMessage({
  sessionId,
  userId,
  role,
  name = null,
  toolCallId = null,
  content = '',
  toolCalls = null,
  attachments = null,
  provider = null,
  model = null,
  tokensIn = 0,
  tokensOut = 0,
  latencyMs = 0,
}) {
  const mid = id('msg');
  await run(
    `INSERT INTO messages (id, chat_session_id, user_id, role, name, tool_call_id, content, tool_calls, attachments, provider, model, tokens_in, tokens_out, latency_ms, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    mid,
    sessionId,
    userId,
    role,
    name,
    toolCallId,
    content,
    toolCalls ? JSON.stringify(toolCalls) : null,
    attachments ? JSON.stringify(attachments) : null,
    provider,
    model,
    tokensIn,
    tokensOut,
    latencyMs,
    now(),
  );
  await run('UPDATE chat_sessions SET updated_at = ? WHERE id = ?', now(), sessionId);
  return one('SELECT * FROM messages WHERE id = ?', mid);
}

export async function listMessages(sessionId, userId, { limit = 500 } = {}) {
  return all(
    `SELECT * FROM messages WHERE chat_session_id = ? AND user_id = ? ORDER BY created_at ASC, id ASC LIMIT ?`,
    sessionId,
    userId,
    limit,
  );
}
