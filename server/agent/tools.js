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
  } finally {
    clearTimeout(timer);
  }
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
  return 'duckduckgo';
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

async function searchDuckDuckGo(query, max) {
  // Keyless best effort: Instant Answer API first, then the HTML endpoint.
  const results = [];
  let answer = '';
  try {
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
    /* ignore, fall through to HTML endpoint */
  }

  if (results.length < max) {
    try {
      const htmlUrl = new URL('https://html.duckduckgo.com/html/');
      htmlUrl.searchParams.set('q', query);
      const res = await fetchWithTimeout(htmlUrl, { timeoutMs: 9000 });
      if (res.ok) {
        const html = await res.text();
        const blocks = html.split(/<div class="result__body"/).slice(1);
        for (const block of blocks) {
          const link = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
          const snip = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/.exec(block);
          if (!link) continue;
          let href = link[1];
          const wrapped = /uddg=([^&]+)/.exec(href);
          if (wrapped) href = decodeURIComponent(wrapped[1]);
          const url = href.startsWith('//') ? `https:${href}` : href;
          if (results.some((r) => r.url === url)) continue;
          results.push({
            title: stripHtml(link[2]).slice(0, 160),
            url,
            snippet: snip ? truncate(stripHtml(snip[1]), 400) : '',
          });
          if (results.length >= max) break;
        }
      }
    } catch {
      /* ignore */
    }
  }

  if (!results.length) {
    throw new Error(
      'No keyless search provider responded. Add TAVILY_API_KEY, BRAVE_API_KEY or SERPER_API_KEY to .env for reliable web search.',
    );
  }
  return { answer, results: results.slice(0, max) };
}

export async function runWebSearch(query, maxResults = 5) {
  if (config.searchOffline) {
    throw new Error('Web search is disabled (BLUE_SEARCH_OFFLINE=true).');
  }
  const provider = searchProvider();
  const max = Math.min(Math.max(Number(maxResults) || 5, 1), 10);
  const q = String(query || '').trim();
  if (!q) throw new Error('Query is required');
  const handler = { tavily: searchTavily, brave: searchBrave, serper: searchSerper, duckduckgo: searchDuckDuckGo }[provider];
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
        const text = contentType.includes('json') ? body.slice(0, maxChars) : stripHtml(body).slice(0, maxChars);
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
