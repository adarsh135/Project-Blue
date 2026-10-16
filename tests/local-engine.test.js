import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.BLUE_LOCAL_TOKEN_DELAY_MS = '0';
process.env.BLUE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'blue-engine-test-'));
process.env.BLUE_SEARCH_OFFLINE = 'true';

const { detectIntent, extractUrl, runLocalEngine } = await import('../server/agent/local-engine.js');

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

test('intent: a pasted URL routes to fetch_page, not a search or the generic reply', () => {
  assert.equal(detectIntent('fetch https://api.github.com/repos/nodejs/node').kind, 'fetch_page');
  assert.equal(detectIntent('https://example.com').kind, 'fetch_page');
  assert.equal(detectIntent('read https://nodejs.org/en/blog and summarise it').kind, 'fetch_page');
  assert.equal(detectIntent('open example.com and summarize').kind, 'fetch_page');
  assert.equal(detectIntent('summarize this page https://api.github.com/repos/nodejs/node').kind, 'fetch_page');
  assert.deepEqual(detectIntent('read https://nodejs.org/en/blog').url, 'https://nodejs.org/en/blog');
});

test('intent: a URL is only extracted when it really is one', () => {
  // Bare hosts resolve to a fetch…
  assert.equal(extractUrl('open example.com/docs'), 'example.com/docs');
  // …but dotted identifiers and unknown TLDs must not be mistaken for hosts.
  assert.equal(detectIntent('explain how node.js handles the event loop').kind, 'general');
  assert.equal(extractUrl('explain how node.js handles the event loop'), '');
  // ".test" is not a public TLD, so an address is a fact to store, not a page.
  assert.equal(extractUrl('my email is someone@internal.test'), '');
  assert.notEqual(detectIntent('my email is someone@internal.test').kind, 'fetch_page');
  assert.equal(extractUrl('calc 1.5 * 4'), '');
});

test('intent: an explicit "search the web" still wins over an incidental URL', () => {
  assert.equal(detectIntent('search the web for node lts release notes').kind, 'web_search');
});

test('engine: fetch_page intent asks the tool layer for the page', async () => {
  const { toolCalls, text } = await collect([{ role: 'user', content: 'read https://nodejs.org/en/blog and summarise it' }], {
    tools: [{ name: 'fetch_page' }],
  });
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0].name, 'fetch_page');
  assert.equal(JSON.parse(toolCalls[0].args).url, 'https://nodejs.org/en/blog');
  assert.match(text, /Fetching/);
});

test('engine: renders fetched page text instead of the offline fallback', async () => {
  const messages = [
    { role: 'user', content: 'read https://nodejs.org/en/blog' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'f1', name: 'fetch_page', args: {} }] },
    {
      role: 'tool',
      name: 'fetch_page',
      tool_call_id: 'f1',
      content: JSON.stringify({
        __tool: 'fetch_page',
        ok: true,
        url: 'https://nodejs.org/en/blog',
        title: 'Node.js Blog',
        text: 'Node 24 is the current LTS release line.',
      }),
    },
  ];
  const { text } = await collect(messages);
  assert.match(text, /Node\.js Blog/);
  assert.match(text, /Node 24 is the current LTS release line\./);
  assert.ok(!/offline `blue-local-1` planner/.test(text), 'must not fall back to the generic reply');
});

test('engine: says so when fetch_page is switched off', async () => {
  const { text, toolCalls } = await collect([{ role: 'user', content: 'read https://example.com' }], { tools: [] });
  assert.equal(toolCalls.length, 0);
  assert.match(text, /switched off/i);
  assert.match(text, /fetch_page/);
});

test('engine: explains a blocked search differently from an empty one', async () => {
  const blocked = [
    { role: 'user', content: 'search the web for node lts' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'b', name: 'web_search', args: {} }] },
    {
      role: 'tool',
      name: 'web_search',
      tool_call_id: 'b',
      content: JSON.stringify({
        __tool: 'web_search',
        ok: false,
        blocked: true,
        error: 'DuckDuckGo served an anti-bot challenge instead of results.',
      }),
    },
  ];
  const { text } = await collect(blocked);
  assert.match(text, /refusing this server/i);
  assert.match(text, /not your query/i);
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
  const stored = listMemories(user.id).find((m) => m.key === 'stack');
  assert.ok(stored);
  assert.equal(stored.value, 'my stack is Node + SQLite');
  forgetMemory(user.id, stored.id);
});
