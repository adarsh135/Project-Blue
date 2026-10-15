/**
 * End-to-end API tests: boots the real server on a random port against a
 * throwaway SQLite database, then exercises auth, sessions, chat, searches,
 * memory and API keys over HTTP.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';

process.env.BLUE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'blue-api-test-'));
process.env.PORT = '0';
process.env.BLUE_LOCAL_TOKEN_DELAY_MS = '0';
process.env.BLUE_FORCE_LOCAL_ENGINE = 'true';
process.env.BLUE_SEARCH_OFFLINE = 'true';

const { server } = await import('../server/index.js');

let base;

class Client {
  constructor() {
    this.cookies = {};
  }

  cookieHeader() {
    return Object.entries(this.cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }

  async request(pathname, { method = 'GET', body, headers = {} } = {}) {
    const h = { ...headers };
    if (body !== undefined) h['content-type'] = 'application/json';
    const cookies = this.cookieHeader();
    if (cookies) h.cookie = cookies;
    if (this.cookies.blue_csrf && !h['x-blue-csrf'] && !['GET', 'HEAD'].includes(method)) {
      h['x-blue-csrf'] = this.cookies.blue_csrf;
    }

    const res = await fetch(`${base}${pathname}`, {
      method,
      headers: h,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const raw of res.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(';');
      const index = pair.indexOf('=');
      const key = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      if (!value) delete this.cookies[key];
      else this.cookies[key] = value;
    }
    const text = await res.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }
    return { status: res.status, data, headers: res.headers };
  }

  /** POST a chat turn and collect the SSE events. */
  async chatTurn(sessionId, content) {
    const res = await fetch(`${base}/api/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: this.cookieHeader(),
        'x-blue-csrf': this.cookies.blue_csrf,
      },
      body: JSON.stringify({ content }),
    });
    assert.equal(res.status, 200);
    const raw = await res.text();
    const events = raw
      .split('\n\n')
      .filter((frame) => frame.startsWith('event:'))
      .map((frame) => {
        const dataLine = frame.split('\n').find((l) => l.startsWith('data:'));
        try {
          return JSON.parse(dataLine.slice(5).trim());
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    return {
      events,
      text: events.filter((e) => e.type === 'text').map((e) => e.delta).join(''),
      toolCalls: events.filter((e) => e.type === 'tool_start'),
    };
  }
}

before(async () => {
  if (!server.listening) await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
});

/* ------------------------------------------------------------------ */

test('health endpoint is public and reports the engine', async () => {
  const res = await fetch(`${base}/api/status`);
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.ok, true);
  assert.ok(Array.isArray(data.providers));
  assert.ok(data.providers.some((p) => p.id === 'local'));
});

test('registration validates input and creates a session cookie', async () => {
  const client = new Client();

  const weak = await client.request('/api/auth/register', {
    method: 'POST',
    body: { email: 'weak@example.com', password: 'short' },
  });
  assert.equal(weak.status, 400);
  assert.match(weak.data.error, /8 characters/);

  const badEmail = await client.request('/api/auth/register', {
    method: 'POST',
    body: { email: 'not-an-email', password: 'BlueDemo2026!' },
  });
  assert.equal(badEmail.status, 400);

  const ok = await client.request('/api/auth/register', {
    method: 'POST',
    body: { name: 'Ada Lovelace', email: 'ada@example.com', password: 'BlueDemo2026!' },
  });
  assert.equal(ok.status, 201);
  assert.equal(ok.data.user.email, 'ada@example.com');
  assert.ok(client.cookies.blue_session, 'session cookie issued');
  assert.ok(client.cookies.blue_csrf, 'csrf cookie issued');

  const me = await client.request('/api/auth/me');
  assert.equal(me.data.authenticated, true);

  const duplicate = await client.request('/api/auth/register', {
    method: 'POST',
    body: { email: 'ada@example.com', password: 'BlueDemo2026!' },
  });
  assert.equal(duplicate.status, 409);
});

test('login rejects wrong credentials and rejects unknown emails identically', async () => {
  const client = new Client();
  const wrongPassword = await client.request('/api/auth/login', {
    method: 'POST',
    body: { email: 'ada@example.com', password: 'nope-nope-1' },
  });
  const unknown = await client.request('/api/auth/login', {
    method: 'POST',
    body: { email: 'ghost@example.com', password: 'nope-nope-1' },
  });
  assert.equal(wrongPassword.status, 401);
  assert.equal(unknown.status, 401);
  assert.equal(wrongPassword.data.error, unknown.data.error);
});

test('cookie writes are CSRF protected, API keys are exempt', async () => {
  const client = new Client();
  await client.request('/api/auth/login', { method: 'POST', body: { email: 'ada@example.com', password: 'BlueDemo2026!' } });

  const blocked = await client.request('/api/memories', {
    method: 'POST',
    headers: { origin: 'https://evil.example', 'x-blue-csrf': 'wrong-token' },
    body: { key: 'x', value: 'y' },
  });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.data.code, 'csrf');

  const allowed = await client.request('/api/memories', { method: 'POST', body: { key: 'csrf', value: 'ok' } });
  assert.equal(allowed.status, 201);
});

test('agent answers, uses tools and persists the conversation', async () => {
  const client = new Client();
  await client.request('/api/auth/login', { method: 'POST', body: { email: 'ada@example.com', password: 'BlueDemo2026!' } });

  const created = await client.request('/api/sessions', { method: 'POST', body: {} });
  const sessionId = created.data.session.id;
  assert.equal(created.status, 201);

  const remember = await client.chatTurn(sessionId, 'remember my timezone is Asia/Kolkata');
  assert.match(remember.text, /timezone/);

  const memories = await client.request('/api/memories');
  assert.ok(memories.data.memories.some((m) => m.key === 'timezone'));

  const calc = await client.chatTurn(sessionId, 'calc (1250 * 1.18) / 3');
  assert.equal(calc.toolCalls.length, 1);
  assert.equal(calc.toolCalls[0].name, 'calculator');
  assert.match(calc.text, /491\.66/);

  const greeting = await client.chatTurn(sessionId, 'hello');
  assert.match(greeting.text, /Blue/);
  assert.equal(greeting.toolCalls.length, 0);

  // the conversation is stored, titled and readable
  const detail = await client.request(`/api/sessions/${sessionId}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.data.messages[0].role, 'user');
  assert.equal(detail.data.messages[0].content, 'remember my timezone is Asia/Kolkata');
  assert.equal(detail.data.session.title, 'Remember my timezone is Asia/Kolkata');
  assert.ok(detail.data.messages.some((m) => m.role === 'tool'));
  assert.ok(detail.data.messages.some((m) => m.role === 'assistant' && m.content));

  // the conversation is searchable
  const found = await client.request('/api/messages/search?q=Kolkata');
  assert.ok(found.data.matches.length >= 1);
});

