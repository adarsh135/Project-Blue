import { config } from '../config.js';
import {
  all,
  forgetMemory,
  listMemories,
  recentSearches,
  recordSearch,
  rememberMemory,
} from '../db.js';
import { isTextAttachment } from './attachments.js';
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

/**
 * Distinguish an empty search page from an anti-bot challenge. DuckDuckGo can
 * serve a challenge as HTTP 202, which otherwise looks like a successful but
 * empty result set.
 */
export class SearchBlockedError extends Error {
  constructor(provider, detail) {
    const advice = config.publicByok
      ? 'The hosted keyless search lane is temporarily rate-limited; try again later.'
      : 'Add TAVILY_API_KEY, BRAVE_API_KEY or SERPER_API_KEY to .env for dependable web search.';
    super(provider + ' served an anti-bot challenge instead of results' + (detail ? ' (' + detail + ')' : '') + '. ' + advice);
    this.name = 'SearchBlockedError';
    this.blocked = true;
  }
}

const DDG_BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const DDG_MIN_INTERVAL_MS = Math.min(30_000, Math.max(0, Number(process.env.BLUE_SEARCH_MIN_INTERVAL_MS ?? 3000) || 0));
let ddgNextAllowedAt = 0;
let ddgQueue = Promise.resolve();

function looksLikeDdgChallenge(body) {
  return /anomaly-modal|anomaly\.js|data-testid="anomaly/i.test(body) ||
    /Unfortunately, bots use DuckDuckGo too/i.test(body);
}

function decodeDdgHref(href) {
  const raw = String(href || '');
  const wrapped = /[?&]uddg=([^&]+)/.exec(raw);
  let target = raw;
  try { if (wrapped) target = decodeURIComponent(wrapped[1]); } catch { target = raw; }
  return target.startsWith('//') ? 'https:' + target : target;
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

async function throttleDdg() {
  let release;
  const previous = ddgQueue;
  ddgQueue = new Promise((resolve) => { release = resolve; });
  await previous;
  try {
    const wait = Math.max(0, ddgNextAllowedAt - Date.now());
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
    ddgNextAllowedAt = Date.now() + DDG_MIN_INTERVAL_MS;
  } finally {
    release();
  }
}

async function ddgHtmlLane(host, pathname, query, results, max) {
  await throttleDdg();
  const base = 'https://' + host;
  const res = await fetchWithTimeout(base + pathname, {
    method: 'POST',
    timeoutMs: 9000,
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': DDG_BROWSER_UA,
      accept: 'text/html,application/xhtml+xml',
      referer: base + '/',
    },
    body: new URLSearchParams({ q: query, kl: 'wt-wt' }).toString(),
  });
  const body = await res.text().catch(() => '');
  if (res.status === 202 || res.status === 403 || res.status === 429 || looksLikeDdgChallenge(body)) {
    throw new SearchBlockedError('DuckDuckGo', 'HTTP ' + res.status);
  }
  if (!res.ok) throw new Error('DuckDuckGo ' + host + ' returned HTTP ' + res.status);
  parseDdgHtml(body, results, max);
  return results;
}

