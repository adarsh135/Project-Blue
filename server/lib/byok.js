import { AsyncLocalStorage } from 'node:async_hooks';
import { neonConfig } from '@neondatabase/serverless';

// Only this request's asynchronous context owns the plaintext credential.
export const credentialContext = new AsyncLocalStorage();
export const visitorKey = () => credentialContext.getStore()?.key || '';
const upstreamFetch = globalThis.fetch;
const endpoints = new Set([
  'https://api.openai.com/v1/chat/completions',
  'https://api.anthropic.com/v1/messages',
]);
export function validateVisitorKey(value) {
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.length < 8 || value.length > 512 || !/^[\x21-\x7e]+$/.test(value)) {
    throw new Error('Enter a valid provider API key (8–512 non-space ASCII characters).');
  }
  return value;
}

// Public-mode outbound policy for the existing model AND tool adapters.
// Neon is trusted server-owned infrastructure, not an agent/tool request: give
// its driver a separate transport so migrations/auth/SQL still work without a
// visitor key. Never attach a visitor credential to database traffic.
export function installPublicTransport() {
  neonConfig.fetchFunction = upstreamFetch;
  globalThis.fetch = async (input, options = {}) => {
    const key = visitorKey();
    const fail = () => { throw new Error('Provider request failed. Check your key, model, quota and provider availability.'); };
    if (!key) return fail();
    let url;
    try { url = new URL(String(input)); } catch { return fail(); }
    const gemini = url.origin === 'https://generativelanguage.googleapis.com' &&
      /^\/v1beta\/models\/[A-Za-z0-9._-]+:streamGenerateContent$/.test(url.pathname);
    const exact = endpoints.has(`${url.origin}${url.pathname}`);
    if ((!exact && !gemini) || url.username || url.password || url.hash || options.method !== 'POST') return fail();
    const headers = new Headers(options.headers);
    const credentialMatches = gemini
      ? !url.searchParams.has('key') && url.searchParams.get('alt') === 'sse' && [...url.searchParams.keys()].every(k => k === 'alt') && headers.get('x-goog-api-key') === key
      : !url.search && (url.hostname === 'api.openai.com' ? headers.get('authorization') === `Bearer ${key}` : headers.get('x-api-key') === key);
    if (!credentialMatches) return fail();
    // Gemini credentials must already be in the header; query-string keys are rejected.
    try {
      const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(45_000)]) : AbortSignal.timeout(45_000);
      const response = await upstreamFetch(url, { ...options, headers, redirect: 'error', signal });
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        return fail();
      }
      const reader = response.body.getReader();
      const body = new ReadableStream({
        async pull(controller) {
          try {
            const item = await reader.read();
            if (item.done) controller.close(); else controller.enqueue(item.value);
          } catch { controller.error(new Error('Provider stream interrupted. Please retry.')); }
        },
        cancel(reason) { return reader.cancel(reason); },
      });
      return new Response(body, { status: response.status, headers: response.headers });
    } catch { return fail(); }
  };
}
export function publicCredentialMiddleware(req, res, next) {
  let key;
  try { key = validateVisitorKey(req.headers['x-blue-provider-key']); }
  catch (error) { return res.status(400).json({ error: error.message }); }
  delete req.headers['x-blue-provider-key'];
  if (Array.isArray(req.rawHeaders)) {
    for (let i = req.rawHeaders.length - 2; i >= 0; i -= 2) {
      if (req.rawHeaders[i].toLowerCase() === 'x-blue-provider-key') req.rawHeaders.splice(i, 2);
    }
  }
  const chat = req.method === 'POST' && (req.path === '/api/chat' || /^\/api\/sessions\/[^/]+\/messages$/.test(req.path));
  if (chat && req.body?.provider !== 'local' && !key) {
    return res.status(400).json({ error: 'A visitor-owned provider key is required. Select Blue Local Engine explicitly for offline chat.' });
  }
  const context = { key: chat ? key : '' };
  const clear = () => { context.key = ''; };
  res.once('finish', clear);
  res.once('close', clear);
  return credentialContext.run(context, next);
}
