import { config } from '../config.js';

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

async function* openaiStream({ apiKey, baseUrl, model, messages, tools, temperature, signal }) {
  const body = {
    model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };
  // Newer GPT-5/6 families manage reasoning/sampling internally and may reject
  // the legacy temperature parameter. Keep it for compatible GPT-4-era models.
  if (!/^gpt-(?:5|6)(?:[.-]|$)/i.test(String(model || ''))) body.temperature = temperature;
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
    throw new Error(`${res.status} ${await res.text().catch(() => res.statusText)}`.slice(0, 500));
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
    throw new Error(`${res.status} ${await res.text().catch(() => res.statusText)}`.slice(0, 500));
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
  // Never put provider credentials in a URL: URLs commonly reach access logs.
  const url = `${baseUrl}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
  const generationConfig = { maxOutputTokens: 4096 };
  // Gemini 3+ models no longer accept legacy sampling parameters.
  const major = /^gemini-(\d+)/i.exec(String(model || ''));
  if (!major || Number(major[1]) < 3) generationConfig.temperature = temperature;
  const body = {
    contents,
    systemInstruction: system ? { parts: [{ text: system }] } : undefined,
    generationConfig,
  };
  if (tools?.length) {
    body.tools = [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parameters: sanitizeSchema(t.parameters) })) }];
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    throw new Error(`${res.status} ${await res.text().catch(() => res.statusText)}`.slice(0, 500));
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
    throw new Error(`${res.status} ${await res.text().catch(() => res.statusText)}`.slice(0, 500));
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

/** Gemini accepts a smaller JSON-schema subset; strip unsupported keywords recursively. */
function sanitizeSchema(schema) {
  const clean = (value) => {
    if (!value || typeof value !== 'object') return { type: 'string' };
    const out = { type: value.type === 'integer' ? 'number' : value.type || 'string' };
    if (value.description) out.description = value.description;
    if (Array.isArray(value.enum)) out.enum = value.enum;
    if (value.type === 'array' && value.items) out.items = clean(value.items);
    if (value.type === 'object' && value.properties) {
      out.properties = Object.fromEntries(Object.entries(value.properties).map(([key, child]) => [key, clean(child)]));
    }
    if (Array.isArray(value.required)) out.required = value.required;
    return out;
  };
  return clean(schema || { type: 'object', properties: {} });
}

/* ------------------------------------------------------------------ */
/* message conversion per provider                                     */
/* ------------------------------------------------------------------ */

function attachmentLabel(attachment) {
  return `[Untrusted attachment: ${String(attachment.name || 'file').slice(0, 128)}]`;
}

function assertOpenAIAttachments(attachments = []) {
  for (const attachment of attachments) {
    if (attachment.kind !== 'text' && attachment.kind !== 'image') {
      throw new Error(`${attachment.name} needs Gemini for audio/video/PDF input. OpenAI-compatible providers accept text and images here.`);
    }
  }
}

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
      const attachments = m.role === 'user' ? m.attachments || [] : [];
      assertOpenAIAttachments(attachments);
      if (!attachments.length) {
        out.push({ role: m.role, content: m.content });
        continue;
      }
      const parts = [{ type: 'text', text: m.content || 'Please analyze the attached file(s).' }];
      for (const attachment of attachments) {
        if (attachment.kind === 'text') {
          parts.push({ type: 'text', text: `\n${attachmentLabel(attachment)}\n${String(attachment.text || '').slice(0, 600_000)}` });
        } else {
          parts.push({
            type: 'image_url',
            image_url: { url: `data:${attachment.mimeType};base64,${attachment.data}` },
          });
        }
      }
      out.push({ role: 'user', content: parts });
    }
  }
  return out;
}

export function toAnthropicMessages({ messages }) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'user') {
      const content = [{ type: 'text', text: m.content || 'Please analyze the attached file(s).' }];
      for (const attachment of m.attachments || []) {
        if (attachment.kind === 'text') {
          content.push({ type: 'text', text: `${attachmentLabel(attachment)}\n${String(attachment.text || '').slice(0, 600_000)}` });
        } else if (attachment.kind === 'image') {
          content.push({
            type: 'image',
            source: { type: 'base64', media_type: attachment.mimeType, data: attachment.data },
          });
        } else if (attachment.mimeType === 'application/pdf') {
          content.push({
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data: attachment.data },
          });
        } else {
          throw new Error(`${attachment.name} needs Gemini for audio/video input. Anthropic supports text, images and PDF documents here.`);
        }
      }
      out.push({ role: 'user', content });
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
      const parts = [{ text: m.content || 'Please analyze the attached file(s).' }];
      for (const attachment of m.attachments || []) {
        if (attachment.kind === 'text') {
          parts.push({ text: `${attachmentLabel(attachment)}\n${String(attachment.text || '').slice(0, 600_000)}` });
        } else {
          parts.push({ inlineData: { mimeType: attachment.mimeType, data: attachment.data } });
        }
      }
      out.push({ role: 'user', parts });
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

export function toOllamaMessages({ system, messages }) {
  const out = [];
  if (system) out.push({ role: 'system', content: system });
  for (const message of messages) {
    if (message.role === 'tool') {
      out.push({ role: 'tool', content: String(message.content).slice(0, 24_000), name: message.name || 'tool' });
      continue;
    }
    if (message.role === 'assistant' && message.tool_calls?.length) {
      out.push({
        role: 'assistant',
        content: message.content || '',
        tool_calls: message.tool_calls.map((call) => ({
          function: { name: call.name, arguments: safeArgs(call.args) },
        })),
      });
      continue;
    }
    const attachments = message.role === 'user' ? message.attachments || [] : [];
    const text = [message.content || '', ...attachments.filter((a) => a.kind === 'text').map((a) => `${attachmentLabel(a)}\n${String(a.text || '').slice(0, 600_000)}`)]
      .filter(Boolean)
      .join('\n\n');
    const images = attachments.filter((a) => a.kind === 'image').map((a) => a.data);
    if (attachments.some((a) => a.kind !== 'image' && a.kind !== 'text')) {
      throw new Error('Ollama accepts text and images here; use Gemini for audio, video or PDF attachments.');
    }
    out.push({ role: message.role, content: text || 'Please analyze the attached image.', ...(images.length ? { images } : {}) });
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
      return ollamaStream({ ...common, baseUrl: provider.baseUrl, messages: toOllamaMessages({ system, messages }) });
    default:
      throw new Error(`Provider "${providerId}" has no streaming adapter`);
  }
}
