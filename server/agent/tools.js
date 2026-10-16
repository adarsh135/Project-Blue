import { config } from '../config.js';
import {
  all,
  forgetMemory,
  listMemories,
  one,
  recentSearches,
  recordSearch,
  rememberMemory,
} from '../db.js';
import { truncate } from '../lib/util.js';
import { evaluateExpression, prettyNumber } from './math.js';

const FETCH_TIMEOUT_MS = 12_000;

/**
 * Node's fetch reports almost every transport problem as the single word
 * "fetch failed" and hides the useful part on `error.cause`. Unwrap it so a
 * TLS/DNS/proxy problem is diagnosable instead of mysterious.
 */
function describeFetchFailure(error, url) {
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
    return new Error(`Timed out fetching ${url} (the host may be unreachable from this server).`);
  }
  const cause = error?.cause;
  const code = cause?.code || cause?.errno;
  const detail = cause?.message || error?.message || 'unknown error';
  const hint =
    code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || code === 'SELF_SIGNED_CERT_IN_CHAIN' || code === 'CERT_HAS_EXPIRED'
      ? ' The server rejects the TLS certificate chain — on a network with a TLS-inspecting proxy, point NODE_EXTRA_CA_CERTS at the proxy CA bundle.'
      : code === 'ENOTFOUND' || code === 'EAI_AGAIN'
        ? ' DNS lookup failed — check the hostname and this machine\'s resolver.'
        : code === 'ECONNREFUSED'
          ? ' The host refused the connection.'
          : '';
  return new Error(`Could not reach ${url} (${code || 'no code'}: ${detail}).${hint}`);
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'user-agent': 'ProjectBlue/1.0 (+https://github.com/adarsh135/Project-Blue)',
        'accept-language': 'en-US,en;q=0.9',
        ...(options.headers || {}),
      },
    });
  } catch (error) {
    throw describeFetchFailure(error, String(url));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pretty-print a JSON body so an API endpoint reads like a document, and cut it
 * at a line boundary rather than mid-token.
 */
function renderJson(body, maxChars) {
  let pretty = String(body);
  try {
    pretty = JSON.stringify(JSON.parse(pretty), null, 2);
  } catch {
    /* not valid JSON — show it as it arrived */
  }
  if (pretty.length <= maxChars) return pretty;
  const clipped = pretty.slice(0, maxChars);
  const lastBreak = Math.max(clipped.lastIndexOf('\n'), clipped.lastIndexOf(', '));
  return `${lastBreak > maxChars * 0.5 ? clipped.slice(0, lastBreak) : clipped}\n… (truncated)`;
}

function stripHtml(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|section|article|li|h[1-6]|tr|br)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* ------------------------------------------------------------------ */
/* web search                                                          */
/* ------------------------------------------------------------------ */

function searchProvider() {
  if (config.search.tavily) return 'tavily';
  if (config.search.brave) return 'brave';
  if (config.search.serper) return 'serper';
  if (config.searxngUrl) return 'searxng';
  return 'duckduckgo';
}

/**
 * Self-hosted SearXNG. Keyless, aggregates whatever engines the instance is
 * configured with, and is not the target of a per-IP anti-bot campaign the way
 * duckduckgo.com is — so it is the dependable path for anyone who cannot or
 * will not hold a commercial search API key.
 *
 * Requires `json` in the instance's `search.formats`; when that is missing the
 * instance answers this endpoint with its HTML UI, which we detect and explain.
 */
async function searchSearxng(query, max) {
  const url = new URL(`${config.searxngUrl}/search`);
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');
  url.searchParams.set('safesearch', '1');

  const res = await fetchWithTimeout(url, { timeoutMs: 12_000, headers: { accept: 'application/json' } });
  if (!res.ok) {
    throw new Error(
      `SearXNG ${res.status} ${res.statusText}`.trim() +
        (res.status === 403 ? ` — ${config.searxngUrl} may need "json" added to search.formats.` : ''),
    );
  }

  const contentType = res.headers.get('content-type') || '';
  const raw = await res.text();
  if (!contentType.includes('json')) {
    throw new Error(
      `SearXNG at ${config.searxngUrl} answered with ${contentType || 'an unknown content type'} instead of JSON. ` +
        'Add "json" to its search.formats setting, or point BLUE_SEARXNG_URL at an instance that has it enabled.',
    );
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`SearXNG at ${config.searxngUrl} returned a body that is not valid JSON.`);
  }

  return {
    answer: (data.answers || [])
      .map((a) => (typeof a === 'string' ? a : a?.answer))
      .filter(Boolean)
      .join(' '),
    results: (data.results || [])
      .filter((r) => r?.url)
      .slice(0, max)
      .map((r) => ({ title: r.title || r.url, url: r.url, snippet: truncate(stripHtml(r.content || ''), 400) })),
  };
}


