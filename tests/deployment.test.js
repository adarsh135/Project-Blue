import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blue-vercel-test-'));
process.env.NODE_ENV = 'development';
process.env.VERCEL = '1';
// This test probes the local listener with outbound fetch(). Keep the generic
// Vercel routing test out of public BYOK transport mode; that policy is tested
// separately in tests/byok.test.js with mock-only provider traffic.
process.env.BLUE_PUBLIC_BYOK = 'false';
process.env.DATABASE_URL = '';
process.env.POSTGRES_URL = '';
process.env.POSTGRES_URL_NON_POOLING = '';
process.env.BLUE_DATA_DIR = dataDir;
process.env.BLUE_SESSION_SECRET = 'deployment-test-session-secret-only';

const vercelConfig = JSON.parse(fs.readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
const { default: app } = await import('../api/index.js');
let server;
let base;

before(async () => {
  server = app.listen(0, '127.0.0.1');
  if (!server.listening) await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server?.listening) await new Promise((resolve) => server.close(resolve));
});

test('Vercel routes the site to one Node function and includes its static assets', () => {
  assert.equal(vercelConfig.functions['api/index.js'].maxDuration, 60);
  assert.equal(vercelConfig.functions['api/index.js'].includeFiles, '{public,skills}/**');
  assert.ok(vercelConfig.rewrites.some((route) => route.source === '/(.*)' && route.destination === '/api'));
  const responseHeaders = vercelConfig.headers[0].headers;
  assert.ok(responseHeaders.some((header) => header.key === 'Content-Security-Policy'));
  assert.ok(responseHeaders.some((header) => header.key === 'X-Content-Type-Options' && header.value === 'nosniff'));
  const entrypoint = fs.readFileSync(new URL('../api/index.js', import.meta.url), 'utf8');
  assert.match(entrypoint, /await ready/);
  assert.doesNotMatch(entrypoint, /\.listen\s*\(/);
});

test('Vercel production refuses to start without durable storage and a stable session secret', () => {
  const runConfig = (overrides = {}) => spawnSync(process.execPath, [
    '--input-type=module',
    '-e',
    "await import('./server/config.js')",
  ], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH || '',
      NODE_ENV: 'production',
      VERCEL: '1',
      DATABASE_URL: '',
      POSTGRES_URL: '',
      POSTGRES_URL_NON_POOLING: '',
      BLUE_SESSION_SECRET: '',
      ...overrides,
    },
  });
  const missingDatabase = runConfig();
  assert.notEqual(missingDatabase.status, 0);
  assert.match(missingDatabase.stderr, /requires DATABASE_URL/);

  const missingSecret = runConfig({ DATABASE_URL: 'postgres://user:password@example.invalid/database' });
  assert.notEqual(missingSecret.status, 0);
  assert.match(missingSecret.stderr, /BLUE_SESSION_SECRET.*32 characters/);
});

test('serverless Express entry point serves API and browser assets without opening its own listener', async () => {
  const health = await fetch(`${base}/api/status`);
  const data = await health.json();
  assert.equal(health.status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.database, 'sqlite');

  const asset = await fetch(`${base}/js/app.js`);
  assert.equal(asset.status, 200);
  assert.match(await asset.text(), /function boot\(/);
});
