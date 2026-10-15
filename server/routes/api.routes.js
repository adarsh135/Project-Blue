import express from 'express';
import {
  all,
  clearSearches,
  createChatSession,
  deleteSearch,
  forgetMemory,
  getChatSession,
  getSettings,
  listChatSessions,
  listMemories,
  listMessages,
  one,
  recentSearches,
  recordSearch,
  rememberMemory,
  run,
  saveSettings,
  toggleSearchPin,
} from '../db.js';
import { requireUser, requireSameOrigin } from '../auth.js';
import { availableProviders, config, PUBLIC_LIMITS } from '../config.js';
import { runAgent } from '../agent/agent.js';
import { runWebSearch, toolsForEnabled, TOOL_DEFINITIONS } from '../agent/tools.js';
import { clamp, safeJsonParse, truncate } from '../lib/util.js';
import { titleFromMessage } from '../agent/prompt.js';

export const apiRouter = express.Router();

apiRouter.use(requireUser);

/* ------------------------------------------------------------------ */
/* meta                                                                */
/* ------------------------------------------------------------------ */

apiRouter.get('/health', (req, res) => {
  res.json({ ok: true, version: config.version, engine: getSettings(req.user.id).provider });
});

apiRouter.get('/tools', (req, res) => {
  const enabled = getSettings(req.user.id).tools_enabled;
  res.json({
    tools: TOOL_DEFINITIONS.map((t) => ({
      name: t.name,
      description: t.description,
      schema: t.parameters,
      enabled: enabled.includes(t.name),
    })),
  });
});

apiRouter.get('/providers', (req, res) => {
  res.json({ providers: availableProviders(), limits: PUBLIC_LIMITS, version: config.version });
});

/* ------------------------------------------------------------------ */
/* chat sessions ("Conversations")                                     */
/* ------------------------------------------------------------------ */

const serialiseSession = (row) => ({
  id: row.id,
  title: row.title,
  provider: row.provider,
  model: row.model,
  pinned: !!row.pinned,
  archived: !!row.archived,
  message_count: row.message_count ?? undefined,
  created_at: row.created_at,
  updated_at: row.updated_at,
});

apiRouter.get('/sessions', (req, res) => {
  const rows = listChatSessions(req.user.id, {
    includeArchived: req.query.archived === '1',
    q: String(req.query.q || '').trim(),
  });
  res.json({ sessions: rows.map(serialiseSession) });
});

apiRouter.post('/sessions', (req, res) => {
  const settings = getSettings(req.user.id);
  const session = createChatSession(req.user.id, {
    title: String(req.body?.title || 'New chat').slice(0, 120),
    provider: req.body?.provider || settings.provider,
    model: req.body?.model || settings.model,
    temperature: settings.temperature,
  });
  res.status(201).json({ session: serialiseSession(session) });
});

apiRouter.get('/sessions/:id', (req, res) => {
  const session = getChatSession(req.user.id, req.params.id);
  if (!session) return res.status(404).json({ error: 'Chat not found' });
  const messages = listMessages(session.id, req.user.id).map((m) => ({
    id: m.id,
    role: m.role,
    name: m.name,
    // tool_call_id links a tool result back to the assistant call that made it
    tool_call_id: m.tool_call_id,
    content: m.content,
    tool_calls: safeJsonParse(m.tool_calls, null),
    provider: m.provider,
    model: m.model,
    latency_ms: m.latency_ms,
    tokens_in: m.tokens_in,
    tokens_out: m.tokens_out,
    created_at: m.created_at,
  }));
  return res.json({ session: serialiseSession(session), messages });
});

apiRouter.patch('/sessions/:id', (req, res) => {
  const session = getChatSession(req.user.id, req.params.id);
  if (!session) return res.status(404).json({ error: 'Chat not found' });
  const body = req.body || {};
  run(
    `UPDATE chat_sessions SET title = ?, pinned = ?, archived = ?, provider = ?, model = ? WHERE id = ? AND user_id = ?`,
    body.title === undefined ? session.title : String(body.title).slice(0, 200),
    body.pinned === undefined ? session.pinned : body.pinned ? 1 : 0,
    body.archived === undefined ? session.archived : body.archived ? 1 : 0,
    body.provider || session.provider,
    body.model || session.model,
    session.id,
    req.user.id,
  );
  return res.json({ session: serialiseSession(getChatSession(req.user.id, session.id)) });
});

apiRouter.delete('/sessions/:id', (req, res) => {
  run('DELETE FROM chat_sessions WHERE id = ? AND user_id = ?', req.params.id, req.user.id);
  res.json({ ok: true });
});

apiRouter.get('/sessions/:id/search', (req, res) => {
  const session = getChatSession(req.user.id, req.params.id);
  if (!session) return res.status(404).json({ error: 'Chat not found' });
  const q = `%${String(req.query.q || '').trim()}%`;
  const rows = all(
    `SELECT id, role, content, created_at FROM messages
     WHERE chat_session_id = ? AND user_id = ? AND content LIKE ? ORDER BY created_at DESC LIMIT 50`,
    session.id,
    req.user.id,
    q,
  );
  res.json({ matches: rows.map((r) => ({ ...r, content: truncate(r.content, 400) })) });
});