async function searchTavily(query, max) {
  const res = await fetchWithTimeout('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      api_key: config.search.tavily,
      query,
      max_results: max,
      search_depth: 'basic',
      include_answer: true,
    }),
  });
  if (!res.ok) throw new Error(`Tavily ${res.status}`);
  const data = await res.json();
  return {
    answer: data.answer || '',
    results: (data.results || []).slice(0, max).map((r) => ({
      title: r.title,
      url: r.url,
      snippet: truncate(r.content, 400),
    })),
  };
}

async function searchBrave(query, max) {
  const url = new URL('https://api.search.brave.com/res/v1/web/search');
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(max));
  const res = await fetchWithTimeout(url, {
    headers: { accept: 'application/json', 'x-subscription-token': config.search.brave },
  });
  if (!res.ok) throw new Error(`Brave ${res.status}`);
  const data = await res.json();
  return {
    answer: data.infobox?.results?.[0]?.description || '',
    results: (data.web?.results || []).slice(0, max).map((r) => ({
      title: r.title,
      url: r.url,
      snippet: truncate(stripHtml(r.description || ''), 400),
    })),
  };
}

async function searchSerper(query, max) {
  const res = await fetchWithTimeout('https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-API-KEY': config.search.serper },
    body: JSON.stringify({ q: query, num: max }),
  });
  if (!res.ok) throw new Error(`Serper ${res.status}`);
  const data = await res.json();
  return {
    answer: data.answerBox?.answer || data.answerBox?.snippet || '',
    results: (data.organic || []).slice(0, max).map((r) => ({
      title: r.title,
      url: r.link,
      snippet: truncate(r.snippet || '', 400),
    })),
  };
}

/**
 * Thrown when a keyless search lane answered, but with an anti-bot challenge
 * instead of results. Keeping this distinct from "no results" is the whole
 * point: DuckDuckGo serves the challenge as HTTP 202, which `fetch` reports as
 * `res.ok === true`, so a naive parser sees "0 results" and the user is told
 * their query matched nothing when in fact the request was blocked.
 */
export class SearchBlockedError extends Error {
  constructor(provider, detail) {
    super(
      `${provider} served an anti-bot challenge instead of results${detail ? ` (${detail})` : ''}. ` +
        'This is an IP-reputation block on the machine running Blue, not a problem with your query. ' +
        'Add TAVILY_API_KEY, BRAVE_API_KEY or SERPER_API_KEY to .env for dependable web search.',
    );
    this.name = 'SearchBlockedError';
    this.blocked = true;
  }
}

const DDG_BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/** Markers present on DuckDuckGo's anomaly/challenge page, absent from real SERPs. */
function looksLikeDdgChallenge(body) {
  return (
    /anomaly-modal|anomaly\.js|data-testid="anomaly/i.test(body) ||
    /Unfortunately, bots use DuckDuckGo too/i.test(body)
  );
}

function decodeDdgHref(href) {
  const raw = String(href || '');
  const wrapped = /[?&]uddg=([^&]+)/.exec(raw);
  const target = wrapped ? decodeURIComponent(wrapped[1]) : raw;
  return target.startsWith('//') ? `https:${target}` : target;
}

function parseDdgHtml(html, results, max) {
  const blocks = html.split(/<div class="result__body"/).slice(1);
  for (const block of blocks) {
    const link = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    const snip = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    if (!link) continue;
    const url = decodeDdgHref(link[1]);
    if (!/^https?:/i.test(url) || results.some((r) => r.url === url)) continue;
    results.push({
      title: stripHtml(link[2]).slice(0, 160),
      url,
      snippet: snip ? truncate(stripHtml(snip[1]), 400) : '',
    });
    if (results.length >= max) break;
  }
  return results;
}

/**
 * DuckDuckGo throttles per IP: GET dies quickly, POST plus a Referer survives
 * noticeably longer, so POST is the lane we use. We also space requests out —
 * hammering the endpoint is what trips the anomaly flag in the first place.
 */
const DDG_MIN_INTERVAL_MS = Math.max(0, Number(process.env.BLUE_SEARCH_MIN_INTERVAL_MS ?? 3000) || 0);
let ddgNextAllowedAt = 0;
let ddgLastOutcome = null;

async function ddgThrottle() {
  const wait = ddgNextAllowedAt - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  ddgNextAllowedAt = Date.now() + DDG_MIN_INTERVAL_MS;
}