async function searchDuckDuckGo(query, max) {
  const results = [];
  let answer = '';
  let sawChallenge = null;
  let lastLaneError = null;

  // Instant Answer is useful for definitions and known entities; the HTML lanes
  // supply the organic links needed for current news and deeper research.
  try {
    const ia = new URL('https://api.duckduckgo.com/');
    ia.searchParams.set('q', query.slice(0, 500));
    ia.searchParams.set('format', 'json');
    ia.searchParams.set('no_html', '1');
    const res = await fetchWithTimeout(ia, { timeoutMs: 8000 });
    if (res.ok) {
      const data = await res.json();
      answer = data.AbstractText || data.Answer || '';
      if (data.AbstractURL) results.push({
        title: data.Heading || query,
        url: data.AbstractURL,
        snippet: truncate(data.AbstractText || '', 400),
      });
      for (const topic of (data.RelatedTopics || []).slice(0, max)) {
        if (topic.FirstURL && topic.Text) {
          results.push({ title: truncate(topic.Text, 90), url: topic.FirstURL, snippet: truncate(topic.Text, 400) });
        }
      }
    } else if (res.status === 202 || res.status === 403 || res.status === 429) {
      sawChallenge = new SearchBlockedError('DuckDuckGo Instant Answer', 'HTTP ' + res.status);
    }
  } catch (error) {
    lastLaneError = error;
  }

  if (results.length < max) {
    for (const [host, pathname] of [
      ['html.duckduckgo.com', '/html/'],
      ['lite.duckduckgo.com', '/lite/'],
    ]) {
      try {
        await ddgHtmlLane(host, pathname, query.slice(0, 500), results, max);
      } catch (error) {
        if (error instanceof SearchBlockedError) sawChallenge = sawChallenge || error;
        else lastLaneError = error;
      }
      if (results.length >= max) break;
    }
  }

  if (results.length) return { answer, results: results.slice(0, max) };
  if (sawChallenge) throw sawChallenge;
  if (lastLaneError) throw lastLaneError;
  throw new Error('DuckDuckGo returned no results. Try a more specific query or configure a search provider in a trusted self-hosted installation.');
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
    name: 'deep_research',
    description:
      'Research a complex or current topic using several focused web searches, compare independent sources, and return source-linked evidence. Use for research briefs, comparisons, or multi-part questions.',
    parameters: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'The main research question or topic.' },
        aspects: { type: 'array', items: { type: 'string' }, description: 'Up to three focused sub-questions to investigate.' },
        max_results: { type: 'integer', description: 'Results per query (1-5).' },
      },
      required: ['topic'],
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
    name: 'data_analysis',
    description:
      'Analyze an attached CSV using deterministic statistics, missing-value checks, numeric summaries, and optional grouped count/sum/average results. Use the latest attached CSV; do not invent or execute code.',
    parameters: {
      type: 'object',
      properties: {
        file_name: { type: 'string', description: 'Optional exact CSV attachment filename.' },
        group_by: { type: 'string', description: 'Optional categorical column for a grouped chart.' },
        value_column: { type: 'string', description: 'Numeric column to aggregate when group_by is provided.' },
        operation: { type: 'string', enum: ['count', 'sum', 'average'], description: 'Grouped operation; defaults to count.' },
      },
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

export function parseCsv(text) {
  const source = String(text || '').replace(/^\uFEFF/, '');
  if (source.length > 600_000) throw new Error('CSV is too large to analyze (600 KB maximum).');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"' && source[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"' && field === '') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && source[i + 1] === '\n') i += 1;
      row.push(field);
      if (row.some((cell) => String(cell).trim() !== '')) rows.push(row);
      row = [];
      field = '';
      if (rows.length > 10_001) throw new Error('CSV is limited to 10,000 data rows.');
    } else {
      field += ch;
    }
  }
  if (quoted) throw new Error('CSV contains an unclosed quoted field.');
  row.push(field);
  if (row.some((cell) => String(cell).trim() !== '')) rows.push(row);
  if (rows.length < 2) throw new Error('CSV needs a header row and at least one data row.');
  if (rows[0].length > 50) throw new Error('CSV is limited to 50 columns.');

  const seen = new Map();
  const headers = rows.shift().map((value, index) => {
    const base = String(value || '').trim().slice(0, 100) || `column_${index + 1}`;
    const count = (seen.get(base) || 0) + 1;
    seen.set(base, count);
    return count === 1 ? base : `${base}_${count}`;
  });
  const records = rows.slice(0, 10_000).map((values) =>
    Object.fromEntries(headers.map((header, index) => [header, String(values[index] ?? '').trim()])),
  );
  return { headers, rows: records };
}

