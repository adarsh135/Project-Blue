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
      calls.push({ url: String(url), options });
      return new Response(fail ? 'fake-secret-that-must-not-escape' : 'data: [DONE]\\n\\n', { status: fail ? 401 : 200 });
    };
    globalThis.fetch = rawFetch;
    process.env.BLUE_PUBLIC_BYOK = 'true';
    process.env.BLUE_SESSION_SECRET = 'fake-session-secret-for-tests-only-1234';
    process.env.DATABASE_URL = 'postgresql://fake:fake@fake.neon.tech/fake';
    process.env.OPENAI_API_KEY = 'owner-key-must-never-be-used';
    process.env.OPENAI_BASE_URL = 'http://127.0.0.1:1234';
    process.env.TAVILY_API_KEY = 'owner-search-must-never-be-used';
    const { config, availableProviders } = await import('./server/config.js');
    const { credentialContext } = await import('./server/lib/byok.js');
    const { neonConfig } = await import('@neondatabase/serverless');
    assert.equal(neonConfig.fetchFunction, rawFetch);
    assert.equal(config.providers.openai.apiKey, '');
    assert.equal(config.providers.openai.baseUrl, 'https://api.openai.com/v1');
    assert.equal(config.search.tavily, '');
    assert.equal(config.searchOffline, true);
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
      fail = true;
      await assert.rejects(fetch('https://api.openai.com/v1/chat/completions', { method: 'POST', headers: { authorization: 'Bearer visitor-fake' } }), error => !error.message.includes('fake-secret') && !error.message.includes('visitor-fake'));
    });
    assert.equal(config.providers.openai.apiKey, '');
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: new URL('..', import.meta.url), encoding: 'utf8', env: { ...process.env, VERCEL: '' } });
  assert.equal(child.status, 0, child.stderr);
});
