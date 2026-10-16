import { config, describeProviderError } from '../config.js';

/**
 * Streaming model adapters.
 *
 * Every adapter is an async generator that yields:
 *   { type: 'text',  text }                          incremental assistant text
 *   { type: 'tool_call', id, name, args }             a tool the model wants to run
 *   { type: 'usage', input, output }                  token accounting (best effort)
 *   { type: 'end', finishReason }
 */

function sseLines(buffer, chunk) {
  const combined = buffer + chunk;
  const lines = combined.split('\n');
  return { rest: lines.pop() ?? '', lines };
}

/** Read a failed response body without ever throwing, then explain it. */
async function failWith({ providerId, model, res }) {
  const body = await res.text().catch(() => res.statusText);
  throw describeProviderError({ providerId, model, status: res.status, body });
}

async function* openaiStream({ apiKey, baseUrl, model, messages, tools, temperature, signal }) {
  const body = {
    model,
    messages,
    temperature,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (tools?.length) {
    body.tools = tools.map((t) => ({ type: 'function', function: t }));
    body.tool_choice = 'auto';
  }

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    await failWith({ providerId: 'openai', model, res });
  }

  let buffer = '';
  const pending = new Map(); // index -> {id, name, args}
  let finishReason = 'stop';

  for await (const chunk of res.body) {
    const { rest, lines } = sseLines(buffer, Buffer.from(chunk).toString('utf8'));
    buffer = rest;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === '[DONE]') continue;
      let json;
      try {
        json = JSON.parse(payload);
      } catch {
        continue;
      }
      if (json.usage) yield { type: 'usage', input: json.usage.prompt_tokens || 0, output: json.usage.completion_tokens || 0 };
      const choice = json.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const delta = choice.delta || {};
      if (delta.content) yield { type: 'text', text: delta.content };
      for (const call of delta.tool_calls || []) {
        const idx = call.index ?? 0;
        const entry = pending.get(idx) || { id: call.id || `call_${idx}`, name: '', args: '' };
        if (call.id) entry.id = call.id;
        if (call.function?.name) entry.name += call.function.name;
        if (call.function?.arguments) entry.args += call.function.arguments;
        pending.set(idx, entry);
      }
    }
  }

  for (const [, entry] of [...pending.entries()].sort((a, b) => a[0] - b[0])) {
    if (!entry.name) continue;
    yield { type: 'tool_call', id: entry.id, name: entry.name, args: entry.args || '{}' };
  }
  yield { type: 'end', finishReason };
}