const numericValue = (value) => {
  const clean = String(value ?? '').trim().replace(/,/g, '');
  if (!clean) return null;
  const number = Number(clean);
  return Number.isFinite(number) ? number : null;
};

function analyzeCsv(attachment, args = {}) {
  const { headers, rows } = parseCsv(attachment.text);
  const columns = headers.map((name) => {
    const values = rows.map((row) => row[name]);
    const present = values.filter((value) => value !== '');
    const numeric = present.map(numericValue).filter((value) => value !== null);
    const isNumeric = numeric.length > 0 && numeric.length / Math.max(present.length, 1) >= 0.8;
    const result = {
      name,
      type: isNumeric ? 'number' : 'category',
      rows: rows.length,
      missing: rows.length - present.length,
      unique: new Set(present).size,
    };
    if (isNumeric) {
      const sorted = [...numeric].sort((a, b) => a - b);
      result.min = sorted[0];
      result.max = sorted.at(-1);
      result.mean = Number((numeric.reduce((sum, value) => sum + value, 0) / numeric.length).toFixed(4));
      result.median = Number((sorted.length % 2
        ? sorted[Math.floor(sorted.length / 2)]
        : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2).toFixed(4));
    } else {
      result.top_values = [...present.reduce((map, value) => map.set(value, (map.get(value) || 0) + 1), new Map())]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([value, count]) => ({ value: truncate(value, 80), count }));
    }
    return result;
  });

  const groupBy = String(args.group_by || '').trim();
  let series;
  let chart;
  if (groupBy) {
    if (!headers.includes(groupBy)) throw new Error(`Column "${groupBy}" is not in this CSV.`);
    const operation = ['count', 'sum', 'average'].includes(args.operation) ? args.operation : 'count';
    const valueColumn = String(args.value_column || '').trim();
    if (operation !== 'count' && !headers.includes(valueColumn)) {
      throw new Error(`Choose a valid value_column for ${operation}; available columns: ${headers.join(', ')}.`);
    }
    const buckets = new Map();
    for (const record of rows) {
      const label = record[groupBy] || '(blank)';
      if (!buckets.has(label)) buckets.set(label, { count: 0, sum: 0, values: 0 });
      const bucket = buckets.get(label);
      bucket.count += 1;
      if (operation !== 'count') {
        const value = numericValue(record[valueColumn]);
        if (value !== null) {
          bucket.sum += value;
          bucket.values += 1;
        }
      }
    }
    series = [...buckets.entries()].map(([label, bucket]) => ({
      label: truncate(label, 80),
      value: operation === 'count'
        ? bucket.count
        : Number((operation === 'sum' ? bucket.sum : bucket.sum / Math.max(bucket.values, 1)).toFixed(4)),
    })).sort((a, b) => b.value - a.value).slice(0, 30);
    chart = { group_by: groupBy, value_column: valueColumn || null, operation, series };
  }

  return {
    ok: true,
    file_name: attachment.name,
    row_count: rows.length,
    columns,
    ...(chart ? { chart } : {}),
    sample: rows.slice(0, 5),
    summary: `Analyzed ${rows.length} rows and ${headers.length} columns from ${attachment.name}.`,
  };
}

