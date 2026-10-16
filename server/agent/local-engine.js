import { rememberMemory, listMemories, recentSearches } from '../db.js';
import { truncate } from '../lib/util.js';
import { evaluateExpression, prettyNumber } from './math.js';

/**
 * Blue Local Engine — the offline fallback "model".
 *
 * Project Blue ships with zero required API keys, so when no provider is
 * configured this engine takes over. It is a deterministic planner, not a
 * language model: it classifies the request, decides which tools to call,
 * executes the agent loop, and writes the answer from real tool output instead
 * of inventing facts.
 */

export const LOCAL_MODEL = 'blue-local-1';

const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

function delayMs() {
  const raw = process.env.BLUE_LOCAL_TOKEN_DELAY_MS;
  if (raw === undefined) return 12;
  return Math.max(0, Number(raw) || 0);
}

const lower = (s) => String(s || '').toLowerCase();
const lastUserMessage = (messages) => [...messages].reverse().find((m) => m.role === 'user');
const lastAssistant = (messages) => [...messages].reverse().find((m) => m.role === 'assistant');

/* ------------------------------------------------------------------ */
/* intent detection                                                    */
/* ------------------------------------------------------------------ */

const SEARCH_VERBS = /^(?:please\s+|can you\s+|could you\s+|hey blue,?\s+)*(search|google|look\s?up|find|browse|research)\b/i;
const SEARCH_TARGET = /\b(web|online|internet|google|the news|news)\b/i;
const NEWSY = /\b(latest|current|today'?s?|recent|now|this week|2024|2025|2026)\b/i;
const QUESTION_START = /^(who|what|which|where|when|how much|how many)\s+(is|are|was|were|does|did|do)\b/i;
const PRICEY = /\b(price|prices|cost|stock|net worth|release date|weather|score|population)\b/i;

// Route a pasted URL to the page reader instead of giving generic help.
// Restrict bare-host recognition to common public TLDs so dotted identifiers
// and private-looking email addresses do not accidentally become fetch targets.
const TLD = 'com|org|net|io|dev|ai|co|edu|gov|info|biz|app|xyz|me|us|uk|in|de|fr|jp|au|ca|sh|so|to|gg|tv|news|blog|site|online|store|tech|cloud|works|wiki';
const SCHEME_URL = /\bhttps?:\/\/[^\s<>"')\]]+/i;
const BARE_URL = new RegExp('\\b(?:www\\.)?[a-z0-9][a-z0-9-]*(?:\\.[a-z0-9-]+)*\\.(?:' + TLD + ')(?:\\/[^\\s<>"\')\\]]*)?', 'i');
const FETCH_VERBS = /\b(fetch|open|read|load|visit|pull up|grab|scrape|summari[sz]e|summarise|digest|extract|review|check out|look at|what does)\b/i;

/** Pull the first URL out of a message, with or without an https:// scheme. */
export function extractUrl(text) {
  const trimmed = String(text || '');
  const match = SCHEME_URL.exec(trimmed) || BARE_URL.exec(trimmed);
  return match ? match[0].replace(/[.,;:!?]+$/, '') : '';
}

export function detectIntent(text) {
  const raw = String(text || '').trim();
  const t = lower(raw);
  if (!raw) return { kind: 'empty' };

  if (/^(hi|hello|hey|yo|hiya|namaste|good (morning|afternoon|evening))\b/.test(t)) return { kind: 'greeting' };
  if (/^(thanks|thank you|thx|ty|cheers)\b/.test(t)) return { kind: 'thanks' };
  if (/\b(who|what) (are|r) (you|u)\b|your name|about yourself|what model|which model/.test(t)) {
    return { kind: 'identity' };
  }
  if (/what can you do|how do you work|^help\b|list (your )?(tools|commands)|capabilit/.test(t)) {
    return { kind: 'capabilities' };
  }

  // recent searches
  if (/recent search(es)?|search history|(what|which).{0,20}(have i|did i|i'?ve)\s*(searched|looked up)|my searches\b/.test(t)) {
    return { kind: 'search_history' };
  }

  // memory
  if (/\b(what|list).{0,20}(do you )?(remember|know)\b.*\b(me|about me)\b|^memories$|list (my )?memor/.test(t)) {
    return { kind: 'memory_recall' };
  }
  const rememberMatch = /^(?:please\s+)?(?:remember|note|keep in mind|don'?t forget)\s+(?:that\s+|:)?(.+)$/i.exec(raw);
  if (rememberMatch) return { kind: 'memory_save', value: rememberMatch[1].trim() };
  const selfFact = /\b(?:my|i)\b/i.test(t) && /^(?:my (name|email|timezone|tz|stack|project|company|role|team|goal|preference)s? is|i (prefer|like|use|work with|work at|live in|am based in|am))\b/i.test(raw);
  if (selfFact) return { kind: 'memory_save', value: raw, auto: true };

  // session search
  const sessionMatch = /(?:find|search|look)\s+(?:in\s+)?(?:my\s+)?(?:chats?|conversations?|history|past (?:messages|chats?)|threads?)\s*(?:for|about)?\s*(.*)$/i.exec(raw);
  if (sessionMatch) return { kind: 'session_search', query: (sessionMatch[1] || '').trim() };
  if (/what did (we|i) (talk|discuss|chat) about\b(.*)$/.test(t)) {
    const rest = /what did (?:we|i) (?:talk|discuss|chat) about\s*(.*)$/i.exec(raw)?.[1] || '';
    return { kind: 'session_search', query: rest.trim() };
  }

  // clock
  const clockMatch = /(?:what(?:'s| is)?\s+)?(?:the\s+)?(?:current\s+)?(?:time|date|day)\b.*?\bin\s+([A-Za-z_\/]+(?:\/[A-Za-z_]+)?)|what time is it|what(?:'s| is) the (?:time|date)|today'?s date/i.exec(raw);
  if (clockMatch) return { kind: 'clock', timezone: clockMatch[1] || 'UTC' };

  // calculator
  const calcMatch = /^(?:what(?:'s| is)\s+)?(?:calc(?:ulate)?\s*:?\s*)?(.+)$/i.exec(raw);
  if (calcMatch && looksLikeMath(calcMatch[1])) return { kind: 'calculator', expression: cleanExpression(calcMatch[1]) };

  // A pasted page URL should be read, not searched around. An explicit
  // "search the web for <URL>" remains a search request.
  const url = extractUrl(raw);
  if (url && !(SEARCH_VERBS.test(raw) && !FETCH_VERBS.test(raw))) {
    return { kind: 'fetch_page', url };
  }

  // Deep research uses several focused queries and keeps the source trail.
  if (/\bdeep research\b|\bresearch brief\b|\bliterature review\b|\bcomprehensive report\b|\binvestigate\b|\bcompare .{0,80}sources\b/i.test(raw) || /^research\b/i.test(raw)) {
    return { kind: 'deep_research', topic: extractQuery(raw) };
  }

  // web search
  const explicit = SEARCH_VERBS.test(raw) || SEARCH_TARGET.test(raw) && /\b(search|look up|find)\b/i.test(raw);
  const queryQuestion =
    QUESTION_START.test(raw) || PRICEY.test(t) || /\b(latest|news|update|release|docs? for)\b/.test(t);
  if (explicit || queryQuestion) {
    return { kind: 'web_search', query: extractQuery(raw) };
  }

  return { kind: 'general' };
}

function cleanExpression(text) {
  return String(text).replace(/=\s*\?*$/, '').replace(/[?]+$/, '').trim();
}

function looksLikeMath(text) {
  const s = cleanExpression(text).replace(/[,\s]/g, '');
  if (!s) return false;
  if (!/^[0-9.()+\-*/%^a-z,]+$/i.test(cleanExpression(text).replace(/\s/g, '')) && !/^[0-9.()+\-*/%^,\s]+$/.test(cleanExpression(text))) {
    return false;
  }
  const hasDigits = /\d/.test(s);
  const hasOperator = /[+\-*/%^]/.test(s);
  const hasFunction = /\b(sqrt|log|ln|sin|cos|tan|round|abs|min|max|pow|floor|ceil|exp)\s*\(/i.test(text);
  return hasDigits && (hasOperator || hasFunction) && !/[a-z]{4,}\s+[a-z]{4,}/i.test(text);
}

function extractQuery(text) {
  let q = String(text).trim();
  q = q.replace(SEARCH_VERBS, '').trim();
  q = q.replace(/^(?:the\s+)?(?:web|internet|online|google)\s*(?:for|about)?\s*/i, '').trim();
  q = q.replace(/^(?:for|about)\s+/i, '').trim();
  q = q.replace(/\?+$/, '').trim();
  return q || String(text).trim();
}

/* ------------------------------------------------------------------ */
/* writing helpers                                                     */
/* ------------------------------------------------------------------ */

function inferMemoryKey(value, auto) {
  const v = lower(value);
  const myMatch = /^(?:my|i)\s+(name|email|timezone|tz|stack|project|company|role|team|goal|preference)s?\b/i.exec(value);
  if (myMatch) return myMatch[1].toLowerCase();
  if (/\bi (prefer|like|use|work with)\b/i.test(v)) return 'preferences';
  if (/\b(work at|work for)\b/i.test(v)) return 'employer';
  if (/\b(live in|based in)\b/i.test(v)) return 'location';
  if (auto) return 'profile';
  const words = value.replace(/[^\w\s]/g, ' ').trim().split(/\s+/).slice(0, 4).join(' ');
  return words || 'note';
}

function usableTools(tools) {
  return new Set((tools || []).map((t) => t.name));
}

function searchResultAnswer(query, results, provider) {
  const lines = [];
  lines.push(`Here's what I found for **${query}** using the live web search tool (${provider}):`);
  lines.push('');
  results.forEach((r, i) => {
    const snippet = r.snippet ? ` — ${truncate(r.snippet, 260)}` : '';
    lines.push(`${i + 1}. [${r.title || r.url}](${r.url})${snippet}`);
  });
  if (!results.length) lines.push('_No results came back. Rephrase the query or connect a search API key._');
  lines.push('');
  lines.push(
    'Snippets are the raw source text, so quote-check anything important by opening the links. Want me to `fetch_page` on any of these for the full article?',
  );
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* engine                                                              */
/* ------------------------------------------------------------------ */

export async function* runLocalEngine({ messages, tools = [], context = {} }) {
  const toolNames = usableTools(tools);
  const last = messages[messages.length - 1];

  // ---------- Round 2: we have tool output, write the answer ----------
  if (last?.role === 'tool') {
    // Only the tool results produced by *this* turn: everything after the last
    // assistant message that requested tools.
    const lastAssistantWithTools = messages
      .map((m) => Boolean(m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0))
      .lastIndexOf(true);
    const fresh = messages.slice(lastAssistantWithTools + 1).filter((m) => m.role === 'tool');
    const results = fresh.length ? fresh : messages.filter((m) => m.role === 'tool').slice(-1);
    yield* streamText(synthesize(results, toolNames));
    yield { type: 'end', finishReason: 'stop' };
    return;
  }

  const userText = lastUserMessage(messages)?.content || '';
  const intent = detectIntent(userText);

  const emitTool = (name, args, text) => (async function* () {
    // args are serialised exactly like a remote provider would send them
    yield { type: 'tool_call', id: `local_${Math.random().toString(36).slice(2, 10)}`, name, args: JSON.stringify(args) };
    if (text) yield { type: 'text', text };
  })();

  const attachments = lastUserMessage(messages)?.attachments || [];
  const csv = attachments.find((attachment) => String(attachment.name || '').toLowerCase().endsWith('.csv'));
  if (csv) {
    if (!toolNames.has('data_analysis')) {
      yield* streamText('CSV analysis is switched off in Settings → Tools. Enable `data_analysis` and ask again.');
      yield { type: 'end', finishReason: 'stop' };
      return;
    }
    yield* emitTool('data_analysis', { file_name: csv.name }, `_Analyzing ${csv.name} safely…_`);
    yield { type: 'end', finishReason: 'tool_calls' };
    return;
  }
  if (attachments.some((attachment) => attachment.kind !== 'text')) {
    yield* streamText('The offline Blue Local Engine cannot inspect images, PDFs, audio, or video. Select a connected multimodal provider (Gemini supports these formats; OpenAI-compatible models and Ollama support images; Anthropic supports images and PDFs).');
    yield { type: 'end', finishReason: 'stop' };
    return;
  }
  if (attachments.length) {
    yield* streamText('I can store text, code and document attachments with your chat, but the offline planner cannot summarize arbitrary files. Select a connected model to analyze them; CSV statistics remain available with the `data_analysis` tool.');
    yield { type: 'end', finishReason: 'stop' };
    return;
  }

  switch (intent.kind) {
    case 'greeting': {
      const name = context.user?.name?.split(' ')[0];
      yield* streamText(
        `Hey${name ? ` ${name}` : ''} 👋 I'm **Blue**. Ask me anything — I can search the web, read pages, do math, remember facts about you, and search back through your earlier chats and searches.`,
      );
      yield { type: 'end', finishReason: 'stop' };
      return;
    }

    case 'thanks':
      yield* streamText("Anytime. What's next?");
      yield { type: 'end', finishReason: 'stop' };
      return;

    case 'identity':
      yield* streamText(
        [
          "I'm **Blue** — the assistant built into Project Blue. Think of me as a self-hosted agentic assistant in the same mould as Arena's Agent Mode:",
          '',
          '- **Credentials & sessions** — you sign in with an account, and every chat, search and memory is scoped to your account. Sessions can be listed and revoked, and machine clients can use `blue_sk_…` API keys.',
          '- **Agent loop with tools** — web research with source links, page reading, exact maths, CSV statistics, timezone lookup, memory and chat-history search.',
          '- **Multimodal input** — connected providers can inspect images; Gemini also accepts PDFs, audio and video. Text, CSV and code files can be attached directly.',
          '- **Persistent memory** — account-scoped facts, plus **Recent searches** saved per user across chats.',
          '- **Work modes** — reasoning summaries, research, coding, planning and writing guidance. I provide concise explanations, not private chain-of-thought.',
          '',
          `Right now I'm answering from the **offline Blue Local Engine** (\`${LOCAL_MODEL}\`), which runs with no API key at all. Add \`OPENAI_API_KEY\`, \`ANTHROPIC_API_KEY\`, \`GEMINI_API_KEY\` or \`OLLAMA_BASE_URL\` to \`.env\` and I'll route through that model while keeping the exact same auth, sessions, memory and search plumbing.`,
        ].join('\n'),
      );
      yield { type: 'end', finishReason: 'stop' };
      return;

    case 'capabilities':
      yield* streamText(
        [
          '**What I can do right now**',
          '',
          '| Tool | What it gives you |',
          '| --- | --- |',
          '| 🔎 `web_search` / `deep_research` | Current results, multi-query research, source links and saved search history |',
          '| 📄 `fetch_page` | Readable text from public web pages |',
          '| 📊 `data_analysis` | CSV statistics, missing values and grouped chart data |',
          '| 🧮 `calculator` | Exact arithmetic — no guessing at numbers |',
          '| 🕒 `clock` | Current time in any timezone |',
          '| 🧠 `memory` | Durable facts about you, stored in your account |',
          '| 💬 `session_search` | Search every message in your earlier chats |',
          '| 🗂️ `search_history` | Replay your recent searches |',
          '',
          '**How to drive me**',
          '- "search for the latest React 19 changes"',
          '- "remember my timezone is Asia/Kolkata"',
          '- "what did we discuss about SQLite?"',
          '- "show my recent searches"',
          '',
          `Engine in use: **${LOCAL_MODEL}** (offline planner) unless a provider key is configured.`,
        ].join('\n'),
      );
      yield { type: 'end', finishReason: 'stop' };
      return;

    case 'deep_research': {
      if (!toolNames.has('deep_research')) {
        yield* streamText('The `deep_research` tool is disabled. Enable it in Settings → Tools, or ask for a single web search.');
        yield { type: 'end', finishReason: 'stop' };
        return;
      }
      yield* emitTool('deep_research', { topic: intent.topic, aspects: [] }, `_Researching "${intent.topic}" across several searches…_`);
      yield { type: 'end', finishReason: 'tool_calls' };
      return;
    }

    case 'search_history': {
      if (!toolNames.has('search_history')) {
        yield* streamText('The `search_history` tool is switched off in Settings → Tools, so I can\'t read your search log.');
        yield { type: 'end', finishReason: 'stop' };
        return;
      }
      yield* emitTool('search_history', { limit: 10 }, '_Checking your recent searches…_');
      yield { type: 'end', finishReason: 'tool_calls' };
      return;
    }

    case 'memory_recall': {
      if (!toolNames.has('memory')) {
        yield* streamText('The `memory` tool is disabled in your settings, so I can\'t recall stored facts.');
        yield { type: 'end', finishReason: 'stop' };
        return;
      }
      yield* emitTool('memory', { action: 'recall' }, '_Looking up what I have on file…_');
      yield { type: 'end', finishReason: 'tool_calls' };
      return;
    }

    case 'memory_save': {
      if (!toolNames.has('memory')) {
        yield* streamText('Memory is switched off in your settings, so I can\'t persist that.');
        yield { type: 'end', finishReason: 'stop' };
        return;
      }
      const key = inferMemoryKey(intent.value, intent.auto);
      await rememberMemory(context.userId, key, intent.value, 'agent');
      yield* streamText(`Noted — saved under **${key}** in your account memory:\n\n> ${intent.value}`);
      yield { type: 'end', finishReason: 'stop' };
      return;
    }

    case 'session_search': {
      if (!toolNames.has('session_search')) {
        yield* streamText('The `session_search` tool is off in your settings.');
        yield { type: 'end', finishReason: 'stop' };
        return;
      }
      const query = intent.query || userText.split(/\s+/).slice(-3).join(' ');
      yield* emitTool('session_search', { query, limit: 8 }, `_Searching your past messages for "${query}"…_`);
      yield { type: 'end', finishReason: 'tool_calls' };
      return;
    }

    case 'clock': {
      if (!toolNames.has('clock')) {
        yield* streamText(`It's ${new Date().toISOString()} (UTC). The clock tool is disabled, so no timezone conversion.`);
        yield { type: 'end', finishReason: 'stop' };
        return;
      }
      yield* emitTool('clock', { timezone: intent.timezone || 'UTC' });
      yield { type: 'end', finishReason: 'tool_calls' };
      return;
    }

    case 'calculator': {
      if (!toolNames.has('calculator')) {
        yield* streamText('The calculator tool is disabled in your settings.');
        yield { type: 'end', finishReason: 'stop' };
        return;
      }
      yield* emitTool('calculator', { expression: intent.expression });
      yield { type: 'end', finishReason: 'tool_calls' };
      return;
    }

    case 'fetch_page': {
      if (!toolNames.has('fetch_page')) {
        yield* streamText(
          `Reading pages is switched off in your settings, so I can't open ${intent.url}. Enable \`fetch_page\` in Settings → Tools.`,
        );
        yield { type: 'end', finishReason: 'stop' };
        return;
      }
      yield* emitTool('fetch_page', { url: intent.url, max_chars: 6000 }, `_Fetching ${intent.url}…_`);
      yield { type: 'end', finishReason: 'tool_calls' };
      return;
    }

    case 'web_search': {
      if (!toolNames.has('web_search')) {
        yield* streamText(`Web search is disabled in your settings, so I can't look up "${intent.query}". Enable \`web_search\` in Settings → Tools.`);
        yield { type: 'end', finishReason: 'stop' };
        return;
      }
      yield* emitTool('web_search', { query: intent.query, max_results: 5 }, `_Searching the web for "${intent.query}"…_`);
      yield { type: 'end', finishReason: 'tool_calls' };
      return;
    }

    default: {
      yield* streamText(await generalAnswer(userText, context, toolNames));
      yield { type: 'end', finishReason: 'stop' };
    }
  }
}

/** Write the final answer from real tool output. */
function synthesize(toolMessages, toolNames) {
  const blocks = [];
  for (const m of toolMessages) {
    let payload;
    try {
      payload = JSON.parse(m.content);
    } catch {
      blocks.push(String(m.content));
      continue;
    }
    if (payload.ok === false) {
      const hints = {
        web_search:
          'No search provider answered. Keyless DuckDuckGo works from most networks; for anything stricter add `TAVILY_API_KEY`, `BRAVE_API_KEY` or `SERPER_API_KEY` to `.env` and restart the server.',
        deep_research: 'Check the web-search provider configuration, then retry with a narrower question.',
        fetch_page: 'Check the URL is public and reachable from the server running Blue.',
        data_analysis: 'Attach a valid CSV file under 600 KB and ensure data_analysis is enabled.',
        memory: 'That memory action failed — the key is probably missing.',
        session_search: 'That history lookup failed.',
        search_history: 'Reading your search log failed.',
      };
      blocks.push(
        [
          `### ⚠️ \`${payload.__tool}\` failed`,
          '',
          payload.error ? `> ${payload.error}` : '',
          '',
          hints[payload.__tool] || '',
        ]
          .filter((line) => line !== '')
          .join('\n'),
      );
      continue;
    }
    if (payload.__tool === 'web_search' && payload.ok) {
      blocks.push(searchResultAnswer(payload.query, payload.results, payload.provider));
    } else if (payload.__tool === 'deep_research' && payload.ok) {
      blocks.push([
        `## Research brief: ${payload.topic}`,
        '',
        `I searched ${payload.queries.length} focused queries and found ${payload.sources.length} unique source(s). Treat snippets as leads and verify important claims on the linked pages.`,
        '',
        ...payload.sources.map((source, index) => `${index + 1}. [${source.title || source.url}](${source.url}) — ${truncate(source.snippet || 'No snippet provided.', 280)}\n   _Search: ${source.query}_`),
      ].join('\n'));
    } else if (payload.__tool === 'data_analysis' && payload.ok) {
      const header = '| Column | Type | Missing | Unique | Min | Max | Mean |';
      const separator = '| --- | --- | ---: | ---: | ---: | ---: | ---: |';
      const rows = payload.columns.map((column) =>
        `| ${column.name.replace(/\|/g, '\\|')} | ${column.type} | ${column.missing} | ${column.unique} | ${column.min ?? '—'} | ${column.max ?? '—'} | ${column.mean ?? '—'} |`,
      );
      const chartRows = payload.chart?.series?.map((item) => `- ${item.label}: **${item.value}**`) || [];
      blocks.push([
        `## CSV analysis: ${payload.file_name}`,
        '',
        `Analyzed **${payload.row_count} rows**. The values below come from deterministic local parsing and summary statistics.`,
        '',
        header,
        separator,
        ...rows,
        ...(payload.chart ? ['', `### Grouped ${payload.chart.operation} by ${payload.chart.group_by}`, ...chartRows] : []),
        '',
        'Sample rows:',
        '```json',
        JSON.stringify(payload.sample, null, 2),
        '```',
      ].join('\n'));
    } else if (payload.__tool === 'fetch_page' && payload.ok) {
      blocks.push(
        [
          `**${payload.title || payload.url}**`,
          `<${payload.url}>`,
          '',
          truncate(payload.text, 2000),
          '',
          `_That's the first ${Math.min(2000, (payload.text || '').length)} characters. Ask me to summarise a specific section._`,
        ].join('\n'),
      );
    } else if (payload.__tool === 'calculator' && payload.ok) {
      blocks.push(`\`${payload.expression}\` = **${payload.result}**`);
    } else if (payload.__tool === 'clock' && payload.ok) {
      blocks.push(`**${payload.formatted}** (${payload.timezone}) — UTC now: \`${payload.iso}\``);
    } else if (payload.__tool === 'memory' && payload.ok) {
      if (!payload.memories?.length) {
        blocks.push("I don't have anything stored about you yet. Say something like _\"remember my timezone is Asia/Kolkata\"_ and I'll keep it.");
      } else {
        blocks.push(
          [
            '**What I remember about you**',
            '',
            '| Key | Value | Updated |',
            '| --- | --- | --- |',
            ...payload.memories.map(
              (m) => `| \`${m.key}\` | ${truncate(String(m.value).replace(/\|/g, '\\|'), 160)} | ${String(m.updated_at).slice(0, 10)} |`,
            ),
          ].join('\n'),
        );
      }
    } else if (payload.__tool === 'session_search' && payload.ok) {
      if (!payload.matches?.length) {
        blocks.push("No earlier messages matched that. Try a broader keyword, or check a different chat.");
      } else {
        blocks.push(
          [
            `**${payload.matches.length} earlier message(s) matched**`,
            '',
            ...payload.matches.map((m) => `- **${m.title}** · _${m.role}_ · ${String(m.when).slice(0, 16).replace('T', ' ')}\n  > ${truncate(m.excerpt, 240)}`),
          ].join('\n'),
        );
      }
    } else if (payload.__tool === 'search_history' && payload.ok) {
      if (!payload.searches?.length) {
        blocks.push('Your search log is empty so far — run a search and it will show up here.');
      } else {
        blocks.push(
          [
            '**Recent searches**',
            '',
            '| When | Query | Provider | Results |',
            '| --- | --- | --- | --- |',
            ...payload.searches.map(
              (s) => `| ${String(s.when).slice(0, 16).replace('T', ' ')} | ${truncate(s.query.replace(/\|/g, '\\|'), 80)} | ${s.provider} | ${s.results} |`,
            ),
            '',
            '_These are stored per user in the `searches` table and shown in the Recent searches panel of the sidebar._',
          ].join('\n'),
        );
      }
    } else {
      blocks.push(`\`\`\`json\n${truncate(JSON.stringify(payload, null, 2), 1500)}\n\`\`\``);
    }
  }
  return blocks.join('\n\n---\n\n');
}

async function generalAnswer(text, context, toolNames) {
  const topic = truncate(String(text).trim(), 160);
  const isQuestion = /\?\s*$/.test(String(text).trim()) || /^(how|why|what|when|where|which|who|can|should|do|does|is|are)\b/i.test(text.trim());
  const memories = (await listMemories(context.userId)).slice(0, 6);
  const searches = await recentSearches(context.userId, { limit: 4 });

  const parts = [];

  if (isQuestion) {
    parts.push(`Here's the problem I'm looking at: **${topic}**`);
    parts.push('');
    parts.push('Running on the offline `blue-local-1` planner, I can\'t free-form reason about it the way a frontier model would, so here is the honest version plus the useful parts I *can* do:');
  } else {
    parts.push(`You asked for: **${topic}**`);
    parts.push('');
    parts.push('I\'m answering from the offline `blue-local-1` planner, so let me be straight about what that means and what I can still deliver:');
  }

  parts.push('');
  parts.push('**What I can do with this right now**');
  const suggestions = [];
  if (toolNames.has('web_search')) suggestions.push(`- \`web_search\` — say _"search for ${truncate(topic, 60)}"_ and I'll return live, cited results.`);
  if (toolNames.has('fetch_page')) suggestions.push('- `fetch_page` — give me a URL and I\'ll pull the readable text out of it.');
  if (toolNames.has('calculator')) suggestions.push('- `calculator` — send me the numbers and I\'ll compute them exactly.');
  if (toolNames.has('memory')) suggestions.push('- `memory` — _"remember that …"_ and I\'ll keep it with your account for later chats.');
  if (toolNames.has('session_search')) suggestions.push('- `session_search` — I can dig this up if we discussed it in an earlier chat.');
  parts.push(suggestions.join('\n') || '- (all tools are currently disabled in Settings → Tools)');

  if (memories.length) {
    parts.push('');
    parts.push(`**Relevant things I remember about you:** ${memories.map((m) => `\`${m.key}\` = ${truncate(m.value, 60)}`).join(' · ')}`);
  }
  if (searches.length) {
    parts.push('');
    parts.push(`**Your recent searches** (so you don't repeat yourself): ${searches.map((s) => `"${truncate(s.query, 40)}"`).join(', ')}`);
  }

  parts.push('');
  parts.push('**To unlock full reasoning here** — add any one of these to `.env` and restart:');
  parts.push('');
  parts.push('```bash\nOPENAI_API_KEY=sk-...        # or any OpenAI-compatible endpoint\nANTHROPIC_API_KEY=sk-ant-...  # Claude\nGEMINI_API_KEY=...            # Gemini\nOLLAMA_BASE_URL=http://localhost:11434  # local models, no key needed\n```');
  parts.push('');
  parts.push('Everything else — your login, sessions, chat history, recent searches and memories — stays exactly as it is. The provider is just the brain behind the same agent loop.');

  return parts.join('\n');
}

/** Stream text in human-sized chunks so the UI feels alive. */
async function* streamText(text) {
  const chunkSize = 18;
  const pause = delayMs();
  for (let i = 0; i < text.length; i += chunkSize) {
    yield { type: 'text', text: text.slice(i, i + chunkSize) };
    if (pause > 0) await sleep(pause);
  }
}