async function* anthropicStream({ apiKey, baseUrl, model, system, messages, tools, temperature, signal }) {
  const body = {
    model,
    system,
    max_tokens: 4096,
    temperature,
    stream: true,
    messages,
  };
  if (tools?.length) {
    body.tools = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters || { type: 'object', properties: {} },
    }));
  }

  const res = await fetch(`${baseUrl}/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    await failWith({ providerId: 'anthropic', model, res });
  }

  let buffer = '';
  let currentTool = null;
  let finishReason = 'stop';
  let inputTokens = 0;
  let outputTokens = 0;

  for await (const chunk of res.body) {
    const { rest, lines } = sseLines(buffer, Buffer.from(chunk).toString('utf8'));
    buffer = rest;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      let json;
      try {
        json = JSON.parse(trimmed.slice(5).trim());
      } catch {
        continue;
      }
      switch (json.type) {
        case 'message_start':
          inputTokens = json.message?.usage?.input_tokens || 0;
          break;
        case 'content_block_start':
          if (json.content_block?.type === 'tool_use') {
            currentTool = { id: json.content_block.id, name: json.content_block.name, args: '' };
          }
          break;
        case 'content_block_delta':
          if (json.delta?.type === 'text_delta') yield { type: 'text', text: json.delta.text };
          if (json.delta?.type === 'input_json_delta' && currentTool) currentTool.args += json.delta.partial_json;
          break;
        case 'content_block_stop':
          if (currentTool) {
            yield { type: 'tool_call', id: currentTool.id, name: currentTool.name, args: currentTool.args || '{}' };
            currentTool = null;
          }
          break;
        case 'message_delta':
          if (json.delta?.stop_reason) finishReason = json.delta.stop_reason;
          outputTokens = json.usage?.output_tokens || outputTokens;
          break;
        default:
          break;
      }
    }
  }

  yield { type: 'usage', input: inputTokens, output: outputTokens };
  yield { type: 'end', finishReason };
}

async function* geminiStream({ apiKey, baseUrl, model, system, contents, tools, temperature, signal }) {
  const url = `${baseUrl}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
  const body = {
    contents,
    systemInstruction: system ? { parts: [{ text: system }] } : undefined,
    generationConfig: { maxOutputTokens: 4096 },
  };
  // Google deprecated temperature/top_p/top_k for the Gemini 3.x family
  // (2026-07-21). Sending it to a 3.x model is at best ignored, so omit it and
  // let the model use its own default rather than risk a 400.
  if (!isGemini3OrNewer(model)) body.generationConfig.temperature = temperature;
  if (tools?.length) {
    body.tools = [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parameters: sanitizeSchema(t.parameters) })) }];
  }

  const res = await fetch(url, {
    method: 'POST',
    // The documented auth surface for the Gemini API is the x-goog-api-key
    // header; the ?key= query parameter is legacy and leaks into logs.
    headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    await failWith({ providerId: 'gemini', model, res });
  }

  let buffer = '';
  let finishReason = 'stop';
  let input = 0;
  let output = 0;
  let callIndex = 0;

  for await (const chunk of res.body) {
    const { rest, lines } = sseLines(buffer, Buffer.from(chunk).toString('utf8'));
    buffer = rest;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      let json;
      try {
        json = JSON.parse(trimmed.slice(5).trim());
      } catch {
        continue;
      }
      input += json.usageMetadata?.promptTokenCount || 0;
      output += json.usageMetadata?.candidatesTokenCount || 0;
      const candidate = json.candidates?.[0];
      if (!candidate) continue;
      if (candidate.finishReason) finishReason = candidate.finishReason;
      for (const part of candidate.content?.parts || []) {
        if (typeof part.text === 'string') yield { type: 'text', text: part.text };
        if (part.functionCall) {
          yield {
            type: 'tool_call',
            id: `gemini_call_${callIndex++}`,
            name: part.functionCall.name,
            args: JSON.stringify(part.functionCall.args || {}),
          };
        }
      }
    }
  }
  yield { type: 'usage', input, output };
  yield { type: 'end', finishReason };
}

async function* ollamaStream({ baseUrl, model, messages, tools, temperature, signal }) {
  const body = { model, messages, stream: true, options: { temperature } };
  if (tools?.length) body.tools = tools.map((t) => ({ type: 'function', function: t }));

  const res = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    await failWith({ providerId: 'ollama', model, res });
  }

  let buffer = '';
  let callIndex = 0;
  for await (const chunk of res.body) {
    const { rest, lines } = sseLines(buffer, Buffer.from(chunk).toString('utf8'));
    buffer = rest;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let json;
      try {
        json = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (json.message?.content) yield { type: 'text', text: json.message.content };
      for (const call of json.message?.tool_calls || []) {
        yield {
          type: 'tool_call',
          id: `ollama_call_${callIndex++}`,
          name: call.function?.name,
          args: JSON.stringify(call.function?.arguments || {}),
        };
      }
      if (json.done) {
        yield {
          type: 'usage',
          input: json.prompt_eval_count || 0,
          output: json.eval_count || 0,
        };
      }
    }
  }
  yield { type: 'end', finishReason: 'stop' };
}

/**
 * The Gemini 3.x line deprecated temperature/top_p/top_k (2026-07-21).
 * Anything 3 or later (3.8, 4, ...) should not be sent sampling parameters.
 */
function isGemini3OrNewer(model) {
  const match = /^gemini-(\d+)/i.exec(String(model || ''));
  return match ? Number(match[1]) >= 3 : false;
}

/** Gemini rejects some JSON-schema keywords; keep it minimal but valid. */
function sanitizeSchema(schema) {
  if (!schema || typeof schema !== 'object') return { type: 'object', properties: {} };
  const out = { type: 'object', properties: {} };
  for (const [key, value] of Object.entries(schema.properties || {})) {
    const entry = sanitizeProperty(value);
    if (entry) out.properties[key] = entry;
  }
  if (Array.isArray(schema.required)) out.required = schema.required;
  return out;
}

/**
 * Gemini's function schema is a restricted OpenAPI subset: `integer` is not a
 * valid scalar type (use `number`), and an `array` without `items` is rejected.
 */