async function runDeepResearch(args, { userId, chatSessionId }) {
  const topic = String(args.topic || args.query || '').trim();
  if (!topic) throw new Error('Research topic is required.');
  const aspects = Array.isArray(args.aspects)
    ? args.aspects.map((aspect) => String(aspect).trim()).filter(Boolean).slice(0, 3)
    : [];
  const queries = [...new Set([topic, ...aspects.map((aspect) => `${topic} ${aspect}`)])].slice(0, 4);
  const attempts = await Promise.all(queries.map(async (query) => {
    try {
      const result = await runWebSearch(query, Math.min(Math.max(Number(args.max_results) || 4, 1), 5));
      await recordSearch({ userId, chatSessionId, query, provider: result.provider, results: result.results, source: 'agent' });
      return { query, ...result };
    } catch (error) {
      await recordSearch({ userId, chatSessionId, query, provider: 'unavailable', results: [], source: 'agent' });
      return { query, error: error?.message || String(error), results: [] };
    }
  }));
  const sources = [];
  const seen = new Set();
  for (const attempt of attempts) {
    for (const result of attempt.results || []) {
      if (!result.url || seen.has(result.url)) continue;
      seen.add(result.url);
      sources.push({ ...result, query: attempt.query, provider: attempt.provider || 'unknown' });
    }
  }
  return {
    ok: sources.length > 0,
    topic,
    queries,
    sources: sources.slice(0, 16),
    failures: attempts.filter((attempt) => attempt.error).map((attempt) => ({ query: attempt.query, error: attempt.error })),
    ...(sources.length ? {} : { error: attempts.map((attempt) => attempt.error).filter(Boolean).join('; ') || 'No sources were returned.' }),
    summary: `${sources.length} unique source(s) found across ${queries.length} search quer${queries.length === 1 ? 'y' : 'ies'}.`,
  };
}

export async function executeTool(name, args = {}, ctx = {}) {
  const { userId, chatSessionId = null, attachments = [] } = ctx;
  const started = Date.now();

  try {
    switch (name) {
      case 'web_search': {
        try {
          const { provider, query, answer, results } = await runWebSearch(args.query, args.max_results);
          await recordSearch({ userId, chatSessionId, query, provider, results, source: 'agent' });
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
          await recordSearch({
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

      case 'deep_research': {
        return await runDeepResearch(args, { userId, chatSessionId });
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

      case 'data_analysis': {
        const candidate = attachments.find((attachment) => {
          const csvName = String(attachment.name || '').toLowerCase().endsWith('.csv');
          return csvName && isTextAttachment(attachment) && typeof attachment.text === 'string' &&
            (!args.file_name || attachment.name === args.file_name);
        });
        if (!candidate) throw new Error('Attach a CSV file (under 600 KB) and ask me to analyze it.');
        return analyzeCsv(candidate, args);
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
          await rememberMemory(userId, args.key, args.value ?? '', 'agent');
          return { ok: true, saved: { key: args.key, value: args.value }, summary: `Remembered "${args.key}"` };
        }
        if (action === 'forget') {
          if (!args.key) throw new Error('key is required to forget a memory');
          await forgetMemory(userId, args.key);
          return { ok: true, forgotten: args.key, summary: `Forgot "${args.key}"` };
        }
        const memories = (await listMemories(userId)).map((m) => ({ key: m.key, value: m.value, updated_at: m.updated_at }));
        return { ok: true, memories, summary: `${memories.length} memor(y/ies) on file` };
      }

      case 'session_search': {
        const q = `%${String(args.query || '').trim()}%`;
        const limit = Math.min(Math.max(Number(args.limit) || 8, 1), 40);
        const rows = await all(
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
        const entries = await recentSearches(userId, { limit: args.limit || 10, q: args.query || '' });
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
    case 'deep_research':
      return [
        `TOOL deep_research ("${result.topic}")`,
        ...result.sources.map((source, index) => `[${index + 1}] ${source.title || source.url}\n${source.url}\nSearch: ${source.query}\n${source.snippet || ''}`),
        result.failures?.length ? `Searches with no response: ${result.failures.map((failure) => failure.query).join('; ')}` : '',
      ].filter(Boolean).join('\n\n');
    case 'fetch_page':
      return `TOOL fetch_page (${result.url})${result.title ? ` — ${result.title}` : ''}\n${result.text}`;
    case 'calculator':
      return `TOOL calculator: ${result.expression} = ${result.result}`;
    case 'data_analysis':
      return `TOOL data_analysis: ${JSON.stringify({ file_name: result.file_name, row_count: result.row_count, columns: result.columns, chart: result.chart, sample: result.sample }).slice(0, 18_000)}`;
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
