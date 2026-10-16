/**
 * Compatibility guards.
 *
 * Model vendors retire IDs on a schedule nobody controls, and DuckDuckGo now
 * answers server-side scrapers with an anti-bot page served as HTTP 202. These
 * tests pin the behaviour that keeps those two realities from turning into
 * silent breakage: retired IDs must be recognised and explained, and a
 * challenge page must never be reported as "no results".
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.BLUE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'blue-compat-test-'));
process.env.BLUE_SEARCH_OFFLINE = 'false';
process.env.BLUE_SEARCH_MIN_INTERVAL_MS = '0';

const { config, describeProviderError, RETIRED_MODELS, retiredModelWarning } = await import('../server/config.js');
const { runWebSearch, SearchBlockedError, searchHealth } = await import('../server/agent/tools.js');

/* ------------------------------------------------------------------ */
/* model IDs that vendors have retired                                 */
/* ------------------------------------------------------------------ */

test('default model IDs are not ones the vendor has retired', () => {
  for (const [providerId, provider] of Object.entries(config.providers)) {
    if (providerId === 'ollama') continue; // local tags, no vendor lifecycle
    const known = RETIRED_MODELS[provider.defaultModel];
    assert.equal(
      known?.retired ?? null,
      null,
      `${providerId} defaults to "${provider.defaultModel}", retired ${known?.retired}`,
    );
  }
});

test('the shipped defaults are the documented current models', () => {
  assert.equal(config.providers.openai.defaultModel, 'gpt-5.6-terra');
  assert.equal(config.providers.anthropic.defaultModel, 'claude-sonnet-5');
  assert.equal(config.providers.gemini.defaultModel, 'gemini-3.8-flash');
});

test('every retired-model entry names a replacement that is itself not retired', () => {
  for (const [model, entry] of Object.entries(RETIRED_MODELS)) {
    assert.ok(entry.replacement, `${model} has no replacement`);
    assert.equal(RETIRED_MODELS[entry.replacement]?.retired ?? null, null, `${model} points at a retired replacement`);
  }
});

test('a retired model 404 becomes an actionable message naming the replacement', () => {
  const error = describeProviderError({
    providerId: 'gemini',
    model: 'gemini-1.5-flash',
    status: 404,
    body: '{"error":{"code":404,"message":"models/gemini-1.5-flash is not found"}}',
  });
  assert.equal(error.status, 404);
  assert.equal(error.retiredModel, true);
  assert.match(error.message, /retired by the provider on 2025-09-29/);
  assert.match(error.message, /gemini-3\.8-flash/);
});

test('an unknown model name still produces a useful message', () => {
  const error = describeProviderError({ providerId: 'openai', model: 'gpt-9-imaginary', status: 404, body: 'not found' });
  assert.match(error.message, /does not recognise model "gpt-9-imaginary"/);
});

test('auth and rate-limit failures are explained rather than dumped raw', () => {
  assert.match(
    describeProviderError({ providerId: 'anthropic', model: 'claude-sonnet-5', status: 401, body: 'unauthorized' })
      .message,
    /API key was rejected/,
  );
  assert.match(
    describeProviderError({ providerId: 'openai', model: 'gpt-5.6-terra', status: 429, body: 'slow down' }).message,
    /rate limited or out of quota/,
  );
});

test('retiredModelWarning flags a stale .env but stays quiet for current models', () => {
  const warning = retiredModelWarning('anthropic', 'claude-3-5-sonnet-latest');
  assert.equal(warning.replacement, 'claude-sonnet-5');
  assert.equal(warning.retired, '2025-10-28');
  assert.equal(retiredModelWarning('anthropic', 'claude-sonnet-5'), null);
  // A model belonging to a different provider must not be claimed.
  assert.equal(retiredModelWarning('openai', 'gemini-1.5-flash'), null);
});

/* ------------------------------------------------------------------ */
/* keyless search: a challenge is not "no results"                     */
/* ------------------------------------------------------------------ */

const DDG_CHALLENGE_PAGE = `<!DOCTYPE html><html><head><title>DuckDuckGo</title></head><body>
<form action="//duckduckgo.com/anomaly.js?sv=html&cc=sre" method="post">
  <div class="anomaly-modal__puzzle">Unfortunately, bots use DuckDuckGo too.</div>
</form></body></html>`;

const DDG_RESULT_PAGE = `<div class="result__body">
  <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnodejs.org%2Fen%2Fdownload&rut=abc">Node.js Downloads</a>
  <a class="result__snippet">Current LTS releases of Node.js.</a>
</div>
<div class="result__body">
  <a class="result__a" href="https://github.com/nodejs/node/releases">Node.js releases</a>
  <a class="result__snippet">Release notes for every version.</a>
</div>`;

const EMPTY_DDG_PAGE = '<html><body><div class="no-results">No results.</div></body></html>';

