import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.BLUE_LOCAL_TOKEN_DELAY_MS = '0';
process.env.BLUE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'blue-engine-test-'));
process.env.BLUE_SEARCH_OFFLINE = 'true';

const { detectIntent, runLocalEngine } = await import('../server/agent/local-engine.js');

const collect = async (messages, { tools = [], context = { userId: 'u_test' } } = {}) => {
  const events = [];
  for await (const event of runLocalEngine({ messages, tools, context })) events.push(event);
  const text = events
    .filter((e) => e.type === 'text')
    .map((e) => e.text)
    .join('');
  return { events, text, toolCalls: events.filter((e) => e.type === 'tool_call') };
};

test('intent: routes questions to the right tool', () => {
  assert.equal(detectIntent('hi there').kind, 'greeting');
  assert.equal(detectIntent('who are you?').kind, 'identity');
  assert.equal(detectIntent('search the web for node 22 release notes').kind, 'web_search');
  assert.equal(detectIntent('what is the latest version of sqlite?').kind, 'web_search');
  assert.equal(detectIntent('calc (1250 * 1.18) / 3').kind, 'calculator');
  assert.equal(detectIntent('what time is it in Asia/Kolkata?').kind, 'clock');
  assert.equal(detectIntent('remember my timezone is Asia/Kolkata').kind, 'memory_save');
  assert.equal(detectIntent('what do you remember about me?').kind, 'memory_recall');
  assert.equal(detectIntent('show my recent searches').kind, 'search_history');
  assert.equal(detectIntent('find in my chats about sqlite').kind, 'session_search');
  assert.equal(detectIntent('explain how a thread pool works').kind, 'general');
});

test('engine: identity answer mentions the credential/session features', async () => {
  const { text } = await collect([{ role: 'user', content: 'who are you?' }]);
  assert.match(text, /Blue/);
  assert.match(text, /Credentials/);
  assert.match(text, /Recent searches/);
});

test('engine: asks the tool layer for a web search instead of guessing', async () => {
  const { toolCalls, text } = await collect([{ role: 'user', content: 'search the web for node lts' }], {
    tools: [{ name: 'web_search' }, { name: 'calculator' }],
  });
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0].name, 'web_search');
  assert.deepEqual(JSON.parse(toolCalls[0].args).query, 'node lts');
  assert.match(text, /Searching the web/);
});

test('engine: synthesises answers from tool output and cites sources', async () => {
  const messages = [
    { role: 'user', content: 'search the web for node lts' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'a1', name: 'web_search', args: {} }] },
    {
      role: 'tool',
      name: 'web_search',
      tool_call_id: 'a1',
      content: JSON.stringify({
        __tool: 'web_search',
        ok: true,
        provider: 'tavily',
        query: 'node lts',
        results: [
          { title: 'Node.js Releases', url: 'https://nodejs.org/en/about/previous-releases', snippet: 'LTS schedule' },
          { title: 'Node 24', url: 'https://nodejs.org/en/blog', snippet: 'Current release line' },
        ],
      }),
    },
  ];
  const { text } = await collect(messages);
  assert.match(text, /node lts/);
  assert.match(text, /\[Node\.js Releases\]\(https:\/\/nodejs\.org\/en\/about\/previous-releases\)/);
  assert.match(text, /tavily/);
});

test('engine: deep research synthesis turns multi-query evidence into linked citations', async () => {
  const messages = [
    { role: 'user', content: 'research hosted SQLite alternatives' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'research_1', name: 'deep_research', args: {} }] },
    {
      role: 'tool',
      name: 'deep_research',
      tool_call_id: 'research_1',
      content: JSON.stringify({
        __tool: 'deep_research',
        ok: true,
        topic: 'hosted SQLite alternatives',
        queries: ['hosted SQLite alternatives', 'Neon serverless PostgreSQL'],
        sources: [{ title: 'Neon Docs', url: 'https://neon.tech/docs', query: 'Neon serverless PostgreSQL', snippet: 'Serverless Postgres.' }],
        failures: [],
      }),
    },
  ];
  const { text } = await collect(messages);
  assert.match(text, /Research brief: hosted SQLite alternatives/);
  assert.match(text, /searched 2 focused queries/);
  assert.match(text, /\[Neon Docs\]\(https:\/\/neon\.tech\/docs\)/);
});

test('engine: only uses the tool results from the current turn', async () => {
  const old = {
    role: 'tool',
    name: 'memory',
    tool_call_id: 'old',
    content: JSON.stringify({ __tool: 'memory', ok: true, memories: [{ key: 'stale', value: 'from an earlier turn', updated_at: '2020-01-01' }] }),
  };
  const messages = [
    { role: 'user', content: 'remember my timezone is Asia/Kolkata' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'old', name: 'memory', args: {} }] },
    old,
    { role: 'assistant', content: 'Noted.' },
    { role: 'user', content: 'calc 2+2' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'new', name: 'calculator', args: {} }] },
    {
      role: 'tool',
      name: 'calculator',
      tool_call_id: 'new',
      content: JSON.stringify({ __tool: 'calculator', ok: true, expression: '2+2', result: '4' }),
    },
  ];
  const { text } = await collect(messages);
  assert.match(text, /4/);
  assert.ok(!text.includes('stale'), 'stale tool output must not leak into the answer');
});

test('engine: explains a failed tool instead of inventing results', async () => {
  const messages = [
    { role: 'user', content: 'search the web for the latest node lts' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'x', name: 'web_search', args: {} }] },
    {
      role: 'tool',
      name: 'web_search',
      tool_call_id: 'x',
      content: JSON.stringify({ __tool: 'web_search', ok: false, error: 'No keyless search provider responded.' }),
    },
  ];
  const { text } = await collect(messages);
  assert.match(text, /web_search/);
  assert.match(text, /failed/i);
  assert.match(text, /TAVILY_API_KEY/);
});

test('engine: respects disabled tools', async () => {
  const { text, toolCalls } = await collect([{ role: 'user', content: 'search the web for anything' }], { tools: [] });
  assert.equal(toolCalls.length, 0);
  assert.match(text, /disabled/i);
});

test('engine: memory write path stores under a sensible key', async () => {
  const { createUser } = await import('../server/auth.js');
  const user = await createUser({ email: 'engine-test@example.com', name: 'Engine', password: 'BlueDemo2026!' });
  const { text } = await collect([{ role: 'user', content: 'remember my stack is Node + SQLite' }], {
    tools: [{ name: 'memory' }],
    context: { userId: user.id },
  });
  assert.match(text, /stack/);
  const { listMemories, forgetMemory } = await import('../server/db.js');
  const stored = (await listMemories(user.id)).find((m) => m.key === 'stack');
  assert.ok(stored);
  assert.equal(stored.value, 'my stack is Node + SQLite');
  await forgetMemory(user.id, stored.id);
});