/** One keyless HTML lane. Returns parsed results, or throws SearchBlockedError. */
async function ddgHtmlLane(host, path, query, inbox, max) {
  // A configured base replaces duckduckgo.com entirely — for a mirror, a proxy,
  // or a local server in tests so the real transport path gets exercised.
  const base = config.searchDdgBase || `https://${host}`;
  await ddgThrottle();
  const res = await fetchWithTimeout(`${base}${path}`, {
    method: 'POST',
    timeoutMs: 9000,
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': DDG_BROWSER_UA,
      accept: 'text/html,application/xhtml+xml',
      referer: `${base}/`,
    },
    body: new URLSearchParams({ q: query, kl: 'wt-wt' }).toString(),
  });

  const body = await res.text().catch(() => '');
  // 202 is the documented anomaly status; 403/429 are the blunter forms.
  if (res.status === 202 || res.status === 403 || res.status === 429 || looksLikeDdgChallenge(body)) {
    throw new SearchBlockedError('DuckDuckGo', `HTTP ${res.status}`);
  }
  if (!res.ok) throw new Error(`DuckDuckGo ${host} returned HTTP ${res.status}`);
  parseDdgHtml(body, inbox, max);
  return inbox;
}

async function searchDuckDuckGo(query, max) {
  // Keyless best effort, two lanes: Instant Answer API (entity/definition
  // facts, never throttled) then the HTML SERP lanes (organic results).
  const results = [];
  let answer = '';
  let sawChallenge = null;
  let lastLaneError = null;

  try {
    if (config.searchDdgBase) throw new Error('keyless base overridden — skipping the public Instant Answer API');
    const ia = new URL('https://api.duckduckgo.com/');
    ia.searchParams.set('q', query);
    ia.searchParams.set('format', 'json');
    ia.searchParams.set('no_html', '1');
    const res = await fetchWithTimeout(ia, { timeoutMs: 8000 });
    if (res.ok) {
      const data = await res.json();
      answer = data.AbstractText || data.Answer || '';
      if (data.AbstractURL) {
        results.push({
          title: data.Heading || query,
          url: data.AbstractURL,
          snippet: truncate(data.AbstractText || '', 400),
        });
      }
      for (const topic of (data.RelatedTopics || []).slice(0, max)) {
        if (topic.FirstURL && topic.Text) {
          results.push({ title: truncate(topic.Text, 90), url: topic.FirstURL, snippet: truncate(topic.Text, 400) });
        }
      }
    }
  } catch {
    /* ignore, fall through to the HTML lanes */
  }

  if (results.length < max) {
    for (const [host, path] of [
      ['html.duckduckgo.com', '/html/'],
      ['lite.duckduckgo.com', '/lite/'],
    ]) {
      try {
        await ddgHtmlLane(host, path, query, results, max);
      } catch (error) {
        if (error instanceof SearchBlockedError) sawChallenge = sawChallenge || error;
        else lastLaneError = error;
      }
      if (results.length >= max) break;
    }
  }

  ddgLastOutcome = {
    at: new Date().toISOString(),
    query,
    results: results.length,
    blocked: !results.length && Boolean(sawChallenge),
    error: !results.length && lastLaneError ? lastLaneError.message : null,
  };

  // Partial results still count as success — only fail when we truly got nothing.
  if (!results.length) {
    if (sawChallenge) throw sawChallenge;
    // A transport failure (DNS, TLS, firewall) is more informative than "no
    // provider answered", so prefer it when we have one.
    if (lastLaneError) throw lastLaneError;
    throw new Error(
      'No keyless search provider responded. Add TAVILY_API_KEY, BRAVE_API_KEY or SERPER_API_KEY to .env for reliable web search.',
    );
  }
  return { answer, results: results.slice(0, max) };
}

/** Health snapshot for /api/status — "is the keyless lane currently blocked?". */
export function searchHealth() {
  const provider = searchProvider();
  return {
    provider,
    keyless: provider === 'duckduckgo' || provider === 'searxng',
    instance: provider === 'searxng' ? config.searxngUrl : undefined,
    last: ddgLastOutcome,
  };
}

export async function runWebSearch(query, maxResults = 5) {
  if (config.searchOffline) {
    throw new Error('Web search is disabled (BLUE_SEARCH_OFFLINE=true).');
  }
  const provider = searchProvider();
  const max = Math.min(Math.max(Number(maxResults) || 5, 1), 10);
  const q = String(query || '').trim();
  if (!q) throw new Error('Query is required');
  const handler = {
    tavily: searchTavily,
    brave: searchBrave,
    serper: searchSerper,
    searxng: searchSearxng,
    duckduckgo: searchDuckDuckGo,
  }[provider];
  const { answer, results } = await handler(q, max);
  return { provider, query: q, answer, results };
}

