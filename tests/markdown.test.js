import test from 'node:test';
import assert from 'node:assert/strict';
import { renderInto, renderMarkdown } from '../public/js/markdown.js';
import { JSDOM } from 'jsdom';

test('markdown: escapes HTML so model output cannot inject markup', () => {
  const html = renderMarkdown('<img src=x onerror="alert(1)">');
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('&lt;img'));
});

test('markdown: script tags are neutralised', () => {
  const html = renderMarkdown('hello\n\n<script>alert(1)</script>');
  assert.ok(!html.includes('<script>'));
});

test('markdown: headings, lists, emphasis and links', () => {
  const html = renderMarkdown('# Title\n\n- one\n- two\n\n**bold** and *italic* and `code`\n\n[Blue](https://example.com)');
  assert.ok(html.includes('<h1>Title</h1>'));
  assert.ok(html.includes('<li>one</li>'));
  assert.ok(html.includes('<strong>bold</strong>'));
  assert.ok(html.includes('<em>italic</em>'));
  assert.ok(html.includes('<code>code</code>'));
  assert.ok(html.includes('href="https://example.com"'));
});

test('markdown: fenced code blocks become copyable pre blocks', () => {
  const html = renderMarkdown('```js\nconst x = 1;\n```');
  assert.ok(html.includes('<pre><code data-lang="js">'));
  assert.ok(html.includes('class="copy-btn"'));
  assert.ok(html.includes('const x = 1;'));
});

test('markdown: HTML artifacts have a preview control while source remains escaped', () => {
  const html = renderMarkdown('```html\n<h1>Preview</h1><script>parent.alert(1)</script>\n```');
  assert.ok(html.includes('class="preview-btn"'));
  assert.ok(html.includes('&lt;h1&gt;Preview&lt;/h1&gt;'));
  assert.ok(!html.includes('<script>parent.alert'));
});

test('markdown: preview uses a sandboxed, isolated iframe and can be hidden', () => {
  const dom = new JSDOM('<div id="mount"></div>');
  const mount = dom.window.document.querySelector('#mount');
  renderInto(mount, '```html\n<h1>hello</h1><meta http-equiv="refresh" content="0;url=https://evil.example"><a href="https://evil.example">leave</a>\n```');
  const button = mount.querySelector('.preview-btn');
  button.click();
  const frame = mount.querySelector('iframe');
  assert.ok(frame);
  assert.equal(frame.getAttribute('sandbox'), '');
  assert.equal(frame.getAttribute('referrerpolicy'), 'no-referrer');
  assert.match(frame.srcdoc, /Content-Security-Policy/);
  assert.match(frame.srcdoc, /script-src 'none'/);
  assert.match(frame.srcdoc, /connect-src 'none'/);
  assert.doesNotMatch(frame.srcdoc, /http-equiv="refresh"/i);
  assert.doesNotMatch(frame.srcdoc, /href="https:\/\/evil\.example"/i);
  button.click();
  assert.equal(mount.querySelector('iframe'), null);
});

test('markdown: tables render with a header row', () => {
  const html = renderMarkdown('| Key | Value |\n| --- | --- |\n| timezone | Asia/Kolkata |');
  assert.ok(html.includes('<table>'));
  assert.ok(html.includes('<th>Key</th>'));
  assert.ok(html.includes('<td>Asia/Kolkata</td>'));
});

test('markdown: bare URLs are linkified', () => {
  const html = renderMarkdown('see https://nodejs.org/en/blog for details');
  assert.ok(html.includes('<a href="https://nodejs.org/en/blog"'));
});

test('markdown: blockquotes and horizontal rules', () => {
  const html = renderMarkdown('> remembered\n\n---');
  assert.ok(html.includes('<blockquote>remembered</blockquote>'));
  assert.ok(html.includes('<hr />'));
});