function sanitizeProperty(value) {
  if (!value || typeof value !== 'object') return { type: 'string' };
  const rawType = value.type === 'integer' ? 'number' : value.type || 'string';
  const entry = { type: rawType };
  if (value.description) entry.description = value.description;
  if (Array.isArray(value.enum)) entry.enum = value.enum;
  if (rawType === 'array') entry.items = sanitizeProperty(value.items || { type: 'string' });
  return entry;
}

/* ------------------------------------------------------------------ */
/* message conversion per provider                                     */
/* ------------------------------------------------------------------ */

export function toOpenAIMessages({ system, messages }) {
  const out = [];
  if (system) out.push({ role: 'system', content: system });
  for (const m of messages) {
    if (m.role === 'assistant' && m.tool_calls?.length) {
      out.push({
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.tool_calls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: typeof c.args === 'string' ? c.args : JSON.stringify(c.args || {}) },
        })),
      });
    } else if (m.role === 'tool') {
      out.push({ role: 'tool', tool_call_id: m.tool_call_id, content: String(m.content).slice(0, 24_000) });
    } else if (m.role === 'user' || m.role === 'assistant') {
      out.push({ role: m.role, content: m.content });
    }
  }
  return out;
}

export function toAnthropicMessages({ messages }) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: [{ type: 'text', text: m.content }] });
    } else if (m.role === 'assistant') {
      const blocks = [];
      if (m.content) blocks.push({ type: 'text', text: m.content });
      for (const call of m.tool_calls || []) {
        blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: safeArgs(call.args) });
      }
      if (blocks.length) out.push({ role: 'assistant', content: blocks });
    } else if (m.role === 'tool') {
      out.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: String(m.content).slice(0, 24_000) }],
      });
    }
  }
  // Anthropic requires alternating-ish turns; merge consecutive same-role text turns.
  const merged = [];
  for (const m of out) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === m.role && Array.isArray(prev.content) && Array.isArray(m.content)) {
      prev.content.push(...m.content);
    } else {
      merged.push({ role: m.role, content: [...m.content] });
    }
  }
  return merged;
}

export function toGeminiContents({ messages }) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', parts: [{ text: m.content }] });
    } else if (m.role === 'assistant') {
      const parts = [];
      if (m.content) parts.push({ text: m.content });
      for (const call of m.tool_calls || []) {
        parts.push({ functionCall: { name: call.name, args: safeArgs(call.args) } });
      }
      if (parts.length) out.push({ role: 'model', parts });
    } else if (m.role === 'tool') {
      out.push({
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: m.name || 'tool',
              response: { result: String(m.content).slice(0, 20_000) },
            },
          },
        ],
      });
    }
  }
  return out;
}

function safeArgs(args) {
  if (args && typeof args === 'object') return args;
  try {
    return JSON.parse(args || '{}');
  } catch {
    return {};
  }
}

/* ------------------------------------------------------------------ */
/* dispatch                                                            */
/* ------------------------------------------------------------------ */

export function providerInfo(providerId) {
  return config.providers[providerId] || null;
}

export function streamModel({ providerId, model, system, messages, tools, temperature, signal }) {
  const provider = providerInfo(providerId);
  if (!provider) throw new Error(`Unknown provider "${providerId}"`);

  const common = { model: model || provider.defaultModel, temperature, tools, signal };

  switch (providerId) {
    case 'openai':
      if (!provider.apiKey) throw new Error('OPENAI_API_KEY is not configured');
      return openaiStream({ ...common, apiKey: provider.apiKey, baseUrl: provider.baseUrl, messages: toOpenAIMessages({ system, messages }) });
    case 'anthropic':
      if (!provider.apiKey) throw new Error('ANTHROPIC_API_KEY is not configured');
      return anthropicStream({ ...common, apiKey: provider.apiKey, baseUrl: provider.baseUrl, system, messages: toAnthropicMessages({ messages }) });
    case 'gemini':
      if (!provider.apiKey) throw new Error('GEMINI_API_KEY is not configured');
      return geminiStream({ ...common, apiKey: provider.apiKey, baseUrl: provider.baseUrl, system, contents: toGeminiContents({ messages }) });
    case 'ollama':
      if (!provider.baseUrl) throw new Error('OLLAMA_BASE_URL is not configured');
      return ollamaStream({ ...common, baseUrl: provider.baseUrl, messages: toOpenAIMessages({ system, messages }) });
    default:
      throw new Error(`Provider "${providerId}" has no streaming adapter`);
  }
}
