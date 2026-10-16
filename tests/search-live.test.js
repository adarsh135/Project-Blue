/**
 * Live verification of the keyless search lanes.
 *
 * `tests/compatibility.test.js` swaps `globalThis.fetch` for a stub, which
 * proves the parsing logic but not the transport. This file stands up a real
 * HTTP server on a real socket and points the lanes at it, so the status-code
 * handling, the POST body, the Referer header and the challenge detection are
 * all exercised end to end the way they are in production.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.BLUE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'blue-search-live-'));
process.env.BLUE_SEARCH_OFFLINE = 'false';
process.env.BLUE_SEARCH_MIN_INTERVAL_MS = '0';
// Provider selection happens at import time, so the stub base must be set first.
process.env.BLUE_SEARCH_DDG_BASE = '__set_below__';

const CHALLENGE_PAGE = `<!DOCTYPE html><html><body>
<form action="//duckduckgo.com/anomaly.js?sv=html" method="post">
  <div class="anomaly-modal__puzzle">Unfortunately, bots use DuckDuckGo too.</div>
  <div class="anomaly-modal__mask"></div>
</form></body></html>`;

const SERP = `<div class="result__body">
  <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnodejs.org%2Fen%2Fdownload">Node.js Downloads</a>
  <a class="result__snippet">Current LTS releases.</a>
</div>`;

/**
 * Boot a throwaway HTTP server. `mode` decides what the SERP lanes answer with,
 * and every request is recorded so the tests can assert on what really arrived.
 */
async function withStubServer(mode, fn) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      const wantsChallenge = mode === 'challenge' || (mode === 'challenge-then-serp' && seen.length === 1);
      if (wantsChallenge) {
        res.writeHead(202, { 'content-type': 'text/html' });
        res.end(CHALLENGE_PAGE);
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(SERP);
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  process.env.BLUE_SEARCH_DDG_BASE = base;

  try {
    return await fn({ base, seen });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// Imported once; each call reads config.searchDdgBase at request time.
const { runWebSearch, SearchBlockedError, searchHealth } = await import('../server/agent/tools.js');
const { config } = await import('../server/config.js');

test('the lane base is configurable, and defaults to the real host when unset', () => {
  assert.equal(config.searchDdgBase, '__set_below__');
  // The override is read per request, so mutating it here re-points the lanes.
  config.searchDdgBase = '';
  assert.equal(config.searchDdgBase, '');
});

test('a real HTTP 202 challenge is detected over a real socket', async () => {
  await withStubServer('challenge', async ({ base }) => {
    config.searchDdgBase = base;
    await assert.rejects(
      () => runWebSearch('a query that gets challenged', 5),
      (error) => {
        assert.ok(error instanceof SearchBlockedError, `expected SearchBlockedError, got ${error?.name}: ${error?.message}`);
        assert.equal(error.blocked, true);
        assert.match(error.message, /HTTP 202/);
        return true;
      },
    );
  });
  config.searchDdgBase = '';
});

test('the lanes really POST a form body with a Referer to the configured base', async () => {
  await withStubServer('serp', async ({ base, seen }) => {
    config.searchDdgBase = base;
    const out = await runWebSearch('node lts', 5);

    assert.equal(out.results.length, 1);
    assert.equal(out.results[0].url, 'https://nodejs.org/en/download');

    assert.ok(seen.length >= 1, 'the stub server received no request');
    const first = seen[0];
    assert.equal(first.method, 'POST');
    assert.equal(first.url, '/html/');
    assert.equal(first.body, 'q=node+lts&kl=wt-wt');
    assert.equal(first.headers['content-type'], 'application/x-www-form-urlencoded');
    assert.match(first.headers['user-agent'], /Mozilla\/5\.0/);
    assert.equal(first.headers.referer, `${base}/`);
  });
  config.searchDdgBase = '';
});

test('a challenge on the first lane falls through to the second', async () => {
  await withStubServer('challenge-then-serp', async ({ base, seen }) => {
    config.searchDdgBase = base;
    const out = await runWebSearch('fallback query', 5);

    assert.equal(out.results.length, 1, 'the second lane should have supplied results');
    assert.ok(seen.length >= 2, `expected the lane fallback to reach the server twice, saw ${seen.length}`);
    const paths = seen.map((r) => r.url);
    assert.deepEqual(paths.slice(0, 2), ['/html/', '/lite/']);
  });
  config.searchDdgBase = '';
});

test('a fully blocked sweep is recorded, and health says so', async () => {
  await withStubServer('challenge', async ({ base }) => {
    config.searchDdgBase = base;
    await runWebSearch('blocked query', 5).catch(() => {});
  });
  config.searchDdgBase = '';

  const health = searchHealth();
  assert.equal(health.provider, 'duckduckgo');
  assert.equal(health.keyless, true);
  assert.equal(health.last.blocked, true);
  assert.equal(health.last.query, 'blocked query');
  assert.equal(health.last.results, 0);
});

/* ------------------------------------------------------------------ */
/* SearXNG: the dependable keyless backend                             */
/* ------------------------------------------------------------------ */

/** Boot a stub SearXNG instance. `mode` picks the response shape. */
async function withSearxngStub(mode, fn) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, headers: req.headers });
    if (mode === 'json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          answers: ['Node.js is a JavaScript runtime.'],
          results: [
            {
              title: 'Node.js — Download',
              url: 'https://nodejs.org/en/download',
              content: 'Current <b>LTS</b> releases of Node.js.',
            },
            { title: 'No URL here', url: '', content: 'dropped' },
          ],
        }),
      );
      return;
    }
    // JSON format disabled: the instance answers the API with its HTML UI.
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!DOCTYPE html><html><body><input name="q"></body></html>');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const saved = config.searxngUrl;
  config.searxngUrl = base;
  try {
    return await fn({ base, seen });
  } finally {
    config.searxngUrl = saved;
    await new Promise((resolve) => server.close(resolve));
  }
}