/* ------------------------------------------------------------------ */
/* tool definitions                                                    */
/* ------------------------------------------------------------------ */

export const TOOL_DEFINITIONS = [
  {
    name: 'web_search',
    description:
      'Search the web for current information. Use this for facts, news, docs, prices, or anything that may have changed recently.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query.' },
        max_results: { type: 'integer', description: 'How many results to return (1-10).', default: 5 },
      },
      required: ['query'],
    },
  },
  {
    name: 'fetch_page',
    description: 'Fetch a URL and return its readable text. Use after web_search when a snippet is not enough.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute http(s) URL.' },
        max_chars: { type: 'integer', description: 'Truncate the text to this many characters (default 6000).' },
      },
      required: ['url'],
    },
  },
  {
    name: 'calculator',
    description: 'Evaluate a mathematical expression exactly. Supports + - * / % ^, parentheses, and sqrt, log, ln, sin, cos, tan, round, min, max, abs, floor, ceil, pi, e.',
    parameters: {
      type: 'object',
      properties: { expression: { type: 'string', description: 'e.g. "(1290 * 1.18) / 3"' } },
      required: ['expression'],
    },
  },
  {
    name: 'clock',
    description: 'Get the current date and time, optionally in a specific IANA timezone.',
    parameters: {
      type: 'object',
      properties: { timezone: { type: 'string', description: 'IANA timezone, e.g. "Asia/Kolkata". Defaults to UTC.' } },
    },
  },
  {
    name: 'memory',
    description:
      'Long-term memory about this user. action=save stores a durable fact; action=recall lists what is stored; action=forget removes one.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['save', 'recall', 'forget'] },
        key: { type: 'string', description: 'Short label, e.g. "timezone" or "preferred stack".' },
        value: { type: 'string', description: 'The fact to store (required for save).' },
      },
      required: ['action'],
    },
  },
  {
    name: 'session_search',
    description: "Search this user's earlier chat messages for a keyword or phrase.",
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keyword or phrase to look for.' },
        limit: { type: 'integer', description: 'Max matches (default 8).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'search_history',
    description: "List this user's recent searches (the Recent searches panel), optionally filtered.",
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Optional filter substring.' },
        limit: { type: 'integer', description: 'Max entries (default 10).' },
      },
    },
  },
];

/* ------------------------------------------------------------------ */
/* execution                                                           */
/* ------------------------------------------------------------------ */

