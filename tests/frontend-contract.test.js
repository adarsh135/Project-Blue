/**
 * Static contract test: every DOM id the front-end reaches for must exist in
 * index.html, and every view the sidebar switches to must have a section.
 * Catches the classic "typo in a selector" bug without a browser.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const jsFiles = ['app.js', 'chat.js', 'panels.js', 'ui.js', 'api.js', 'store.js', 'markdown.js'].map((f) =>
  fs.readFileSync(path.join(root, 'public/js', f), 'utf8'),
);

const htmlIds = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));

test('every #id referenced from JavaScript exists in index.html or is created dynamically', () => {
  const dynamic = new Set(['welcome-name', 'del-password']); // rendered by JS/modal at runtime
  const referenced = new Set();
  for (const source of jsFiles) {
    for (const match of source.matchAll(/\$\('#([a-zA-Z0-9_-]+)'\)/g)) referenced.add(match[1]);
    for (const match of source.matchAll(/querySelector\('#([a-zA-Z0-9_-]+)'\)/g)) referenced.add(match[1]);
  }
  const missing = [...referenced].filter((id) => !htmlIds.has(id) && !dynamic.has(id));
  assert.deepEqual(missing, [], `index.html is missing these ids: ${missing.join(', ')}`);
});

test('each sidebar view has a matching section element', () => {
  const views = [...html.matchAll(/data-view="([a-z]+)"/g)].map((m) => m[1]);
  assert.ok(views.length >= 6);
  for (const view of new Set(views)) {
    if (view === 'chat') continue; // the chat view is #view-chat, handled separately
    assert.ok(htmlIds.has(`view-${view}`), `missing #view-${view} section`);
  }
  assert.ok(htmlIds.has('view-chat'));
});

test('index.html loads the module entry point and the stylesheet', () => {
  assert.match(html, /<script type="module" src="\/js\/app\.js">/);
  assert.match(html, /<link rel="stylesheet" href="\/css\/app\.css"/);
});

test('no inline event handlers or inline scripts (CSP compatibility)', () => {
  assert.ok(!/<script(?![^>]*src=)[^>]*>[\s\S]*?<\/script>/.test(html), 'inline <script> blocks are blocked by CSP');
  assert.ok(!/\son[a-z]+="/.test(html), 'inline on* handlers are blocked by CSP');
});

test('mobile composer has a safe-area layout and touch-sized controls', () => {
  const css = fs.readFileSync(path.join(root, 'public/css/app.css'), 'utf8');
  assert.match(css, /@media \(max-width: 600px\)/);
  assert.match(css, /safe-area-inset-bottom/);
  assert.match(css, /\.composer-bar button, \.composer-tools button \{ min-height: 38px; \}/);
});

test('CSS defines the theme tokens the app relies on', () => {
  const css = fs.readFileSync(path.join(root, 'public/css/app.css'), 'utf8');
  for (const token of ['--bg:', '--panel:', '--text:', '--accent:', '--line:']) {
    assert.ok(css.includes(token), `missing ${token} in app.css`);
  }
  assert.ok(css.includes('[data-theme="light"]'), 'light theme is not defined');
});