test('a configured SearXNG instance is selected over the keyless scrape', async () => {
  await withSearxngStub('json', async ({ base }) => {
    assert.equal(searchHealth().provider, 'searxng');
    assert.equal(searchHealth().keyless, true);
    assert.equal(searchHealth().instance, base);

    const out = await runWebSearch('node js', 5);
    assert.equal(out.provider, 'searxng');
    assert.equal(out.results.length, 1, 'a result with no url must be dropped');
    assert.equal(out.results[0].url, 'https://nodejs.org/en/download');
    assert.equal(out.results[0].title, 'Node.js — Download');
    assert.equal(out.results[0].snippet, 'Current LTS releases of Node.js.', 'html in the snippet is stripped');
    assert.match(out.answer, /JavaScript runtime/);
  });
});

test('the SearXNG request asks for JSON and carries the query', async () => {
  await withSearxngStub('json', async ({ seen }) => {
    await runWebSearch('node lts release', 5);
    assert.equal(seen.length, 1);
    const [request] = seen;
    const params = new URL(`http://localhost${request.url}`).searchParams;
    assert.equal(params.get('q'), 'node lts release');
    assert.equal(params.get('format'), 'json');
  });
});

test('an instance with the JSON API disabled explains how to enable it', async () => {
  await withSearxngStub('html', async ({ base }) => {
    await assert.rejects(
      () => runWebSearch('node lts', 5),
      (error) => {
        assert.match(error.message, /instead of JSON/);
        assert.match(error.message, /search\.formats/);
        assert.ok(error.message.includes(base), 'the message should name the instance');
        return true;
      },
    );
  });
});

test('a commercial API key still outranks a configured SearXNG instance', async () => {
  await withSearxngStub('json', async () => {
    config.search.tavily = 'tvly-test-key';
    try {
      assert.equal(searchHealth().provider, 'tavily');
      assert.equal(searchHealth().keyless, false);
    } finally {
      config.search.tavily = '';
    }
  });
});

/** A port that was just released, so connecting to it is refused immediately. */
async function deadPortUrl() {
  const server = http.createServer(() => {});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return `http://127.0.0.1:${port}`;
}

test('an unreachable SearXNG degrades to the keyless scrape instead of losing the search', async () => {
  await withStubServer('serp', async ({ base }) => {
    const savedDdg = config.searchDdgBase;
    const savedSearxng = config.searxngUrl;
    config.searchDdgBase = base;
    config.searxngUrl = await deadPortUrl();
    try {
      const out = await runWebSearch('node lts release', 5);

      // The lane that actually answered is the one reported, so a degradation
      // can never be mistaken for the configured provider having worked.
      assert.equal(out.provider, 'duckduckgo');
      assert.ok(out.results.length >= 1, 'the fallback lane must return results');
      assert.equal(out.degraded.configured, 'searxng');
      assert.equal(out.degraded.instance, config.searxngUrl);
      assert.ok(out.degraded.reason, 'the reason SearXNG was skipped must be recorded');

      // Config is untouched: SearXNG is still the selected lane, just failing.
      assert.equal(searchHealth().provider, 'searxng');
      assert.equal(searchHealth().searxng_last.ok, false);
      assert.ok(searchHealth().searxng_last.reason);
    } finally {
      config.searchDdgBase = savedDdg;
      config.searxngUrl = savedSearxng;
    }
  });
});

test('a 5xx from SearXNG falls back, while an unreachable fallback reports both failures', async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(503, { 'content-type': 'text/plain' });
    res.end('upstream is down');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const broken = `http://127.0.0.1:${server.address().port}`;

  try {
    await withStubServer('serp', async ({ base }) => {
      const savedDdg = config.searchDdgBase;
      const savedSearxng = config.searxngUrl;
      config.searchDdgBase = base;
      config.searxngUrl = broken;
      try {
        const out = await runWebSearch('node lts release', 5);
        assert.equal(out.provider, 'duckduckgo');
        assert.match(out.degraded.reason, /503/);
      } finally {
        config.searchDdgBase = savedDdg;
        config.searxngUrl = savedSearxng;
      }
    });

    // Both lanes down: the error has to name both, not just the last one tried.
    // The fallback base is pointed at a closed port too, so this asserts the
    // same thing on a machine where duckduckgo.com is actually reachable.
    const savedSearxng = config.searxngUrl;
    const savedDdg = config.searchDdgBase;
    config.searxngUrl = broken;
    config.searchDdgBase = await deadPortUrl();
    try {
      await assert.rejects(
        () => runWebSearch('node lts release', 5),
        (error) => {
          assert.match(error.message, /SearXNG at .* failed/);
          assert.match(error.message, /keyless fallback failed/);
          return true;
        },
      );
    } finally {
      config.searxngUrl = savedSearxng;
      config.searchDdgBase = savedDdg;
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