test('recent searches are recorded, pinned, filtered and cleared', async () => {
  const client = new Client();
  await client.request('/api/auth/login', { method: 'POST', body: { email: 'ada@example.com', password: 'BlueDemo2026!' } });

  const created = await client.request('/api/sessions', { method: 'POST', body: {} });
  const sessionId = created.data.session.id;

  // search is offline in tests, so the attempt is recorded with no results
  const turn = await client.chatTurn(sessionId, 'search the web for the latest sqlite release');
  assert.equal(turn.toolCalls.length, 1);
  assert.equal(turn.toolCalls[0].name, 'web_search');
  assert.match(turn.text, /BLUE_SEARCH_OFFLINE|disabled|failed/i);

  const list = await client.request('/api/searches');
  assert.equal(list.data.count, 1);
  assert.equal(list.data.searches[0].provider, 'unavailable');
  assert.equal(list.data.searches[0].source, 'agent');
  assert.equal(list.data.searches[0].result_count, 0);
  const searchId = list.data.searches[0].id;

  const pinned = await client.request(`/api/searches/${searchId}/pin`, { method: 'POST' });
  assert.equal(pinned.data.pinned, true);
  const pinnedOnly = await client.request('/api/searches?pinned=1');
  assert.equal(pinnedOnly.data.count, 1);

  const filtered = await client.request('/api/searches?q=sqlite');
  assert.equal(filtered.data.count, 1);
  const noMatch = await client.request('/api/searches?q=kubernetes');
  assert.equal(noMatch.data.count, 0);

  // clearing keeps pinned entries
  await client.request('/api/searches', { method: 'DELETE' });
  const afterClear = await client.request('/api/searches');
  assert.equal(afterClear.data.count, 1);

  await client.request(`/api/searches/${searchId}`, { method: 'DELETE' });
  const empty = await client.request('/api/searches');
  assert.equal(empty.data.count, 0);
});

