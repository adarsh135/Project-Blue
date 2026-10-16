import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { credentialContext, visitorKey, validateVisitorKey, publicCredentialMiddleware } from '../server/lib/byok.js';

// Fake strings only. No real credentials or provider network requests.
test('visitor credentials remain isolated across overlapping asynchronous work', async () => {
  const result = await Promise.all(['visitor-a-fake', 'visitor-b-fake'].map((key, index) => credentialContext.run({ key }, async () => {
    await new Promise(resolve => setTimeout(resolve, index ? 1 : 10));
    return visitorKey();
  })));
  assert.deepEqual(result, ['visitor-a-fake', 'visitor-b-fake']);
  assert.equal(visitorKey(), '');
});
test('credential validation rejects arrays, newlines, whitespace and excessive headers', () => {
  for (const value of [[], 'tiny', 'fake key', 'fake-key\n', 'x'.repeat(513)]) assert.throws(() => validateVisitorKey(value));
  assert.equal(validateVisitorKey(undefined), '');
});
test('middleware removes header copies and clears key when response ends', () => {
  const req = { method: 'POST', path: '/api/chat', body: { provider: 'openai' }, headers: { 'x-blue-provider-key': 'visitor-fake' }, rawHeaders: ['X-Blue-Provider-Key', 'visitor-fake'] };
  const res = new EventEmitter();
  let context;
  publicCredentialMiddleware(req, res, () => { context = credentialContext.getStore(); assert.equal(visitorKey(), 'visitor-fake'); });
  assert.equal(req.headers['x-blue-provider-key'], undefined);
  assert.deepEqual(req.rawHeaders, []);
  res.emit('finish');
  assert.equal(context.key, '');
});
test('missing remote key is rejected before chat handling; local mode remains available', () => {
  for (const provider of ['openai', undefined, 'local']) {
    let status;
    let continued = false;
    const res = Object.assign(new EventEmitter(), { status(code) { status = code; return this; }, json() {} });
    publicCredentialMiddleware({ method: 'POST', path: '/api/chat', body: { provider }, headers: {} }, res, () => { continued = true; });
    assert.equal(continued, provider === 'local');
    if (!continued) assert.equal(status, 400);
  }
});
test('public transport: no owner fallback, SSRF denied, Gemini key moved to header, errors redacted, Neon separate', () => {
  const script = `
    import assert from 'node:assert/strict';
    const calls = [];
    let fail = false;
    const rawFetch = async (url, options) => {
      const target = String(url);
      calls.push({ url: target, options });
      if (!fail && target.startsWith('https://api.duckduckgo.com/')) {
        const topics = [1, 2, 3, 4].map(n => ({ FirstURL: 'https://example.com/' + n, Text: 'Fake search result ' + n }));
        return new Response(JSON.stringify({
          Heading: 'Fake answer',
          AbstractText: 'Mocked search data only',
          AbstractURL: 'https://example.com/overview',
          RelatedTopics: topics,
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (!fail && (target === 'https://html.duckduckgo.com/html/' || target === 'https://lite.duckduckgo.com/lite/')) {
        return new Response('<div class="result__body"><a class="result__a" href="https://example.com/page">Example</a><a class="result__snippet">Mocked page snippet</a></div>', {
          status: 200, headers: { 'content-type': 'text/html' },
        });
      }
      return new Response(fail ? 'fake-secret-that-must-not-escape' : 'data: [DONE]\\n\\n', { status: fail ? 401 : 200 });
    };
    globalThis.fetch = rawFetch;
    process.env.BLUE_PUBLIC_BYOK = 'true';
    process.env.BLUE_SEARCH_OFFLINE = 'false';
    process.env.BLUE_SESSION_SECRET = 'fake-session-secret-for-tests-only-1234';
    process.env.DATABASE_URL = 'postgresql://fake:fake@fake.neon.tech/fake';
    process.env.OPENAI_API_KEY = 'owner-key-must-never-be-used';
    process.env.OPENAI_BASE_URL = 'http://127.0.0.1:1234';
    process.env.TAVILY_API_KEY = 'owner-search-must-never-be-used';
    const { config, availableProviders } = await import('./server/config.js');
    const { streamModel } = await import('./server/agent/providers.js');
    const { credentialContext } = await import('./server/lib/byok.js');
    const { neonConfig } = await import('@neondatabase/serverless');
    assert.equal(neonConfig.fetchFunction, rawFetch);
    assert.equal(config.providers.openai.apiKey, '');
    assert.equal(config.providers.openai.baseUrl, 'https://api.openai.com/v1');
    assert.equal(config.search.tavily, '');
    assert.equal(config.searchOffline, false);
    assert.equal(config.providers.openai.defaultModel, 'gpt-6.1-sol');
    assert.equal(config.providers.anthropic.defaultModel, 'claude-sonnet-5');
    assert.equal(config.providers.gemini.defaultModel, 'gemini-3.8-flash');
    assert.equal(config.providers.ollama.baseUrl, '');
    assert.ok(availableProviders().some(p => p.id === 'openai' && p.requires_visitor_key));
    await assert.rejects(fetch('https://api.openai.com/v1/chat/completions', { method: 'POST' }));
    await credentialContext.run({ key: 'visitor-fake' }, async () => {
      assert.equal(config.providers.openai.apiKey, 'visitor-fake');
      for (const url of ['http://127.0.0.1/', 'http://169.254.169.254/', 'https://api.openai.com.evil.test/v1/chat/completions', 'https://api.openai.com/v1/chat/completions?redirect=evil']) {
        await assert.rejects(fetch(url, { method: 'GET' }));
      }
      assert.equal(calls.length, 0);
      await fetch('https://api.openai.com/v1/chat/completions', { method: 'POST', headers: { authorization: 'Bearer visitor-fake' } });
      assert.equal(calls[0].options.redirect, 'error');
      await assert.rejects(fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-test:streamGenerateContent?alt=sse&key=visitor-fake', { method: 'POST', headers: { 'x-goog-api-key': 'visitor-fake' } }));
      assert.equal(calls.length, 1, 'a Gemini key in the URL is rejected before network transmission');
      await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-test:streamGenerateContent?alt=sse', { method: 'POST', headers: { 'x-goog-api-key': 'visitor-fake' } });
      assert.ok(!calls[1].url.includes('visitor-fake'));
      assert.equal(calls[1].options.headers.get('x-goog-api-key'), 'visitor-fake');

      // Exercise the real adapters with fake-only credentials and a mocked fetch.
      for await (const _ of streamModel({
        providerId: 'gemini',
        model: 'gemini-3.8-flash',
        messages: [{ role: 'user', content: 'hello' }],
        tools: [],
        temperature: 0.9,
      })) {}
      assert.equal(calls[2].url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse');
      assert.equal(calls[2].options.headers.get('x-goog-api-key'), 'visitor-fake');
      assert.equal(JSON.parse(calls[2].options.body).generationConfig.temperature, undefined);

      for await (const _ of streamModel({
        providerId: 'openai',
        model: 'gpt-6.1-sol',
        messages: [{ role: 'user', content: 'hello' }],
        tools: [],
        temperature: 0.9,
      })) {}
      const openaiBody = JSON.parse(calls[3].options.body);
      assert.equal(openaiBody.model, 'gpt-6.1-sol');
      assert.equal(openaiBody.temperature, undefined);

      // Search is available without a model key, but only via fixed DDG URLs.
      const instant = await credentialContext.run({ key: '' }, () =>
        fetch('https://api.duckduckgo.com/?q=mock&format=json&no_html=1', { method: 'GET' }));
      assert.equal(instant.status, 200);
      assert.equal((await instant.json()).Heading, 'Fake answer');
      assert.equal(calls[4].url.startsWith('https://api.duckduckgo.com/?'), true);
      assert.equal(calls[4].options.redirect, 'error');

      await fetch('https://html.duckduckgo.com/html/', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: 'must-not-be-forwarded' },
        body: new URLSearchParams({ q: 'fixed safe query', kl: 'wt-wt' }).toString(),
      });
      assert.equal(calls[5].url, 'https://html.duckduckgo.com/html/');
      assert.equal(calls[5].options.redirect, 'error');
      assert.equal(calls[5].options.headers.has('authorization'), false);
      await assert.rejects(fetch('https://html.duckduckgo.com/html/?url=https%3A%2F%2F127.0.0.1%2F', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ q: 'fixed safe query', kl: 'wt-wt' }).toString(),
      }));
      await assert.rejects(fetch('https://api.duckduckgo.com/?q=safe&format=json&no_html=1&url=https%3A%2F%2F127.0.0.1%2F', { method: 'GET' }));
      assert.equal(calls.length, 6);

      fail = true;
      await assert.rejects(fetch('https://api.openai.com/v1/chat/completions', { method: 'POST', headers: { authorization: 'Bearer visitor-fake' } }), error => !error.message.includes('fake-secret') && !error.message.includes('visitor-fake'));
    });
    assert.equal(config.providers.openai.apiKey, '');
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: new URL('..', import.meta.url), encoding: 'utf8', env: { ...process.env, VERCEL: '' } });
  assert.equal(child.status, 0, child.stderr);
});


test('public search tool uses fixed DuckDuckGo egress and returns mock-only results', () => {
  const script = "import assert from 'node:assert/strict';\nimport fs from 'node:fs';\nimport os from 'node:os';\nimport path from 'node:path';\nprocess.env.BLUE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'blue-search-test-'));\nprocess.env.BLUE_PUBLIC_BYOK = 'true';\nprocess.env.BLUE_SEARCH_OFFLINE = 'false';\nprocess.env.BLUE_SEARCH_MIN_INTERVAL_MS = '0';\nprocess.env.NODE_ENV = 'test';\nprocess.env.VERCEL = '';\nprocess.env.DATABASE_URL = '';\nprocess.env.POSTGRES_URL = '';\nprocess.env.POSTGRES_URL_NON_POOLING = '';\nprocess.env.BLUE_SESSION_SECRET = 'fake-search-test-session-secret-only-1234';\ndelete process.env.TAVILY_API_KEY;\ndelete process.env.BRAVE_API_KEY;\ndelete process.env.SERPER_API_KEY;\nconst calls = [];\nconst rawFetch = async (url, options = {}) => {\n  const target = String(url);\n  calls.push({ url: target, options });\n  if (target.startsWith('https://api.duckduckgo.com/')) {\n    return new Response(JSON.stringify({\n      Heading: 'Fake answer',\n      AbstractText: 'Mocked search data only',\n      AbstractURL: 'https://example.com/overview',\n      RelatedTopics: [{ FirstURL: 'https://example.com/1', Text: 'Fake result 1' }],\n    }), { status: 200, headers: { 'content-type': 'application/json' } });\n  }\n  if (target === 'https://html.duckduckgo.com/html/') {\n    return new Response('<div class=\"result__body\"><a class=\"result__a\" href=\"https://example.com/page\">Example</a><a class=\"result__snippet\">Mocked page snippet</a></div>', { status: 200, headers: { 'content-type': 'text/html' } });\n  }\n  if (target === 'https://lite.duckduckgo.com/lite/') {\n    return new Response('<div class=\"result__body\"><a class=\"result__a\" href=\"https://example.com/lite\">Lite example</a><a class=\"result__snippet\">Mocked alternate snippet</a></div>', { status: 200, headers: { 'content-type': 'text/html' } });\n  }\n  throw new Error('Unexpected outbound request in mocked test: ' + target);\n};\nglobalThis.fetch = rawFetch;\nconst { runWebSearch } = await import('./server/agent/tools.js');\nconst search = await runWebSearch('mock release notes');\nassert.equal(search.provider, 'duckduckgo');\nassert.equal(search.results.length, 4);\nassert.equal(search.results[0].title, 'Fake answer');\nassert.equal(search.results.some(r => r.url === 'https://example.com/page'), true);\nassert.equal(search.results.some(r => r.url === 'https://example.com/lite'), true);\nassert.equal(calls.length, 3);\nassert.equal(calls[0].url.startsWith('https://api.duckduckgo.com/?'), true);\nassert.equal(calls[0].options.redirect, 'error');\nassert.equal(calls[1].url, 'https://html.duckduckgo.com/html/');\nassert.equal(calls[1].options.redirect, 'error');\nassert.equal(calls[1].options.headers.has('authorization'), false);\nassert.equal(calls[2].url, 'https://lite.duckduckgo.com/lite/');\nassert.equal(calls[2].options.redirect, 'error');\nawait assert.rejects(fetch('https://127.0.0.1/', { method: 'GET' }));\nassert.equal(calls.length, 3);\n";
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
    env: { ...process.env, VERCEL: '' },
  });
  assert.equal(child.status, 0, child.stderr);
});