export async function executeTool(name, args = {}, ctx = {}) {
  const { userId, chatSessionId = null } = ctx;
  const started = Date.now();

  try {
    switch (name) {
      case 'web_search': {
        try {
          const { provider, query, answer, results } = await runWebSearch(args.query, args.max_results);
          recordSearch({ userId, chatSessionId, query, provider, results, source: 'agent' });
          return {
            ok: true,
            provider,
            query,
            answer: answer || undefined,
            results,
            summary: `${results.length} result(s) from ${provider} for "${truncate(query, 80)}"`,
          };
        } catch (error) {
          // Keep the attempt in the user's search history, flagged as unavailable.
          recordSearch({
            userId,
            chatSessionId,
            query: String(args.query || '').trim(),
            provider: 'unavailable',
            results: [],
            source: 'agent',
          });
          throw error;
        }
      }

      case 'fetch_page': {
        const raw = String(args.url || '').trim();
        const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw.replace(/^\/+/, '')}`;
        const parsed = new URL(url);
        if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only http(s) URLs are supported');
        const res = await fetchWithTimeout(url, { headers: { accept: 'text/html,application/json;q=0.9,*/*;q=0.8' } });
        if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
        const contentType = res.headers.get('content-type') || '';
        const body = await res.text();
        const maxChars = Math.min(Math.max(Number(args.max_chars) || 6000, 500), 40_000);
        const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1];
        const text = contentType.includes('json') ? renderJson(body, maxChars) : stripHtml(body).slice(0, maxChars);
        return { ok: true, url, title: title ? stripHtml(title) : undefined, text, summary: `Fetched ${url}` };
      }

      case 'calculator': {
        const value = evaluateExpression(args.expression);
        return {
          ok: true,
          expression: String(args.expression),
          value,
          result: prettyNumber(value),
          summary: `${args.expression} = ${prettyNumber(value)}`,
        };
      }

      case 'clock': {
        const tz = String(args.timezone || 'UTC');
        let formatted;
        try {
          formatted = new Intl.DateTimeFormat('en-GB', {
            timeZone: tz,
            dateStyle: 'full',
            timeStyle: 'long',
          }).format(new Date());
        } catch {
          throw new Error(`Unknown timezone "${tz}"`);
        }
        return { ok: true, timezone: tz, iso: new Date().toISOString(), formatted, summary: `${tz}: ${formatted}` };
      }

      case 'memory': {
        const action = String(args.action || 'recall');
        if (action === 'save') {
          if (!args.key) throw new Error('key is required to save a memory');
          rememberMemory(userId, args.key, args.value ?? '', 'agent');
          return { ok: true, saved: { key: args.key, value: args.value }, summary: `Remembered "${args.key}"` };
        }
        if (action === 'forget') {
          if (!args.key) throw new Error('key is required to forget a memory');
          forgetMemory(userId, args.key);
          return { ok: true, forgotten: args.key, summary: `Forgot "${args.key}"` };
        }
        const memories = listMemories(userId).map((m) => ({ key: m.key, value: m.value, updated_at: m.updated_at }));
        return { ok: true, memories, summary: `${memories.length} memor(y/ies) on file` };
      }

      case 'session_search': {
        const q = `%${String(args.query || '').trim()}%`;
        const limit = Math.min(Math.max(Number(args.limit) || 8, 1), 40);
        const rows = all(
          `SELECT m.id, m.role, m.content, m.created_at, s.id AS session_id, s.title
           FROM messages m JOIN chat_sessions s ON s.id = m.chat_session_id
           WHERE m.user_id = ? AND m.content LIKE ?
           ORDER BY m.created_at DESC LIMIT ?`,
          userId,
          q,
          limit,
        );
        return {
          ok: true,
          matches: rows.map((r) => ({
            chat_session_id: r.session_id,
            title: r.title,
            role: r.role,
            when: r.created_at,
            excerpt: truncate(r.content, 300),
          })),
          summary: `${rows.length} earlier message(s) matched`,
        };
      }

      case 'search_history': {
        const entries = recentSearches(userId, { limit: args.limit || 10, q: args.query || '' });
        return {
          ok: true,
          searches: entries.map((s) => ({ query: s.query, provider: s.provider, results: s.result_count, when: s.created_at, pinned: s.pinned })),
          summary: `${entries.length} recent search(es)`,
        };
      }

      default:
        throw new Error(`Unknown tool "${name}"`);
    }
  } catch (error) {
    return {
      ok: false,
      error: error?.message || String(error),
      summary: `${name} failed: ${error?.message || error}`,
      // Preserve the "challenged by an anti-bot page" signal so the UI can
      // explain a block instead of implying the query simply matched nothing.
      blocked: error?.blocked || undefined,
      elapsed_ms: Date.now() - started,
    };
  }
}

export function toolsForEnabled(enabledNames) {
  if (!Array.isArray(enabledNames)) return TOOL_DEFINITIONS;
  return TOOL_DEFINITIONS.filter((t) => enabledNames.includes(t.name));
}

/** Compact text rendering of a tool result, for the model's context window. */
export function toolResultToText(name, result) {
  if (!result?.ok) return `TOOL ${name} ERROR: ${result?.error || 'failed'}`;
  switch (name) {
    case 'web_search':
      return [
        `TOOL web_search ("${result.query}" via ${result.provider})`,
        result.answer ? `Answer summary: ${result.answer}` : '',
        ...result.results.map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.snippet}`),
      ]
        .filter(Boolean)
        .join('\n');
    case 'fetch_page':
      return `TOOL fetch_page (${result.url})${result.title ? ` — ${result.title}` : ''}\n${result.text}`;
    case 'calculator':
      return `TOOL calculator: ${result.expression} = ${result.result}`;
    case 'clock':
      return `TOOL clock: ${result.formatted} (${result.iso})`;
    case 'memory':
      return `TOOL memory: ${JSON.stringify(result).slice(0, 3000)}`;
    case 'session_search':
      return `TOOL session_search matches:\n${result.matches
        .map((m) => `- [${m.title}] ${m.role} @ ${m.when}: ${m.excerpt}`)
        .join('\n')}`;
    case 'search_history':
      return `TOOL search_history:\n${result.searches
        .map((s) => `- "${s.query}" (${s.provider}, ${s.results} results, ${s.when})`)
        .join('\n')}`;
    default:
      return `TOOL ${name}: ${JSON.stringify(result).slice(0, 3000)}`;
  }
}