/** Swap global fetch for the duration of one call. */
async function withFetch(handler, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

const jsonResponse = (body) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

test('an HTTP 202 anomaly page raises SearchBlockedError, not "no results"', async () => {
  await withFetch(
    async (url) => {
      if (String(url).includes('api.duckduckgo.com')) return jsonResponse({ RelatedTopics: [] });
      return new Response(DDG_CHALLENGE_PAGE, { status: 202, headers: { 'content-type': 'text/html' } });
    },
    async () => {
      await assert.rejects(
        () => runWebSearch('an ordinary query', 5),
        (error) => {
          assert.ok(error instanceof SearchBlockedError, `expected SearchBlockedError, got ${error?.name}`);
          assert.equal(error.blocked, true);
          assert.match(error.message, /anti-bot challenge/);
          assert.match(error.message, /TAVILY_API_KEY/);
          return true;
        },
      );
    },
  );
});

test('a challenge body served with HTTP 200 is still detected', async () => {
  await withFetch(
    async (url) => {
      if (String(url).includes('api.duckduckgo.com')) return jsonResponse({});
      return new Response(DDG_CHALLENGE_PAGE, { status: 200, headers: { 'content-type': 'text/html' } });
    },
    async () => {
      await assert.rejects(() => runWebSearch('another query', 5), SearchBlockedError);
    },
  );
});

test('a real SERP parses into citations, including uddg-wrapped links', async () => {
  await withFetch(
    async (url) => {
      if (String(url).includes('api.duckduckgo.com')) return jsonResponse({ RelatedTopics: [] });
      return new Response(DDG_RESULT_PAGE, { status: 200, headers: { 'content-type': 'text/html' } });
    },
    async () => {
      const out = await runWebSearch('node lts', 5);
      assert.equal(out.provider, 'duckduckgo');
      assert.equal(out.results.length, 2);
      assert.equal(out.results[0].url, 'https://nodejs.org/en/download');
      assert.equal(out.results[0].title, 'Node.js Downloads');
      assert.equal(out.results[1].url, 'https://github.com/nodejs/node/releases');
    },
  );
});

test('the SERP lane is asked with POST, a Referer and a form body', async () => {
  const seen = [];
  await withFetch(
    async (url, options = {}) => {
      if (String(url).includes('api.duckduckgo.com')) return jsonResponse({ RelatedTopics: [] });
      seen.push({ url: String(url), method: options.method, headers: options.headers, body: options.body });
      return new Response(DDG_RESULT_PAGE, { status: 200, headers: { 'content-type': 'text/html' } });
    },
    async () => {
      await runWebSearch('node lts', 5);
    },
  );
  assert.ok(seen.length >= 1, 'no HTML lane was requested');
  const lane = seen[0];
  assert.equal(lane.method, 'POST');
  assert.match(lane.url, /html\.duckduckgo\.com\/html\//);
  assert.match(lane.headers.referer, /html\.duckduckgo\.com/);
  assert.equal(lane.headers['content-type'], 'application/x-www-form-urlencoded');
  assert.match(lane.headers['user-agent'], /Mozilla\/5\.0/);
  assert.equal(lane.body, 'q=node+lts&kl=wt-wt');
});

test('a genuinely empty SERP is reported as an empty result set, not a block', async () => {
  await withFetch(
    async (url) => {
      if (String(url).includes('api.duckduckgo.com')) return jsonResponse({});
      return new Response(EMPTY_DDG_PAGE, { status: 200, headers: { 'content-type': 'text/html' } });
    },
    async () => {
      await assert.rejects(
        () => runWebSearch('nothing at all', 5),
        (error) => {
          assert.ok(!(error instanceof SearchBlockedError), 'an empty page must not be reported as a block');
          assert.match(error.message, /No keyless search provider responded/);
          return true;
        },
      );
    },
  );
});

test('the Instant Answer API alone is enough to answer', async () => {
  await withFetch(
    async (url) => {
      if (String(url).includes('api.duckduckgo.com')) {
        return jsonResponse({
          AbstractText: 'Node.js is a JavaScript runtime.',
          AbstractURL: 'https://en.wikipedia.org/wiki/Node.js',
          Heading: 'Node.js',
          RelatedTopics: [],
        });
      }
      throw new Error(`unexpected request to ${url}`);
    },
    async () => {
      const out = await runWebSearch('what is node js', 5);
      assert.equal(out.results.length, 1);
      assert.equal(out.results[0].url, 'https://en.wikipedia.org/wiki/Node.js');
      assert.match(out.answer, /JavaScript runtime/);
    },
  );
});

test('searchHealth reports the active backend and last outcome', async () => {
  await withFetch(
    async (url) => {
      if (String(url).includes('api.duckduckgo.com')) return jsonResponse({});
      return new Response(DDG_CHALLENGE_PAGE, { status: 202 });
    },
    async () => {
      await runWebSearch('health probe', 5).catch(() => {});
    },
  );
  const health = searchHealth();
  assert.equal(health.provider, 'duckduckgo');
  assert.equal(health.keyless, true);
  assert.equal(health.last.blocked, true);
  assert.equal(health.last.query, 'health probe');
});