test('a directly-run search is recorded even when the provider is unreachable', async () => {
  const client = new Client();
  await client.request('/api/auth/login', { method: 'POST', body: { email: 'ada@example.com', password: 'BlueDemo2026!' } });
  const res = await client.request('/api/searches', { method: 'POST', body: { query: 'keyless provider check' } });
  assert.equal(res.status, 502);
  const list = await client.request('/api/searches');
  const entry = list.data.searches.find((s) => s.query === 'keyless provider check');
  assert.ok(entry);
  assert.equal(entry.source, 'user');
});

test('API keys authenticate machine clients and can be revoked', async () => {
  const client = new Client();
  await client.request('/api/auth/login', { method: 'POST', body: { email: 'ada@example.com', password: 'BlueDemo2026!' } });

  const created = await client.request('/api/auth/keys', { method: 'POST', body: { label: 'test cli' } });
  assert.equal(created.status, 201);
  const key = created.data.plaintext;
  assert.match(key, /^blue_sk_[0-9a-f]{8}_[A-Za-z0-9_-]+$/);

  const listed = await client.request('/api/auth/keys');
  assert.equal(listed.data.keys.length, 1);
  assert.ok(!JSON.stringify(listed.data).includes(key.split('_')[3]), 'secret is never returned again');

  // Bearer auth needs no cookies and no CSRF header
  const answer = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ content: 'calc 6*7' }),
  });
  assert.equal(answer.status, 200);
  const payload = await answer.json();
  assert.equal(payload.answer.trim(), '`6*7` = **42**');
  assert.deepEqual(payload.tools_used, ['calculator']);

  const revoked = await client.request(`/api/auth/keys/${listed.data.keys[0].id}`, { method: 'DELETE' });
  assert.equal(revoked.status, 200);

  const afterRevoke = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ content: 'hi' }),
  });
  assert.equal(afterRevoke.status, 401);
});

test('sessions are listed, revocable, and logout clears the cookie', async () => {
  const first = new Client();
  await first.request('/api/auth/login', { method: 'POST', body: { email: 'ada@example.com', password: 'BlueDemo2026!' } });
  const second = new Client();
  await second.request('/api/auth/login', { method: 'POST', body: { email: 'ada@example.com', password: 'BlueDemo2026!' } });

  const list = await second.request('/api/auth/sessions');
  assert.ok(list.data.sessions.length >= 2);
  assert.equal(list.data.sessions.filter((s) => s.current).length, 1);

  const others = list.data.sessions.filter((s) => !s.current);
  await second.request(`/api/auth/sessions/${others[0].id}`, { method: 'DELETE' });
  const afterRevoke = await first.request('/api/auth/me');
  assert.equal(afterRevoke.data.authenticated, false, 'revoked session no longer authenticates');

  await second.request('/api/auth/logout', { method: 'POST' });
  const afterLogout = await second.request('/api/auth/me');
  assert.equal(afterLogout.data.authenticated, false);
});