/** Search across every conversation of the signed-in user. */
apiRouter.get('/messages/search', (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ matches: [] });
  const rows = all(
    `SELECT m.id, m.chat_session_id, m.role, m.content, m.created_at, s.title
     FROM messages m JOIN chat_sessions s ON s.id = m.chat_session_id
     WHERE m.user_id = ? AND m.content LIKE ? ORDER BY m.created_at DESC LIMIT 60`,
    req.user.id,
    `%${q}%`,
  );
  res.json({
    matches: rows.map((r) => ({
      id: r.id,
      session_id: r.chat_session_id,
      title: r.title,
      role: r.role,
      excerpt: truncate(r.content, 300),
      created_at: r.created_at,
    })),
  });
});

/* ------------------------------------------------------------------ */
/* chat streaming                                                      */
/* ------------------------------------------------------------------ */

const streamLimiter = new Map();
const STREAM_WINDOW_MS = 60_000;
const STREAM_MAX = 30;

function streamGuard(req, res, next) {
  const key = req.user.id;
  const nowMs = Date.now();
  const hits = (streamLimiter.get(key) || []).filter((t) => nowMs - t < STREAM_WINDOW_MS);
  if (hits.length >= STREAM_MAX) {
    return res.status(429).json({ error: 'Too many messages per minute. Take a breath and retry shortly.' });
  }
  hits.push(nowMs);
  streamLimiter.set(key, hits);
  return next();
}

apiRouter.post('/sessions/:id/messages', requireSameOrigin, streamGuard, async (req, res) => {
  const session = getChatSession(req.user.id, req.params.id);
  if (!session) return res.status(404).json({ error: 'Chat not found' });

  const content = String(req.body?.content || '').trim();
  if (!content) return res.status(400).json({ error: 'Message content is required.' });
  if (content.length > 16_000) return res.status(413).json({ error: 'Message is too long (16k characters max).' });

  const settings = getSettings(req.user.id);
  const provider = req.body?.provider || settings.provider;
  const model = req.body?.model || settings.model;
  const effective = { ...settings, provider, model };

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': blue stream open\n\n');

  const controller = new AbortController();
  let closed = false;

  // NOTE: use res 'close' (not req 'close') — in modern Node the request stream
  // emits 'close' as soon as its body has been consumed, which would abort the
  // stream immediately. res 'close' means the connection really went away.
  res.on('close', () => {
    if (res.writableEnded) return;
    closed = true;
    controller.abort();
  });

  const send = (event) => {
    if (closed || res.writableEnded) return;
    try {
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    } catch {
      closed = true;
    }
  };

  const keepAlive = setInterval(() => {
    if (!closed && !res.writableEnded) res.write(': keep-alive\n\n');
  }, 15_000);

  try {
    await runAgent({
      user: req.user,
      session,
      settings: effective,
      userText: content,
      onEvent: send,
      signal: controller.signal,
    });
  } catch (error) {
    send({ type: 'error', message: error?.message || 'Agent failed' });
  } finally {
    clearInterval(keepAlive);
    if (!res.writableEnded) {
      try {
        res.write('event: close\ndata: {}\n\n');
        res.end();
      } catch {
        /* connection already gone */
      }
    }
  }
});

/** Convenience endpoint used by API-key clients: one-shot JSON answer. */
apiRouter.post('/chat', requireSameOrigin, streamGuard, async (req, res) => {
  const content = String(req.body?.content || req.body?.message || '').trim();
  if (!content) return res.status(400).json({ error: 'content is required' });
  const settings = getSettings(req.user.id);
  let session = req.body?.session_id ? getChatSession(req.user.id, req.body.session_id) : null;
  if (!session) {
    session = createChatSession(req.user.id, {
      title: titleFromMessage(content),
      provider: req.body?.provider || settings.provider,
      model: req.body?.model || settings.model,
    });
  }
  const events = [];
  const done = await runAgent({
    user: req.user,
    session,
    settings: { ...settings, provider: req.body?.provider || settings.provider, model: req.body?.model || settings.model },
    userText: content,
    onEvent: (event) => events.push(event),
  });
  const answer = events.filter((e) => e.type === 'text').map((e) => e.delta).join('');
  const toolsUsed = events.filter((e) => e.type === 'tool_start').map((e) => e.name);
  res.json({
    session_id: session.id,
    answer,
    tools_used: toolsUsed,
    provider: done.provider,
    model: done.model,
    latency_ms: done.latencyMs,
    tokens: { input: done.tokensIn, output: done.tokensOut },
  });
});

/* ------------------------------------------------------------------ */
/* recent searches                                                     */
/* ------------------------------------------------------------------ */

