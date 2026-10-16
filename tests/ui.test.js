/**
 * Browser-less UI smoke test.
 *
 * Boots the real server, loads public/index.html into jsdom, wires the globals
 * the front-end expects (document, navigator, localStorage, a cookie-aware
 * fetch), then drives the real client modules: register → shell render →
 * send a message → streamed answer → tool card. This is the test that catches
 * "it looks fine but nothing renders" bugs.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

process.env.BLUE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'blue-ui-test-'));
process.env.PORT = '0';
process.env.BLUE_LOCAL_TOKEN_DELAY_MS = '0';
process.env.BLUE_FORCE_LOCAL_ENGINE = 'true';
process.env.BLUE_SEARCH_OFFLINE = 'true';

const { server } = await import('../server/index.js');
const realFetch = globalThis.fetch;
let base;

/** Minimal cookie jar + relative-URL support, mimicking a browser. */
const jar = new Map();
const browserFetch = async (input, init = {}) => {
  const url = typeof input === 'string' && input.startsWith('http') ? input : `${base}${input}`;
  const headers = new Headers(init.headers || {});
  if (jar.size) headers.set('cookie', [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; '));
  const res = await realFetch(url, { ...init, headers });
  for (const raw of res.headers.getSetCookie?.() ?? []) {
    const [pair, ...attrs] = raw.split(';');
    const index = pair.indexOf('=');
    const key = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    if (!value) {
      jar.delete(key);
      document.cookie = `${key}=; path=/; Max-Age=0`;
      continue;
    }
    jar.set(key, value);
    // Browsers expose non-HttpOnly cookies (the CSRF token) to document.cookie,
    // which is exactly how the client picks it up.
    if (!attrs.some((a) => /httponly/i.test(a))) document.cookie = `${key}=${value}; path=/`;
  }
  return res;
};

const waitFor = async (predicate, { timeout = 5000, label = 'condition' } = {}) => {
  const started = Date.now();
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};

before(async () => {
  if (!server.listening) await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;

  const dom = new JSDOM(fs.readFileSync(path.join(root, 'public/index.html'), 'utf8'), {
    url: 'http://localhost:4000/',
    pretendToBeVisual: true,
  });

  const define = (key, value) => Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  define('window', dom.window);
  define('document', dom.window.document);
  define('navigator', { ...dom.window.navigator, clipboard: { writeText: async () => {} } });
  define('localStorage', dom.window.localStorage);
  define('HTMLElement', dom.window.HTMLElement);
  define('Event', dom.window.Event);
  define('CustomEvent', dom.window.CustomEvent);
  define('fetch', browserFetch);

  await import('../public/js/app.js');
  await waitFor(() => document.querySelector('#engine-pill')?.textContent.includes('Local Engine'), {
    label: 'engine pill',
  });
});

after(() => {
  server.close();
});

test('the login screen boots and reports the available engine', () => {
  const pill = document.querySelector('#engine-pill').textContent;
  assert.match(pill, /Blue Local Engine/);
  assert.notEqual(document.querySelector('#auth-screen').style.display, 'none');
  assert.equal(document.querySelector('#app').classList.contains('ready'), false);
});

test('registering through the form renders the full shell', async () => {
  document.querySelector('#reg-name').value = 'Grace Hopper';
  document.querySelector('#reg-email').value = 'grace@example.com';
  document.querySelector('#reg-password').value = 'Compiler1952!';
  document.querySelector('#register-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));

  await waitFor(
    () => document.querySelector('#app').classList.contains('ready') && document.querySelector('#provider-select').options.length >= 1,
    { label: 'app shell' },
  );
  await waitFor(() => document.querySelector('#welcome'), { label: 'welcome card' });

  assert.equal(document.querySelector('#auth-screen').style.display, 'none');
  assert.equal(document.querySelector('#user-name').textContent, 'Grace Hopper');
  assert.equal(document.querySelector('#user-avatar').textContent, 'GH');
  assert.match(document.querySelector('#topbar-title').textContent, /New chat/);
  assert.ok(document.querySelector('#welcome'), 'welcome card is rendered for an empty account');
  assert.ok(document.querySelector('#provider-select').options.length >= 1, 'provider picker is populated');
  assert.ok(document.querySelector('#tool-toggles').children.length >= 5, 'tool toggles are rendered');
});

test('sending a message streams an answer into the transcript', async () => {
  const input = document.querySelector('#input');
  input.value = 'calc 21 * 2';
  document.querySelector('#send-btn').click();

  await waitFor(() => document.querySelectorAll('#messages-inner .msg').length >= 2, { label: 'user + assistant bubbles' });
  await waitFor(() => document.querySelector('.msg.assistant .tool-card'), { label: 'tool card' });
  await waitFor(() => document.querySelector('.msg.assistant .msg-body.md')?.textContent.includes('42'), {
    label: 'streamed answer',
  });

  const userBubble = document.querySelector('.msg.user .msg-body');
  assert.match(userBubble.textContent, /calc 21 \* 2/);

  const toolCard = document.querySelector('.tool-card');
  assert.match(toolCard.querySelector('.name').textContent, /calculator/);
  assert.match(toolCard.querySelector('.pill').textContent, /done/);

  const answer = [...document.querySelectorAll('.msg.assistant .msg-body.md')].map((n) => n.textContent).join(' ');
  assert.match(answer, /42/);

  // the conversation title is derived from the first message
  await waitFor(() => !/New chat/.test(document.querySelector('#topbar-title').textContent), { label: 'derived title' });
});

test('CSV attachment picker, chip removal lifecycle and analysis rendering work in the browser UI', async () => {
  const chat = await import('../public/js/chat.js');
  document.querySelector('#new-chat').click();
  await waitFor(() => document.querySelector('#welcome'), { label: 'fresh chat for attachment' });

  await chat.addFiles([new window.File(['discard me'], 'discard.txt', { type: 'text/plain' })]);
  document.querySelector('#attachment-list .attachment-chip button').click();
  assert.equal(document.querySelector('#attachment-list').children.length, 0, 'removed files leave the pending list');

  const file = new window.File(['region,revenue\nEast,10\nWest,20'], 'sales.csv', { type: 'text/csv' });
  await chat.addFiles([file]);
  assert.match(document.querySelector('#attachment-list').textContent, /sales\.csv/);
  assert.equal(document.querySelector('#attachment-list .attachment-chip button').getAttribute('aria-label'), 'Remove sales.csv');

  document.querySelector('#send-btn').click();
  await waitFor(() => document.querySelector('.msg.assistant .tool-card .name')?.textContent === 'data_analysis', { label: 'CSV tool card' });
  await waitFor(() => [...document.querySelectorAll('.msg.assistant .msg-body.md')].some((body) => body.textContent.includes('CSV analysis: sales.csv')), { label: 'CSV summary' });
  assert.match(document.querySelector('.msg.user .msg-attachments').textContent, /sales\.csv/);
  assert.equal(document.querySelector('#attachment-list').children.length, 0, 'sent attachments leave the pending list');
});

test('the conversation appears in the sidebar and reopens with its history', async () => {
  await waitFor(() => document.querySelectorAll('#conv-list .conv-item').length >= 2, { label: 'conversation list' });
  const item = [...document.querySelectorAll('#conv-list .conv-item')].find((candidate) => /Calc 21/.test(candidate.querySelector('.t').textContent));
  assert.ok(item, 'the earlier calculator conversation remains in the sidebar');
  item.click();
  await waitFor(() => [...document.querySelectorAll('#conv-list .conv-item')]
    .some((candidate) => /Calc 21/.test(candidate.querySelector('.t').textContent) && candidate.classList.contains('active')), { label: 'active conversation' });

  // open a second chat, then come back to the first
  document.querySelector('#new-chat').click();
  await waitFor(() => document.querySelector('#welcome'), { label: 'fresh chat view' });

  [...document.querySelectorAll('#conv-list .conv-item')]
    .find((candidate) => /Calc 21/.test(candidate.querySelector('.t').textContent))
    ?.click();
  await waitFor(() => document.querySelectorAll('#messages-inner .msg').length >= 2, { label: 'restored transcript' });
  assert.match(document.querySelector('#messages-inner').textContent, /21 \* 2/);

  // restored tool cards carry their real payload, not a placeholder
  const restored = document.querySelector('#messages-inner .tool-card');
  assert.ok(restored, 'tool card survived the reload');
  assert.match(restored.querySelector('.pill').textContent, /done/);
  assert.match(restored.querySelector('.tool-body').textContent, /42/);

  // the final assistant message holds only the closing answer, not the progress note
  const assistantBodies = [...document.querySelectorAll('.msg.assistant .msg-body.md')].map((n) => n.textContent);
  assert.ok(assistantBodies.some((t) => /42/.test(t)));
  assert.equal(assistantBodies.filter((t) => /42/.test(t)).length, 1, 'the answer is not duplicated across turns');
});

test('memory and search panels render from the API', async () => {
  const { api } = await import('../public/js/api.js');
  await api('/api/memories', { method: 'POST', body: { key: 'editor', value: 'neovim' } });
  await api('/api/searches', { method: 'POST', body: { query: 'ui smoke search' } }).catch(() => {});

  const panels = await import('../public/js/panels.js');
  await panels.loadMemories();
  await panels.loadSearches();
  panels.renderMemories();
  panels.renderSearchesView();
  panels.renderRail();

  assert.match(document.querySelector('#mem-list').textContent, /neovim/);
  assert.match(document.querySelector('#search-list').textContent, /ui smoke search/);
  assert.match(document.querySelector('#rail-body').textContent, /ui smoke search/);
  assert.equal(document.querySelector('#count-searches').textContent, '1');
  assert.equal(document.querySelector('#count-memories').textContent, '1');
});

test('tool cards explain a failed tool instead of rendering nothing', async () => {
  const input = document.querySelector('#input');
  document.querySelector('#new-chat').click();
  await waitFor(() => document.querySelector('#welcome'), { label: 'fresh chat' });
  input.value = 'search the web for a kubernetes operator';
  document.querySelector('#send-btn').click();

  await waitFor(() => document.querySelector('.tool-card .pill-err'), { label: 'failed tool badge' });
  const card = [...document.querySelectorAll('.tool-card')].find((c) => c.textContent.includes('failed'));
  assert.ok(card);
  assert.equal(card.querySelector('.tool-head .sp').textContent.includes('failed'), true);
  card.querySelector('.tool-head').click();
  assert.ok(card.classList.contains('open'));
});

test('theme toggle flips the document theme and persists it', () => {
  document.querySelector('#theme-toggle').click();
  assert.equal(document.documentElement.dataset.theme, 'light');
  assert.equal(localStorage.getItem('blue-theme'), 'light');
  document.querySelector('#theme-toggle').click();
  assert.equal(document.documentElement.dataset.theme, 'dark');
});

test('workspace navigation saves skills and agent profiles through the real UI and API', async()=>{
 document.querySelector('[data-view=workspace]').click();
 await waitFor(()=>document.querySelector('#workspace-agents').textContent.includes('Researcher'));
 assert.equal(document.querySelector('#view-workspace').style.display,'block');
 document.querySelector('#skill-name').value='UI skill';
 document.querySelector('#skill-instructions').value='Answer with evidence.';
 document.querySelector('#skill-form').dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));
 await waitFor(()=>document.querySelector('#workspace-skills').textContent.includes('UI skill'));
 document.querySelector('#agent-name').value='UI analyst';
 document.querySelector('#agent-instructions').value='Analyze the request.';
 const skill=[...document.querySelectorAll('#agent-skills label')].find(x=>x.textContent==='UI skill').querySelector('input');skill.checked=true;
 document.querySelector('#agent-tools input[value=calculator]').checked=true;
 document.querySelector('#agent-form').dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));
 await waitFor(()=>document.querySelector('#workspace-agents').textContent.includes('UI analyst'));
 const {loadWorkspace}=await import('../public/js/workspace.js');await loadWorkspace();
 assert.match(document.querySelector('#workspace-agents').textContent,/UI analyst/);
 assert.match(document.querySelector('#team-selection').textContent,/UI analyst/);
});