test('password changes require the current password and sign out other devices', async () => {
  const client = new Client();
  await client.request('/api/auth/login', { method: 'POST', body: { email: 'ada@example.com', password: 'BlueDemo2026!' } });

  const wrong = await client.request('/api/auth/password', {
    method: 'POST',
    body: { current_password: 'not-it-123', new_password: 'AnotherPass123!' },
  });
  assert.equal(wrong.status, 403);

  const updated = await client.request('/api/auth/password', {
    method: 'POST',
    body: { current_password: 'BlueDemo2026!', new_password: 'AnotherPass123!' },
  });
  assert.equal(updated.status, 200);

  const oldLogin = await new Client().request('/api/auth/login', {
    method: 'POST',
    body: { email: 'ada@example.com', password: 'BlueDemo2026!' },
  });
  assert.equal(oldLogin.status, 401);

  const newLogin = await new Client().request('/api/auth/login', {
    method: 'POST',
    body: { email: 'ada@example.com', password: 'AnotherPass123!' },
  });
  assert.equal(newLogin.status, 200);

  // put it back for other tests
  await client.request('/api/auth/password', {
    method: 'POST',
    body: { current_password: 'AnotherPass123!', new_password: 'BlueDemo2026!' },
  });
});

test('one user cannot read another user\'s chats, searches or memories', async () => {
  const ada = new Client();
  await ada.request('/api/auth/login', { method: 'POST', body: { email: 'ada@example.com', password: 'BlueDemo2026!' } });
  const adaSession = (await ada.request('/api/sessions', { method: 'POST', body: { title: 'private chat' } })).data.session.id;
  await ada.chatTurn(adaSession, 'remember that Ada likes lattice Boltzmann methods');

  const bob = new Client();
  await bob.request('/api/auth/register', { method: 'POST', body: { email: 'bob@example.com', password: 'BobPass2026!' } });

  const foreign = await bob.request(`/api/sessions/${adaSession}`);
  assert.equal(foreign.status, 404);

  const bobChats = await bob.request('/api/sessions');
  assert.ok(!bobChats.data.sessions.some((s) => s.id === adaSession));

  const bobMemories = await bob.request('/api/memories');
  assert.equal(bobMemories.data.memories.length, 0);

  const bobSearches = await bob.request('/api/searches');
  assert.equal(bobSearches.data.count, 0);

  const bobEvents = await bob.request('/api/auth/events');
  assert.ok(bobEvents.data.events.every((e) => e.event !== 'api_key_create'));
});

test('settings drive the provider, model and enabled tools', async () => {
  const client = new Client();
  await client.request('/api/auth/login', { method: 'POST', body: { email: 'ada@example.com', password: 'BlueDemo2026!' } });

  const unknownProvider = await client.request('/api/settings', { method: 'PUT', body: { provider: 'gpt-9' } });
  assert.equal(unknownProvider.status, 400);

  const saved = await client.request('/api/settings', { method: 'PUT', body: { tools_enabled: ['calculator', 'clock'], temperature: 0.2 } });
  assert.deepEqual(saved.data.settings.tools_enabled, ['calculator', 'clock']);
  assert.equal(saved.data.settings.temperature, 0.2);

  const tools = await client.request('/api/tools');
  const enabled = tools.data.tools.filter((t) => t.enabled).map((t) => t.name);
  assert.deepEqual(enabled, ['calculator', 'clock']);

  // with search disabled the agent refuses to fake it
  const session = (await client.request('/api/sessions', { method: 'POST', body: {} })).data.session.id;
  const turn = await client.chatTurn(session, 'search the web for node 24');
  assert.equal(turn.toolCalls.length, 0);
  assert.match(turn.text, /disabled/i);

  await client.request('/api/settings', {
    method: 'PUT',
    body: { tools_enabled: ['web_search', 'fetch_page', 'calculator', 'clock', 'memory', 'session_search', 'search_history'] },
  });
});