apiRouter.get('/searches', (req, res) => {
  const entries = recentSearches(req.user.id, {
    limit: clamp(req.query.limit || 40, 1, 200),
    q: String(req.query.q || '').trim(),
    pinnedOnly: req.query.pinned === '1',
  });
  const grouped = entries.reduce((acc, s) => {
    const day = s.created_at.slice(0, 10);
    acc[day] = acc[day] || [];
    acc[day].push(s);
    return acc;
  }, {});
  res.json({ searches: entries, grouped, count: entries.length });
});

/** Run a search directly from the Recent searches panel (source: "user"). */
apiRouter.post('/searches', requireSameOrigin, async (req, res) => {
  const query = String(req.body?.query || '').trim();
  if (!query) return res.status(400).json({ error: 'query is required' });
  try {
    const { provider, results, answer } = await runWebSearch(query, clamp(req.body?.max_results || 5, 1, 10));
    recordSearch({
      userId: req.user.id,
      chatSessionId: req.body?.session_id || null,
      query,
      provider,
      results,
      source: 'user',
    });
    return res.json({ query, provider, answer, results });
  } catch (error) {
    recordSearch({ userId: req.user.id, query, provider: 'unavailable', results: [], source: 'user' });
    return res.status(502).json({ error: error?.message || 'Search failed', query });
  }
});

apiRouter.post('/searches/:id/pin', requireSameOrigin, (req, res) => {
  const pinned = toggleSearchPin(req.user.id, req.params.id);
  if (pinned === null) return res.status(404).json({ error: 'Search not found' });
  res.json({ ok: true, pinned });
});

apiRouter.delete('/searches/:id', requireSameOrigin, (req, res) => {
  deleteSearch(req.user.id, req.params.id);
  res.json({ ok: true });
});

apiRouter.delete('/searches', requireSameOrigin, (req, res) => {
  clearSearches(req.user.id);
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* memories                                                            */
/* ------------------------------------------------------------------ */

apiRouter.get('/memories', (req, res) => {
  res.json({ memories: listMemories(req.user.id) });
});

apiRouter.post('/memories', requireSameOrigin, (req, res) => {
  const key = String(req.body?.key || '').trim();
  const value = String(req.body?.value || '').trim();
  if (!key || !value) return res.status(400).json({ error: 'key and value are required' });
  rememberMemory(req.user.id, key, value, 'user');
  res.status(201).json({ memories: listMemories(req.user.id) });
});

apiRouter.delete('/memories/:id', requireSameOrigin, (req, res) => {
  forgetMemory(req.user.id, req.params.id);
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* settings                                                            */
/* ------------------------------------------------------------------ */

apiRouter.get('/settings', (req, res) => {
  res.json({ settings: getSettings(req.user.id), available_tools: toolsForEnabled(undefined).map((t) => t.name) });
});

apiRouter.put('/settings', requireSameOrigin, (req, res) => {
  const body = req.body || {};
  if (body.provider && !availableProviders().some((p) => p.id === body.provider)) {
    return res.status(400).json({ error: `Provider "${body.provider}" is not configured on this server.` });
  }
  const patch = {};
  if (body.provider) patch.provider = body.provider;
  if (body.model) patch.model = String(body.model).slice(0, 120);
  if (body.temperature !== undefined) patch.temperature = clamp(body.temperature, 0, 2);
  if (body.system_prompt !== undefined) patch.system_prompt = body.system_prompt ? String(body.system_prompt).slice(0, 8000) : null;
  if (Array.isArray(body.tools_enabled)) {
    const valid = new Set(TOOL_DEFINITIONS.map((t) => t.name));
    patch.tools_enabled = body.tools_enabled.filter((t) => valid.has(t));
  }
  if (body.theme) patch.theme = String(body.theme).slice(0, 20);
  res.json({ settings: saveSettings(req.user.id, patch) });
});

/* ------------------------------------------------------------------ */
/* stats (dashboard chips)                                             */
/* ------------------------------------------------------------------ */

apiRouter.get('/stats', (req, res) => {
  const chats = one('SELECT COUNT(*) AS n FROM chat_sessions WHERE user_id = ? AND archived = 0', req.user.id).n;
  const messages = one('SELECT COUNT(*) AS n FROM messages WHERE user_id = ?', req.user.id).n;
  const searches = one('SELECT COUNT(*) AS n FROM searches WHERE user_id = ?', req.user.id).n;
  const memories = one('SELECT COUNT(*) AS n FROM memories WHERE user_id = ?', req.user.id).n;
  const session = req.auth?.sessionId
    ? one('SELECT created_at, expires_at FROM sessions WHERE id = ?', req.auth.sessionId)
    : null;
  const lastSearch = one('SELECT query, created_at FROM searches WHERE user_id = ? ORDER BY created_at DESC LIMIT 1', req.user.id);
  res.json({ chats, messages, searches, memories, session, last_search: lastSearch });
});
